"""Сколько раз за минуту комната может заставить сервер работать на неё."""

from __future__ import annotations

import math
import time
from collections import deque
from typing import Callable

from fastapi import HTTPException


class Window:
    """
    Скользящее окно: не больше `limit` событий за `period` секунд на один ключ (комнату).

    Окно скользит, а не обнуляется в начале минуты: иначе тридцать запросов в конце одной
    минуты и тридцать в начале следующей — это шестьдесят за две секунды. Отказ в окно не
    записывается: комната, которая упёрлась в предел, снова может работать ровно тогда, когда
    из окна уходит её старейшее событие, — это время и уходит в `Retry-After`.
    """

    def __init__(
        self, limit: int, period: float, detail: str, clock: Callable[[], float] = time.monotonic
    ):
        self.limit = limit
        self.period = period
        self.detail = detail
        self.clock = clock
        self._events: dict[str, deque[float]] = {}

    def take(self, key: str) -> None:
        now = self.clock()
        events = self._events.setdefault(key, deque())
        while events and events[0] <= now - self.period:
            events.popleft()
        if len(events) >= self.limit:
            wait = max(1, math.ceil(events[0] + self.period - now))
            raise HTTPException(429, self.detail, headers={"Retry-After": str(wait)})
        events.append(now)
        if len(self._events) > 1024:
            self._sweep(now)

    def _sweep(self, now: float) -> None:
        """Комнаты, которые давно ничего не просили, из памяти уходят."""
        stale = now - self.period
        for key in [key for key, events in self._events.items() if not events or events[-1] <= stale]:
            del self._events[key]
