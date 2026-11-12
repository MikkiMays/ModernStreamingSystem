"""Уведомления владельцу в Telegram: итоги дня аналитики и сбой задачи пульта (`fleet/notify.py`)."""

import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

from fleet.notify import Daily, Telegram, digest_text
from fleet.settings import from_env

MSK = timezone(timedelta(hours=3))

PULSE = {
    "tiles": {
        "people": {"value": 244, "previous": 218, "change": 0.1193},
        "new_people": {"value": 89, "previous": 70, "change": 0.2714},
        "interlocutors": {"value": 185, "previous": 190, "change": -0.0263},
        "weekly_interlocutors": {"value": 142, "previous": 130, "change": 0.0923},
        "talk_hours": {"value": 188.24, "previous": 150.0, "change": 0.2549},
        "join_success": {"value": 0.9723, "previous": 0.96, "change": 0.0128},
        "error_free_sessions": {"value": 0.8065, "previous": None, "change": None},
    }
}
ERRORS = {"totals": {"events": 267, "groups": 20, "new_groups": 4, "people_affected": 109}}
TRAFFIC = {"totals": {"visits": 1582, "human_share": 0.5879, "bot": 239, "automation": 60}}


class Bot:
    """Telegram глазами пульта: запоминает отправленное, по желанию отказывает."""

    def __init__(self):
        self.sent = []
        self.status = 200

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.sent.append((request.url.path, json.loads(request.content)))
        return httpx.Response(self.status, json={"ok": self.status == 200})


def telegram(bot: Bot, token="1:secret", chat="42") -> Telegram:
    return Telegram(token, chat, client=httpx.AsyncClient(transport=httpx.MockTransport(bot.handler)))


class Text(unittest.TestCase):
    def test_the_digest_says_the_day_in_product_words(self):
        text = digest_text("2026-11-12", PULSE, ERRORS, TRAFFIC, "https://admin.example.test/analytics")
        self.assertEqual(
            text.split("\n"),
            [
                "Cord · итоги 12.11",
                "Люди: 244 (▲ 12 %), новых — 89",
                "Собеседники: 185 (▼ 3 %), за неделю — 142",
                "Разговоры: 188,2 ч (▲ 25 %)",
                "Вход: 97,2 % успешных, сессий без ошибок — 80,7 %",
                "Ошибки: 267 (20 видов, новых — 4), затронуто людей — 109",
                "Заходы: 1 582, из них люди — 58,8 %, роботы — 299",
                "Подробно: https://admin.example.test/analytics",
            ],
        )

    def test_an_empty_day_and_missing_sections_do_not_break_the_text(self):
        text = digest_text("2026-11-13", {"tiles": {}}, None, None, "")
        self.assertIn("Люди: —, новых — —", text)
        self.assertNotIn("Ошибки", text)
        self.assertNotIn("Подробно", text)


class Sending(unittest.IsolatedAsyncioTestCase):
    async def test_a_message_goes_to_the_owner_chat_and_failures_never_raise(self):
        bot = Bot()
        sender = telegram(bot)
        self.assertTrue(await sender.send("привет"))
        path, body = bot.sent[0]
        self.assertEqual(path, "/bot1:secret/sendMessage")
        self.assertEqual((body["chat_id"], body["text"]), (42, "привет"))
        bot.status = 502
        self.assertFalse(await sender.send("ещё"))
        # Без токена или чата уведомлений нет — и запросов нет.
        silent = telegram(bot, token="")
        self.assertFalse(silent.enabled)
        self.assertFalse(await silent.send("никому"))
        self.assertEqual(len(bot.sent), 2)
        await sender.close()
        await silent.close()

    async def test_the_digest_is_sent_once_a_day_after_the_hour_and_retried_when_analytics_is_down(self):
        bot = Bot()
        now = [datetime(2026, 11, 13, 8, 59, tzinfo=MSK)]
        asked = []
        down = [True]

        async def report(section, params):
            asked.append((section, params))
            if down[0]:
                raise RuntimeError("аналитика лежит")
            return {"data": {"pulse": PULSE, "errors": ERRORS, "traffic": TRAFFIC}[section]}

        with tempfile.TemporaryDirectory() as directory:
            daily = Daily(
                telegram(bot),
                report,
                hour=9,
                marker=Path(directory) / "digest.day",
                url="https://admin.example.test/analytics",
                now=lambda: now[0],
            )
            self.assertTrue(daily.enabled)
            # До назначенного часа — ничего.
            self.assertFalse(await daily.tick())
            self.assertEqual(asked, [])
            # Час наступил, но аналитика лежит: ничего не отправлено, отметки нет — попробуем позже.
            now[0] = datetime(2026, 11, 13, 9, 0, tzinfo=MSK)
            self.assertFalse(await daily.tick())
            self.assertEqual(bot.sent, [])
            down[0] = False
            self.assertTrue(await daily.tick())
            self.assertEqual(asked[-3][1], {"from": "2026-11-12", "to": "2026-11-12", "compare": "1"})
            self.assertIn("Cord · итоги 12.11", bot.sent[0][1]["text"])
            # В тот же день второй раз не шлётся — и после перезапуска тоже (отметка на диске).
            now[0] = datetime(2026, 11, 13, 18, 0, tzinfo=MSK)
            self.assertFalse(await daily.tick())
            again = Daily(telegram(bot), report, hour=9, marker=Path(directory) / "digest.day", now=lambda: now[0])
            self.assertFalse(await again.tick())
            # На следующий день — итоги следующего дня.
            now[0] = datetime(2026, 11, 14, 9, 5, tzinfo=MSK)
            self.assertTrue(await daily.tick())
            self.assertIn("итоги 13.11", bot.sent[1][1]["text"])
            self.assertEqual(len(bot.sent), 2)


class Settings(unittest.TestCase):
    def test_the_bot_and_the_hour_come_from_the_environment(self):
        settings = from_env({"ALERT_TELEGRAM_BOT_TOKEN": " 1:abc ", "ALERT_TELEGRAM_CHAT_ID": "42"})
        self.assertEqual((settings.notify_token, settings.notify_chat, settings.digest_hour, settings.digest_offset), ("1:abc", "42", 9, 3))
        self.assertEqual(from_env({"FLEET_DIGEST_HOUR": ""}).digest_hour, -1)
        self.assertEqual(from_env({"FLEET_DIGEST_HOUR": "7", "FLEET_DIGEST_OFFSET": "5"}).digest_hour, 7)
        self.assertEqual(from_env({}).notify_token, "")


if __name__ == "__main__":
    unittest.main()
