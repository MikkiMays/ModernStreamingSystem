import time
import unittest

from fleet.auth import Auth, hash_password, new_totp_secret, totp, verify_password, verify_totp
from fleet.errors import Problem
from fleet.settings import LOCK_AFTER_FAILURES, LOGIN_PER_MINUTE, Settings
from fleet.store import Store

# Вектор RFC 6238 (приложение B): секрет «12345678901234567890», SHA-1.
RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"


def settings(**overrides):
    base = dict(password_hash=hash_password("пароль-пульта"), totp_secret=RFC_SECRET, insecure_dev=True)
    base.update(overrides)
    return Settings(**base)


class PasswordTest(unittest.TestCase):
    def test_hash_round_trip(self):
        stored = hash_password("secret")
        self.assertTrue(stored.startswith("scrypt$32768,8,1$"))
        self.assertTrue(verify_password("secret", stored))
        self.assertFalse(verify_password("Secret", stored))
        self.assertFalse(verify_password("secret", "nonsense"))
        self.assertFalse(verify_password("secret", ""))

    def test_salts_differ(self):
        self.assertNotEqual(hash_password("a"), hash_password("a"))


class TotpTest(unittest.TestCase):
    def test_rfc_vectors(self):
        self.assertEqual(totp(RFC_SECRET, 59), "287082")
        self.assertEqual(totp(RFC_SECRET, 1111111109), "081804")
        self.assertEqual(totp(RFC_SECRET, 1234567890), "005924")

    def test_window_is_one_step_each_way(self):
        at = 1111111109
        self.assertTrue(verify_totp(RFC_SECRET, "081804", at))
        self.assertTrue(verify_totp(RFC_SECRET, "081804", at + 30))
        self.assertTrue(verify_totp(RFC_SECRET, "081804", at - 30))
        self.assertFalse(verify_totp(RFC_SECRET, "081804", at + 61))
        self.assertFalse(verify_totp(RFC_SECRET, "08180", at))
        self.assertFalse(verify_totp(RFC_SECRET, "abcdef", at))
        self.assertTrue(verify_totp(RFC_SECRET, " 081 804 ", at))

    def test_new_secret_is_base32(self):
        secret = new_totp_secret()
        self.assertEqual(len(secret), 32)
        self.assertRegex(secret, r"^[A-Z2-7]+$")


