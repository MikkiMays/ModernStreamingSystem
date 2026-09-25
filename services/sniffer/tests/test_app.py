"""
Вход плеера страниц (`sniffer/app.py`): ключ службы, одна страница на комнату, место на контейнере и
отмена страницы, как только служба ушла. Браузер здесь не нужен — страницу играет подставная `sniff`;
сервер — настоящий uvicorn на 127.0.0.1, чтобы обрыв соединения был настоящим.
"""

import asyncio
import socket
import unittest

import httpx
import uvicorn

from cord_services.cinema.egress import Busy
from sniffer.app import BODY, create_app
from sniffer.isolation import Isolation

KEY = "k" * 64
AUTH = {"Authorization": f"Bearer {KEY}"}
PAGE = "https://site.example/watch/1"


class Fake:
    """Подставная страница: ждёт, пока её отпустят, и помнит, какие отменили."""

    def __init__(self):
        self.started: list[str] = []
        self.cancelled: list[str] = []
        self.release = asyncio.Event()
        self.busy = False

    async def __call__(self, url: str):
        if self.busy:
            raise Busy("занято")
        self.started.append(url)
        try:
            await self.release.wait()
        except asyncio.CancelledError:
            self.cancelled.append(url)
            raise
        return {"page": url, "streams": []}


class ApiCase(unittest.IsolatedAsyncioTestCase):
    isolation = None

    async def asyncSetUp(self):
        self.fake = Fake()
        app = create_app(KEY, self.fake, isolation=self.isolation)
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            self.port = probe.getsockname()[1]
        self.server = uvicorn.Server(
            uvicorn.Config(app, host="127.0.0.1", port=self.port, log_level="warning", lifespan="on")
        )
        self.serving = asyncio.ensure_future(self.server.serve())
        while not self.server.started:
            await asyncio.sleep(0.02)
        self.client = httpx.AsyncClient(base_url=f"http://127.0.0.1:{self.port}", timeout=10)

    async def asyncTearDown(self):
        await self.client.aclose()
        self.fake.release.set()
        self.server.should_exit = True
        await self.serving

    async def sniff(self, url=PAGE, room="r1", headers=AUTH):
        return await self.client.post("/sniff", json={"url": url, "room": room}, headers=headers)


class Entry(ApiCase):
    async def test_health_answers_without_a_key(self):
        response = await self.client.get("/health")
        self.assertEqual(response.json(), {"status": "UP", "isolated": None})

    async def test_without_the_key_of_the_service_nothing_opens(self):
        for headers in (
            {},
            {"Authorization": "Bearer wrong"},
            {"Authorization": KEY},
            {"Authorization": "Bearer ключ".encode()},
        ):
            response = await self.sniff(headers=headers)
            self.assertEqual(response.status_code, 401, headers)
        self.assertEqual(self.fake.started, [])

    async def test_only_a_page_address_is_opened(self):
        for url in (
            "javascript:alert(1)",
            "file:///etc/passwd",
            "https://user:pass@site.example/",
            "https://site.example/#__youtubedl_smuggle=%7B%7D",
            "https://site.example/\nx",
            "ftp://site.example/",
        ):
            response = await self.sniff(url=url)
            self.assertIn(response.status_code, (400, 422), url)
        self.assertEqual(self.fake.started, [])

    async def test_an_empty_key_opens_nothing(self):
        app = create_app("", self.fake)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://sniffer") as client:
            response = await client.post("/sniff", json={"url": PAGE}, headers={"Authorization": "Bearer "})
        self.assertEqual(response.status_code, 401)


