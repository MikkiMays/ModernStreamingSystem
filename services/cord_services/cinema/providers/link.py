"""
«По ссылке»: страница из открытого интернета, которую понял yt-dlp, — нашим плеером и всей комнатой.

ЧТО ЗДЕСЬ. Ссылку своей площадки узнаёт её грамматика (`Provider.match`), и сюда она не доходит.
Остальное разбирает yt-dlp — всеми своими разборщиками, включая `generic`, который читает
произвольную страницу: `<video>`, плейлисты HLS и манифесты, разметку видео, встроенные плееры
других сайтов. Встроенный плеер своей площадки (YouTube, Rutube, VK, Twitch) уходит в её сцену тем
же `match` на каждом шаге разбора: блог с роликом Rutube открывается страницей Rutube, а не здесь.

КАК ХОДИТ НАРУЖУ. Только через охраняемый выход (`egress.py`): страницу вставил любой участник, и без
проверки на каждом соединении она увела бы yt-dlp внутрь сети службы. Поток потом едет нашим прокси
(`HostPolicy.public_any`: любой публичный хост, проверка при соединении), подписанный как у всех.

НОМЕР ССЫЛКИ. В комнату и в ядро уходит не адрес, а непрозрачный номер: 22 знака HMAC от адреса на
ключе службы (`identify`). Номер → адрес и что нашлось — в сторе службы на сутки (`store.Links`), и
поток разбирается снова только по номеру: адресу, присланному браузером, служба не верит никогда.

ЧТО ОТДАЁТ. Карточку для сцены «По ссылке»: имя, сайт, постер, длительность, ступени качества,
дорожки звука и субтитры (`wire.link_card`); идущий эфир — `channel`; плейлист — `series`, и его
серии отдаёт маршрут `series` (номер каждой серии заводится, когда её порцию спросили). DRM — отказ
словами (`drm.py`); вход, подписка, капча и запрет по стране — тоже отказ: их кинозал не обходит.

ПРЕДЕЛЫ. Разбор ссылки — дорогое: секунды yt-dlp и запросы к чужому сайту. Поэтому у комнаты — один
разбор разом и `PER_MINUTE` в минуту, у разбора — `LEASE_SECONDS` (дальше выход закрывает его
соединения), а одинаковая ссылка, которую уже разобрали, отвечает из памяти и в счёт не идёт.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import itertools
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable
from urllib.parse import urlsplit, urlunsplit

from fastapi import HTTPException

from .. import address, wire
from ..captions import CAPTIONS_LIMIT, SUBTITLE_FORMATS, _base_language
from ..egress import LEASE_SECONDS
from ..limits import Window
from ..paging import PAGE
from ..registry import Ctx, Features, HostPolicy, Kit, Provider
from ..resolve import (
    EXPIRED,
    INSIDE,
    Inside,
    Protected,
    SourcePlan,
    frame_side,
    playable_file,
    refusal,
    ytdlp,
)
from ..drm import DRM

logger = logging.getLogger(__name__)

# Номер ссылки: 22 знака base64url — 132 бита HMAC, угадать или подобрать нельзя.
LINK_ID = re.compile(r"[A-Za-z0-9_-]{22}")
# Сколько помнится номер ссылки и её серий: сутки от последнего обращения.
TTL = 24 * 3600
# Больше серий из одного плейлиста не берётся: на странице их листают порциями, а тысяча серий —
# это уже не сериал, а архив канала, и у него есть своя площадка.
EPISODES = 200
# Сколько шагов «страница → встроенный плеер → его страница» проходит разбор.
HOPS = 5
PER_MINUTE = 10
# Весь ответ о ссылке: разбор (`LEASE_SECONDS`) и проверка потока на DRM после него.
INSPECTION_SECONDS = LEASE_SECONDS + 10
# Сколько помнится ответ о ссылке: её вставляют разом все, кто в комнате.
ANSWER_TTL = 300
# Кем представляются и разбор, и прокси потока: своим именем, а не браузером. Проверено 25.09.2026:
# Wikimedia на «Chrome» с сервера отвечает 403 «Please respect our robot policy», а честное имя
# пускает; Дзен (CDN okcdn) выдаёт адрес под то имя, которым его спросили (`srcAg=UNKNOWN` вместо
# `CHROME`), и отдаёт поток тому же имени — важно лишь, чтобы разбор и поток шли одним именем.
AGENT = "CordCinema/1.0 (+https://github.com/MikkiMays/ModernStreamingSystem)"
# Готовые файлы, которые играет браузер, — лучший первым: `mp4` открывают и телефоны.
PLAYABLE = ("mp4", "m4v", "webm", "mov")
OPTIONS = {
    "quiet": True,
    "no_warnings": True,
    "skip_download": True,
    # Ролик внутри плейлиста — это ролик: его и видно по ссылке. Чистый плейлист — список серий.
    "noplaylist": True,
    "cachedir": False,
    "socket_timeout": 15,
    # yt-dlp иногда пробует скачать кусочек формата, чтобы проверить его, — нам нужен только список.
    "check_formats": False,
    "http_headers": {"User-Agent": AGENT},
}

NOTHING = "На этой странице не нашлось видео, которое можно показать комнате"
GONE = "Ссылка устарела — вставьте её в кинозал ещё раз"
UPCOMING = "Эфир ещё не начался — откройте ссылку, когда он пойдёт"
GEO = "Сайт не показывает это видео в стране сервера"
LOGIN = "Видео открывается только после входа или по подписке на самом сайте — такое кинозал не открывает"
ROBOT = "Сайт просит подтвердить, что вы не робот, — откройте видео на самом сайте"
MISSING = "Страница не найдена: сайт ответил, что её нет"
# 403 на саму страницу: сайт не пускает программы (или сервер из его страны) — кинозал представляется
# честно, своим именем, и чужим браузером не притворяется (см. `AGENT`).
FORBIDDEN = "Сайт не пустил кинозал к этой странице (403) — откройте видео на самом сайте"
BROKEN = "Разборщик этого сайта не справился со страницей — попробуйте позже или другую ссылку"
SILENT = "Сайт не ответил вовремя или оборвал связь — попробуйте ещё раз"
OFF = "Разбор ссылок на этом сервере выключен"
BUSY_ROOM = "Комната уже разбирает ссылку — дождитесь ответа"
TOO_OFTEN = "Комната слишком часто разбирает ссылки, подождите минуту"

# Узнаются по тексту yt-dlp — английскому, как его пишут разборщики. Регистр не важен.
LOGIN_WORDS = re.compile(
    r"log ?in|sign ?in|members[- ]only|subscri|premium|private video|this video is private|"
    r"authenticat|--cookies|--username",
    re.IGNORECASE,
)
ROBOT_WORDS = re.compile(r"captcha|cloudflare|anti-bot|not a bot|verify you are human", re.IGNORECASE)
# Так urllib3 и сокеты говорят о молчании и обрыве сети — английским текстом с адресом внутри.
NETWORK_WORDS = re.compile(
    r"timed out|connection (?:refused|reset|aborted)|remote ?disconnected|name resolution|"
    r"name or service not known|failed to resolve|network is unreachable",
    re.IGNORECASE,
)
# Так yt-dlp говорит, что его разборщик не понял страницу сайта, которую знает: сайт поменялся.
BROKEN_WORDS = re.compile(r"please report this issue|unable to extract", re.IGNORECASE)
# Дата и время, которые yt-dlp дописывает к имени идущего эфира (`YoutubeDL.process_video_result`).
STAMP = re.compile(r" \d{4}-\d{2}-\d{2} \d{2}:\d{2}$")

Route = Callable[[str], "dict[str, Any] | None"]
Settle = Callable[[SourcePlan, dict[str, Any], str], Awaitable[dict[str, Any]]]


class Link(Provider):
    id = "link"
    name = "По ссылке"
    hosts = HostPolicy(public_any=True)
    features = Features(search=False, series=True, live=True)
    content_id = LINK_ID
    refusals = {
        "search": "По ссылке не ищут — вставьте адрес страницы с видео",
        "channels": "У ссылок каналов нет — вставьте адрес страницы с видео",
        "playlists": "Плейлист по ссылке открывается списком серий",
        "categories": "У ссылок разделов нет",
    }
    user_agent = AGENT
    follows_redirects = True
    refuses_drm = True

    def __init__(self, kit: Kit):
        super().__init__(kit)
        self.links = kit.links if kit.links is not None else MemoryLinks()
        self.key = kit.key or b"cord-cinema"
        self.egress = kit.egress
        self.window = Window(PER_MINUTE, 60.0, TOO_OFTEN)
        # Комнаты, у которых разбор идёт прямо сейчас: второй разом — отказ, а не очередь.
        self.busy: set[str] = set()

    def identify(self, url: str, item: int | None = None) -> str:
        """
        Номер ссылки: HMAC от адреса на ключе службы. Одна страница — один номер у всех комнат (и одна
        общая память на её разбор); якорь (`#…`), регистр хоста и порт по умолчанию номер не меняют.
        Серия страницы без своего адреса — это адрес страницы и номер серии в ней.
        """
        normal = _normal(url) + (f"\x00{item}" if item else "")
        digest = hmac.new(self.key, b"link\x00" + normal.encode(), hashlib.sha256).digest()
        return base64.urlsafe_b64encode(digest).decode().rstrip("=")[:22]

    # --- ответ о ссылке -----------------------------------------------------------------

    async def inspect(self, ctx: Ctx, url: str, route: Route, settle: Settle) -> dict[str, Any]:
        """
        Что по ссылке: `{"item": карточка}`, `{"route": …}` (встроенный плеер своей площадки) или
        `{"item": None, "reason": …}` — почему это не показать комнате.

        Предел комнаты — только на новый разбор: ответ, который уже есть или уже считается (ссылку
        вставили соседи по комнате), ничего наружу не стоит.
        """
        if self.egress is None:
            return {"item": None, "reason": OFF}
        key = f"inspect:{self.identify(url)}"
        charged = not self.memo.known(key)
        if charged:
            self._admit(ctx.room)
        try:
            return await self.memo.get(key, lambda: self._inspect(ctx, url, route, settle), ANSWER_TTL)
        finally:
            if charged:
                self.busy.discard(ctx.room)

    def _admit(self, room: str) -> None:
        if room in self.busy:
            raise HTTPException(429, BUSY_ROOM, headers={"Retry-After": "5"})
        self.window.take(room)
        self.busy.add(room)

    async def _inspect(self, ctx: Ctx, url: str, route: Route, settle: Settle) -> dict[str, Any]:
        assert self.egress is not None
        started = time.monotonic()
        await self.egress.start()
        try:
            async with asyncio.timeout(INSPECTION_SECONDS):
                walk = await asyncio.to_thread(
                    self.ytdlp.run, self.id, OPTIONS, lambda ydl: _walk(ydl, url, route)
                )
                if walk.route is not None:
                    return walk.route
                if walk.playlist is not None:
                    return self._series(url, walk, route)
                assert walk.info is not None
                return await self._video(url, walk.info, settle)
        except TimeoutError:
            raise HTTPException(504, EXPIRED) from None
        except HTTPException:
            raise
        except Exception as error:  # yt-dlp поднимает свои типы; наружу — слова, а не трассировка
            return self._refused(url, error, time.monotonic() - started)

    async def _video(self, url: str, info: dict[str, Any], settle: Settle) -> dict[str, Any]:
        """Одно видео: разобрать поток в общую память, запомнить номер — и только тогда карточка."""
        if info.get("live_status") == "is_upcoming":
            return {"item": None, "reason": UPCOMING}
        item_id = self.identify(url)
        record: dict[str, Any] = {
            "url": url,
            "author": _author(info),
            "thumbnail": _thumbnail(info),
            "description": (info.get("description") or "")[:1200],
            "site": site(url),
        }
        try:
            # Поток разбирается сразу, тем же ответом yt-dlp: «Смотреть вместе» после карточки не
            # ждёт второго разбора, DRM и «нечего играть» видны раньше, чем карточка, а эфир у чужого
            # HLS узнаётся только по его списку кусочков.
            source = await settle(self._plan(record), info, item_id)
        except HTTPException as error:
            if error.status_code in (403, 502):
                return {"item": None, "reason": error.detail}
            raise
        live = bool(source["live"])
        kind = "channel" if live else "video"
        record["kind"] = kind
        record["title"] = _title(info, url, live)
        record["duration"] = None if live else _number(info.get("duration"))
        self.links.put(item_id, record, TTL)
        card = wire.card(
            self.id,
            kind,
            item_id,
            record["title"],
            author=record["author"],
            duration=record["duration"],
            live=live,
            viewers=_count(info.get("concurrent_view_count")) if live else None,
            views=_count(info.get("view_count")),
            poster=self.image(record["thumbnail"] or ""),
            description=record["description"],
            published=info.get("upload_date") or None,
        )
        formats = info.get("formats") or []
        return {
            "item": wire.link_card(
                card,
                site=record["site"],
                qualities=qualities(formats),
                audio=audio_tracks(formats),
                captions=caption_tracks(info),
            )
        }

    def _series(self, url: str, walk: Walk, route: Route) -> dict[str, Any]:
        """Плейлист: серии запоминаются списком, номер каждой — когда её порцию спросят (`series`)."""
        playlist = walk.playlist or {}
        entries = [
            found
            for index, entry in enumerate(walk.entries, 1)
            if (found := _episode(entry, index, url, route)) is not None
        ]
        if not entries:
            return {"item": None, "reason": NOTHING}
        series_id = self.identify(url)
        record = {
            "kind": "series",
            "url": url,
            "title": playlist.get("title") or f"Видео с {site(url)}",
            "thumbnail": _thumbnail(playlist)
            or next((e["thumbnail"] for e in entries if e["thumbnail"]), ""),
            "description": (playlist.get("description") or "")[:1200],
            "author": _author(playlist),
            "site": site(url),
            "entries": entries,
        }
        self.links.put(series_id, record, TTL)
        card = wire.card(
            self.id,
            "series",
            series_id,
            record["title"],
            author=record["author"],
            poster=self.image(record["thumbnail"] or ""),
            count=len(entries),
            description=record["description"],
        )
        return {"item": wire.link_card(card, site=record["site"])}

    def _refused(self, url: str, error: Exception, spent: float) -> dict[str, Any]:
        """Отказ yt-dlp — словами: что это свойство страницы — ответом, что сбой — ошибкой."""
        known = refusal(error)
        if isinstance(error, (Inside, Protected)):
            return {"item": None, "reason": INSIDE if isinstance(error, Inside) else DRM}
        if known is not None:
            raise known from None
        cause = getattr(error, "exc_info", None)
        original = cause[1] if cause and len(cause) > 1 and cause[1] is not None else error
        kind = type(original).__name__
        text = str(original)
        # Имя сайта и вид отказа — без адреса и текста yt-dlp: в них бывают ключи из ссылки.
        logger.info("кинозал: ссылка с %s не разобрана: %s (%.1f с)", site(url), kind, spent)
        if kind == "UnsupportedError" or "No video formats found" in text or "Unsupported URL" in text:
            return {"item": None, "reason": NOTHING}
        if kind == "GeoRestrictedError" or "not available in your country" in text.lower():
            return {"item": None, "reason": GEO}
        if ROBOT_WORDS.search(text):
            return {"item": None, "reason": ROBOT}
        if LOGIN_WORDS.search(text):
            return {"item": None, "reason": LOGIN}
        if "HTTP Error 404" in text or "HTTP Error 410" in text:
            return {"item": None, "reason": MISSING}
        if "HTTP Error 403" in text:
            return {"item": None, "reason": FORBIDDEN}
        if NETWORK_WORDS.search(text):
            # Молчание и обрыв — не свойство страницы, а сбой: ответ не запоминается, и повтор возможен.
            raise HTTPException(502, SILENT) from None
        if not _from_yt_dlp(original) or BROKEN_WORDS.search(text):
            # Не отказ сайта, а поломка разборщика (`TypeError` в его коде, «Unable to extract…»): сайт
            # поменялся быстрее, чем yt-dlp. Сказать об этом можно, а показать трассировку — нечего.
            raise HTTPException(502, BROKEN) from None
        raise HTTPException(502, f"Сайт не отдал видео: {self.ytdlp.explain(text)}"[:300]) from None

    # --- страницы сцены -----------------------------------------------------------------

    async def series(self, ctx: Ctx, series_id: str, season: str | None, offset: int) -> wire.SeriesPage:
        """Серии плейлиста порцией. Каждая серия без своей площадки получает номер здесь — и на сутки."""
        record = self.links.get(series_id)
        if not record or record.get("kind") != "series":
            raise HTTPException(410, GONE)
        entries = record.get("entries") or []
        cards: list[wire.Card] = []
        fresh: dict[str, dict[str, Any]] = {}
        for number, entry in enumerate(entries[offset : offset + PAGE], offset + 1):
            poster = self.image(entry.get("thumbnail") or "")
            routed = entry.get("route")
            if routed:
                # Серия своей площадки: её карточка — той площадки, и включает её та площадка.
                cards.append(
                    wire.card(
                        routed["provider"],
                        routed["kind"],
                        routed["id"],
                        entry["title"],
                        duration=entry.get("duration"),
                        live=routed["kind"] == "channel",
                        poster=poster,
                    )
                )
                continue
            episode_id = self.identify(entry["url"], entry.get("item"))
            fresh[episode_id] = {
                "kind": "video",
                "url": entry["url"],
                "item": entry.get("item"),
                "title": entry["title"],
                "author": record.get("author") or "",
                "duration": entry.get("duration"),
                "thumbnail": entry.get("thumbnail") or "",
                "description": "",
                "site": record.get("site") or "",
                "series": series_id,
            }
            cards.append(
                wire.card(
                    self.id,
                    "video",
                    episode_id,
                    entry["title"],
                    author=record.get("author") or "",
                    duration=entry.get("duration"),
                    poster=poster,
                    badge=f"{number} серия",
                    series=series_id,
                )
            )
        if fresh:
            self.links.put_many(fresh, TTL)
        head = wire.series_head(
            series_id,
            record["title"],
            poster=self.image(record.get("thumbnail") or ""),
            description=record.get("description") or "",
        )
        more = offset + PAGE < len(entries)
        return {"series": head, "season": None, "items": cards, "next": str(offset + PAGE) if more else None}

    async def details(self, ctx: Ctx, kind: str, item_id: str) -> wire.Details:
        """Страница видео по ссылке — из того, что нашлось при разборе: наружу за ней не ходят."""
        record = self.links.get(item_id)
        if not record or record.get("kind") == "series":
            raise HTTPException(410, GONE)
        live = record.get("kind") == "channel"
        extra = {"series": record["series"]} if record.get("series") else {}
        return wire.details(
            self.id,
            record["kind"],
            item_id,
            record["title"],
            author=record.get("author") or "",
            duration=None if live else record.get("duration"),
            live=live,
            description=record.get("description") or "",
            poster=self.image(record.get("thumbnail") or ""),
            **extra,
        )

    async def source(self, ctx: Ctx, kind: str, item_id: str, options: dict[str, Any]) -> SourcePlan:
        """
        Поток — только по номеру: адрес берётся из стора, а не из запроса. Открытая ссылка живёт ещё
        сутки от этого раза — фильм, поставленный на паузу до утра, откроется и утром.
        """
        record = self.links.get(item_id)
        if record is None:
            raise HTTPException(410, GONE)
        if record.get("kind") == "series":
            raise HTTPException(400, "Это список серий — выберите серию")
        if self.egress is None:
            raise HTTPException(503, OFF)
        await self.egress.start()
        self.links.put(item_id, record, TTL)
        return self._plan(record)

    def _plan(self, record: dict[str, Any]) -> SourcePlan:
        # Серия страницы без своего адреса — это её номер на странице (`playlist_items`).
        extra = {"playlist_items": str(record["item"])} if record.get("item") else {}
        return ytdlp(
            record["url"],
            drm=True,
            subtitles="any",
            hls_subtitles=False,
            files=PLAYABLE,
            **{**OPTIONS, **extra},
        )


class MemoryLinks:
    """Номера ссылок в памяти процесса — для службы без стора (тесты, сборка без диска)."""

    def __init__(self, capacity: int = 4096):
        self.capacity = capacity
        self._items: dict[str, tuple[float, dict[str, Any]]] = {}

    def get(self, key: str) -> dict[str, Any] | None:
        found = self._items.get(key)
        if found is None or found[0] <= time.time():
            self._items.pop(key, None)
            return None
        return found[1]

    def put(self, key: str, value: dict[str, Any], ttl: float) -> None:
        self.put_many({key: value}, ttl)

    def put_many(self, values: dict[str, dict[str, Any]], ttl: float) -> None:
        for key, value in values.items():
            self._items.pop(key, None)
            self._items[key] = (time.time() + ttl, value)
        while len(self._items) > self.capacity:
            self._items.pop(next(iter(self._items)))


# --- разбор по шагам (в потоке yt-dlp) ---------------------------------------------------


@dataclass
class Walk:
    """Куда пришёл разбор: чужая площадка (`route`), одно видео (`info`) или плейлист с сериями."""

    route: dict[str, Any] | None = None
    info: dict[str, Any] | None = None
    playlist: dict[str, Any] | None = None
    entries: list[Any] = field(default_factory=list)


def _walk(ydl: Any, url: str, route: Route) -> Walk:
    """
    Разбор ссылки шаг за шагом, как его делает сам yt-dlp (`process_ie_result`), — но с остановкой на
    каждом переходе: страница, которая встраивает плеер своей площадки, отдаёт `route` раньше, чем
    yt-dlp пошёл бы разбирать ту площадку через наш выход.
    """
    from yt_dlp.utils import sanitize_url

    result = ydl.extract_info(url, download=False, process=False)
    for _ in range(HOPS):
        if not result:
            break
        kind = result.get("_type", "video")
        if kind in ("url", "url_transparent"):
            target = sanitize_url(result.get("url") or "", scheme="https")
            known = route(target)
            if known is not None:
                return Walk(route=known)
            inner = ydl.extract_info(target, download=False, process=False, ie_key=result.get("ie_key"))
            result = _transparent(result, inner) if kind == "url_transparent" else inner
            continue
        if kind in ("playlist", "multi_video"):
            return Walk(playlist=result, entries=_first(result.get("entries"), EPISODES))
        return Walk(info=ydl.process_ie_result(result, download=False))
    raise _Unsupported("No video formats found")


class _Unsupported(Exception):
    """Разбор кончился ничем: шаги кончились раньше видео."""


def _from_yt_dlp(error: BaseException) -> bool:
    """Ошибка yt-dlp (его отказ с текстом) — а не падение кода разборщика."""
    return type(error).__module__.startswith("yt_dlp") or isinstance(error, _Unsupported)


def _transparent(outer: dict[str, Any], inner: dict[str, Any] | None) -> dict[str, Any] | None:
    """
    `url_transparent` — как у yt-dlp: всё, что знала встраивающая страница (имя, постер), поверх
    того, что нашлось по ссылке плеера; номер и разборщик — плеера.
    """
    if not inner:
        return inner
    exempt = {"_type", "url", "ie_key"}
    if not outer.get("section_end") and outer.get("section_start") is None:
        exempt |= {"id", "extractor", "extractor_key"}
    merged = dict(inner)
    merged.update((key, value) for key, value in outer.items() if value is not None and key not in exempt)
    if merged.get("_type") == "url":
        merged["_type"] = "url_transparent"
    return merged


def _first(entries: Any, limit: int) -> list[Any]:
    """Первые серии плейлиста: у yt-dlp это список, генератор или ленивый список с порциями."""
    if entries is None:
        return []
    if hasattr(entries, "getslice"):
        return list(entries.getslice(0, limit))
    return list(itertools.islice(entries, limit))


def _episode(entry: Any, index: int, page: str, route: Route) -> dict[str, Any] | None:
    """
    Серия плейлиста как её помнит стор: своя площадка — её `route`; своя страница — её адрес; серия
    без своего адреса (несколько `<video>` на одной странице) — страница и номер серии на ней.
    """
    if not isinstance(entry, dict):
        return None
    kind = entry.get("_type", "video")
    if kind in ("playlist", "multi_video"):
        return None
    title = entry.get("title") or f"Видео {index}"
    found = {
        "title": str(title)[:300],
        "duration": _number(entry.get("duration")),
        "thumbnail": _thumbnail(entry),
    }
    if kind in ("url", "url_transparent"):
        target = entry.get("url") or ""
    else:
        own = entry.get("webpage_url") or ""
        target = own if own and _normal(own) != _normal(page) else ""
    if not target:
        return {**found, "url": page, "item": index}
    from yt_dlp.utils import sanitize_url

    target = sanitize_url(target, scheme="https")
    known = route(target)
    if known is not None:
        # Ссылка выключенной площадки серией не становится: настройку сервера ссылка не обходит.
        return {**found, "route": known["route"]} if "route" in known else None
    if not address.web(target):
        return None
    return {**found, "url": target}


# --- что показать на карточке -----------------------------------------------------------


def site(url: str) -> str:
    """Сайт для глаз: хост без `www.`, у доменов не латиницей — их буквами."""
    host = (urlsplit(url).hostname or "").removeprefix("www.")
    try:
        return host.encode().decode("idna")
    except UnicodeError:
        return host


def qualities(formats: list[dict[str, Any]]) -> list[str]:
    """
    Ступени качества, лучшая первой (`4K`, `1080p`, `720p`…), — ровно те, что увидит комната: у HLS —
    его варианты (плеер выбирает между ними сам), у готового файла — он один, тот, что выберет
    `resolve.playable_file`. Отдельные дорожки DASH и файлы, которые мы не возьмём, сюда не идут —
    обещать их качество незачем.
    """
    hls = [
        item
        for item in formats
        if str(item.get("protocol") or "").startswith("m3u8") and item.get("vcodec") != "none"
    ]
    if hls:
        chosen = hls
    else:
        found = playable_file(formats, PLAYABLE)
        chosen = [found] if found else []
    sides = {int(side) for item in chosen if (side := frame_side(item))}
    return [_quality(side) for side in sorted(sides, reverse=True)][:6]


def _quality(side: int) -> str:
    if side >= 4320:
        return "8K"
    if side >= 2160:
        return "4K"
    return f"{side}p"


def audio_tracks(formats: list[dict[str, Any]]) -> list[dict[str, str]]:
    """
    Дорожки звука, из которых выбирают в плеере («Язык озвучки»): отдельные дорожки HLS
    (`EXT-X-MEDIA TYPE=AUDIO`) — язык и имя, как их назвал сайт. Звук DASH и звук внутри файла здесь
    не дорожки на выбор: плеер их не переключает.
    """
    tracks: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    # yt-dlp сортирует форматы от худшего к лучшему: дорожка по умолчанию (`DEFAULT=YES`) — последней.
    # Список на карточке — от лучшей, как их предложит плеер.
    for item in reversed(formats):
        hls = str(item.get("protocol") or "").startswith("m3u8")
        if not hls or item.get("vcodec") != "none" or item.get("acodec") == "none":
            continue
        language = str(item.get("language") or "")
        label = str(item.get("format_note") or "")
        key = (language.lower(), label.lower())
        if not (language or label) or key in seen:
            continue
        seen.add(key)
        tracks.append({"lang": language, "label": label})
    return tracks[:12]


def caption_tracks(info: dict[str, Any]) -> list[dict[str, Any]]:
    """Субтитры, которые плеер покажет: файлы, которые умеет маршрут `subtitles`, и дорожки HLS."""
    tracks: list[dict[str, Any]] = []
    seen: set[str] = set()
    for source, generated in (
        (info.get("subtitles") or {}, False),
        (info.get("automatic_captions") or {}, True),
    ):
        for language, entries in source.items():
            usable = [
                entry
                for entry in entries or []
                if entry.get("ext") in SUBTITLE_FORMATS or str(entry.get("protocol") or "").startswith("m3u8")
            ]
            base = _base_language(language)
            if not usable or base in seen or any("tlang=" in str(entry.get("url")) for entry in usable):
                continue
            seen.add(base)
            label = next((entry["name"] for entry in usable if entry.get("name")), "")
            tracks.append({"lang": language.removesuffix("-orig"), "label": label, "auto": generated})
    return tracks[:CAPTIONS_LIMIT]


def _title(info: dict[str, Any], url: str, live: bool = False) -> str:
    title = str(info.get("title") or "").strip()
    # Одно `<video>` на странице yt-dlp называет «Имя страницы (1)»: номер нужен списку, а не видео.
    if str(info.get("id") or "").endswith("-1") and title.endswith(" (1)"):
        title = title[: -len(" (1)")]
    # К имени эфира yt-dlp дописывает дату и время разбора — для имени файла, а не для комнаты.
    if live:
        title = STAMP.sub("", title)
    # У голой ссылки на поток имя — кусок адреса (`.m3u8`, `master`, `index`): это не название.
    basename = urlsplit(url).path.rstrip("/").rsplit("/", 1)[-1]
    if not title or title.startswith(".") or title in (basename, basename.rsplit(".", 1)[0]):
        return f"{'Эфир' if live else 'Видео'} с {site(url)}"
    return title[:300]


def _author(info: dict[str, Any]) -> str:
    author = str(info.get("uploader") or info.get("channel") or info.get("creator") or "")[:200]
    # archive.org называет автором почту загрузившего: это адрес, а не имя, — на карточку он не идёт.
    return "" if "@" in author else author


def _thumbnail(info: dict[str, Any]) -> str:
    if info.get("thumbnail"):
        return str(info["thumbnail"])
    pictures = [picture for picture in info.get("thumbnails") or [] if picture.get("url")]
    if not pictures:
        return ""
    return str(max(pictures, key=lambda picture: _number(picture.get("width")) or 0)["url"])


def _number(value: Any) -> float | None:
    return float(value) if isinstance(value, (int, float)) and value > 0 else None


def _count(value: Any) -> int | None:
    return int(value) if isinstance(value, (int, float)) and value >= 0 else None


def _normal(url: str) -> str:
    """Адрес для номера: схема и хост строчными, без порта по умолчанию и без якоря."""
    parts = urlsplit(url.strip())
    scheme = parts.scheme.lower()
    host = (parts.hostname or "").rstrip(".")
    try:
        port = parts.port
    except ValueError:
        port = None
    netloc = f"[{host}]" if ":" in host else host
    if port and port != {"http": 80, "https": 443}.get(scheme):
        netloc += f":{port}"
    return urlunsplit((scheme, netloc, parts.path or "/", parts.query, ""))
