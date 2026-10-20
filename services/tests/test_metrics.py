import unittest
from types import SimpleNamespace

from cord_services.metrics import render


class Task:
    def __init__(self, done: bool):
        self._done = done

    def done(self) -> bool:
        return self._done


class Store:
    def __init__(self, status: str):
        self.status = status

    def state(self, key: str):
        return self.status if key == "bot_status" else None


class MetricsTests(unittest.TestCase):
    def test_counts_live_music_and_the_bot_without_any_labels(self):
        state = SimpleNamespace(
            music=SimpleNamespace(
                tasks={"room-a": Task(False), "room-b": Task(True), "room-c": Task(False)}
            ),
            store=Store("polling"),
        )
        text = render(state)
        self.assertIn("cord_services_up 1\n", text)
        self.assertIn("cord_music_sessions_active 2\n", text)
        self.assertIn("cord_telegram_connected 1\n", text)
        # Ни встречи, ни пользователя в метриках нет: только числа.
        self.assertNotIn("room-a", text)
        self.assertNotIn("{", text)

    def test_a_service_without_music_or_bot_still_answers(self):
        text = render(SimpleNamespace())
        self.assertIn("cord_music_sessions_active 0\n", text)
        self.assertIn("cord_telegram_connected 0\n", text)


if __name__ == "__main__":
    unittest.main()
