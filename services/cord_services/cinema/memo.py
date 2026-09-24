"""Общая память на ответ площадки на несколько секунд: первый зритель считает, остальные
ждут его ответа."""

from __future__ import annotations

import asyncio
import time
from typing import Any, Awaitable, Callable


class Memo:
    """
    Ответ площадки, который стоит секунд, — один на всех.

    ЗАЧЕМ. `resolve` у YouTube это две секунды работы yt-dlp, и просит его **каждый** зритель
    отдельно: пятеро в комнате — пять одинаковых запросов наружу и пять раз по две секунды
    ожидания. Здесь же и защита от лавины: первый считает, остальные ждут его ответ.

    ОТКАЗ ТОЖЕ ОДИН НА ВСЕХ. Раньше ожидающие стояли в очереди за замком, и отказ площадки
    доставался только первому: второй снимал замок и спрашивал её заново, за ним третий — пятый
    ждал пятикратное время ради пяти одинаковых отказов. Теперь ответ считается одной задачей,
    и её исход — значение или исключение — получают все, кто ждал её вместе. Запоминается
    только значение: следующий вопрос после отказа снова идёт к площадке.

    Задача считается сама по себе, а не в том запросе, который её начал: зритель, закрывший
    вкладку первым, не отменяет ответ для остальных.
    """

    def __init__(self, capacity: int = 256):
        self.capacity = capacity
        self._items: dict[str, tuple[float, Any]] = {}
        self._flights: dict[str, asyncio.Future[Any]] = {}

    async def get(
        self,
        key: str,
        produce: Callable[[], Awaitable[Any]],
        ttl: float | Callable[[Any], float],
    ) -> Any:
        fresh = self._fresh(key)
        if fresh is not None:
            return fresh
        flight = self._flights.get(key)
        if flight is None:
            flight = asyncio.ensure_future(self._produce(key, produce, ttl))
            self._flights[key] = flight
            flight.add_done_callback(lambda done: self._land(key, done))
        # Отмена ожидающего не должна отменять общий ответ: его ждут и другие.
        return await asyncio.shield(flight)

    def known(self, key: str) -> bool:
        """Есть ли свежий ответ или его уже считают: тогда вопрос ничего наружу не стоит."""
        return self._fresh(key) is not None or self.pending(key)

    def pending(self, key: str) -> bool:
        """Считают ли ответ прямо сейчас: к такому разбору можно присоединиться даром."""
        return key in self._flights

    def forget(self, key: str) -> None:
        """Забыть готовый ответ: тот, кто просит обновить, получит новый."""
        self._items.pop(key, None)

    def scope(self, namespace: str) -> Scope:
        """Память одной площадки: все её ключи начинаются с её имени."""
        return Scope(self, namespace)

    async def _produce(
        self, key: str, produce: Callable[[], Awaitable[Any]], ttl: float | Callable[[Any], float]
    ) -> Any:
        value = await produce()
        seconds = ttl(value) if callable(ttl) else ttl
        self._items.pop(key, None)
        self._items[key] = (time.time() + seconds, value)
        while len(self._items) > self.capacity:
            self._items.pop(next(iter(self._items)))
        return value

    def _land(self, key: str, flight: asyncio.Future[Any]) -> None:
        if self._flights.get(key) is flight:
            del self._flights[key]
        # Если ждать было уже некому, исключение всё равно забирается здесь — иначе asyncio
        # напишет в журнал «Task exception was never retrieved» про обычный отказ площадки.
        if not flight.cancelled():
            flight.exception()

    def _fresh(self, key: str) -> Any:
        found = self._items.get(key)
        if found and found[0] > time.time():
            return found[1]
        if found:
            self._items.pop(key, None)
        return None


class Scope:
    """
    Память одной площадки внутри общей.

    Правило «ключ площадки начинается с её имени» держится не договорённостью, а устройством:
    площадка получает только эту обёртку и чужого ключа не назовёт, даже если захочет.
    """

    def __init__(self, memo: Memo, namespace: str):
        self._memo = memo
        self._prefix = namespace + ":"

    async def get(
        self,
        key: str,
        produce: Callable[[], Awaitable[Any]],
        ttl: float | Callable[[Any], float],
    ) -> Any:
        return await self._memo.get(self._prefix + key, produce, ttl)
