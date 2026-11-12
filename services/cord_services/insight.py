"""Факты для службы аналитики `insight` (R239, `contracts/insight.md` §2): трафик и время кинозала и музыки.

ЗАЧЕМ. Сколько стоит час кино или музыки, знает только эта служба: через неё идут байты площадок. Раз в
30 секунд она рассказывает аналитике, сколько байт и секунд потока ушло на каждую встречу и площадку
(факт `usage`), — из этого раздел «Интеграции» пульта считает трафик и цену часа.

ПРАВИЛА. Встреча и кино от аналитики не зависят: счёт — пара словарей в памяти, отправка — фоном, отказ
службы аналитики — повтор той же пачки с теми же номерами фактов, переполнение — старое выбрасывается со
строкой в журнале. В фактах нет ни людей, ни адресов, ни ссылок: только встреча, вид, площадка, байты и
секунды. Адреса службы нет (`INSIGHT_URL` пуст) — счёт не ведётся вовсе.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
import uuid
from typing import Callable

import httpx

from . import keys

PURPOSE = "insight"  # ключ назначения в заголовке X-Insight-Key — тот же, что у ядра
INTERVAL = 30.0
BATCH = 500
PENDING = 5_000  # сколько не ушедших фактов держать: больше — аналитика лежит давно, старое не нужно
_WORD = re.compile(r"[^a-z0-9_.-]+")

log = logging.getLogger(__name__)


def word(value: str | None) -> str:
    """Имя площадки словом аналитики: `[a-z0-9_.-]{1,32}`; пустое и непонятное — `other`."""
    cleaned = _WORD.sub("-", (value or "").lower()).strip("-")[:32]
    return cleaned or "other"


class Usage:
    def __init__(
        self,
        url: str,
        secret: str,
        *,
        client: httpx.AsyncClient | None = None,
        clock: Callable[[], float] = time.time,
        interval: float = INTERVAL,
    ):
        self.url = (url or "").rstrip("/")
        self.enabled = bool(self.url and secret)
        self.key = keys.text(secret, PURPOSE) if self.enabled else ""
        self.clock = clock
        self.interval = interval
        self.client = client or httpx.AsyncClient(timeout=httpx.Timeout(5.0, connect=2.0))
        self._bytes: dict[tuple[str, str, str], int] = {}
        self._seconds: dict[tuple[str, str, str], float] = {}
        self._pending: list[dict] = []
        self.dropped = 0

    def count(self, room: str, kind: str, variant: str | None, amount: int) -> None:
        """Байты, ушедшие зрителям встречи `room` с площадки `variant`."""
        if not self.enabled or not room or amount <= 0:
            return
        key = (room, kind, word(variant))
        self._bytes[key] = self._bytes.get(key, 0) + amount

    def played(self, room: str, kind: str, variant: str | None, seconds: float) -> None:
        """Секунды потока, когда их знает сама интеграция (музыка — по позиции трека)."""
        if not self.enabled or not room or not 0 < seconds <= 60:
            return
        key = (room, kind, word(variant))
        self._seconds[key] = self._seconds.get(key, 0.0) + seconds

    def take(self, window: float | None = None) -> list[dict]:
        """Факты `usage` за прошедшее окно; счёт начинается заново.

        Кинозал секунд не называет: поток шёл, пока шли байты, — засчитывается окно целиком.
        """
        window = self.interval if window is None else window
        now = int(self.clock() * 1000)
        facts = []
        for key in sorted(set(self._bytes) | set(self._seconds)):
            amount = self._bytes.pop(key, 0)
            seconds = self._seconds.pop(key, None)
            if seconds is None:
                seconds = window if amount else 0.0
            if not amount and not seconds:
                continue
            room, kind, variant = key
            facts.append(
                {
                    "id": str(uuid.uuid4()),
                    "at": now,
                    "type": "usage",
                    "room": room,
                    "kind": kind,
                    "variant": variant,
                    "bytes": amount,
                    "seconds": round(min(seconds, window), 1),
                }
            )
        return facts

    async def flush(self) -> bool:
        """Отправить накопленное. Не ушло — пачка остаётся и уйдёт в следующий раз с теми же номерами."""
        if not self.enabled:
            return True
        self._pending.extend(self.take())
        if len(self._pending) > PENDING:
            lost = len(self._pending) - PENDING
            self.dropped += lost
            del self._pending[:lost]
            log.warning("аналитика: служба не принимает факты, выброшено старых: %s", lost)
        while self._pending:
            batch = self._pending[:BATCH]
            try:
                response = await self.client.post(
                    self.url + "/internal/facts",
                    json={"source": "services", "facts": batch},
                    headers={"X-Insight-Key": self.key},
                )
            except httpx.HTTPError:
                return False
            # 503 — очередь службы полна или база лежит: повторить ту же пачку. Отказ по существу
            # (400, 401, 413) повтором не лечится — пачка выбрасывается, иначе она встала бы навсегда.
            if response.status_code >= 500 or response.status_code == 429:
                return False
            if response.status_code >= 400:
                self.dropped += len(batch)
                log.warning("аналитика: служба отвергла факты (%s), пачка выброшена", response.status_code)
            del self._pending[: len(batch)]
        return True

    async def run(self) -> None:
        """Фоновая отправка раз в `interval`. Ошибка отправки цикл не останавливает."""
        if not self.enabled:
            return
        while True:
            await asyncio.sleep(self.interval)
            try:
                await self.flush()
            except Exception:  # noqa: BLE001 — аналитика не роняет службу
                log.exception("аналитика: отправка фактов не удалась")

    async def close(self) -> None:
        try:
            if self.enabled:
                await asyncio.wait_for(self.flush(), 3)
        except Exception:  # noqa: BLE001
            pass
        await self.client.aclose()
