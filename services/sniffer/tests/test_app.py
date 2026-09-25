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
from sniffer.app import create_app

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
    async def asyncSetUp(self):
        self.fake = Fake()
        app = create_app(KEY, self.fake)
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
        self.assertEqual(response.json(), {"status": "UP"})

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


if __name__ == "__main__":
    unittest.main()
