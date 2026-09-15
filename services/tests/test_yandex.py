import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
from fastapi import HTTPException

from test_services import Fixture, ROOM, HOST, GUEST, audio
from cord_services.store import now


class YandexTests(Fixture):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.integrations_allowed = True
        self.yandex = self.app.state.yandex
        self.profile = "p" * 43
        self.fake = SimpleNamespace(
            account_status=AsyncMock(
                return_value=SimpleNamespace(
                    account=SimpleNamespace(
                        uid=100, display_name="Listener", login="listener"
                    )
                )
            ),
            request_device_code=AsyncMock(
                return_value=SimpleNamespace(
                    device_code="PRIVATE_DEVICE_CODE",
                    user_code="ABCD-EFGH",
                    verification_url="https://ya.ru/device",
                    interval=5,
                    expires_in=300,
                )
            ),
            poll_device_token=AsyncMock(return_value=None),
        )
        self.yandex.client_factory = lambda *args, **kwargs: self.fake

    def url(self, mode="personal", tail=""):
        return f"/api/v1/services/rooms/{ROOM}/yandex{tail}"

    def headers(self, member=HOST, profile=None):
        return {**super().headers(member), "X-Cord-Profile": profile or self.profile}

    async def test_any_allowed_participant_can_connect_replace_or_disconnect_room_account(
        self,
    ):
        token = "PRIVATE_TOKEN_SHOULD_NOT_ESCAPE"
        response = await self.client.post(
            self.url(tail="/token"), headers=self.headers(GUEST), json={"token": token}
        )
        self.assertEqual(response.status_code, 200)
        self.assertNotIn(token, response.text)
        encrypted = self.store.db.execute("SELECT body FROM integrations").fetchone()[0]
        self.assertNotIn(token, encrypted)
        self.assertNotIn("Listener", encrypted)
        self.assertTrue(
            (await self.client.get(self.url(), headers=self.headers())).json()[
                "connected"
            ]
        )
        self.assertFalse(self.yandex.status("room:" + str(uuid.uuid4()))["connected"])
        self.fake.account_status.return_value.account.display_name = "Another listener"
        response = await self.client.post(
            self.url(tail="/token"),
            headers=self.headers(GUEST),
            json={"token": "ANOTHER_PRIVATE_TOKEN"},
        )
        self.assertEqual(response.json()["name"], "Another listener")
        self.assertEqual(
            (await self.client.get(self.url(), headers=self.headers())).json()["name"],
            "Another listener",
        )
        await self.client.delete(self.url(), headers=self.headers(GUEST))
        self.assertFalse(
            (await self.client.get(self.url(), headers=self.headers())).json()[
                "connected"
            ]
        )

    async def test_device_flow_pending_interval_room_scope_completion_and_cancel(
        self,
    ):
        start = await self.client.post(
            self.url(tail="/auth"), headers=self.headers(GUEST)
        )
        self.assertEqual(start.status_code, 200)
        self.assertNotIn("PRIVATE_DEVICE_CODE", start.text)
        identifier = start.json()["id"]
        duplicate = await self.client.post(
            self.url(tail="/auth"), headers=self.headers(GUEST)
        )
        self.assertEqual(duplicate.json()["id"], identifier)
        self.assertEqual(self.fake.request_device_code.await_count, 1)
        poll = await self.client.post(
            self.url(tail="/auth/" + identifier), headers=self.headers(GUEST)
        )
        self.assertEqual(poll.json()["status"], "pending")
        self.assertEqual(self.fake.poll_device_token.await_count, 0)
        with self.assertRaises(HTTPException) as wrong:
            await self.yandex.poll_auth("room:" + str(uuid.uuid4()), identifier)
        self.assertEqual(wrong.exception.status_code, 410)
        value = self.store.claim(identifier)
        value["nextPoll"] = now() - 1
        self.store.delete_claim(identifier)
        self.store.put_claim(identifier, value)
        self.fake.poll_device_token.return_value = SimpleNamespace(
            access_token="PRIVATE_OAUTH_TOKEN", expires_in=3600
        )
        finished = await self.client.post(
            self.url(tail="/auth/" + identifier), headers=self.headers(GUEST)
        )
        self.assertEqual(finished.json()["status"], "connected")
        self.assertNotIn("PRIVATE_OAUTH_TOKEN", finished.text)
        self.assertEqual(self.fake.poll_device_token.await_count, 1)
        retry = await self.client.post(
            self.url(tail="/auth/" + identifier), headers=self.headers(GUEST)
        )
        self.assertEqual(retry.json()["status"], "connected")
        new = (
            await self.client.post(self.url(tail="/auth"), headers=self.headers(GUEST))
        ).json()["id"]
        await self.client.delete(
            self.url(tail="/auth/" + new), headers=self.headers(GUEST)
        )
        self.assertIsNone(self.store.claim(new))

    async def test_host_can_disable_guest_integrations_after_connecting(self):
        await self.client.post(
            self.url(tail="/token"),
            headers=self.headers(GUEST),
            json={"token": "token_for_test_only_12345"},
        )
        self.integrations_allowed = False
        self.assertEqual(
            (
                await self.client.get(self.url(), headers=self.headers(GUEST))
            ).status_code,
            403,
        )
        self.assertEqual(
            (
                await self.client.post(
                    self.url(tail="/auth"), headers=self.headers(GUEST)
                )
            ).status_code,
            403,
        )
        self.assertEqual(
            (await self.client.get(self.url(), headers=self.headers())).status_code, 200
        )

    async def test_search_links_and_queue_accept_only_complete_authorized_audio(self):
        scope = "room:" + ROOM
        self.yandex.save(scope, {"token": "TEST_TOKEN", "name": "Tester"})
        one = SimpleNamespace(
            id=123,
            title="Track",
            artists=[SimpleNamespace(name="Artist")],
            duration_ms=1000,
            available=True,
        )
        self.fake.tracks = AsyncMock(return_value=[one])
        self.fake.search = AsyncMock(
            return_value=SimpleNamespace(tracks=SimpleNamespace(results=[one]))
        )
        self.fake.tracks_download_info = AsyncMock(
            return_value=[
                SimpleNamespace(preview=True, codec="mp3", bitrate_in_kbps=128)
            ]
        )
        found = await self.yandex.search(
            scope, "https://music.yandex.ru/album/1/track/123"
        )
        self.assertEqual(found[0]["id"], "123")
        with self.assertRaises(HTTPException):
            await self.yandex.search(scope, "https://another.test/track/123")
        with self.assertRaises(HTTPException):
            await self.yandex.enqueue(ROOM, scope, "123", str(uuid.uuid4()), "Tester")
        self.assertEqual(self.store.get(ROOM)["queue"], [])
        wav = self.root / "source.wav"
        audio(wav)
        await self.yandex.http.aclose()
        self.yandex.http = httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda _: httpx.Response(200, content=wav.read_bytes())
            )
        )

        def option(codec, bitrate, url):
            return SimpleNamespace(
                preview=False,
                codec=codec,
                bitrate_in_kbps=bitrate,
                download_info_url="https://music.yandex.ru/download-info/123",
                get_direct_link_async=AsyncMock(return_value=url),
            )

        best = option("aac", 320, "https://cdn.yandex.net/test.aac")
        self.fake.tracks_download_info.return_value = [
            option("mp3", 192, "https://cdn.yandex.net/low.mp3"),
            best,
            option("mp3", 320, "https://cdn.yandex.net/test.mp3"),
        ]
        command = str(uuid.uuid4())
        await self.yandex.enqueue(ROOM, scope, "123", command, "Tester")
        # Одного трека Яндекс предлагает несколько вариантов, и комната слушает лучший из них.
        best.get_direct_link_async.assert_awaited()
        await self.yandex.enqueue(ROOM, scope, "123", command, "Tester")
        self.assertEqual(len(self.store.get(ROOM)["queue"]), 1)
        self.assertEqual(self.store.get(ROOM)["queue"][0]["source"], "yandex")
        one.duration_ms = 60000
        with self.assertRaises(HTTPException):
            await self.yandex.enqueue(ROOM, scope, "123", str(uuid.uuid4()), "Tester")
        self.assertEqual(len(list(self.store.files.iterdir())), 1)
        for url in (
            "file:///etc/passwd",
            "https://127.0.0.1:8080/file",
            "https://yandex.net.evil.test/track",
        ):
            with self.assertRaises(HTTPException):
                self.yandex.download_url(url)
