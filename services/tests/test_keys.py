"""Ключи по назначению из `INTERNAL_SECRET` (A14): одна формула у ядра, службы и плеера страниц."""

import asyncio
import base64
import hashlib
import hmac
import sqlite3
import tempfile
import unittest
from pathlib import Path

import httpx
from cryptography.fernet import Fernet

from cord_services import keys
from cord_services.accounts import Vault
from cord_services.cinema.sniffer import key_for
from cord_services.core import Core

SECRET = "a-test-internal-secret-of-32-chars"
# Общий образец с ядром (`server/src/test/java/dev/mikki/stream/InternalKeysTest.java`).
SERVICE = "0VpQEjXyrY1j1PlleKmCpXUw0obr6f_ZvOULDAArni4"


class Formula(unittest.TestCase):
    def test_rfc_5869_test_case_1(self):
        okm = keys.hkdf(bytes([0x0B]) * 22, bytes(range(0x0D)), bytes(range(0xF0, 0xFA)), 42)
        self.assertEqual(
            okm.hex(),
            "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
        )

    def test_the_service_key_is_the_one_the_core_expects(self):
        self.assertEqual(keys.text(SECRET, keys.SERVICE), SERVICE)

    def test_every_purpose_has_its_own_key_and_none_is_the_secret(self):
        found = {purpose: keys.derive(SECRET, purpose) for purpose in
                 (keys.SERVICE, keys.ACTOR, keys.CINEMA, keys.SNIFFER, keys.FERNET)}
        self.assertEqual(len(set(found.values())), 5)
        for key in found.values():
            self.assertEqual(len(key), 32)
            self.assertNotIn(SECRET.encode(), key)

    def test_no_secret_no_key(self):
        with self.assertRaises(ValueError):
            keys.derive("", keys.SERVICE)


class ServiceHeaders(unittest.TestCase):
    def test_the_core_hears_the_service_key_and_never_the_secret(self):
        seen = []

        def handler(request):
            seen.append(request.headers)
            return httpx.Response(200, json={})

        core = Core("http://core.test", SECRET)
        core.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        asyncio.run(core.request("GET", "/internal/services/x"))
        headers = seen[0]
        self.assertEqual(headers["X-Service-Secret"], SERVICE)
        # Шлюзовой заголовок служба больше не шлёт: ядро узнаёт её по ключу службы.
        self.assertNotIn("X-Internal-Secret", headers)
        self.assertFalse(any(SECRET in value for value in headers.values()))


class Sniffer(unittest.TestCase):
    # Тот же образец, что у контейнера (`services/sniffer/tests/test_capture.py`).
    SAMPLE = (
        "local-development-internal-secret-32bytes",
        "64c7335b9f98d139169be2c3a4bdc43aa6377edfe614b1a9913624ea41ef17e8",
    )

    def test_the_sniffer_key_is_the_one_the_container_computes(self):
        secret, key = self.SAMPLE
        self.assertEqual(key_for(secret), key)


class Actor(unittest.TestCase):
    def test_a_telegram_user_is_named_by_the_actor_key_not_the_secret(self):
        from cord_services.telegram import Telegram

        bot = Telegram.__new__(Telegram)
        bot.core = Core("http://core.test", SECRET)
        header = bot.actor_header(42)["X-Cord-Actor"]
        expected = hmac.new(keys.derive(SECRET, keys.ACTOR), b"telegram:42", hashlib.sha256).hexdigest()
        self.assertEqual(header, "tg:" + expected[:32])
        old = hmac.new(SECRET.encode(), b"telegram-actor:42", hashlib.sha256).hexdigest()
        self.assertNotEqual(header, "tg:" + old[:32])


class CinemaKey(unittest.TestCase):
    def test_cinema_signatures_use_their_own_key(self):
        from cord_services.app import create_app

        with tempfile.TemporaryDirectory() as root:
            app = create_app(Path(root), Core("http://core.test", SECRET), telegram_enabled=False)
            try:
                signer = app.state.cinema.signer
                self.assertEqual(signer._secret, keys.derive(SECRET, keys.CINEMA).hex().encode())
                self.assertNotEqual(signer._secret, SECRET.encode())
            finally:
                app.state.sources.close()
                app.state.store.db.close()


class VaultKeys(unittest.TestCase):
    def test_new_entries_use_the_vault_key_and_old_ones_still_open(self):
        vault = Vault(sqlite3.connect(":memory:"), SECRET)
        legacy = Fernet(base64.urlsafe_b64encode(hashlib.sha256(SECRET.encode()).digest()))
        # Сохранённое до A14 — прежним ключом — открывается.
        old = legacy.encrypt(b'{"token": "before"}').decode()
        self.assertEqual(vault.open(old), {"token": "before"})
        # Новое — ключом сейфа: прежний ключ его не открывает.
        sealed = vault.seal({"token": "after"})
        self.assertEqual(vault.open(sealed), {"token": "after"})
        with self.assertRaises(Exception):
            legacy.decrypt(sealed.encode())


if __name__ == "__main__":
    unittest.main()
