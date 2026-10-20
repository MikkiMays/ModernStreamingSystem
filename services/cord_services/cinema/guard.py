"""
Прокси кинозала — не бесплатный канал (A8 docs/abuse-model.md, E11-B).

Раньше подписанный адрес работал пять часов у кого угодно: без входа, без встречи и после её конца, а
байты к зрителям нигде не считались. Теперь адрес, который служба выдаёт плееру, живёт под встречей
(`signer.located`): прокси пускает, пока встреча открыта и в ней идёт кино (`Watching`), и считает байты
на встречу и на сервер за сутки (`Traffic`). Сверх потолка — отказ 429: кино в этой встрече
останавливается до её конца, а на сервере — до следующих суток.
"""

from __future__ import annotations

import os
import re
import time
import uuid
from collections import defaultdict
from typing import Any, Callable
from urllib.parse import parse_qs, urlencode

from fastapi import HTTPException, Response
from fastapi.responses import StreamingResponse

from .transport.signer import PREFIX, ROUTES, Signer, located

_SIZES = {"": 1, "b": 1, "k": 1024, "kb": 1024, "m": 1024**2, "mb": 1024**2, "g": 1024**3, "gb": 1024**3,
          "t": 1024**4, "tb": 1024**4}


def size(text: str) -> int:
    """Размер словами, как в `application.yml` ядра: `100GB`, `500 MB`."""
    found = re.fullmatch(r"\s*(\d+)\s*([kmgt]?b?)\s*", text.lower())
    if not found:
        raise ValueError(f"Не понимаю размер «{text}»: ожидается «100GB» или «500 MB»")
    return int(found.group(1)) * _SIZES[found.group(2)]


class Watching:
    """
    Встреча открыта и смотрит кино — спрашивается у ядра и помнится `ttl` секунд.

    Прокси дёргают десятки раз в минуту на зрителя; спрашивать ядро на каждый сегмент незачем.
    Закрытая встреча или погашенное кино узнаются не позже чем через `ttl`.
    """

    def __init__(self, core, ttl: float = 30, clock: Callable[[], float] = time.monotonic):
        self.core = core
        self.ttl = ttl
        self.clock = clock
        self._known: dict[str, tuple[float, bool]] = {}

    async def require(self, room: str) -> None:
        try:
            uuid.UUID(room)
        except ValueError:
            raise HTTPException(404, "Встреча не найдена") from None
        now = self.clock()
        known = self._known.get(room)
        if known is None or known[0] <= now:
            try:
                info = await self.core.request("GET", f"/internal/services/{room}")
                open_ = bool(info) and not info.get("closedAt") and info.get("watching", True)
            except HTTPException as error:
                if error.status_code not in (404, 410):
                    raise
                open_ = False
            if len(self._known) > 4096:
                self._known = {key: value for key, value in self._known.items() if value[0] > now}
            known = (now + self.ttl, open_)
            self._known[room] = known
        if not known[1]:
            raise HTTPException(410, "Встреча закончилась или кино в ней закрыто. Откройте видео заново")


class Traffic:
    """
    Байты к зрителям: на встречу и на весь сервер за сутки (`CINEMA_TRAFFIC_PER_MEETING`,
    `CINEMA_TRAFFIC_PER_DAY`).

    Счёт — в памяти службы: она одна на сервер, а сутки и встреча короче её жизни. После перезапуска счёт
    начинается заново — это щедрость, а не дыра: перезапуск не в руках зрителя.
    """

    def __init__(
        self,
        per_meeting: int,
        per_day: int,
        warn_at: float = 0.8,
        today: Callable[[], int] = lambda: int(time.time() // 86400),
    ):
        self.per_meeting = per_meeting
        self.per_day = per_day
        self.warn_at = warn_at
        self.today = today
        self._rooms: dict[str, int] = defaultdict(int)
        self._day: tuple[int, int] = (today(), 0)

    @classmethod
    def from_env(cls) -> Traffic:
        return cls(
            size(os.environ.get("CINEMA_TRAFFIC_PER_MEETING", "100GB")),
            size(os.environ.get("CINEMA_TRAFFIC_PER_DAY", "500GB")),
            int(os.environ.get("CINEMA_TRAFFIC_WARN_AT", "80").rstrip("%")) / 100,
        )

    def _spent_today(self) -> int:
        day, spent = self._day
        return spent if day == self.today() else 0

    def admit(self, room: str) -> None:
        if room and self._rooms[room] >= self.per_meeting:
            raise HTTPException(429, "Встреча выбрала потолок трафика кинозала. Кино остановлено до её конца")
        if self._spent_today() >= self.per_day:
            raise HTTPException(429, "Кинозал на сегодня выбрал трафик сервера. Попробуйте завтра")

    def count(self, room: str, amount: int) -> None:
        if amount <= 0:
            return
        if room:
            self._rooms[room] += amount
            if len(self._rooms) > 4096:
                # Самые скромные встречи забываются первыми: потолок защищает от тяжёлых.
                for key in sorted(self._rooms, key=self._rooms.get)[:1024]:
                    del self._rooms[key]
        self._day = (self.today(), self._spent_today() + amount)

    def used(self, room: str) -> int:
        return self._rooms.get(room, 0)

    def warned(self, room: str) -> bool:
        """Встреча выбрала долю `warn_at` своего потолка (видно на странице «Активность», E10)."""
        return self.used(room) >= self.per_meeting * self.warn_at

    def wrap(self, response: Response, room: str) -> Response:
        """Ответ прокси, байты которого засчитываются, когда уходят к зрителю."""
        if isinstance(response, StreamingResponse):
            inner = response.body_iterator

            async def counted():
                async for chunk in inner:
                    self.count(room, len(chunk) if isinstance(chunk, (bytes, bytearray, memoryview)) else 0)
                    yield chunk

            response.body_iterator = counted()
        else:
            self.count(room, len(getattr(response, "body", b"") or b""))
        return response


def bind_room(value: Any, room: str, signer: Signer) -> Any:
    """
    Ответ разбора, где каждый адрес прокси переподписан под встречу.

    Разбор общий на всех зрителей ролика (`Sources`, память на минуты), поэтому адреса в нём — без встречи.
    Здесь, на выходе к конкретной встрече, каждый из них получает её номер в пути и в подписи; общий ответ
    не меняется.
    """
    if isinstance(value, dict):
        return {key: bind_room(item, room, signer) for key, item in value.items()}
    if isinstance(value, list):
        return [bind_room(item, room, signer) for item in value]
    if not isinstance(value, str) or not value.startswith(PREFIX + "/") or value.startswith(PREFIX + "/r/"):
        return value
    path, _, query = value.partition("?")
    route = path[len(PREFIX) + 1 :]
    if route.startswith("dash/") or route.startswith("seg/"):
        return f"{PREFIX}/r/{room}/{route}"
    if route not in ROUTES or not query:
        return value
    params = {key: items[0] for key, items in parse_qs(query).items()}
    try:
        signer.open(route, params["u"], params["e"], params["s"], params.get("p", ""), params.get("h", ""))
    except (KeyError, HTTPException):
        return value
    sealed = signer.seal(route, params.get("p", ""), params["u"], params["e"], params.get("h") or None, room)
    return located(route, room) + "?" + urlencode(sealed)