class LoginTest(unittest.TestCase):
    def setUp(self):
        self.store = Store(":memory:")
        self.auth = Auth(settings(), self.store)
        self.code = totp(RFC_SECRET)

    def test_login_issues_session_and_audits(self):
        token, session = self.auth.login("пароль-пульта", self.code, "203.0.113.5", "Mozilla")
        self.assertEqual(session.actor, "owner")
        found = self.auth.session(token)
        self.assertIsNotNone(found)
        self.assertEqual(found.id, session.id)
        rows = self.store.audit_query()
        self.assertEqual([r["action"] for r in rows], ["auth.login"])
        self.assertEqual(rows[0]["outcome"], "ok")
        self.assertEqual(rows[0]["ip"], "203.0.113.5")

    def test_wrong_password_or_code_is_one_error(self):
        for password, code in (("чужой", self.code), ("пароль-пульта", "000000"), ("", "")):
            with self.assertRaises(Problem) as caught:
                self.auth.login(password, code, "203.0.113.5", None)
            self.assertEqual(caught.exception.code, "AUTH_INVALID")
            self.assertEqual(caught.exception.detail, "Неверный пароль или код")
        self.assertEqual([r["outcome"] for r in self.store.audit_query()], ["refused"] * 3)

    def test_rate_limit_per_minute(self):
        for _ in range(LOGIN_PER_MINUTE):
            with self.assertRaises(Problem):
                self.auth.login("чужой", "000000", "198.51.100.1", None)
        with self.assertRaises(Problem) as caught:
            self.auth.login("пароль-пульта", self.code, "198.51.100.1", None)
        self.assertEqual(caught.exception.code, "AUTH_LOCKED")
        self.assertIn("retryAfter", caught.exception.extra)
        # Другой адрес не задет.
        self.auth.login("пароль-пульта", self.code, "198.51.100.2", None)

    def test_lock_after_failures(self):
        ip = "198.51.100.9"
        # Записываем неудачи напрямую, чтобы не упираться в лимит в минуту.
        for _ in range(LOCK_AFTER_FAILURES):
            self.store.login_attempt(ip, False)
        self.store.db.execute("UPDATE login_attempts SET at = at - 120")
        with self.assertRaises(Problem) as caught:
            self.auth.login("пароль-пульта", self.code, ip, None)
        self.assertEqual(caught.exception.code, "AUTH_LOCKED")
        self.assertTrue(any(r["action"] == "auth.locked" for r in self.store.audit_query()))

    def test_logout_and_expiry(self):
        token, session = self.auth.login("пароль-пульта", self.code, "203.0.113.5", None)
        self.auth.logout(session)
        self.assertIsNone(self.auth.session(token))
        token, session = self.auth.login("пароль-пульта", self.code, "203.0.113.5", None)
        self.store.db.execute("UPDATE sessions SET last_seen_at = ?", (int(time.time()) - 3601,))
        self.assertIsNone(self.auth.session(token))

    def test_disabled_without_secrets(self):
        auth = Auth(Settings(), self.store)
        with self.assertRaises(Problem) as caught:
            auth.login("x", "y", "203.0.113.5", None)
        self.assertEqual(caught.exception.status, 404)

    def test_agent_key_only_without_real_ip(self):
        auth = Auth(settings(agent_key="agent-key"), self.store)
        self.assertTrue(auth.agent("agent-key", None))
        self.assertFalse(auth.agent("agent-key", "203.0.113.5"))
        self.assertFalse(auth.agent("other", None))
        self.assertFalse(Auth(settings(), self.store).agent("agent-key", None))

    def test_origin_check(self):
        auth = Auth(settings(admin_host="admin.callcord.ru"), self.store)
        auth.check_origin("https://admin.callcord.ru", "admin.callcord.ru")
        for origin in (None, "https://cordcam.ru", "https://admin.callcord.ru.evil.com", "null"):
            with self.assertRaises(Problem):
                auth.check_origin(origin, "admin.callcord.ru")
        # Без имени пульта Origin сверяется с Host.
        dev = Auth(settings(), self.store)
        dev.check_origin("http://127.0.0.1:5173", "127.0.0.1:5173")
        with self.assertRaises(Problem):
            dev.check_origin("http://evil.test", "127.0.0.1:5173")


class SettingsTest(unittest.TestCase):
    def test_allow_ips(self):
        from fleet.settings import from_env

        s = from_env({"FLEET_ALLOW_IPS": "203.0.113.0/24, 2001:db8::/32"})
        self.assertTrue(s.allows("203.0.113.77"))
        self.assertTrue(s.allows("2001:db8::1"))
        self.assertFalse(s.allows("198.51.100.1"))
        self.assertFalse(s.allows("мусор"))
        self.assertTrue(from_env({}).allows("198.51.100.1"))

    def test_executor_and_credentials(self):
        from fleet.settings import from_env

        s = from_env({"FLEET_EXECUTOR": "ssh", "FLEET_SSH_MACHINES": "meet, b", "FLEET_CORE_A": "password:x", "FLEET_CORE_MEET": "key:y"})
        self.assertTrue(s.ssh_allowed("meet"))
        self.assertFalse(s.ssh_allowed("cordcam"))
        self.assertEqual(s.core_credentials, {"a": "password:x", "meet": "key:y"})
        self.assertFalse(from_env({}).ssh_allowed("meet"))
        with self.assertRaises(ValueError):
            from_env({"FLEET_EXECUTOR": "bash"})


if __name__ == "__main__":
    unittest.main()
