"""Общий сейф для сохранённых входов в чужие службы.

ПОЧЕМУ ОТДЕЛЬНО. Яндекс Музыка была первой (и единственной) службой, куда Cord входит чужим
аккаунтом, и коробка с шифрованием жила прямо внутри `yandex.py` — один Fernet-ключ, выведенный
из секрета службы, и таблица `integrations`, где строка — это `(provider, scope)`. Следующему
входу (какой бы службой он ни был) нужна ровно та же коробка, а не её копия под другим именем.
Здесь — то же самое, что было, вынесенное так, чтобы вторая служба могла позвать `Vault`, а не
переписывать шифрование заново.

Ключ входа — `scope`: обычно `"room:" + room_id`, но это решает вызывающий, а не сейф. Секрет
входа — `token`, `cookie`, что угодно сериализуемое в JSON; сейф не знает и не спрашивает, что
внутри, — только шифрует и хранит.
"""

from __future__ import annotations

import base64
import hashlib
import json
from typing import Any

from cryptography.fernet import Fernet, InvalidToken

from .store import now


class Vault:
    """Шифрованное хранилище `(provider, scope) -> JSON` поверх таблицы `integrations`.

    Один процесс — один ключ, выведенный из общего секрета службы тем же способом, что раньше
    был внутри `Yandex.__init__`: секрет не хранится и не сравнивается напрямую, а участвует
    только в выводе ключа Fernet, — так утечка таблицы без секрета ничего не открывает.
    """

    def __init__(self, db, secret: str):
        self.db = db
        self.fernet = Fernet(base64.urlsafe_b64encode(hashlib.sha256(secret.encode()).digest()))
        db.execute(
            "CREATE TABLE IF NOT EXISTS integrations"
            "(provider TEXT, scope TEXT, body TEXT NOT NULL, PRIMARY KEY(provider,scope))"
        )

    def seal(self, value: Any) -> str:
        """Зашифровать произвольное JSON-значение в строку для хранения где угодно."""
        return self.fernet.encrypt(json.dumps(value).encode()).decode()

    def open(self, token: str) -> Any | None:
        """Обратное к `seal`. Битый или чужой токен — не авария, а пустой аккаунт."""
        try:
            return json.loads(self.fernet.decrypt(token.encode()))
        except (InvalidToken, ValueError):
            return None

    def get(self, provider: str, scope: str) -> Any | None:
        row = self.db.execute(
            "SELECT body FROM integrations WHERE provider=? AND scope=?", (provider, scope)
        ).fetchone()
        return self.open(row[0]) if row else None

    def put(self, provider: str, scope: str, value: Any, *, ttl_ms: int | None = None) -> None:
        # Срок годности — то же поле `expiresAt` внутри записи, что раньше расставлял сам
        # Яндекс вручную при подключении: он живёт в теле, а не отдельной колонкой, поэтому его
        # проверяет тот, кто знает смысл записи (истёкший токен остаётся отключённым аккаунтом,
        # а не исчезает сам), а не сейф вслепую.
        if ttl_ms is not None:
            value = {**value, "expiresAt": now() + ttl_ms}
        self.db.execute(
            "INSERT INTO integrations VALUES (?,?,?) "
            "ON CONFLICT(provider,scope) DO UPDATE SET body=excluded.body",
            (provider, scope, self.seal(value)),
        )

    def delete(self, provider: str, scope: str) -> None:
        self.db.execute("DELETE FROM integrations WHERE provider=? AND scope=?", (provider, scope))
