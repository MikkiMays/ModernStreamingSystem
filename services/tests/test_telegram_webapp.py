"""Mini App Telegram (E09): проверка `initData`, кнопка в беседе и вход во встречу."""

import hashlib
import hmac
import json
import time
import unittest
from urllib.parse import quote, urlencode

from test_services import GUEST, HOST, ROOM, Fixture

from cord_services.webapp import (
    InitDataError,
    Memberships,
    display_name,
    enabled,
    max_age,
    startapp_url,
    startgroup_url,
    verify_init_data,
)

# Эталон из https://docs.telegram-mini-apps.com/platform/init-data — токен и строка опубликованы там
# ради проверки чужих реализаций; это не настоящий бот.
VECTOR_TOKEN = "5768337691:AAH5YkoiEuPk8-FZa32hStHTqXiLPtAEhx8"
VECTOR = (
    "query_id=AAHdF6IQAAAAAN0XohDhrOrc&user=%7B%22id%22%3A279058397%2C%22first_name%22%3A%22Vladislav"
    "%22%2C%22last_name%22%3A%22Kibenko%22%2C%22username%22%3A%22vdkfrost%22%2C%22language_code%22%3A"
    "%22ru%22%2C%22is_premium%22%3Atrue%7D&auth_date=1662771648"
    "&hash=c501b71e775f74ce10e377dea85a7ea24ecd640b223ea86dfe453e0eaed2e2b2"
)
VECTOR_AUTH = 1662771648
BOT_TOKEN = "TEST_TOKEN_DO_NOT_USE"


def sign(fields: dict, token: str = BOT_TOKEN) -> str:
    """Строка `initData`, подписанная так, как это делает Telegram (по документации, отдельно от службы)."""
    check = "\n".join(f"{k}={v}" for k, v in sorted(fields.items()))
    secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    digest = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    return urlencode({**fields, "hash": digest}, quote_via=quote)


def init_data(start: str, user_id: int = 5, *, age: int = 10, **user) -> str:
    person = {"id": user_id, "first_name": "Иван", "last_name": "Петров", **user}
    return sign(
        {
            "auth_date": str(int(time.time()) - age),
            "chat_instance": "-42",
            "chat_type": "supergroup",
            "start_param": start,
            "user": json.dumps(person, ensure_ascii=False, separators=(",", ":")),
        }
    )


