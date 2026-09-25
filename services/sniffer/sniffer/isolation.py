"""
Самопроверка изоляции: без стены своей подсети и при соседях, до которых можно дотянуться, плеер страниц
не открывает ни одной страницы.

ЗАЧЕМ. Браузер здесь без своей песочницы, и между кодом чужой страницы и сетью хоста стоит стена, которую
ставит не этот контейнер: своя подсеть (compose.yaml, `CINEMA_SNIFFER_SUBNET`) и правила хоста
(`infra/sniffer-firewall.sh`: DOCKER-USER для пересылаемого и INPUT для самого хоста). Её могут не
поставить (первая выкатка руками, другой хост) или она может не встать (единица упала при загрузке).
Поэтому проверок две, и нужны обе:

- МЕТКА СТЕНЫ. Скрипт стены, проверив свои правила, пишет на хосте `/run/cord-sniffer/<подсеть>`; каталог
  смонтирован сюда только для чтения (`WALLS`). Нет метки подсети, в которой стоит сам контейнер, — стены
  нет. Метка смотрится при каждой странице и каждые `MARK` секунд: снятая метка закрывает страницы сразу,
  появившаяся — открывает без ожидания полной проверки. Это то, чего не видно изнутри: правила DOCKER-USER.
- ПРОБЫ. При старте и раз в `PERIOD` — короткое TCP-соединение к адресам, которые должны быть закрыты:
  шлюз своей подсети на портах соседних служб хоста и метаданные облака. Соединилось хоть одно — изоляции
  нет, как бы ни была поставлена стена. Отказ или молчание значит «туда не пустили или там никого»: это
  сторожевая лампочка, а не доказательство.

Без изоляции `/sniff` отвечает 503 «изоляция не настроена», страница не открывается, а служба отвечает
то, что сказал yt-dlp. Цели проб — `CINEMA_SNIFFER_CANARIES`: `хост:порт` через запятую, `gateway` — шлюз
подсети контейнера.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import socket
import struct
import time
from dataclasses import dataclass, field
from ipaddress import ip_address, ip_network
from pathlib import Path
from typing import Callable

logger = logging.getLogger(__name__)

# Порты соседних служб хоста, которым доверяют сети docker 172.16.0.0/12 (llm-bridge и graphify MCP на
# этой машине), и метаданные облака.
CANARIES = "gateway:8090,gateway:8091,169.254.169.254:80"
# Сколько ждать одно соединение, как часто проверять снова и как часто смотреть метку стены.
ATTEMPT = 2.0
PERIOD = 300.0
MARK = 5.0
ROUTES = "/proc/net/route"
# Каталог меток стены на хосте — тот же путь и в контейнере (compose.yaml, только чтение).
WALLS = "/run/cord-sniffer"
# Больше меток не читается: их пишет root хоста, по одной на подсеть; имя — подсеть с `_` вместо `/`.
MARKS = 16
MARK_NAME = re.compile(r"\d{1,3}(?:\.\d{1,3}){3}_\d{1,2}")
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


def own_address() -> str | None:
    """Свой адрес в сети контейнера — тот, с которого ушёл бы пакет наружу (UDP connect ничего не шлёт)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("192.0.2.1", 9))
            return probe.getsockname()[0]
    except OSError:
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
    """
    Изоляция: `None` — ещё не проверяли, `True` — стена отмечена и ни одна цель не ответила, `False` — нет.
    `walls` — каталог меток стены (`None` — метка не нужна: так только в тестах самих проб); `address` —
    откуда брать свой адрес.
    """

    canaries: list[tuple[str, int]]
    attempt: float = ATTEMPT
    period: float = PERIOD
    walls: Path | None = None
    address: Callable[[], str | None] = own_address
    mark: float = MARK
    isolated: bool | None = None
    walled: bool | None = None
    reached: list[str] = field(default_factory=list)
    checked: float | None = None
    _first: asyncio.Event = field(default_factory=asyncio.Event)

    async def check(self) -> bool:
        """Одна проверка: метка стены и все цели разом. Нет метки или соединилась хоть одна цель — отказ."""
        walled = self.marked()
        answers = await asyncio.gather(*(self._reaches(host, port) for host, port in self.canaries))
        reached = [f"{host}:{port}" for (host, port), ok in zip(self.canaries, answers) if ok]
        isolated = walled and not reached
        if not isolated and self.isolated is not False:
            if not walled:
                logger.error(
                    "плеер страниц: стены сети нет — в %s нет метки подсети адреса %s; страниц нет",
                    self.walls,
                    self.address(),
                )
            if reached:
                logger.error(
                    "плеер страниц: изоляции нет — открыто соединение к %s; страницы не открываются", reached
                )
        self.walled = walled
        self.reached = reached
        self.isolated = isolated
        self.checked = time.time()
        self._first.set()
        return isolated

    async def ready(self) -> bool:
        """Изолирован ли плеер страниц: метка — сразу, первую проверку — подождать (при старте — секунды)."""
        if not self.marked():
            return False
        if self.isolated is None:
            with contextlib.suppress(TimeoutError):
                async with asyncio.timeout(self.attempt + 1.0):
                    await self._first.wait()
        return self.isolated is True

    async def watch(self) -> None:
        """Проверять при старте и раз в `period`, а метку — каждые `mark`: изменилась — проверить сразу."""
        while True:
            try:
                await self.check()
            except Exception:  # своя проверка не должна гасить сервер — только закрыть страницы
                logger.exception("плеер страниц: самопроверка изоляции упала")
                self.isolated = False
                self._first.set()
            seen = self.marked()
            waited = 0.0
            while waited < self.period:
                step = min(self.mark, self.period - waited)
                await asyncio.sleep(step)
                waited += step
                if self.marked() != seen:
                    break

    def marked(self) -> bool:
        """
        Есть ли метка стены подсети, в которой стоит сам контейнер. Метка — только файл с именем подсети
        (`10.231.0.0_24`) и ею же внутри: недописанный или переименованный файл (`.10.231.0.0_24.new`) не
        считается, иначе метку, которую снял скрипт, заменил бы её след.
        """
        if self.walls is None:
            return True
        own = self.address()
        if own is None:
            return False
        try:
            names = sorted(entry.name for entry in self.walls.iterdir() if MARK_NAME.fullmatch(entry.name))
        except OSError:
            return False
        for name in names[:MARKS]:
            subnet = name.replace("_", "/")
            try:
                with (self.walls / name).open("rb") as file:
                    text = file.read(64).decode("ascii").strip()
                if text == subnet and ip_address(own) in ip_network(subnet, strict=False):
                    return True
            except (OSError, ValueError, UnicodeDecodeError):
                continue
        return False

    def state(self) -> dict[str, object]:
        return {
            "isolated": self.isolated is True,
            "walled": self.walled,
            "reached": list(self.reached),
            "checked": self.checked,
        }

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
