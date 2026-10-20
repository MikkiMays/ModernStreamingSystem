"""
Прокси кинозала не бесплатный канал (A8 docs/abuse-model.md, E11-B).

Адреса, которые служба выдаёт плееру, привязаны к встрече: путь `…/cinema/r/<встреча>/…`, а номер
встречи — под подписью. Прокси пускает, пока встреча открыта и в ней идёт кино; байты к зрителям
считаются на встречу и на сервер за сутки, и сверх потолка — отказ.
"""

import unittest
import uuid
from urllib.parse import parse_qs, urlsplit

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse

from cord_services.cinema.facade import Cinema
from cord_services.cinema.guard import Traffic, Watching, bind_room, size
from cord_services.cinema.routes import routes
from cord_services.cinema.transport import signer as signing
from cord_services.cinema.transport.signer import PREFIX, ROOM, Signer, proxied

ROOM_A = str(uuid.UUID(int=1))
ROOM_B = str(uuid.UUID(int=2))
URL = "https://rr5.googlevideo.com/videoplayback?id=1"


def hosts(provider):
    from cord_services.cinema.providers.youtube import YouTube

    return YouTube.hosts if provider == "youtube" else None


class RoomInSignature(unittest.TestCase):
    def setUp(self):
        self.signer = Signer("secret-of-thirty-two-characters!", hosts)

    def parts(self, address):
        query = {k: v[0] for k, v in parse_qs(urlsplit(address).query).items()}
        return query["u"], query["e"], query["s"], query.get("p", ""), query.get("h", "")

    def test_a_link_signed_for_one_meeting_does_not_open_in_another(self):
        token = ROOM.set(ROOM_A)
        try:
            address = proxied(self.signer, URL, "fetch", provider="youtube")
        finally:
            ROOM.reset(token)
        self.assertTrue(address.startswith(f"{PREFIX}/r/{ROOM_A}/fetch?"))
        u, e, s, p, h = self.parts(address)
        self.assertEqual(self.signer.open("fetch", u, e, s, p, h, room=ROOM_A), URL)
        for other in (ROOM_B, ""):
            with self.assertRaises(HTTPException) as refusal:
                self.signer.open("fetch", u, e, s, p, h, room=other)
            self.assertEqual(refusal.exception.status_code, 403)

    def test_a_meetingless_link_does_not_open_under_a_meeting(self):
        u, e, s, p, h = self.parts(proxied(self.signer, URL, "fetch", provider="youtube"))
        with self.assertRaises(HTTPException):
            self.signer.open("fetch", u, e, s, p, h, room=ROOM_A)

    def test_links_live_an_hour_by_default(self):
        self.assertEqual(signing.SIGNATURE_TTL, 3600)
        self.assertEqual(signing.seconds("90 minutes"), 5400)
        self.assertEqual(signing.seconds("2 hours"), 7200)
        self.assertEqual(signing.seconds("600"), 600)

    def test_the_resolver_answer_is_rebound_to_the_asking_meeting(self):
        """Разбор общий на всех (память), а адреса в ответе — у каждой встречи свои."""
        shared = {
            "url": proxied(self.signer, URL, "playlist", provider="youtube"),
            "tracks": [{"url": proxied(self.signer, URL, "subtitles", provider="youtube"), "lang": "ru"}],
            "dash": f"{PREFIX}/dash/0123456789abcdef01234567",
            "poster": "https://example.com/not-ours.jpg",
        }
        bound = bind_room(shared, ROOM_A, self.signer)
        self.assertTrue(bound["url"].startswith(f"{PREFIX}/r/{ROOM_A}/playlist?"))
        self.assertTrue(bound["tracks"][0]["url"].startswith(f"{PREFIX}/r/{ROOM_A}/subtitles?"))
        self.assertEqual(bound["dash"], f"{PREFIX}/r/{ROOM_A}/dash/0123456789abcdef01234567")
        self.assertEqual(bound["poster"], shared["poster"])
        u, e, s, p, h = self.parts(bound["url"])
        self.assertEqual(self.signer.open("playlist", u, e, s, p, h, room=ROOM_A), URL)
        # Общий ответ не тронут: следующая встреча получит свои адреса из того же разбора.
        self.assertTrue(shared["url"].startswith(f"{PREFIX}/playlist?"))


class Core:
    """Ядро теста: встреча открыта и смотрит кино, пока не сказано иное."""

    def __init__(self):
        self.closed = set()
        self.idle = set()
        self.asked = 0

    async def request(self, method, path, *args, **kwargs):
        self.asked += 1
        room = path.rsplit("/", 1)[1]
        return {"id": room, "closedAt": 1 if room in self.closed else None, "watching": room not in self.idle}

    async def member(self, room_id, authorization, **_):
        return {"id": room_id}, {"id": "member"}


