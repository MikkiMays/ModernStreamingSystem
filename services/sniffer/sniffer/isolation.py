"""
Самопроверка изоляции: плеер страниц сам стучится туда, куда ему нельзя, — и если дотянулся, не открывает
ни одной страницы.

ЗАЧЕМ. Браузер здесь без своей песочницы, и между кодом чужой страницы и сетью хоста стоят две стены,
которые ставит не этот контейнер: своя подсеть вне доверенных UFW (compose.yaml, `CINEMA_SNIFFER_SUBNET`) и
правила DOCKER-USER (`infra/sniffer-firewall.sh`). Их могут не поставить (первая выкатка руками, другой
хост, чужое правило UFW «доверять 10.0.0.0/8»). Поэтому при старте и раз в `PERIOD` плеер страниц пробует
короткое TCP-соединение к адресам, которые должны быть закрыты: шлюз своей подсети на портах соседних
служб хоста и метаданные облака. Соединилось хоть одно — изоляции нет: `/sniff` отвечает 503 «изоляция не
настроена», страница не открывается, а служба отвечает то, что сказал yt-dlp.

Это сторожевая лампочка, а не доказательство: отказ или молчание значит «туда не пустили или там никого»,
и полную стену проверяет `sniffer-firewall.sh check` на хосте. Но то, ради чего стена ставилась (порты 8090 и
8091 хоста, метаданные), она видит сама и сразу.

Цели — `CINEMA_SNIFFER_CANARIES`: `хост:порт` через запятую, `gateway` — шлюз подсети контейнера.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import socket
import struct
import time
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

# Порты соседних служб хоста, которым доверяют сети docker 172.16.0.0/12 (llm-bridge и graphify MCP на
# этой машине), и метаданные облака.
CANARIES = "gateway:8090,gateway:8091,169.254.169.254:80"
# Сколько ждать одно соединение и как часто проверять снова.
ATTEMPT = 2.0
PERIOD = 300.0
ROUTES = "/proc/net/route"
BROKEN = "Плеер страниц: изоляция не настроена — страницы не открываются"


def gateway(routes: str = ROUTES) -> str | None:
    """Шлюз маршрута по умолчанию контейнера (`/proc/net/route`: адрес — шестнадцатерично, байты наоборот)."""
    try:
        lines = open(routes, encoding="ascii").read().splitlines()[1:]
    except OSError:
        return None
    for line in lines:
        fields = line.split()
        if len(fields) > 2 and fields[1] == "00000000":
            try:
                return socket.inet_ntoa(struct.pack("<L", int(fields[2], 16)))
            except (ValueError, struct.error, OSError):
                return None
    return None


def targets(spec: str, found_gateway: str | None) -> list[tuple[str, int]]:
    """Цели из строки `хост:порт,…`; `gateway` без шлюза пропускается."""
    found: list[tuple[str, int]] = []
    for part in (spec or "").split(","):
        host, colon, port = part.strip().rpartition(":")
        if not colon or not port.isdigit() or not 0 < int(port) < 65536:
            continue
        host = found_gateway if host == "gateway" else host.strip("[]")
        if host:
            found.append((host, int(port)))
    return found


@dataclass
class Isolation:
    """Изоляция: `None` — ещё не проверяли, `True` — ни одна цель не ответила, `False` — ответила."""

    canaries: list[tuple[str, int]]
    attempt: float = ATTEMPT
    period: float = PERIOD
    isolated: bool | None = None
    reached: list[str] = field(default_factory=list)
    checked: float | None = None
    _first: asyncio.Event = field(default_factory=asyncio.Event)

    async def check(self) -> bool:
        """Одна проверка всех целей разом; хоть одна соединилась — изоляции нет."""
        answers = await asyncio.gather(*(self._reaches(host, port) for host, port in self.canaries))
        reached = [f"{host}:{port}" for (host, port), ok in zip(self.canaries, answers) if ok]
        if reached and self.isolated is not False:
            logger.error(
                "плеер страниц: изоляции нет — открыто соединение к %s; страницы не открываются", reached
            )
        self.reached = reached
        self.isolated = not reached
        self.checked = time.time()
        self._first.set()
        return self.isolated

    async def ready(self) -> bool:
        """Изолирован ли плеер страниц; первую проверку подождать (при старте она идёт секунды)."""
        if self.isolated is None:
            with contextlib.suppress(TimeoutError):
                async with asyncio.timeout(self.attempt + 1.0):
                    await self._first.wait()
        return self.isolated is True

    async def watch(self) -> None:
        """Проверять при старте и раз в `period`, пока жив процесс."""
        while True:
            try:
                await self.check()
            except Exception:  # своя проверка не должна гасить сервер — только закрыть страницы
                logger.exception("плеер страниц: самопроверка изоляции упала")
                self.isolated = False
                self._first.set()
            await asyncio.sleep(self.period)

    def state(self) -> dict[str, object]:
        return {"isolated": self.isolated is True, "reached": list(self.reached), "checked": self.checked}

    async def _reaches(self, host: str, port: int) -> bool:
        try:
            async with asyncio.timeout(self.attempt):
                _, writer = await asyncio.open_connection(host, port)
        except (OSError, TimeoutError):
            return False
        writer.close()
        with contextlib.suppress(Exception):
            await writer.wait_closed()
        return True
