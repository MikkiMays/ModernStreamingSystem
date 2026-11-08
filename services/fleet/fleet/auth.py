"""Вход в пульт (Р-113): пароль (scrypt) + одноразовый код (TOTP, RFC 6238), сессии в куке, ключ агента.

Ошибка входа одна на все причины — «Неверный пароль или код»: не говорим, что именно не так. Код и пароль
сравниваются в постоянное время; пароль проверяется всегда, даже если код заведомо неверен, чтобы время
ответа не выдавало, какой из двух факторов не сошёлся.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import struct
import time
from dataclasses import dataclass

from .errors import AUTH_DISABLED, AUTH_INVALID, AUTH_LOCKED, AUTH_REQUIRED, CSRF_REJECTED, Problem
from .settings import SESSION_IDLE, SESSION_LIFETIME, Settings
from .store import Session, Store

OWNER = "owner"
AGENT = "agent"


@dataclass(frozen=True)
class Actor:
    kind: str
    session: Session | None
    ip: str | None

    @property
    def session_id(self) -> str | None:
        return self.session.id if self.session else None


# ── Пароль ───────────────────────────────────────────────────────────────────────────────────────
SCRYPT_N, SCRYPT_R, SCRYPT_P = 1 << 15, 8, 1
# scrypt с n=2^15, r=8 держит 32 МиБ — ровно потолок OpenSSL по умолчанию; поднимаем явно.
SCRYPT_MAXMEM = 128 * 1024 * 1024


def hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=32, maxmem=SCRYPT_MAXMEM)
    return "scrypt$%d,%d,%d$%s$%s" % (
        SCRYPT_N,
        SCRYPT_R,
        SCRYPT_P,
        base64.b64encode(salt).decode(),
        base64.b64encode(digest).decode(),
    )


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, params, salt, digest = stored.split("$")
        n, r, p = (int(x) for x in params.split(","))
        if scheme != "scrypt":
            return False
        expected = base64.b64decode(digest)
        actual = hashlib.scrypt(
            password.encode(), salt=base64.b64decode(salt), n=n, r=r, p=p, dklen=len(expected), maxmem=SCRYPT_MAXMEM
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)


# ── Одноразовый код ──────────────────────────────────────────────────────────────────────────────
TOTP_STEP = 30
TOTP_DIGITS = 6


def totp(secret_b32: str, at: float | None = None, step_offset: int = 0) -> str:
    key = base64.b32decode(secret_b32.upper() + "=" * (-len(secret_b32) % 8), casefold=True)
    counter = int((time.time() if at is None else at) // TOTP_STEP) + step_offset
    mac = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = mac[-1] & 0x0F
    code = (struct.unpack(">I", mac[offset : offset + 4])[0] & 0x7FFFFFFF) % (10**TOTP_DIGITS)
    return str(code).zfill(TOTP_DIGITS)


def verify_totp(secret_b32: str, code: str, at: float | None = None) -> bool:
    """Окно ±1 шаг: часы телефона и сервера расходятся на секунды, а код живёт 30 с."""
    candidate = (code or "").strip().replace(" ", "")
    if len(candidate) != TOTP_DIGITS or not candidate.isdigit():
        return False
    ok = False
    for offset in (-1, 0, 1):
        ok |= hmac.compare_digest(totp(secret_b32, at, offset), candidate)
    return ok


def new_totp_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


# ── Сессии и запросы ─────────────────────────────────────────────────────────────────────────────
def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class Auth:
    def __init__(self, settings: Settings, store: Store) -> None:
        self.settings = settings
        self.store = store

    def login(self, password: str, code: str, ip: str, user_agent: str | None) -> tuple[str, Session]:
        """Пароль и код → токен сессии (значение куки) и сама сессия. Отказы — `Problem`."""
        if not self.settings.enabled:
            raise Problem(404, AUTH_DISABLED, "Пульт на этом сервере не настроен")
        wait = self.store.login_lock(ip)
        if wait:
            self.store.audit(OWNER, "auth.locked", "refused", ip=ip, detail=f"ждать {wait} с")
            raise Problem(429, AUTH_LOCKED, "Слишком много попыток — подождите", retryAfter=wait)
        password_ok = verify_password(password or "", self.settings.password_hash)
        code_ok = verify_totp(self.settings.totp_secret, code or "")
        if not (password_ok and code_ok):
            self.store.login_attempt(ip, False)
            self.store.audit(OWNER, "auth.login", "refused", ip=ip)
            raise Problem(401, AUTH_INVALID, "Неверный пароль или код")
        self.store.login_attempt(ip, True)
        token = secrets.token_urlsafe(32)
        session = self.store.create_session(secrets.token_hex(8), token_hash(token), OWNER, ip, user_agent)
        self.store.audit(OWNER, "auth.login", "ok", session_id=session.id, ip=ip)
        return token, session

    def session(self, token: str | None) -> Session | None:
        if not token or not self.settings.enabled:
            return None
        self.store.expire_sessions(SESSION_LIFETIME, SESSION_IDLE)
        session = self.store.session_by_token(token_hash(token))
        if session:
            self.store.touch_session(session.id)
        return session

    def logout(self, session: Session) -> None:
        self.store.delete_session(session.id)
        self.store.audit(OWNER, "auth.logout", "ok", session_id=session.id, ip=session.ip)

    def agent(self, key: str | None, real_ip: str | None) -> bool:
        """Ключ агента принимается только без `X-Real-IP` — то есть не через шлюз, а с самой машины."""
        if not key or not self.settings.agent_key or real_ip:
            return False
        return hmac.compare_digest(key, self.settings.agent_key)

    def agent_may(self, operation_group: str) -> bool:
        return operation_group in self.settings.agent_ops

    def check_origin(self, origin: str | None, host: str | None) -> None:
        """Изменяющий запрос браузера: `Origin` обязан совпасть с именем пульта (или с Host без него)."""
        expected = self.settings.admin_host or (host or "").split(":")[0].lower()
        if not origin:
            raise Problem(403, CSRF_REJECTED, "Запрос без Origin отклонён")
        actual = origin.lower().removeprefix("https://").removeprefix("http://").split("/")[0].split(":")[0]
        if not expected or actual != expected:
            raise Problem(403, CSRF_REJECTED, "Запрос с чужого адреса отклонён")

    @staticmethod
    def require(actor: Actor | None) -> Actor:
        if actor is None:
            raise Problem(401, AUTH_REQUIRED, "Войдите в пульт")
        return actor
