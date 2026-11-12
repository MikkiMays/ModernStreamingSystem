"""Трафик и время кинозала и музыки — фактами `usage` службе аналитики (R239, contracts/insight.md §2)."""

import json
import unittest
import uuid

import httpx
from fastapi.responses import Response, StreamingResponse

from cord_services import keys
from cord_services.cinema.guard import Traffic
from cord_services.insight import Usage, word

SECRET = "a-test-internal-secret-of-32-chars"
ROOM_A = str(uuid.UUID(int=1))
ROOM_B = str(uuid.UUID(int=2))


class Service:
    """Служба аналитики глазами отправителя: запоминает пачки, по желанию отказывает."""

    def __init__(self):
        self.batches = []
        self.keys = []
        self.status = 204

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.keys.append(request.headers.get("X-Insight-Key"))
        if self.status == 204:
            self.batches.append(json.loads(request.content))
        return httpx.Response(self.status)


def usage(service: Service, now: list[float] | None = None) -> Usage:
    clock = (lambda: now[0]) if now else (lambda: 1_793_612_345.678)
    return Usage(
        "http://127.0.0.1:18300/",
        SECRET,
        client=httpx.AsyncClient(transport=httpx.MockTransport(service.handler)),
        clock=clock,
    )


class Facts(unittest.IsolatedAsyncioTestCase):
    async def test_bytes_and_seconds_become_usage_facts_per_meeting_and_platform(self):
        service = Service()
        sender = usage(service)
        sender.count(ROOM_A, "cinema", "youtube", 700_000)
        sender.count(ROOM_A, "cinema", "youtube", 300_000)
        sender.count(ROOM_A, "cinema", "ivi", 50)
        # Музыка секунды называет сама; байты — размер трека в очереди.
        sender.count(ROOM_B, "music", "yandex", 4_000_000)
        sender.played(ROOM_B, "music", "yandex", 12.5)
        sender.played(ROOM_B, "music", "yandex", 9.25)
        # Не встреча, не байты, перемотка назад и скачок позиции — не в счёт.
        sender.count("", "cinema", "youtube", 999)
        sender.count(ROOM_A, "cinema", "youtube", 0)
        sender.played(ROOM_B, "music", "yandex", -3)
        sender.played(ROOM_B, "music", "yandex", 600)
        self.assertTrue(await sender.flush())
        self.assertEqual(service.keys, [keys.text(SECRET, "insight")])
        (batch,) = service.batches
        self.assertEqual(batch["source"], "services")
        facts = {(f["room"], f["kind"], f["variant"]): f for f in batch["facts"]}
        self.assertEqual(len(facts), 3)
        youtube = facts[(ROOM_A, "cinema", "youtube")]
        self.assertEqual((youtube["type"], youtube["bytes"], youtube["seconds"]), ("usage", 1_000_000, 30.0))
        self.assertEqual(youtube["at"], 1_793_612_345_678)
        uuid.UUID(youtube["id"])
        self.assertEqual(facts[(ROOM_A, "cinema", "ivi")]["bytes"], 50)
        music = facts[(ROOM_B, "music", "yandex")]
        self.assertEqual((music["bytes"], music["seconds"]), (4_000_000, 21.8))
        # Окно начато заново: без новых байт фактов нет и запроса нет.
        self.assertTrue(await sender.flush())
        self.assertEqual(len(service.batches), 1)
        await sender.close()

    async def test_a_refused_batch_is_repeated_with_the_same_ids(self):
        service = Service()
        sender = usage(service)
        sender.count(ROOM_A, "cinema", "rutube", 10)
        service.status = 503
        self.assertFalse(await sender.flush())
        sender.count(ROOM_A, "cinema", "rutube", 20)
        service.status = 204
        self.assertTrue(await sender.flush())
        (batch,) = service.batches
        self.assertEqual([f["bytes"] for f in batch["facts"]], [10, 20])
        self.assertEqual(len({f["id"] for f in batch["facts"]}), 2)
        # Отказ по существу повтором не лечится: пачка выбрасывается и не встаёт навсегда.
        sender.count(ROOM_A, "cinema", "rutube", 30)
        service.status = 401
        self.assertTrue(await sender.flush())
        self.assertEqual(sender.dropped, 1)
        service.status = 204
        self.assertTrue(await sender.flush())
        self.assertEqual(len(service.batches), 1)
        await sender.close()

    async def test_without_an_address_nothing_is_counted_or_sent(self):
        service = Service()
        sender = Usage("", SECRET, client=httpx.AsyncClient(transport=httpx.MockTransport(service.handler)))
        sender.count(ROOM_A, "cinema", "youtube", 100)
        sender.played(ROOM_A, "music", "yandex", 5)
        self.assertEqual(sender.take(), [])
        self.assertTrue(await sender.flush())
        self.assertEqual(service.keys, [])
        await sender.close()

    def test_platform_names_fit_the_contract(self):
        self.assertEqual(word("YouTube"), "youtube")
        self.assertEqual(word("vk.video"), "vk.video")
        self.assertEqual(word("Яндекс Музыка"), "other")
        self.assertEqual(word(""), "other")
        self.assertEqual(word(None), "other")
        self.assertEqual(len(word("a" * 80)), 32)
        self.assertEqual(word("По ссылке / link"), "link")


class CinemaTraffic(unittest.IsolatedAsyncioTestCase):
    async def test_proxy_bytes_reach_the_usage_counter_with_their_platform(self):
        seen = []
        traffic = Traffic(per_meeting=10**9, per_day=10**9, warn_at=0.8)
        traffic.usage = lambda room, provider, amount: seen.append((room, provider, amount))
        traffic.wrap(Response(content=b"12345"), ROOM_A, "ivi")

        async def chunks():
            yield b"abc"
            yield b"de"

        streamed = traffic.wrap(StreamingResponse(chunks()), ROOM_A, "youtube")
        async for _ in streamed.body_iterator:
            pass
        # Вне встречи (витрина, картинки каталога) аналитике рассказывать не о чем.
        traffic.wrap(Response(content=b"zz"), "", "youtube")
        self.assertEqual(seen, [(ROOM_A, "ivi", 5), (ROOM_A, "youtube", 3), (ROOM_A, "youtube", 2)])
        self.assertEqual(traffic.used(ROOM_A), 10)


if __name__ == "__main__":
    unittest.main()
