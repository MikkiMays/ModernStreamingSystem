"""Трафик кинозала доходит до встречи плашкой (A8): служба говорит ядру порог и потолок."""

import asyncio
import unittest
import uuid

import httpx
from fastapi import FastAPI, HTTPException

from cord_services.cinema.facade import Cinema
from cord_services.cinema.guard import Traffic
from cord_services.cinema.routes import routes
from cord_services.cinema.transport.signer import ROOM, proxied

ROOM_A = str(uuid.UUID(int=1))
URL = "https://media.youtube.com/film.mp4"


class Told:
    def __init__(self):
        self.calls = []

    async def __call__(self, room, percent):
        self.calls.append((room, percent))


class Shares(unittest.IsolatedAsyncioTestCase):
    async def test_the_meeting_hears_the_threshold_and_the_ceiling_once_each(self):
        now = [0.0]
        told = Told()
        traffic = Traffic(per_meeting=1000, per_day=100_000, warn_at=0.8, clock=lambda: now[0])
        traffic.notify = told
        traffic.count(ROOM_A, 700)
        traffic.count(ROOM_A, 150)
        traffic.count(ROOM_A, 10)
        await asyncio.sleep(0)
        self.assertEqual(told.calls, [(ROOM_A, 80)])
        traffic.count(ROOM_A, 200)
        await asyncio.sleep(0)
        self.assertEqual(told.calls, [(ROOM_A, 80), (ROOM_A, 100)])
        # Сверх потолка — отказ; ядро уже знает и второй раз не слышит.
        with self.assertRaises(HTTPException):
            traffic.admit(ROOM_A)
        await asyncio.sleep(0)
        self.assertEqual(len(told.calls), 2)
        # Спустя время отказ напоминает: ядро могло перезапуститься, встречу — открыть заново.
        now[0] = 301
        with self.assertRaises(HTTPException):
            traffic.admit(ROOM_A)
        await asyncio.sleep(0)
        self.assertEqual(told.calls[-1], (ROOM_A, 100))
        self.assertEqual(len(told.calls), 3)

    async def test_a_failing_core_does_not_break_the_film(self):
        async def broken(room, percent):
            raise HTTPException(503, "ядро недоступно")

        traffic = Traffic(per_meeting=100, per_day=100_000, warn_at=0.8)
        traffic.notify = broken
        traffic.count(ROOM_A, 90)
        await asyncio.sleep(0)
        traffic.admit(ROOM_A)

    def test_without_a_running_loop_counting_still_works(self):
        traffic = Traffic(per_meeting=100, per_day=100_000, warn_at=0.8)
        traffic.notify = Told()
        traffic.count(ROOM_A, 90)
        self.assertTrue(traffic.warned(ROOM_A))


class Core:
    """Ядро теста: встреча смотрит кино; запоминает, что ей сказали о трафике."""

    def __init__(self):
        self.reports = []

    async def request(self, method, path, data=None, *args, **kwargs):
        if path.endswith("/cinema-traffic"):
            self.reports.append((method, path, data))
            return None
        room = path.rsplit("/", 1)[1]
        return {"id": room, "closedAt": None, "watching": True}


class Upstream:
    def __call__(self, request):
        headers = {"content-type": "video/mp4", "content-length": "4"}
        return httpx.Response(200, headers=headers, content=b"film")


class Proxy(unittest.IsolatedAsyncioTestCase):
    async def test_bytes_to_viewers_reach_the_meeting_as_a_share_of_its_ceiling(self):
        core = Core()
        cinema = Cinema(
            "secret-of-thirty-two-characters!", httpx.AsyncClient(transport=httpx.MockTransport(Upstream()))
        )
        traffic = Traffic(per_meeting=10, per_day=1000, warn_at=0.8)
        app = FastAPI()
        app.include_router(routes(cinema, core, traffic=traffic))
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://cord.test")
        token = ROOM.set(ROOM_A)
        try:
            address = proxied(cinema.signer, URL, "fetch", provider="youtube")
        finally:
            ROOM.reset(token)
        try:
            path = f"/internal/services/{ROOM_A}/cinema-traffic"
            await client.get(address)
            await asyncio.sleep(0.05)
            self.assertEqual(core.reports, [])
            # Восемь байт из десяти — порог 80 %; двенадцать — потолок.
            await client.get(address)
            await asyncio.sleep(0.05)
            self.assertEqual(core.reports, [("POST", path, {"percent": 80})])
            await client.get(address)
            await asyncio.sleep(0.05)
            self.assertEqual(core.reports[-1], ("POST", path, {"percent": 100}))
            self.assertEqual((await client.get(address)).status_code, 429)
        finally:
            await client.aclose()
            await cinema.close()


if __name__ == "__main__":
    unittest.main()