class InitDataTests(unittest.TestCase):
    def test_the_published_vector_passes_within_an_hour(self):
        data = verify_init_data(VECTOR, VECTOR_TOKEN, VECTOR_AUTH + 10)
        self.assertEqual(data["user"]["id"], 279058397)
        self.assertEqual(data["user"]["first_name"], "Vladislav")
        self.assertNotIn("hash", data)

    def test_older_than_an_hour_or_from_the_future_is_stale(self):
        for now in (VECTOR_AUTH + 3601, VECTOR_AUTH + 4000, VECTOR_AUTH - 120):
            with self.assertRaises(InitDataError) as caught:
                verify_init_data(VECTOR, VECTOR_TOKEN, now)
            self.assertEqual(caught.exception.reason, "stale")
        verify_init_data(VECTOR, VECTOR_TOKEN, VECTOR_AUTH + 3600)
        verify_init_data(VECTOR, VECTOR_TOKEN, VECTOR_AUTH - 59)

    def test_any_changed_field_or_another_token_breaks_the_signature(self):
        for forged in (
            VECTOR.replace("auth_date=1662771648", "auth_date=1662771649"),
            VECTOR.replace("Vladislav", "Vladislaw"),
            VECTOR.replace("hash=c501", "hash=d501"),
            VECTOR + "&start_param=bAAAA",
        ):
            with self.assertRaises(InitDataError) as caught:
                verify_init_data(forged, VECTOR_TOKEN, VECTOR_AUTH + 10)
            self.assertEqual(caught.exception.reason, "signature")
        with self.assertRaises(InitDataError):
            verify_init_data(VECTOR, "1:other", VECTOR_AUTH + 10)

    def test_duplicate_keys_and_garbage_are_malformed(self):
        for raw in (
            VECTOR + "&auth_date=1662771648",
            "not a query",
            "auth_date=1&user=x",
            "",
        ):
            with self.assertRaises(InitDataError) as caught:
                verify_init_data(raw, VECTOR_TOKEN, VECTOR_AUTH + 10)
            self.assertEqual(caught.exception.reason, "malformed")

    def test_signature_stays_in_the_checked_string(self):
        """Ed25519-подпись `signature` исключается только из своей проверки, не из HMAC."""
        fields = {"auth_date": str(int(time.time())), "signature": "abc-_", "user": '{"id":1}'}
        raw = sign(fields)
        self.assertEqual(verify_init_data(raw, BOT_TOKEN, time.time())["signature"], "abc-_")
        without = raw.replace("signature=abc-_&", "")
        with self.assertRaises(InitDataError):
            verify_init_data(without, BOT_TOKEN, time.time())

    def test_unicode_plus_and_slash_in_the_name_survive_decoding(self):
        raw = init_data("bX", first_name="Анна+Мария / Ё", last_name="")
        data = verify_init_data(raw, BOT_TOKEN, time.time())
        self.assertEqual(data["user"]["first_name"], "Анна+Мария / Ё")
        self.assertEqual(display_name(data["user"]), "Анна+Мария / Ё")

    def test_settings(self):
        self.assertFalse(enabled(None))
        self.assertFalse(enabled("false"))
        self.assertTrue(enabled("true"))
        self.assertTrue(enabled(" 1 "))
        self.assertEqual(max_age(None), 3600)
        self.assertEqual(max_age("86400"), 3600)
        self.assertEqual(max_age("600"), 600)
        self.assertEqual(max_age("x"), 3600)
        self.assertEqual(display_name({"first_name": "A" * 50}), "A" * 40)
        self.assertEqual(display_name({}), "Участник Telegram")

    def test_links(self):
        self.assertEqual(
            startapp_url("cord_meet_bot", "bAbc_-"),
            "https://t.me/cord_meet_bot?startapp=bAbc_-&mode=fullscreen",
        )
        self.assertEqual(
            startapp_url("cord_meet_bot", "bAbc", "meet"),
            "https://t.me/cord_meet_bot/meet?startapp=bAbc&mode=fullscreen",
        )
        self.assertEqual(
            startgroup_url("cord_meet_bot", "tok_-"),
            "https://t.me/cord_meet_bot?startgroup=tok_-&admin=pin_messages+manage_chat",
        )


class MembershipTests(unittest.IsolatedAsyncioTestCase):
    async def test_members_admins_and_restricted_members_pass_and_answers_are_cached(self):
        answers = {
            1: {"status": "member"},
            2: {"status": "administrator"},
            3: {"status": "restricted", "is_member": True},
            4: {"status": "restricted", "is_member": False},
            5: {"status": "left"},
            6: {"status": "kicked"},
        }
        asked = []

        async def api(method, data):
            asked.append(data["user_id"])
            return answers[data["user_id"]]

        clock = [0.0]
        cache = Memberships(clock=lambda: clock[0])
        verdicts = [await cache.check(api, -100, user) for user in range(1, 7)]
        self.assertEqual(verdicts, [True, True, True, False, False, False])
        await cache.check(api, -100, 1)
        self.assertEqual(asked.count(1), 1)
        clock[0] = 301
        await cache.check(api, -100, 1)
        self.assertEqual(asked.count(1), 2)
        # Личный чат: беседа — сам человек, Telegram не спрашивается.
        self.assertTrue(await cache.check(api, 77, 77))
        self.assertFalse(await cache.check(api, 77, 78))
        self.assertNotIn(77, asked)


