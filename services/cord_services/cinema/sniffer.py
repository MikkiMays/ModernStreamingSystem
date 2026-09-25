"""
Плеер страниц со стороны службы: спросить контейнер `sniffer`, какой поток спросил плеер страницы, — и
помнить, с какими заголовками его спрашивать.

КОГДА. Только у площадки «По ссылке» и только после yt-dlp: он не нашёл видео, сайт ответил ему 403, его
разборщик не понял страницу или упал, файл страницы не отдался без её cookies (`providers/link.py`). Отказы,
которые yt-dlp понял — DRM, вход, капча, страна, «страницы нет», — остаются отказами: браузер их не лечит, а
обходить их кинозал не станет.

ОТВЕТ КОНТЕЙНЕРА — ЧУЖОЙ. Плеер страниц исполняет код страницы, которую вставил любой участник, и его ответ
проверяется здесь целиком (`Sight.parse`): адреса — как у ссылки кинозала (`address.web`), заголовки —
печатным ASCII и с пределами (дальше они станут заголовками наших запросов), cookies — по хостам и с
пределом, тело ответа — не больше `ANSWER_LIMIT`. Всё, что не прошло, просто отбрасывается.

ПРОФИЛЬ ЗАГОЛОВКОВ (`Profile`). Referer, Origin и имя браузера, с которыми плеер страницы спросил поток, и
cookies, которые браузер послал хостам потока. Прокси подставляет их в каждый запрос этого потока — мастер,
варианты, кусочки, ключи: адреса потока подписаны с номером профиля (`h`), и подменить номер нельзя. Cookie
уходит только тому хосту, которому её послал браузер. Профили — в памяти процесса (`Profiles`), не на диске:
cookies чужого сайта хранить незачем; служба перезапустилась — поток спросит плеер страниц снова.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any, Mapping
from urllib.parse import urlsplit

import httpx

from . import address
from .transport.signer import SIGNATURE_TTL

logger = logging.getLogger(__name__)

# Срок страницы у плеера (`services/sniffer/sniffer/page.py`, `SECONDS`) и сколько сверх него ждать ответа:
# закрыть вкладку и отдать ответ — ещё секунды.
SNIFF_SECONDS = 25.0
ANSWER_SECONDS = SNIFF_SECONDS + 10.0
# Больше ответ плеера страниц не бывает: шестнадцать потоков и шестнадцать хостов с cookie.
ANSWER_LIMIT = 256 * 1024
# Страниц разом на службу — как у контейнера; ждать места не дольше `WAIT`.
PLACES = 2
WAIT = 10.0
# Профили: сколько их помнить, сколько байт cookies у одного и сколько живёт профиль — дольше подписи
# адреса потока: фильм, открытый под конец её срока, досматривается до его конца.
PROFILES = 256
PROFILE_COOKIES = 16 * 1024
PROFILE_TTL = SIGNATURE_TTL + 3600

STREAMS = 16
HOSTS = 16
LONGEST_AGENT = 512
LONGEST_ORIGIN = 300
LONGEST_COOKIE = 4096
LONGEST_TITLE = 300
KINDS = frozenset({"hls", "dash", "file"})
EXTENSIONS = frozenset(
    {"mp4", "m4v", "webm", "mov", "m4a", "mp3", "ogg", "oga", "opus", "aac", "flac", "wav"}
)
PRINTABLE = re.compile(r"[\x20-\x7e]*")
ORIGIN = re.compile(r"https?://[A-Za-z0-9.\-\[\]:]+")
HOST = re.compile(r"[a-z0-9.\-:\[\]]{1,253}")


def key_for(secret: str) -> str:
    """
    Ключ входа службы в плеер страниц: HMAC-SHA256 от секрета установки с меткой назначения. Та же формула
    у контейнера (`services/sniffer/sniffer/entry.py`): сам секрет туда не попадает, только этот ключ.
    """
    return hmac.new(secret.encode(), b"cord-cinema-sniffer", hashlib.sha256).hexdigest()


def _safe(value: Any, limit: int) -> str:
    """Значение, которое можно поставить заголовком: печатное ASCII, не длиннее предела; иначе пусто."""
    text = value.strip() if isinstance(value, str) else ""
    return text if len(text) <= limit and PRINTABLE.fullmatch(text) else ""


@dataclass(frozen=True)
class Profile:
    """Заголовки, с которыми плеер страницы спрашивал поток: наш прокси спрашивает с теми же."""

    id: str
    referer: str = ""
    origin: str = ""
    agent: str = ""
    # Хост → заголовок Cookie, как его послал браузер. Другим хостам cookie не уходит никогда.
    cookies: Mapping[str, str] = field(default_factory=dict, repr=False)

    def headers_for(self, url: str) -> dict[str, str]:
        found: dict[str, str] = {}
        if self.agent:
            found["User-Agent"] = self.agent
        if self.referer:
            found["Referer"] = self.referer
        if self.origin:
            found["Origin"] = self.origin
        cookie = self.cookies.get((urlsplit(url).hostname or "").lower())
        if cookie:
            found["Cookie"] = cookie
        return found

    def public(self) -> dict[str, str]:
        """Что из профиля можно хранить на диске: всё, кроме cookies."""
        return {"referer": self.referer, "origin": self.origin, "agent": self.agent}

    @classmethod
    def restored(cls, profile_id: str, stored: Any) -> Profile:
        """Профиль без cookies — из записи ссылки (`public`), проверенный заново."""
        stored = stored if isinstance(stored, dict) else {}
        return cls(profile_id, **_headers(stored.get("referer"), stored.get("origin"), stored.get("agent")))


class Profiles:
    """Профили потоков по номеру потока — в памяти процесса, с пределом числа и сроком."""

    def __init__(self, capacity: int = PROFILES, ttl: float = PROFILE_TTL):
        self.capacity = capacity
        self.ttl = ttl
        self._items: dict[str, tuple[float, Profile]] = {}

    def put(self, profile: Profile) -> None:
        self._items.pop(profile.id, None)
        self._items[profile.id] = (time.monotonic() + self.ttl, profile)
        while len(self._items) > self.capacity:
            self._items.pop(next(iter(self._items)))

    def get(self, profile_id: str) -> Profile | None:
        found = self._items.get(profile_id)
        if found is None:
            return None
        if found[0] <= time.monotonic():
            del self._items[profile_id]
            return None
        return found[1]

    def forget(self, profile_id: str) -> None:
        self._items.pop(profile_id, None)


@dataclass(frozen=True)
class Seen:
    """Поток, который спросил плеер страницы: адрес, вид и заголовки его запроса."""

    url: str
    kind: str
    master: bool | None = None
    heights: tuple[int, ...] = ()
    ext: str = ""
    referer: str = ""
    origin: str = ""
    agent: str = ""


@dataclass(frozen=True)
class Sight:
    """Ответ плеера страниц — проверенный."""

    page: str = ""
    status: int | None = None
    title: str = ""
    poster: str = ""
    duration: float | None = None
    drm: bool = False
    robot: bool = False
    login: bool = False
    inside: bool = False
    unreachable: bool = False
    streams: tuple[Seen, ...] = ()
    cookies: Mapping[str, str] = field(default_factory=dict, repr=False)

    @classmethod
    def parse(cls, data: Any) -> Sight:
        if not isinstance(data, dict):
            return cls()
        status = data.get("status")
        duration = data.get("duration")
        page = data.get("page")
        poster = data.get("poster")
        return cls(
            page=page if isinstance(page, str) and address.web(page) else "",
            status=status if isinstance(status, int) and 100 <= status <= 599 else None,
            title=_title(data.get("title")),
            poster=poster if isinstance(poster, str) and address.web(poster) else "",
            duration=float(duration)
            if isinstance(duration, (int, float)) and 0 < duration < 7 * 86400
            else None,
            drm=data.get("drm") is True,
            robot=data.get("robot") is True,
            login=data.get("login") is True,
            inside=data.get("inside") is True,
            unreachable=data.get("unreachable") is True,
            streams=_streams(data.get("streams")),
            cookies=_cookies(data.get("cookies")),
        )


def _title(value: Any) -> str:
    text = value if isinstance(value, str) else ""
    return re.sub(r"\s+", " ", re.sub(r"[\x00-\x1f\x7f]", " ", text)).strip()[:LONGEST_TITLE]


def _headers(referer: Any, origin: Any, agent: Any) -> dict[str, str]:
    found = {"referer": _safe(referer, address.LONGEST), "origin": _safe(origin, LONGEST_ORIGIN)}
    if found["referer"] and not address.web(found["referer"]):
        found["referer"] = ""
    if found["origin"] and not ORIGIN.fullmatch(found["origin"]):
        found["origin"] = ""
    found["agent"] = _safe(agent, LONGEST_AGENT)
    return found


def _streams(value: Any) -> tuple[Seen, ...]:
    found: list[Seen] = []
    for item in value[:STREAMS] if isinstance(value, list) else []:
        if not isinstance(item, dict):
            continue
        url, kind = item.get("url"), item.get("type")
        if not isinstance(url, str) or not address.web(url) or kind not in KINDS:
            continue
        headers = item.get("headers") if isinstance(item.get("headers"), dict) else {}
        master = item.get("master")
        found.append(
            Seen(
                url=url,
                kind=kind,
                master=master if isinstance(master, bool) else None,
                heights=_heights(item.get("heights")),
                ext=item["ext"] if item.get("ext") in EXTENSIONS else "",
                **_headers(headers.get("referer"), headers.get("origin"), headers.get("user-agent")),
            )
        )
    return tuple(found)


def _heights(value: Any) -> tuple[int, ...]:
    sides = value[:12] if isinstance(value, list) else []
    return tuple(side for side in sides if type(side) is int and 0 < side <= 8640)


def _cookies(value: Any) -> dict[str, str]:
    """Cookies по хостам — только годные и не больше `PROFILE_COOKIES` байт вместе."""
    found: dict[str, str] = {}
    spent = 0
    for host, cookie in list(value.items())[:HOSTS] if isinstance(value, dict) else []:
        if not isinstance(host, str) or not HOST.fullmatch(host):
            continue
        cookie = _safe(cookie, LONGEST_COOKIE)
        if not cookie or spent + len(cookie) > PROFILE_COOKIES:
            continue
        spent += len(cookie)
        found[host] = cookie
    return found


class SnifferError(Exception):
    """Плеер страниц не ответил по делу."""


class Down(SnifferError):
    """
    Плеер страниц недоступен, настроен не так или не изолирован (его самопроверка дотянулась до сети хоста):
    тогда остаётся ответ yt-dlp.
    """


class Crowded(SnifferError):
    """Все места плеера страниц заняты дольше, чем стоит ждать."""


class Replaced(SnifferError):
    """Страницу этой комнаты сменила следующая."""


class Sniffer:
    """
    Клиент контейнера `sniffer`: не больше `PLACES` страниц разом (место ждётся в цикле событий не дольше
    `WAIT`), ответ — не больше `ANSWER_LIMIT` и не дольше `ANSWER_SECONDS`. Адрес контейнера — из настройки
    (`CINEMA_SNIFFER_URL`, у compose — `127.0.0.1:18103`), а не от человека: защиты «только наружу» этому
    клиенту не нужно, и ходит он не через клиентов площадок.
    """

    def __init__(
        self,
        url: str,
        key: str,
        *,
        client: httpx.AsyncClient | None = None,
        places: int = PLACES,
        wait: float = WAIT,
    ):
        self.url = url.rstrip("/")
        self.key = key
        self.client = client or httpx.AsyncClient(
            timeout=httpx.Timeout(ANSWER_SECONDS, connect=3.0), trust_env=False, follow_redirects=False
        )
        self.places = places
        self.wait = wait
        self._slots: asyncio.Semaphore | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    async def look(self, page: str, room: str) -> Sight:
        slots = self._semaphore()
        try:
            async with asyncio.timeout(self.wait):
                await slots.acquire()
        except TimeoutError:
            raise Crowded() from None
        try:
            return await self._ask(page, room)
        finally:
            slots.release()

    async def close(self) -> None:
        await self.client.aclose()

    def _semaphore(self) -> asyncio.Semaphore:
        loop = asyncio.get_running_loop()
        if self._slots is None or self._loop is not loop:
            self._slots, self._loop = asyncio.Semaphore(self.places), loop
        return self._slots

    async def _ask(self, page: str, room: str) -> Sight:
        # Комната для контейнера — только ключ очереди: её номер ему знать незачем.
        queue = hashlib.sha256(room.encode()).hexdigest()[:32] if room else ""
        try:
            async with asyncio.timeout(ANSWER_SECONDS):
                async with self.client.stream(
                    "POST",
                    f"{self.url}/sniff",
                    json={"url": page, "room": queue},
                    headers={"Authorization": f"Bearer {self.key}", "Accept-Encoding": "identity"},
                ) as response:
                    if response.status_code == 503:
                        if response.headers.get("x-cord-isolation") == "broken":
                            logger.error("кинозал: плеер страниц не изолирован от сети хоста — страниц нет")
                            raise Down()
                        raise Crowded()
                    if response.status_code == 409:
                        raise Replaced()
                    if response.status_code != 200:
                        if response.status_code == 401:
                            logger.error("кинозал: плеер страниц не принял ключ службы — страниц не видно")
                        raise Down()
                    body = await _read(response)
            data = json.loads(body)
        except (httpx.HTTPError, TimeoutError, ValueError):
            raise Down() from None
        return Sight.parse(data)


async def _read(response: httpx.Response) -> bytes:
    """Ответ несжатым и не больше `ANSWER_LIMIT`: сжатый не читается вовсе (кусок «бомбы» — мегабайты)."""
    if response.headers.get("content-encoding", "identity").strip().lower() not in ("", "identity"):
        raise Down()
    body = bytearray()
    async for chunk in response.aiter_bytes():
        body.extend(chunk)
        if len(body) > ANSWER_LIMIT:
            raise Down()
    return bytes(body)