class OnePagePerRoom(ApiCase):
    async def test_a_new_page_of_the_room_replaces_the_one_still_open(self):
        first = asyncio.ensure_future(self.sniff(url=PAGE))
        while not self.fake.started:
            await asyncio.sleep(0.02)
        second = asyncio.ensure_future(self.sniff(url=PAGE + "?2"))
        response = await first
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.fake.cancelled, [PAGE])
        self.fake.release.set()
        self.assertEqual((await second).json(), {"page": PAGE + "?2", "streams": []})

    async def test_other_rooms_do_not_replace_each_other(self):
        first = asyncio.ensure_future(self.sniff(room="r1"))
        second = asyncio.ensure_future(self.sniff(room="r2"))
        while len(self.fake.started) < 2:
            await asyncio.sleep(0.02)
        self.fake.release.set()
        self.assertEqual([(await first).status_code, (await second).status_code], [200, 200])
        self.assertEqual(self.fake.cancelled, [])

    async def test_a_busy_player_says_so(self):
        self.fake.busy = True
        response = await self.sniff()
        self.assertEqual(response.status_code, 503)

    async def test_a_page_the_service_gave_up_on_is_closed_at_once(self):
        asking = asyncio.ensure_future(self.sniff())
        while not self.fake.started:
            await asyncio.sleep(0.02)
        asking.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await asking
        for _ in range(50):
            if self.fake.cancelled:
                break
            await asyncio.sleep(0.05)
        self.assertEqual(self.fake.cancelled, [PAGE])


class Body(ApiCase):
    async def test_the_key_is_checked_before_the_body_is_read(self):
        # Чужому — 401 сразу, какое бы тело он ни прислал: разбирать его сервер не станет.
        started = asyncio.get_running_loop().time()
        response = await self.client.post(
            "/sniff", content=b"{" * (4 * 1024 * 1024), headers={"Authorization": "x"}
        )
        self.assertEqual(response.status_code, 401)
        self.assertLess(asyncio.get_running_loop().time() - started, 2)

    async def test_a_body_bigger_than_the_limit_is_refused(self):
        big = {"url": PAGE + "?" + "a" * (BODY + 10), "room": "r1"}
        response = await self.client.post("/sniff", json=big, headers=AUTH)
        self.assertEqual(response.status_code, 413)

        async def chunks():
            for _ in range(20):
                yield b" " * 1024

        # Без объявленной длины — считается прочитанное.
        response = await self.client.post("/sniff", content=chunks(), headers=AUTH)
        self.assertEqual(response.status_code, 413)
        self.assertEqual(self.fake.started, [])

    async def test_a_body_that_is_not_the_order_is_refused(self):
        for body in (b"not json", b'{"url": 1}', b'{"url": "' + PAGE.encode() + b'", "room": "a b"}'):
            response = await self.client.post("/sniff", content=body, headers=AUTH)
            self.assertEqual(response.status_code, 422, body)
        self.assertEqual(self.fake.started, [])


class Unisolated(ApiCase):
    """Цель самопроверки — слушающий сокет теста: он отвечает, значит «изоляции нет»."""

    async def asyncSetUp(self):
        self.canary = socket.socket()
        self.canary.bind(("127.0.0.1", 0))
        self.canary.listen(8)
        self.isolation = Isolation([("127.0.0.1", self.canary.getsockname()[1])], attempt=1.0, period=3600)
        await super().asyncSetUp()

    async def asyncTearDown(self):
        await super().asyncTearDown()
        self.canary.close()

    async def test_without_isolation_no_page_is_opened(self):
        response = await self.sniff()
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.headers.get("x-cord-isolation"), "broken")
        self.assertIn("изоляция не настроена", response.json()["detail"])
        self.assertEqual(self.fake.started, [])

    async def test_the_isolation_can_be_asked_by_hand(self):
        response = await self.client.get("/isolation")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["reached"], [f"127.0.0.1:{self.canary.getsockname()[1]}"])
        health = await self.client.get("/health")
        self.assertEqual(health.json(), {"status": "UP", "isolated": False})


class Isolated(ApiCase):
    async def asyncSetUp(self):
        probe = socket.socket()
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
        probe.close()
        self.isolation = Isolation([("127.0.0.1", port)], attempt=1.0, period=3600)
        await super().asyncSetUp()

    async def test_with_isolation_pages_open_and_the_state_says_so(self):
        response = await self.client.get("/isolation")
        self.assertEqual((response.status_code, response.json()["isolated"]), (200, True))
        asking = asyncio.ensure_future(self.sniff())
        while not self.fake.started:
            await asyncio.sleep(0.02)
        self.fake.release.set()
        self.assertEqual((await asking).status_code, 200)


if __name__ == "__main__":
    unittest.main()
