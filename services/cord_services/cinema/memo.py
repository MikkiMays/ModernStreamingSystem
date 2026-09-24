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
    """

    def __init__(self, capacity: int = 256):
        self.capacity = capacity
        self._items: dict[str, tuple[float, Any]] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    async def get(
        self,
        key: str,
        produce: Callable[[], Awaitable[Any]],
        ttl: float | Callable[[Any], float],
    ) -> Any:
        fresh = self._fresh(key)
        if fresh is not None:
            return fresh
        if key not in self._locks:
            if len(self._locks) > 512:
                self._locks.clear()
            self._locks[key] = asyncio.Lock()
        async with self._locks[key]:
            fresh = self._fresh(key)
            if fresh is not None:
                return fresh
            value = await produce()
            seconds = ttl(value) if callable(ttl) else ttl
            self._items.pop(key, None)
            self._items[key] = (time.time() + seconds, value)
            while len(self._items) > self.capacity:
                self._items.pop(next(iter(self._items)))
            return value

    def _fresh(self, key: str) -> Any:
        found = self._items.get(key)
        if found and found[0] > time.time():
            return found[1]
        if found:
            self._items.pop(key, None)
        return None
