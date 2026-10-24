"""
Telegram Mini App (E09): проверка `initData`, членство в беседе и вход во встречу беседы.

Mini App открывается url-кнопкой `https://t.me/<бот>?startapp=<номер привязки>&mode=fullscreen`
(решение архитектора 17). Браузер присылает строку `Telegram.WebApp.initData` как есть; доверять
можно только ей, проверенной HMAC по токену бота (`initDataUnsafe` — то же самое без подписи).
Номер привязки — `start_param`: он есть только у ссылок, которые бот сам закрепил в беседе, и
говорит, какая беседа и какая встреча. Беседу человек доказывает членством (`getChatMember`), а не
словом браузера: `chat_instance` и `chat_type` из `initData` ничего не решают.

Всё — за `TELEGRAM_WEBAPP_ENABLED` (по умолчанию выключено): без флага вход отвечает
`TELEGRAM_WEBAPP_OFF`, а бот не рисует кнопок Mini App.

`initData` и номер пользователя Telegram не пишутся ни в журнал, ни в базу: строка нужна один раз —
в момент входа, дальше встреча живёт на собственном удостоверении Cord.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any, Mapping
from urllib.parse import parse_qsl, quote

from fastapi import HTTPException

# Решение архитектора 17: `initData` старше часа не принимается. Больше часа нельзя и переменной —
# строка, которая прожила дольше, уже не «только что открытый Mini App».
MAX_AGE = 3600
# Часы Telegram и сервера расходятся; «из будущего» больше чем на минуту — подделка или сбой.
FUTURE_SKEW = 60
# Членство спрашивается у Telegram не на каждый вход: перезагрузка WebView не должна стоить запроса.
MEMBERSHIP_TTL = 300
MEMBER_STATUSES = ("creator", "administrator", "member")
# `start_param` нашей кнопки: `b` и 22 символа base64url. Telegram пускает `[A-Za-z0-9_-]{0,512}`.
LINK_PREFIX = "b"


def enabled(value: str | None) -> bool:
    """`TELEGRAM_WEBAPP_ENABLED`: включено только явное «да»."""
    return (value or "").strip().lower() in ("1", "true", "yes", "on")


def max_age(value: str | None) -> int:
    """`TELEGRAM_INITDATA_MAX_AGE`: короче — можно, длиннее часа — нет."""
    try:
        seconds = int(value or MAX_AGE)
    except ValueError:
        return MAX_AGE
    return max(60, min(seconds, MAX_AGE))


class Refusal(HTTPException):
    """
    Отказ со стабильным кодом: `{"code": …, "detail": …}`, как у ядра (RFC 7807, E14).

    Коды службы попадают в `contracts/errors.json` тем же сборщиком, что и коды ядра
    (`scripts/errors_registry.py` ищет `Refusal(статус, "КОД", "текст")`), поэтому текст — одна
    строка-литерал прямо в вызове.

    `extra` — значения рядом с кодом, которые клиенту нужны не словами (кинозал: `provider`, чтобы
    назвать площадку на языке человека); `headers` — заголовки ответа (`Retry-After`).
    """

    def __init__(
        self,
        status: int,
        code: str,
        detail: str,
        *,
        headers: Mapping[str, str] | None = None,
        extra: Mapping[str, Any] | None = None,
    ):
        super().__init__(status, detail, headers=dict(headers) if headers else None)
        self.code = code
        self.extra = dict(extra or {})


class InitDataError(ValueError):
    """Почему строка не принята: `malformed`, `signature`, `stale`. Наружу — один код."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def verify_init_data(raw: str, token: str, now: float, limit: int = MAX_AGE) -> dict:
    """
    Проверка `initData` по https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app.

    1. Строка запроса, значения раскодированы; повтор ключа — ошибка (иначе подпись проверялась бы
       над одним значением, а читалось бы другое).
    2. Вынуть `hash`; `signature` (Ed25519 для третьих сторон) остаётся в проверяемой строке.
    3. Пары `key=value`, по ключу, через `\\n`.
    4. Ключ — `HMAC_SHA256(key="WebAppData", msg=токен)`, сырые байты.
    5. Сравнение за постоянное время.
    6. `auth_date` — не старше `limit` секунд и не из будущего больше чем на минуту.
    """
    try:
        pairs = parse_qsl(raw, keep_blank_values=True, strict_parsing=True)
    except ValueError:
        raise InitDataError("malformed") from None
    data = dict(pairs)
    if len(data) != len(pairs) or "hash" not in data or "auth_date" not in data:
        raise InitDataError("malformed")
    received = data.pop("hash")
    check = "\n".join(f"{key}={value}" for key, value in sorted(data.items()))
    secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    expected = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, received):
        raise InitDataError("signature")
    try:
        age = now - int(data["auth_date"])
    except ValueError:
        raise InitDataError("malformed") from None
    if age > limit or age < -FUTURE_SKEW:
        raise InitDataError("stale")
    try:
        data["user"] = json.loads(data["user"]) if "user" in data else None
    except ValueError:
        raise InitDataError("malformed") from None
    return data


