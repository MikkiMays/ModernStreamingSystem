import asyncio
import tempfile
import unittest
import uuid
from pathlib import Path

from fastapi import HTTPException

from cord_services.store import Store
from cord_services.support import SupportRelay, keyboard


class FakeCore:
    def __init__(self, outbox):
        self.outbox = list(outbox)
        self.calls = []

    async def request(self, method, path, data=None, credential=None, headers=None):
        self.calls.append((method, path))
        if path == "/internal/support/outbox":
            return list(self.outbox)
        if path.endswith("/sent"):
            ticket = path.split("/")[-2]
            self.outbox = [t for t in self.outbox if t["id"] != ticket]
            return None
        raise AssertionError(path)


def ticket(number):
    return {"id": f"{number}-id", "chat": "-100123", "text": f"Обращение {number}"}


class SupportRelayTest(unittest.TestCase):
    def test_each_ticket_reaches_the_owner_once(self):
        core = FakeCore([ticket(1), ticket(2)])
        sent = []

        async def send(method, data):
            sent.append((method, data))

        relay = SupportRelay(send, core)
        self.assertEqual(asyncio.run(relay.deliver()), 2)
        self.assertEqual(asyncio.run(relay.deliver()), 0)
        self.assertEqual([m for m, _ in sent], ["sendMessage", "sendMessage"])
        self.assertEqual(sent[0][1]["chat_id"], "-100123")
        self.assertEqual(sent[0][1]["text"], "Обращение 1")
        # Без разметки: написанное человеком не становится ссылкой или жирным.
        self.assertNotIn("parse_mode", sent[0][1])
        self.assertIn(("POST", "/internal/support/1-id/sent"), core.calls)

    def test_a_refused_message_stays_in_the_queue(self):
        core = FakeCore([ticket(1), ticket(2)])

        async def send(method, data):
            if data["text"].endswith("2"):
                raise HTTPException(503, "Telegram отклонил запрос")

        relay = SupportRelay(send, core)
        with self.assertRaises(HTTPException):
            asyncio.run(relay.deliver())
        # Первое донесено и отмечено, второе осталось ждать следующего круга.
        self.assertEqual([t["id"] for t in core.outbox], ["2-id"])


class Buttons(unittest.TestCase):
    def test_every_ticket_comes_with_status_buttons(self):
        core = FakeCore([ticket(1)])
        sent = []

        async def send(method, data):
            sent.append(data)

        asyncio.run(SupportRelay(send, core).deliver())
        buttons = sent[0]["reply_markup"]["inline_keyboard"][0]
        self.assertEqual([b["text"] for b in buttons], ["В работу", "Решено"])
        self.assertEqual([b["callback_data"] for b in buttons], ["support:1-id:open", "support:1-id:done"])

    def test_callback_data_fits_telegram_for_a_real_ticket(self):
        ticket_id = str(uuid.uuid4())
        for row in keyboard(ticket_id, "new")["inline_keyboard"]:
            for button in row:
                self.assertLessEqual(len(button["callback_data"].encode()), 64)
        # Выбранный статус отмечен, другой остаётся кнопкой.
        done = keyboard(ticket_id, "done")["inline_keyboard"][0]
        self.assertEqual([b["text"] for b in done], ["В работу", "✓ Решено"])


class StatusCore:
    """Ядро теста для кнопок: меняет статус, только если чат — чат поддержки."""

    def __init__(self):
        self.calls = []

    async def request(self, method, path, data=None, credential=None, headers=None):
        self.calls.append((method, path, data))
        if data["chat"] != "-100123":
            raise HTTPException(403, "Доступ недоступен или отозван")
        ticket = path.split("/")[-2]
        return {"id": ticket, "number": ticket[:8].upper(), "status": data["status"]}


class Callbacks(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from cord_services.telegram import Telegram

        self.tmp = tempfile.TemporaryDirectory()
        self.bot = Telegram.__new__(Telegram)
        self.bot.store = Store(Path(self.tmp.name))
        self.bot.core = StatusCore()
        self.api = []

        async def api(method, data=None):
            self.api.append((method, data))
            return True

        self.bot.api = api
        self.ticket = str(uuid.uuid4())

    async def asyncTearDown(self):
        self.bot.store.db.close()
        self.tmp.cleanup()

    def press(self, update_id, action, chat=-100123):
        return {
            "update_id": update_id,
            "callback_query": {
                "id": f"q{update_id}",
                "from": {"id": 7, "first_name": "Владелец"},
                "data": f"support:{self.ticket}:{action}",
                "message": {"message_id": 55, "chat": {"id": chat, "type": "private"}},
            },
        }

    async def test_the_owner_moves_a_ticket_from_telegram(self):
        await self.bot.handle(self.press(1, "open"))
        self.assertEqual(
            self.bot.core.calls,
            [("PUT", f"/internal/support/{self.ticket}/status", {"status": "OPEN", "chat": "-100123"})],
        )
        methods = [m for m, _ in self.api]
        self.assertEqual(methods, ["editMessageReplyMarkup", "answerCallbackQuery"])
        edited = self.api[0][1]
        self.assertEqual((edited["chat_id"], edited["message_id"]), (-100123, 55))
        self.assertEqual(edited["reply_markup"], keyboard(self.ticket, "open"))
        self.assertIn(self.ticket[:8].upper(), self.api[1][1]["text"])
        self.assertIn("в работе", self.api[1][1]["text"])
        # Повтор того же апдейта (бот перезапустился до отметки) ничего не делает второй раз.
        await self.bot.handle(self.press(1, "open"))
        self.assertEqual(len(self.bot.core.calls), 1)

    async def test_a_button_pressed_elsewhere_changes_nothing(self):
        await self.bot.handle(self.press(2, "done", chat=-100999))
        self.assertEqual([m for m, _ in self.api], ["answerCallbackQuery"])
        self.assertIn("чате поддержки", self.api[0][1]["text"])

    async def test_foreign_callback_data_is_only_acknowledged(self):
        update = self.press(3, "open")
        update["callback_query"]["data"] = "support:../../admin:open"
        await self.bot.handle(update)
        self.assertEqual(self.bot.core.calls, [])
        self.assertEqual([m for m, _ in self.api], ["answerCallbackQuery"])


if __name__ == "__main__":
    unittest.main()
