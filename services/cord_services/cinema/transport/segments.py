"""Общая память на кусочки видео: комната смотрит одно и то же, и площадка отдаёт кусок один
раз, а не по числу зрителей."""

from __future__ import annotations

import asyncio
import time


class Segments:
    """
    Общая память на кусочки видео.

    Комната смотрит одно и то же и примерно в одном месте, поэтому пятеро зрителей просят у нас
    одни и те же сегменты в течение нескольких секунд. Без этой памяти каждый такой кусок
    качался бы с площадки заново — пятикратный входящий трафик ради одного и того же байта.

    Здесь же и защита от лавины: первый запрос идёт наружу, остальные ждут его результата, а не
    открывают собственные соединения.
    """

    def __init__(
        self, capacity: int = 192 * 1024 * 1024, ttl: float = 120.0, largest: int = 12 * 1024 * 1024
    ):
        self.capacity = capacity
        self.ttl = ttl
        self.largest = largest
        self._items: dict[str, tuple[float, bytes, str]] = {}
        self._size = 0
        self._locks: dict[str, asyncio.Lock] = {}

    def get(self, url: str) -> tuple[bytes, str] | None:
        found = self._items.get(url)
        if not found:
            return None
        born, body, kind = found
        if time.time() - born > self.ttl:
            self.drop(url)
            return None
        return body, kind

    def put(self, url: str, body: bytes, kind: str) -> None:
        if len(body) > self.largest:
            return
        self.drop(url)
        self._items[url] = (time.time(), body, kind)
        self._size += len(body)
        # Выселяем самое старое: очередь просмотра движется вперёд, и назад почти не ходят.
        while self._size > self.capacity and self._items:
            self.drop(next(iter(self._items)))

    def drop(self, url: str) -> None:
        found = self._items.pop(url, None)
        if found:
            self._size -= len(found[1])

    def lock(self, url: str) -> asyncio.Lock:
        if url not in self._locks:
            if len(self._locks) > 512:
                self._locks.clear()
            self._locks[url] = asyncio.Lock()
        return self._locks[url]