class Meetings(unittest.IsolatedAsyncioTestCase):
    async def test_a_closed_meeting_or_a_closed_cinema_stops_the_proxy(self):
        core = Core()
        now = [0.0]
        watching = Watching(core, ttl=30, clock=lambda: now[0])
        await watching.require(ROOM_A)
        await watching.require(ROOM_A)
        self.assertEqual(core.asked, 1)
        core.closed.add(ROOM_A)
        now[0] = 31
        with self.assertRaises(HTTPException) as refusal:
            await watching.require(ROOM_A)
        self.assertEqual(refusal.exception.status_code, 410)
        core.idle.add(ROOM_B)
        with self.assertRaises(HTTPException):
            await watching.require(ROOM_B)
        with self.assertRaises(HTTPException):
            await watching.require("не номер")

    async def test_bytes_past_the_meeting_ceiling_are_refused(self):
        traffic = Traffic(per_meeting=1000, per_day=10_000, warn_at=0.8)
        traffic.admit(ROOM_A)
        traffic.count(ROOM_A, 900)
        self.assertTrue(traffic.warned(ROOM_A))
        traffic.count(ROOM_A, 200)
        with self.assertRaises(HTTPException) as refusal:
            traffic.admit(ROOM_A)
        self.assertEqual(refusal.exception.status_code, 429)
        self.assertIn("трафик", refusal.exception.detail)
        traffic.admit(ROOM_B)

    async def test_the_server_has_a_daily_ceiling_too(self):
        day = [0]
        traffic = Traffic(per_meeting=10_000, per_day=1000, warn_at=0.8, today=lambda: day[0])
        traffic.count(ROOM_A, 600)
        traffic.count(ROOM_B, 600)
        with self.assertRaises(HTTPException):
            traffic.admit(str(uuid.UUID(int=3)))
        day[0] = 1
        traffic.admit(str(uuid.UUID(int=3)))

    async def test_streamed_bodies_are_counted_as_they_leave(self):
        traffic = Traffic(per_meeting=10_000, per_day=100_000, warn_at=0.8)

        async def body():
            for _ in range(3):
                yield b"x" * 100

        response = traffic.wrap(StreamingResponse(body()), ROOM_A)
        received = b"".join([chunk async for chunk in response.body_iterator])
        self.assertEqual(len(received), 300)
        self.assertEqual(traffic.used(ROOM_A), 300)
        self.assertEqual(size("1GB"), 1024**3)
        self.assertEqual(size("500 MB"), 500 * 1024**2)


class Upstream:
    def __call__(self, request):
        headers = {"content-type": "video/mp4", "content-length": "4"}
        return httpx.Response(200, headers=headers, content=b"film")


class Routes(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.core = Core()
        self.cinema = Cinema(
            "secret-of-thirty-two-characters!", httpx.AsyncClient(transport=httpx.MockTransport(Upstream()))
        )
        self.traffic = Traffic(per_meeting=10, per_day=1000, warn_at=0.8)
        app = FastAPI()
        app.include_router(routes(self.cinema, self.core, traffic=self.traffic))
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://cord.test")

    async def asyncTearDown(self):
        await self.client.aclose()
        await self.cinema.close()

    def address(self, room):
        token = ROOM.set(room)
        try:
            return proxied(self.cinema.signer, URL, "fetch", provider="youtube")
        finally:
            ROOM.reset(token)

    async def test_a_meeting_link_serves_while_the_meeting_watches_and_counts_its_bytes(self):
        address = self.address(ROOM_A)
        answer = await self.client.get(address)
        self.assertEqual((answer.status_code, answer.content), (200, b"film"))
        self.assertEqual(self.traffic.used(ROOM_A), 4)
        # Тот же адрес под чужой встречей — подпись не сходится.
        forged = address.replace(ROOM_A, ROOM_B)
        self.assertEqual((await self.client.get(forged)).status_code, 403)
        # Встреча закрыта — адрес больше не работает.
        self.core.closed.add(ROOM_B)
        self.assertEqual((await self.client.get(self.address(ROOM_B))).status_code, 410)

    async def test_the_meeting_ceiling_stops_the_film(self):
        address = self.address(ROOM_A)
        for _ in range(3):
            await self.client.get(address)
        answer = await self.client.get(address)
        self.assertEqual(answer.status_code, 429)


class Startup(unittest.TestCase):
    def test_the_service_does_not_start_without_a_real_secret(self):
        """A14: без `INTERNAL_SECRET` подписи кинозала считались бы на запасном ключе из кода."""
        from unittest.mock import patch

        from cord_services.app import create_app

        for secret in ("", "short"):
            with patch.dict("os.environ", {"INTERNAL_SECRET": secret}), self.assertRaises(RuntimeError):
                create_app()


if __name__ == "__main__":
    unittest.main()