def display_name(user: dict) -> str:
    """Имя во встрече — как у сообщений бота (`Telegram.actor`): имя и фамилия, до 40 символов."""
    return (
        " ".join(filter(None, (user.get("first_name"), user.get("last_name")))).strip()
        or "Участник Telegram"
    )[:40]


def startapp_url(username: str, link_id: str, short_name: str = "") -> str:
    """
    Ссылка кнопки в беседе. Кнопка `web_app` в группах запрещена (Bot API), работает только `url`.

    Пусто в `short_name` — главный Mini App бота (`t.me/<бот>?startapp=…`), иначе — Mini App из
    `/newapp` (`t.me/<бот>/<short_name>?startapp=…`). `mode=fullscreen` — сразу на весь экран (T55).
    """
    path = f"{username}/{quote(short_name, safe='')}" if short_name else username
    return f"https://t.me/{path}?startapp={quote(link_id, safe='')}&mode=fullscreen"


def startgroup_url(username: str, token: str) -> str:
    """
    «Добавить бота в группу»: Telegram сам предложит группу, добавит бота админом с правом закрепа и
    пришлёт туда `/start <token>` — это и есть привязка (https://core.telegram.org/api/links).
    """
    return (
        f"https://t.me/{username}?startgroup={quote(token, safe='')}"
        "&admin=pin_messages+manage_chat"
    )


def is_member(member: dict) -> bool:
    status = member.get("status")
    return status in MEMBER_STATUSES or (status == "restricted" and bool(member.get("is_member")))


class Memberships:
    """Ответы `getChatMember` на пять минут — в памяти процесса, номера пользователей не на диске."""

    def __init__(self, ttl: float = MEMBERSHIP_TTL, clock=time.monotonic):
        self.ttl = ttl
        self.clock = clock
        self._known: dict[tuple[int, int], tuple[float, bool]] = {}

    async def check(self, api, chat_id: int, user_id: int) -> bool:
        key = (chat_id, user_id)
        now = self.clock()
        known = self._known.get(key)
        if known and known[0] > now:
            return known[1]
        if chat_id > 0:
            # Личный чат с ботом: беседа — это сам человек.
            answer = chat_id == user_id
        else:
            try:
                member = await api("getChatMember", {"chat_id": chat_id, "user_id": user_id})
            except HTTPException:
                # Telegram отказал («user not found», бота убрали из чата) или недоступен — войти
                # нельзя, но и запоминать нечего: следующий вход спросит снова.
                return False
            answer = is_member(member)
        if len(self._known) > 4096:
            self._known = {k: v for k, v in self._known.items() if v[0] > now}
        self._known[key] = (now + self.ttl, answer)
        return answer


async def release(store, link: dict, api=None, *, keep_binding: bool = False):
    """
    Снять привязку Mini App: номер отзывается, закреп снимается, кнопка уходит из сообщения.

    `keep_binding` — привязка беседы к встрече остаётся (перепривязка: старую кнопку заменит
    новая). Без него уходит и привязка `/meet` — если она ещё указывает на ту же встречу. Telegram
    здесь — вежливость: отозванный номер отказывает и тогда, когда сообщение изменить не вышло.
    """
    store.revoke_telegram_link(link["id"])
    if not keep_binding:
        binding = store.binding(link["scope"])
        if binding and binding["roomId"] == link["roomId"]:
            store.unbind(link["scope"])
    if api is None or not link.get("messageId"):
        return
    target = {"chat_id": link["chatId"], "message_id": link["messageId"]}
    for method, payload in (
        ("unpinChatMessage", target),
        ("editMessageText", {**target, "text": "Встреча отвязана от этого чата."}),
    ):
        try:
            await api(method, payload)
        except HTTPException:
            pass
