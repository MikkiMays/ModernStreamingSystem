import asyncio
import unittest

from fastapi import HTTPException

from cord_services.support import SupportRelay


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


if __name__ == "__main__":
    unittest.main()
