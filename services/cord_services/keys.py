"""Ключи по назначению из `INTERNAL_SECRET` (A14 docs/abuse-model.md).

ЗАЧЕМ. Раньше один секрет установки работал сразу всем: заголовком «я служба Cord» к ядру, ключом подписи
адресов кинозала, HMAC номера пользователя бота, ключом плеера страниц и ключом сейфа входов. Заголовок
уходит по сети при каждом запросе — и попади он в чей-то журнал, вместе с ним утекли бы подписи кинозала и
сейф. Теперь каждое назначение получает свой ключ HKDF-SHA256 (RFC 5869) с меткой назначения: зная один,
не получить ни соседний, ни сам секрет.

Формула одна на ядро, службу и плеер страниц: соль `cord-internal-secret`, `info` — имя назначения, 32 байта.
Общий образец — `services/tests/test_keys.py` и `server/.../InternalKeysTest.java`; у плеера страниц своя
копия формулы (`services/sniffer/sniffer/entry.py`), сверка — тем же образцом.

Шлюз (Caddy) ключей выводить не умеет и ставит `X-Internal-Secret` самим секретом; службы этот заголовок
больше не шлют.
"""

from __future__ import annotations

import base64
import hashlib
import hmac

from cryptography.fernet import Fernet, MultiFernet

SALT = b"cord-internal-secret"

# Назначения. Имя — часть формулы: переименование меняет ключ.
SERVICE = "service"  # заголовок X-Service-Secret службы к ядру
ACTOR = "actor"  # HMAC номера пользователя Telegram в X-Cord-Actor
CINEMA = "cinema-sign"  # подписи адресов прокси кинозала
SNIFFER = "sniffer"  # вход службы в плеер страниц
FERNET = "fernet"  # сейф сохранённых входов (Яндекс Музыка)


def hkdf(ikm: bytes, salt: bytes, info: bytes, length: int = 32) -> bytes:
    """HKDF-SHA256 (RFC 5869): извлечь, затем растянуть до `length` байт."""
    prk = hmac.new(salt or bytes(32), ikm, hashlib.sha256).digest()
    out, block, counter = b"", b"", 1
    while len(out) < length:
        block = hmac.new(prk, block + info + bytes([counter]), hashlib.sha256).digest()
        out += block
        counter += 1
    return out[:length]


def derive(secret: str, purpose: str) -> bytes:
    """32 байта ключа назначения `purpose` из секрета установки."""
    if not secret:
        raise ValueError("INTERNAL_SECRET не задан — ключу не из чего выводиться")
    return hkdf(secret.encode(), SALT, purpose.encode())


def text(secret: str, purpose: str) -> str:
    """Ключ строкой для заголовка: base64url без `=` (43 знака), как у ядра."""
    return base64.urlsafe_b64encode(derive(secret, purpose)).rstrip(b"=").decode()


def vault_cipher(secret: str) -> MultiFernet:
    """
    Шифр сейфа: пишет своим ключом, читает и своим, и прежним (SHA-256 от секрета).

    Прежний ключ остаётся только на чтение — так входы, сохранённые до A14, не пропадают (данные откатываться
    должны и по В-2). Новое и перезаписанное шифруется уже ключом назначения.
    """
    legacy = base64.urlsafe_b64encode(hashlib.sha256(secret.encode()).digest())
    return MultiFernet([Fernet(base64.urlsafe_b64encode(derive(secret, FERNET))), Fernet(legacy)])
