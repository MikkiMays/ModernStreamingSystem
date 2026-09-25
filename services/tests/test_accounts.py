"""
Сейф сохранённых входов (`cord_services.accounts.Vault`), вынесенный из `yandex.py` задачей 13a.

Яндекс Музыка по-прежнему проверяется в `test_yandex.py` — тем же способом, что до выноса,
поэтому здесь не задача повторить те проверки. Здесь — сам сейф как таковой: то, чем будет
пользоваться следующий вход, у которого пока нет ни своего провайдера, ни своих тестов.
"""

import sqlite3
import unittest

from cord_services.accounts import Vault


class VaultTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.vault = Vault(self.db, "test-secret-not-used-in-prod")

    def test_seal_and_open_round_trip_and_the_stored_body_hides_the_secret(self):
        sealed = self.vault.seal({"token": "PRIVATE_VALUE", "name": "Кто-то"})
        self.assertNotIn("PRIVATE_VALUE", sealed)
        self.assertEqual(self.vault.open(sealed), {"token": "PRIVATE_VALUE", "name": "Кто-то"})

    def test_open_refuses_a_body_sealed_with_a_different_secret(self):
        foreign = Vault(sqlite3.connect(":memory:"), "another-secret")
        sealed = foreign.seal({"token": "X"})
        self.assertIsNone(self.vault.open(sealed))

    def test_open_refuses_garbage_instead_of_raising(self):
        self.assertIsNone(self.vault.open("not-a-fernet-token"))

    def test_put_get_delete_are_scoped_to_provider_and_scope(self):
        self.assertIsNone(self.vault.get("kinopoisk", "room:1"))
        self.vault.put("kinopoisk", "room:1", {"token": "A"})
        self.vault.put("yandex", "room:1", {"token": "B"})
        self.vault.put("kinopoisk", "room:2", {"token": "C"})
        self.assertEqual(self.vault.get("kinopoisk", "room:1"), {"token": "A"})
        self.assertEqual(self.vault.get("yandex", "room:1"), {"token": "B"})
        self.assertEqual(self.vault.get("kinopoisk", "room:2"), {"token": "C"})
        self.vault.delete("kinopoisk", "room:1")
        self.assertIsNone(self.vault.get("kinopoisk", "room:1"))
        # Соседние записи не задело — «удалить» относится к одной паре (provider, scope).
        self.assertEqual(self.vault.get("yandex", "room:1"), {"token": "B"})
        self.assertEqual(self.vault.get("kinopoisk", "room:2"), {"token": "C"})

    def test_put_replaces_the_previous_value_for_the_same_provider_and_scope(self):
        self.vault.put("kinopoisk", "room:1", {"token": "OLD"})
        self.vault.put("kinopoisk", "room:1", {"token": "NEW"})
        self.assertEqual(self.vault.get("kinopoisk", "room:1"), {"token": "NEW"})
        rows = self.db.execute(
            "SELECT COUNT(*) FROM integrations WHERE provider=? AND scope=?", ("kinopoisk", "room:1")
        ).fetchone()
        self.assertEqual(rows[0], 1)

    def test_ttl_ms_stamps_an_expires_at_into_the_stored_value(self):
        before = self.vault.put("kinopoisk", "room:1", {"token": "A"}, ttl_ms=60000)
        self.assertIsNone(before)
        stored = self.vault.get("kinopoisk", "room:1")
        self.assertIn("expiresAt", stored)
        self.assertGreater(stored["expiresAt"], 0)

    def test_delete_of_an_absent_scope_does_not_raise(self):
        self.vault.delete("kinopoisk", "room:absent")


if __name__ == "__main__":
    unittest.main()