class WebAppTests(Fixture):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.bot.webapp = True
        self.bot.username = "cord_meet_bot"
        self.app.state.webapp = True
        self.app.state.telegram = self.bot
        self.member_status = "member"
        self.pins = []
        self.edits = []

    async def telegram_api(self, method, data=None):
        if method == "getChatMember" and data["user_id"] != 1:
            return {"status": self.member_status}
        if method in ("pinChatMessage", "unpinChatMessage"):
            self.pins.append((method, data))
            return True
        if method == "editMessageText":
            self.edits.append(data)
            return True
        if method == "sendMessage":
            self.sent.append(data)
            return {"message_id": 500 + len(self.sent)}
        return await super().telegram_api(method, data)

    def claim(self, token="c" * 24):
        self.store.put_claim(
            token,
            {"kind": "bind", "roomId": ROOM, "profile": "p" * 43, "title": "Test", "ownerName": "Host"},
        )
        return token

    async def bound_link(self):
        await self.bot.handle(self.message("/bind " + self.claim()))
        link = self.store.active_telegram_link("-123:7")
        self.assertIsNotNone(link)
        return link

    async def enter(self, raw):
        return await self.client.post(
            "/api/v1/services/telegram/webapp/enter", json={"initData": raw}
        )

    async def test_bind_pins_a_fullscreen_mini_app_button(self):
        link = await self.bound_link()
        button = self.sent[-1]["reply_markup"]["inline_keyboard"][0][0]
        self.assertEqual(
            button["url"],
            f"https://t.me/cord_meet_bot?startapp={link['id']}&mode=fullscreen",
        )
        self.assertRegex(link["id"], r"^b[A-Za-z0-9_-]{22}$")
        self.assertNotIn("123456789", button["url"])
        self.assertEqual(
            self.pins,
            [("pinChatMessage", {"chat_id": -123, "message_id": 501, "disable_notification": True})],
        )
        self.assertTrue(link["pinned"])
        self.assertEqual(link["messageId"], 501)
        self.assertEqual(link["chatTitle"], "Group")

    async def test_add_to_group_link_binds_through_start(self):
        """`startgroup=<код>` присылает в группу `/start@бот <код>` — это привязка."""
        await self.bot.handle(self.message("/start@cord_meet_bot " + self.claim()))
        self.assertEqual(self.store.binding("-123:7")["roomId"], ROOM)
        self.assertIsNotNone(self.store.active_telegram_link("-123:7"))
        # В личке `/start <что-то>` — по-прежнему справка, а не привязка.
        await self.bot.handle(self.message("/start " + self.claim("d" * 24), 2, private=True))
        self.assertIsNone(self.store.binding("1:7"))

    async def test_flag_off_keeps_the_old_bind_reply(self):
        self.bot.webapp = False
        await self.bot.handle(self.message("/bind " + self.claim()))
        self.assertNotIn("reply_markup", self.sent[-1])
        self.assertIsNone(self.store.active_telegram_link("-123:7"))
        self.assertEqual(self.pins, [])

    async def test_meet_offers_the_mini_app_first(self):
        self.bind()
        await self.bot.handle(self.message("/meet"))
        rows = self.sent[-1]["reply_markup"]["inline_keyboard"]
        self.assertIn("startapp=b", rows[0][0]["url"])
        self.assertIn("?invite=", rows[1][0]["url"])

    async def test_a_member_enters_with_the_telegram_name(self):
        link = await self.bound_link()
        response = await self.enter(init_data(link["id"]))
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(
            response.json(),
            {
                "roomId": ROOM,
                "title": "Test",
                "name": "Иван Петров",
                "inviteUrl": "https://cord.test/room/" + ROOM + "?invite=test",
            },
        )

    async def test_refusals_carry_stable_codes(self):
        link = await self.bound_link()
        cases = [
            (init_data(link["id"], age=4000), 401, "TELEGRAM_INIT_DATA"),
            (init_data(link["id"]).replace("auth_date=", "auth_date=1"), 401, "TELEGRAM_INIT_DATA"),
            (init_data("bUnknownLinkNumber00000"), 404, "TELEGRAM_LINK_UNKNOWN"),
            (init_data(""), 404, "TELEGRAM_LINK_UNKNOWN"),
        ]
        for raw, status, code in cases:
            response = await self.enter(raw)
            self.assertEqual((response.status_code, response.json()["code"]), (status, code))
        self.member_status = "left"
        response = await self.enter(init_data(link["id"], user_id=6))
        self.assertEqual((response.status_code, response.json()["code"]), (403, "TELEGRAM_NOT_MEMBER"))
        self.assertEqual(response.json()["detail"], "Вы не состоите в чате, к которому привязана встреча")

    async def test_unbind_revokes_the_button_and_unpins(self):
        link = await self.bound_link()
        await self.bot.handle(self.message("/unbind", 2))
        self.assertIsNone(self.store.binding("-123:7"))
        self.assertIn(("unpinChatMessage", {"chat_id": -123, "message_id": 501}), self.pins)
        self.assertEqual(self.edits[-1]["message_id"], 501)
        response = await self.enter(init_data(link["id"]))
        self.assertEqual((response.status_code, response.json()["code"]), (410, "TELEGRAM_LINK_REVOKED"))

    async def test_rebinding_replaces_the_old_button(self):
        first = await self.bound_link()
        await self.bot.handle(self.message("/bind " + self.claim("e" * 24), 2))
        second = self.store.active_telegram_link("-123:7")
        self.assertNotEqual(first["id"], second["id"])
        self.assertIsNotNone(self.store.telegram_link(first["id"])["revokedAt"])
        self.assertEqual(self.store.binding("-123:7")["roomId"], ROOM)
        response = await self.enter(init_data(first["id"]))
        self.assertEqual(response.json()["code"], "TELEGRAM_LINK_REVOKED")

    async def test_bot_removed_from_the_chat_revokes_its_links(self):
        link = await self.bound_link()
        await self.bot.handle(
            {
                "update_id": 9,
                "my_chat_member": {
                    "chat": {"id": -123, "type": "supergroup"},
                    "new_chat_member": {"status": "kicked", "user": {"id": 99}},
                },
            }
        )
        self.assertIsNotNone(self.store.telegram_link(link["id"])["revokedAt"])
        self.assertIsNone(self.store.binding("-123:7"))

    async def test_a_deleted_meeting_answers_gone(self):
        link = await self.bound_link()
        original = self.respond

        def respond(request):
            if request.url.path == "/internal/services/" + ROOM:
                import httpx

                return httpx.Response(404, json={"detail": "Комната не найдена"})
            return original(request)

        self.core.client._transport.handler = respond
        response = await self.enter(init_data(link["id"]))
        self.assertEqual((response.status_code, response.json()["code"]), (410, "TELEGRAM_MEETING_GONE"))
        self.assertIsNone(self.store.binding("-123:7"))

    async def test_flag_off_answers_off(self):
        self.app.state.webapp = False
        response = await self.enter(init_data("bX"))
        self.assertEqual((response.status_code, response.json()["code"]), (404, "TELEGRAM_WEBAPP_OFF"))

    async def test_catalog_shows_the_mini_app_only_with_the_flag_and_a_live_bot(self):
        self.bot.ready = True
        self.store.set_state("bot_status", "polling")
        self.assertTrue((await self.client.get("/api/v1/services/catalog")).json()["telegram"]["webapp"])
        self.app.state.webapp = False
        self.assertFalse((await self.client.get("/api/v1/services/catalog")).json()["telegram"]["webapp"])
        self.app.state.webapp = True
        self.store.set_state("bot_status", "retrying")
        self.assertFalse((await self.client.get("/api/v1/services/catalog")).json()["telegram"]["webapp"])

    async def test_the_creator_sees_and_unlinks_chats_and_nobody_else_does(self):
        self.store.set_state("bot_username", "cord_meet_bot")
        created = await self.client.post(
            f"/api/v1/services/rooms/{ROOM}/telegram/link", headers=self.headers()
        )
        self.assertEqual(created.status_code, 200, created.text)
        token = created.json()["command"].split(" ")[1]
        self.assertEqual(
            created.json()["startgroupUrl"],
            f"https://t.me/cord_meet_bot?startgroup={token}&admin=pin_messages+manage_chat",
        )
        await self.bot.handle(self.message("/start@cord_meet_bot " + token))
        listed = await self.client.get(f"/api/v1/services/rooms/{ROOM}/telegram", headers=self.headers())
        self.assertEqual(listed.status_code, 200)
        [entry] = listed.json()["links"]
        self.assertEqual((entry["chatTitle"], entry["pinned"]), ("Group", True))
        guest = await self.client.get(
            f"/api/v1/services/rooms/{ROOM}/telegram", headers=self.headers(GUEST)
        )
        self.assertEqual(guest.status_code, 403)
        refused = await self.client.delete(
            f"/api/v1/services/rooms/{ROOM}/telegram/links/{entry['id']}", headers=self.headers(GUEST)
        )
        self.assertEqual(refused.status_code, 403)
        removed = await self.client.delete(
            f"/api/v1/services/rooms/{ROOM}/telegram/links/{entry['id']}", headers=self.headers(HOST)
        )
        self.assertEqual(removed.json(), {"links": []})
        self.assertIsNone(self.store.binding("-123:7"))
        self.assertIn(("unpinChatMessage", {"chat_id": -123, "message_id": 501}), self.pins)


if __name__ == "__main__":
    unittest.main()
