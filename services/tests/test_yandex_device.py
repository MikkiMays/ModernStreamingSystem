"""
Вход в Яндекс Музыку по QR-коду без встречи (R39, DECISIONS Р-15): из «Настроек → Аккаунты».

Вход по коду устройства был только у аккаунта комнаты: токен оставался на сервере в области встречи и
вне её не работал. Здесь тот же Device Flow, но токен отдаётся устройству один раз — оно хранит его там
же, где вставленный вручную, — а на сервере не остаётся ничего, кроме зашифрованного кода устройства на
время входа. Без заголовка входа: встречи нет; поэтому не больше пяти новых входов в минуту с адреса.
Яндекс подменён, сети нет.
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock

from yandex_music.exceptions import DeviceAuthError, YandexMusicError

from test_services import Fixture, ROOM, GUEST
from cord_services import yandex as yandex_module
from cord_services.store import now

DEVICE = "/api/v1/services/yandex/device"
TOKEN = "PRIVATE_OAUTH_TOKEN"


class DeviceTests(Fixture):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.yandex = self.app.state.yandex
        self.fake = SimpleNamespace(
            account_status=AsyncMock(
                return_value=SimpleNamespace(
                    account=SimpleNamespace(uid=100, display_name="Listener", login="listener")
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
        self.tokens = []

        def factory(*args, **kwargs):
            self.tokens.append(args[0] if args else None)
            return self.fake

        self.yandex.client_factory = factory

    async def start(self, address="203.0.113.5"):
        return await self.client.post(DEVICE, headers={"X-Forwarded-For": address})

    def due(self, identifier):
        """Срок следующего вопроса к Яндексу уже наступил."""
        value = self.store.claim(identifier)
        value["nextPoll"] = now() - 1
        self.store.delete_claim(identifier)
        self.store.put_claim(identifier, value)

    async def poll(self, identifier):
        return await self.client.post(f"{DEVICE}/{identifier}")

    def stored(self) -> str:
        """Всё, что служба держит на диске: ни токен, ни имя аккаунта туда попадать не должны."""
        rows = []
        for table in ("claims", "receipts", "state", "bindings", "integrations"):
            rows += [str(row) for row in self.store.db.execute(f"SELECT * FROM {table}")]
        return "\n".join(rows)

    async def test_the_code_comes_without_a_meeting_and_without_the_device_secret(self):
        response = await self.start()
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(
            sorted(body), ["expiresAt", "id", "interval", "status", "userCode", "verificationUrl"]
        )
        self.assertEqual(
            (body["status"], body["userCode"], body["verificationUrl"], body["interval"]),
            ("pending", "ABCD-EFGH", "https://ya.ru/device", 5),
        )
        self.assertNotIn("PRIVATE_DEVICE_CODE", response.text)
        self.assertNotIn("PRIVATE_DEVICE_CODE", self.stored())

    async def test_the_token_goes_to_the_device_once_and_nothing_stays_on_the_server(self):
        identifier = (await self.start()).json()["id"]
        early = await self.poll(identifier)
        self.assertEqual(early.json()["status"], "pending")
        self.assertEqual(self.fake.poll_device_token.await_count, 0, "до срока Яндекс не спрашивают")
        self.due(identifier)
        self.fake.poll_device_token.return_value = SimpleNamespace(access_token=TOKEN, expires_in=3600)
        done = await self.poll(identifier)
        self.assertEqual(done.status_code, 200, done.text)
        self.assertEqual(done.json(), {"status": "connected", "token": TOKEN, "name": "Listener"})
        self.assertIn(TOKEN, self.tokens, "имя аккаунта спрошено этим же токеном")
        self.assertNotIn(TOKEN, self.stored())
        self.assertNotIn("Listener", self.stored())
        self.assertFalse(self.yandex.status("room:" + ROOM)["connected"], "аккаунт комнаты не тронут")
        again = await self.poll(identifier)
        self.assertEqual(again.status_code, 410, "второй раз токен не выдаётся")

    async def test_without_the_account_name_the_token_still_comes(self):
        identifier = (await self.start()).json()["id"]
        self.due(identifier)
        self.fake.poll_device_token.return_value = SimpleNamespace(access_token=TOKEN, expires_in=3600)
        self.fake.account_status.side_effect = YandexMusicError("нет ответа")
        done = await self.poll(identifier)
        self.assertEqual(done.json(), {"status": "connected", "token": TOKEN, "name": None})

    async def test_slow_down_stretches_the_interval_and_a_refusal_ends_the_code(self):
        identifier = (await self.start()).json()["id"]
        self.due(identifier)
        self.fake.poll_device_token.side_effect = DeviceAuthError("slow_down")
        slowed = await self.poll(identifier)
        self.assertEqual((slowed.json()["status"], slowed.json()["interval"]), ("pending", 10))
        self.due(identifier)
        self.fake.poll_device_token.side_effect = DeviceAuthError("access_denied")
        refused = await self.poll(identifier)
        self.assertEqual(refused.status_code, 410)
        self.assertIsNone(self.store.claim(identifier))

    async def test_yandex_not_answering_is_a_retryable_refusal(self):
        identifier = (await self.start()).json()["id"]
        self.due(identifier)
        self.fake.poll_device_token.side_effect = YandexMusicError("нет ответа")
        failed = await self.poll(identifier)
        self.assertEqual(failed.status_code, 502)
        self.assertIsNotNone(self.store.claim(identifier), "код жив — можно спросить снова")

    async def test_cancel_forgets_the_code(self):
        identifier = (await self.start()).json()["id"]
        cancelled = await self.client.delete(f"{DEVICE}/{identifier}")
        self.assertEqual(cancelled.json(), {"cancelled": True})
        self.assertIsNone(self.store.claim(identifier))
        self.assertEqual((await self.client.delete(f"{DEVICE}/{'x' * 32}")).json(), {"cancelled": True})

    async def test_five_new_codes_a_minute_from_one_address(self):
        for _ in range(yandex_module.DEVICE_PER_MINUTE):
            self.assertEqual((await self.start()).status_code, 200)
        limited = await self.start()
        self.assertEqual(limited.status_code, 429)
        self.assertEqual(limited.json()["code"], "RATE_LIMITED")
        self.assertIn("retry-after", limited.headers)
        self.assertEqual((await self.start("198.51.100.7")).status_code, 200, "у другого адреса свой счёт")
        self.assertEqual(self.fake.request_device_code.await_count, yandex_module.DEVICE_PER_MINUTE + 1)

    async def test_the_address_is_the_one_the_gateway_saw(self):
        # Шлюз дописывает адрес собеседника последним: подставленные браузером слева счёт не обходят.
        for number in range(yandex_module.DEVICE_PER_MINUTE):
            await self.start(f"10.0.0.{number}, 203.0.113.9")
        self.assertEqual((await self.start("10.0.0.99, 203.0.113.9")).status_code, 429)

    async def test_room_codes_and_device_codes_do_not_open_each_other(self):
        self.integrations_allowed = True
        room = await self.client.post(
            f"/api/v1/services/rooms/{ROOM}/yandex/auth", headers=self.headers(GUEST)
        )
        self.assertEqual((await self.poll(room.json()["id"])).status_code, 410)
        own = (await self.start()).json()["id"]
        crossed = await self.client.post(
            f"/api/v1/services/rooms/{ROOM}/yandex/auth/{own}", headers=self.headers(GUEST)
        )
        self.assertEqual(crossed.status_code, 410)

    async def test_an_unknown_sign_in_address_is_refused(self):
        self.fake.request_device_code.return_value.verification_url = "https://evil.test/device"
        response = await self.start()
        self.assertEqual(response.status_code, 502)
