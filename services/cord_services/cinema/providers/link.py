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
разбор разом и `PER_MINUTE` в минуту, и вставленной ссылки, и открытой по номеру (`enter`); у разбора —
`LEASE_SECONDS` (дальше выход закрывает его соединения), а одинаковая ссылка, которую уже разобрали,
отвечает из памяти и в счёт не идёт. Новая ссылка той же комнаты сменяет прежнюю: её разбор
отменяется, и вход в выход закрывается сразу (последняя побеждает, а не ждёт отказа 429).

ПЛЕЕР СТРАНИЦЫ. yt-dlp не нашёл видео, сайт ответил ему 403, его разборщик не понял страницу или упал,
отказал словами, которых мы не знаем, или файл и мастер страницы не отдались нам без её cookies
(`PAGE_REASONS`) — тогда страницу открывает настоящий браузер (`sniffer.py`, контейнер `sniffer`), и мы
берём поток, который спросил её собственный плеер, вместе с заголовками его запроса (профиль потока).
Отказы, которые yt-dlp понял, — DRM, вход, капча, страна, «страницы нет», — остаются отказами: обходить их
кинозал не станет. Запись такой ссылки помнит, что поток нашёл плеер страницы (`via: page`), его адрес и
заголовки без cookies; сами cookies — только в памяти процесса. Поток по номеру берётся из записи, пока он
отвечает с профилем, иначе плеер страницы спрашивается снова — и когда плеер комнаты попросил обновить поток
(403/410 у кусочка): тогда один раз на `RENEW_GRACE`, сколько бы зрителей ни попросило разом.
"""

from __future__ import annotations

import asyncio
import base64
import functools
import hashlib
import hmac
import itertools
import json
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable
from urllib.parse import urlsplit, urlunsplit

from fastapi import HTTPException

from .. import address, wire
from .. import drm as drm_checks
from ..captions import CAPTIONS_LIMIT, SUBTITLE_FORMATS, _base_language
from ..drm import DRM
from ..egress import LEASE_SECONDS
from ..limits import Window
from ..net import BROWSER
from ..paging import PAGE, absolute
from ..registry import Ctx, Features, HostPolicy, Kit, Provider
from ..resolve import (
    AUDIO_FILES,
    BUSY,
    CAPTION_LABEL_LIMIT,
    CAPTION_LANG_LIMIT,
    DASH_ONLY,
    EXPIRED,
    INSIDE,
    LOCKED,
    NO_FILE,
    NO_STREAM,
    TITLE_LIMIT,
    TOO_BIG,
    Inside,
    Oversized,
    Protected,
    SourcePlan,
    _clip,
    frame_side,
    page,
    playable_file,
    refusal,
    ytdlp,
)
from ..sniffer import SNIFF_SECONDS, Crowded, Down, Profile, Profiles, Replaced, Seen, Sight
from ..transport.signer import allowed

logger = logging.getLogger(__name__)

# Номер ссылки: 22 знака base64url — 132 бита HMAC, угадать или подобрать нельзя.
LINK_ID = re.compile(r"[A-Za-z0-9_-]{22}")
# Сколько помнится номер ссылки и её серий: сутки от последнего обращения.
TTL = 24 * 3600
# Больше серий из одного плейлиста не берётся: на странице их листают порциями, а тысяча серий —
# это уже не сериал, а архив канала, и у него есть своя площадка.
EPISODES = 200
# Больше этого одна запись `cinema_links` в стор не пишется (M12): чужой плейлист с двумя сотнями серий, у
# каждой имя, постер и адрес, — это под мегабайт на одну вставку, а у стора нет уборки по размеру, только по
# сроку. Лишние серии с конца отбрасываются (`_capped`): начало плейлиста — то, что смотрят, а конец
# двухсотсерийного архива и так за пределом порции. Адрес страницы у серий на ней не повторяется — он в
# записи один раз (`_episode`), иначе двести повторов адреса в две тысячи знаков и были бы этим мегабайтом.
RECORD_LIMIT = 256 * 1024
# Сколько шагов «страница → встроенный плеер → его страница» проходит разбор.
HOPS = 5
# Якорь, в котором yt-dlp передаёт себе данные для разборщика.
SMUGGLE = "#__youtubedl_smuggle"
PER_MINUTE = 10
# Весь ответ о ссылке: разбор (`LEASE_SECONDS`) и проверка потока на DRM после него.
INSPECTION_SECONDS = LEASE_SECONDS + 10
# Сколько помнится ответ о ссылке: её вставляют разом все, кто в комнате.
ANSWER_TTL = 300
# Весь ответ плеера страницы о ссылке — страница у контейнера и проверка потока на DRM после неё.
PAGE_SECONDS = SNIFF_SECONDS + 15
# Поток плеера страницы вытянут заново — и ещё столько секунд просьбы обновить его отвечает он же: когда у
# кусочка 403, просят разом все зрители комнаты, а вытягивать страницу пять раз подряд незачем.
RENEW_GRACE = 20.0
# Кем представляются и разбор, и прокси потока: настольным Chrome, как VK и Rutube (`net.BROWSER`), и
# одним именем у обоих — CDN выдаёт адрес под то имя, которым его спросили (у Дзена в адресе
# `srcAg=CHROME`), и отдаёт поток тому же имени. Цена решения (25.09.2026): Wikimedia на «Chrome» с
# сервера отвечает 403 «Please respect our robot policy» — такая ссылка честно не открывается.
AGENT = BROWSER
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
# 403 на саму страницу: сайт не пускает программы (или сервер из его страны) — обходов нет.
FORBIDDEN = "Сайт не пустил кинозал к этой странице (403) — откройте видео на самом сайте"
BROKEN = "Разборщик этого сайта не справился со страницей — попробуйте позже или другую ссылку"
SILENT = "Сайт не ответил вовремя или оборвал связь — попробуйте ещё раз"
OFF = "Разбор ссылок на этом сервере выключен"
PAGES_DOWN = "Плеер страниц сейчас недоступен — попробуйте через минуту"
BUSY_ROOM = "Комната уже разбирает ссылку — дождитесь ответа"
TOO_OFTEN = "Комната слишком часто разбирает ссылки, подождите минуту"
SUPERSEDED = "Эту ссылку сменила следующая"

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
# С этими ответами yt-dlp страницу дальше открывает плеер страниц (`_page`): видео он не нашёл, сайт ему
# отказал, разборщик не справился, или поток не отдался нам без того, что знает только плеер страницы.
PAGE_REASONS = frozenset({NOTHING, FORBIDDEN, BROKEN, NO_FILE, NO_STREAM, LOCKED})
# Так начинается отказ yt-dlp, который мы не узнали по словам (`_verdict`): его тоже пробует плеер страниц.
UNKNOWN = "Сайт не отдал видео: "

Route = Callable[[str], "dict[str, Any] | None"]
Settle = Callable[[SourcePlan, dict[str, Any], str], Awaitable[dict[str, Any]]]


@dataclass(eq=False)
class Flight:
    """
    Разбор одной вставленной ссылки. Его ждут комнаты `rooms` — все, кто вставил эту ссылку, пока он
    шёл, — и отменяется он, только когда его бросили все: у каждой из них уже следующая ссылка.
    """

    url: str
    key: str
    task: asyncio.Future[dict[str, Any]]
    rooms: set[str] = field(default_factory=set)


class Resolving:
    """Место комнаты под разбор потока по номеру (`Link.enter`): его не отменяет никто."""


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
        # Плеер страниц и профили заголовков его потоков (их же читает прокси: `Cinema._profile`).
        self.sniffer = kit.sniffer
        self.profiles = kit.profiles if kit.profiles is not None else Profiles()
        # Когда поток ссылки плеер страниц вытянул последний раз, и чей поток просили обновить.
        self.renewed: dict[str, float] = {}
        self.stale: dict[str, None] = {}
        self.window = Window(PER_MINUTE, 60.0, TOO_OFTEN)
        # Разбор, который идёт у комнаты: один разом. Освобождается, когда кончился сам разбор, а не
        # когда ушёл ждавший его запрос (`_landed`, `leave`).
        self.running: dict[str, Flight | Resolving] = {}
        # Идущие разборы вставленных ссылок — по адресу: ту же ссылку другая комната не разбирает
        # второй раз, а ждёт.
        self.flights: dict[str, Flight] = {}

    def identify(self, url: str, item: int | None = None, space: str = "stream") -> str:
        """
        Номер ссылки: HMAC от адреса на ключе службы. Одна страница — один номер у всех комнат (и одна
        общая память на её разбор); адрес — нормальный (`normal`: без якоря, регистр хоста и порт по
        умолчанию номер не меняют), тот же, что уходит в стор и в yt-dlp. Серия страницы без своего
        адреса — это адрес страницы и номер серии в ней. `space` — род записи: у списка серий и у
        потока номера из разных пространств, и ссылка на чужой сериал серией другого плейлиста его
        запись не заденет.
        """
        text = f"link\x00{space}\x00{normal(url)}\x00{item or ''}"
        digest = hmac.new(self.key, text.encode(), hashlib.sha256).digest()
        return base64.urlsafe_b64encode(digest).decode().rstrip("=")[:22]

    def _keep(self, values: dict[str, dict[str, Any]]) -> None:
        """
        В стор — не затирая запись другого рода под тем же номером: список серий остаётся списком,
        поток — потоком, что бы ни прислала чужая страница. Номера родов и так из разных пространств
        (`identify`), это вторая стена.
        """
        kept = {}
        for key, value in values.items():
            found = self.links.get(key)
            if found is None or _family(found) == _family(value):
                kept[key] = value
        if kept:
            self.links.put_many(kept, TTL)

    # --- ответ о ссылке -----------------------------------------------------------------

    async def inspect(self, ctx: Ctx, url: str, route: Route, settle: Settle) -> dict[str, Any]:
        """
        Что по ссылке: `{"item": карточка}`, `{"route": …}` (встроенный плеер своей площадки) или
        `{"item": None, "reason": …}` — почему это не показать комнате.

        Предел комнаты — только на новый разбор: ответ, который уже есть или уже считается (ссылку
        вставили соседи), ничего наружу не стоит. Новая ссылка комнаты, пока идёт разбор прежней,
        прежнюю сменяет: комната её бросает, и разбор, который больше никто не ждёт, отменяется (его
        запрос получает 409 — клиент его уже бросил). Разбор потока по номеру (`enter`) не
        отменяется ничем: это поток, который комната уже смотрит, — пока он идёт, ссылке отказ 429.
        """
        if self.egress is None:
            return {"item": None, "reason": OFF}
        url = normal(url)
        key = f"inspect:{self.identify(url)}"
        cached = self.memo.peek(key)
        if cached is not None:
            return cached
        room = ctx.room
        held = self.running.get(room)
        if isinstance(held, Resolving):
            raise HTTPException(429, BUSY_ROOM, headers={"Retry-After": "5"})
        flight = self.flights.get(url)
        if flight is not None and flight.task.cancelled():
            flight = None
        if flight is None or held is not flight:
            if flight is None:
                self.window.take(room)
            if held is not None:
                self._abandon(room, held)
            if flight is None:
                flight = self._launch(url, key, self._inspect(url, route, settle, room))
            flight.rooms.add(room)
            self.running[room] = flight
        try:
            return await asyncio.shield(flight.task)
        except asyncio.CancelledError:
            current = asyncio.current_task()
            if flight.task.cancelled() and not (current is not None and current.cancelling()):
                raise HTTPException(409, SUPERSEDED) from None
            raise

    def _launch(self, url: str, key: str, work: Awaitable[dict[str, Any]]) -> Flight:
        flight = Flight(url, key, asyncio.ensure_future(work))
        self.flights[url] = flight
        flight.task.add_done_callback(functools.partial(self._landed, flight))
        return flight

    def _abandon(self, room: str, flight: Flight) -> None:
        """Комната бросила разбор; не ждёт больше никто — отмена, и вход в выход закрывается сразу."""
        flight.rooms.discard(room)
        if self.running.get(room) is flight:
            del self.running[room]
        if not flight.rooms:
            flight.task.cancel()

    def _landed(self, flight: Flight, task: asyncio.Future[dict[str, Any]]) -> None:
        """Разбор кончился — сам, отказом или отменой: места комнат свободны, ответ — в память."""
        if self.flights.get(flight.url) is flight:
            del self.flights[flight.url]
        for room in flight.rooms:
            if self.running.get(room) is flight:
                del self.running[room]
        if not task.cancelled() and task.exception() is None:
            self.memo.put(flight.key, task.result(), ANSWER_TTL)

    def enter(self, room: str) -> Resolving:
        """
        Разбор потока по номеру (`resolve`) — под тем же пределом комнаты, что и вставленная ссылка:
        один разбор разом и `PER_MINUTE` в минуту. Идёт другой разбор — отказ 429, а не отмена и не
        очередь: иначе номера серий с `refresh` держали бы выход сервера сколько угодно.
        """
        if room in self.running:
            raise HTTPException(429, BUSY_ROOM, headers={"Retry-After": "5"})
        self.window.take(room)
        held = Resolving()
        self.running[room] = held
        return held

    def leave(self, room: str, held: Resolving) -> None:
        if self.running.get(room) is held:
            del self.running[room]

    async def _inspect(self, url: str, route: Route, settle: Settle, room: str = "") -> dict[str, Any]:
        """
        yt-dlp, а за ним, если он не справился так, что может помочь браузер (`PAGE_REASONS`), — плеер
        страницы. Недоступен плеер страниц — остаётся ответ yt-dlp, как было до него.
        """
        assert self.egress is not None
        started = time.monotonic()
        answer: dict[str, Any] | HTTPException
        try:
            async with asyncio.timeout(INSPECTION_SECONDS):
                # Место в выходе ждётся в цикле событий, yt-dlp работает в пуле выхода; отменили разбор
                # (новая ссылка, срок) — вход закрыт сразу, а место занято, пока не кончится поток.
                walk = await self.egress.run(
                    lambda lease: self.ytdlp.run(
                        self.id, OPTIONS, lambda ydl: _walk(ydl, url, route), lease=lease
                    )
                )
                if walk.route is not None:
                    return walk.route
                if walk.playlist is not None:
                    return self._series(url, walk, route)
                assert walk.info is not None
                answer = await self._video(url, walk.info, settle)
                paged = answer.get("item") is None and answer.get("reason") in PAGE_REASONS
        except TimeoutError:
            raise HTTPException(504, EXPIRED) from None
        except HTTPException:
            raise
        except Exception as error:  # yt-dlp поднимает свои типы; наружу — слова, а не трассировка
            answer, paged = self._verdict(url, error, time.monotonic() - started)
        if paged and self.sniffer is not None:
            return await self._page(url, room, settle, answer)
        if isinstance(answer, HTTPException):
            raise answer
        return answer

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
        self._keep({item_id: record})
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
        series_id = self.identify(url, space="series")
        record = {
            "kind": "series",
            "url": url,
            "title": _clip(playlist.get("title"), TITLE_LIMIT) or f"Видео с {site(url)}",
            "thumbnail": _thumbnail(playlist)
            or next((e["thumbnail"] for e in entries if e["thumbnail"]), ""),
            "description": (playlist.get("description") or "")[:1200],
            "author": _author(playlist),
            "site": site(url),
            "entries": [],
        }
        # Байтовый потолок — на всю запись: серии обрезаются под то, что от него осталось после шапки.
        overhead = len(json.dumps(record, ensure_ascii=False).encode())
        record["entries"] = _capped(entries, overhead)
        self._keep({series_id: record})
        card = wire.card(
            self.id,
            "series",
            series_id,
            record["title"],
            author=record["author"],
            poster=self.image(record["thumbnail"] or ""),
            count=len(record["entries"]),
            description=record["description"],
        )
        return {"item": wire.link_card(card, site=record["site"])}

    def _verdict(
        self, url: str, error: Exception, spent: float
    ) -> tuple[dict[str, Any] | HTTPException, bool]:
        """
        Отказ yt-dlp — словами: что это свойство страницы — ответом, что сбой — ошибкой (её поднимут). И
        может ли тут помочь плеер страницы: да — видео не нашлось, сайт ответил 403, разборщик не справился
        или отказ не узнан по словам; нет — DRM, вход, капча, страна, «страницы нет», сеть и выход.
        """
        known = refusal(error)
        if isinstance(error, (Inside, Protected, Oversized)):
            reason = INSIDE if isinstance(error, Inside) else DRM if isinstance(error, Protected) else TOO_BIG
            return {"item": None, "reason": reason}, False
        if known is not None:
            return known, False
        cause = getattr(error, "exc_info", None)
        original = cause[1] if cause and len(cause) > 1 and cause[1] is not None else error
        kind = type(original).__name__
        text = str(original)
        # Имя сайта и вид отказа — без адреса и текста yt-dlp: в них бывают ключи из ссылки.
        logger.info("кинозал: ссылка с %s не разобрана: %s (%.1f с)", site(url), kind, spent)
        if kind == "UnsupportedError" or "No video formats found" in text or "Unsupported URL" in text:
            return {"item": None, "reason": NOTHING}, True
        if kind == "GeoRestrictedError" or "not available in your country" in text.lower():
            return {"item": None, "reason": GEO}, False
        if ROBOT_WORDS.search(text):
            return {"item": None, "reason": ROBOT}, False
        if LOGIN_WORDS.search(text):
            return {"item": None, "reason": LOGIN}, False
        if "HTTP Error 404" in text or "HTTP Error 410" in text:
            return {"item": None, "reason": MISSING}, False
        if "HTTP Error 403" in text:
            return {"item": None, "reason": FORBIDDEN}, True
        if NETWORK_WORDS.search(text):
            # Молчание и обрыв — не свойство страницы, а сбой: ответ не запоминается, и повтор возможен.
            return HTTPException(502, SILENT), False
        if not _from_yt_dlp(original) or BROKEN_WORDS.search(text):
            # Не отказ сайта, а поломка разборщика (`TypeError` в его коде, «Unable to extract…»): сайт
            # поменялся быстрее, чем yt-dlp. Сказать об этом можно, а показать трассировку — нечего.
            return HTTPException(502, BROKEN), True
        return HTTPException(502, f"{UNKNOWN}{self.ytdlp.explain(text)}"[:300]), True

    # --- плеер страницы -------------------------------------------------------------------

    async def _page(
        self, url: str, room: str, settle: Settle, fallback: dict[str, Any] | HTTPException
    ) -> dict[str, Any]:
        """
        Страница в настоящем браузере (`sniffer.py`): поток, который спросил её плеер, — карточкой, как у
        страницы, которую понял yt-dlp. Плеер страниц недоступен — ответ yt-dlp (`fallback`), как было.
        """
        assert self.sniffer is not None
        try:
            async with asyncio.timeout(PAGE_SECONDS):
                sight = await self.sniffer.look(url, room)
                return await self._sighted(url, sight, settle)
        except TimeoutError:
            raise HTTPException(504, EXPIRED) from None
        except Crowded:
            raise HTTPException(503, BUSY) from None
        except Replaced:
            raise HTTPException(409, SUPERSEDED) from None
        except Down:
            logger.warning("кинозал: плеер страниц не ответил — ссылка с %s остаётся за yt-dlp", site(url))
            if isinstance(fallback, HTTPException):
                raise fallback from None
            return fallback

    async def _sighted(self, url: str, sight: Sight, settle: Settle) -> dict[str, Any]:
        """Что увидел плеер страницы — отказом словами или карточкой с потоком в общей памяти `resolve`."""
        if sight.inside:
            return {"item": None, "reason": INSIDE}
        if sight.drm:
            return {"item": None, "reason": DRM}
        candidates = _candidates(sight)
        if not candidates:
            return {"item": None, "reason": _nothing(sight)}
        item_id = self.identify(url)
        for number, chosen in enumerate(candidates, 1):
            profile = _profile(item_id, chosen, sight)
            record: dict[str, Any] = {
                "url": url,
                "via": "page",
                "author": "",
                "thumbnail": _picture(sight.poster),
                "description": "",
                "site": site(url),
                "title": sight.title,
                "duration": sight.duration if chosen.kind == "file" else None,
                **_stream_record(chosen, profile),
            }
            try:
                source = await settle(self._page_plan(record, profile), _page_info(record), item_id)
                break
            except HTTPException as error:
                # DASH не по требованию наш плеер не собирает — тогда следующий поток страницы, если он есть.
                if error.detail == DASH_ONLY and number < len(candidates):
                    continue
                if error.status_code in (403, 502):
                    return {"item": None, "reason": error.detail}
                raise
        self._renewed(item_id, profile)
        live = bool(source["live"])
        kind = "channel" if live else "video"
        record["kind"] = kind
        record["title"] = _title({"title": sight.title}, url, live)
        # Длительность файла знает `<video>` страницы, манифеста — сам манифест (`Resolver.settle`).
        record["duration"] = None if live else record["duration"] or _number(source.get("duration"))
        self._keep({item_id: record})
        card = wire.card(
            self.id,
            kind,
            item_id,
            record["title"],
            author="",
            duration=record["duration"],
            live=live,
            poster=self.image(record["thumbnail"] or ""),
            description="",
        )
        heights = [_quality(side) for side in chosen.heights][:6]
        return {"item": wire.link_card(card, site=record["site"], qualities=heights, audio=[], captions=[])}

    def _page_plan(self, record: dict[str, Any], profile: Profile) -> SourcePlan:
        return page(record["url"], _page_info(record), profile, files=PLAYABLE + AUDIO_FILES)

    def _renewed(self, item_id: str, profile: Profile) -> None:
        """Поток вытянут: профиль — прокси, отметка «только что» — просьбам обновить его разом."""
        self.profiles.put(profile)
        self.stale.pop(item_id, None)
        self.renewed.pop(item_id, None)
        self.renewed[item_id] = time.monotonic()
        while len(self.renewed) > 1024:
            self.renewed.pop(next(iter(self.renewed)))

    def fresh(self, item_id: str) -> bool:
        """Поток этой ссылки плеер страниц вытянул только что: ещё одна просьба обновить его — не работа."""
        at = self.renewed.get(item_id)
        return at is not None and time.monotonic() - at < RENEW_GRACE

    def renew(self, item_id: str) -> None:
        """
        Поток по номеру просят обновить (у плеера комнаты 403/410 или срок подписи). Поток плеера страниц
        тогда вытягивается заново, а не берётся из записи; прежний профиль живёт, пока его не сменил новый.
        """
        self.stale[item_id] = None
        while len(self.stale) > 1024:
            self.stale.pop(next(iter(self.stale)))

    async def _page_source(self, ctx: Ctx, item_id: str, record: dict[str, Any]) -> SourcePlan:
        """
        Поток ссылки, которую открыл плеер страницы: из записи, если он отвечает с профилем, — иначе плеер
        страницы открывает её снова (под тем же пределом комнаты, что и разбор: `Cinema.resolve`).
        """
        profile = self._known_profile(item_id, record)
        stream = record.get("stream") or {}
        if profile is not None and stream.get("url") and await self._alive(ctx.net, stream["url"], profile):
            return self._page_plan(record, profile)
        if self.sniffer is None:
            raise HTTPException(503, OFF)
        try:
            async with asyncio.timeout(SNIFF_SECONDS + 5):
                sight = await self.sniffer.look(record["url"], ctx.room)
        except TimeoutError:
            raise HTTPException(504, EXPIRED) from None
        except Crowded:
            raise HTTPException(503, BUSY) from None
        except Replaced:
            raise HTTPException(409, SUPERSEDED) from None
        except Down:
            raise HTTPException(503, PAGES_DOWN) from None
        if sight.inside:
            raise HTTPException(403, INSIDE)
        if sight.drm:
            raise HTTPException(403, DRM)
        candidates = _candidates(sight)
        if not candidates:
            raise HTTPException(502, _nothing(sight))
        # Тот же вид потока, что был найден при разборе ссылки (он и прошёл проверки), — если он снова есть.
        kind = stream.get("type")
        chosen = next((seen for seen in candidates if seen.kind == kind), candidates[0])
        profile = _profile(item_id, chosen, sight)
        record = {**record, **_stream_record(chosen, profile)}
        self._renewed(item_id, profile)
        self._keep({item_id: record})
        return self._page_plan(record, profile)

    def _known_profile(self, item_id: str, record: dict[str, Any]) -> Profile | None:
        """
        Профиль потока из памяти; без cookies его можно восстановить из записи и после перезапуска.

        Найденный профиль продлевается при каждом использовании (M15). Иначе фильм, поставленный на паузу
        под конец шестичасовой жизни профиля (`sniffer.PROFILE_TTL`), получал бы пятичасовую подпись на
        поток, а профиль к тому часу уже умер бы — один 410 и пересниф посреди фильма.
        """
        if item_id in self.stale:
            return None
        found = self.profiles.get(item_id)
        if found is not None:
            self.profiles.put(found)
            return found
        if record.get("cookied") or not record.get("stream"):
            return None
        restored = Profile.restored(item_id, record.get("headers"))
        self.profiles.put(restored)
        return restored

    async def _alive(self, net: Any, url: str, profile: Profile) -> bool:
        """Отвечает ли поток с профилем: один байт, переадресация — по политике площадки."""
        return await drm_checks.answers(
            net, url, lambda target: allowed(target, self.hosts), extra=profile.headers_for
        )

    # --- страницы сцены -----------------------------------------------------------------

    async def series(self, ctx: Ctx, series_id: str, season: str | None, offset: int) -> wire.SeriesPage:
        """
        Серии плейлиста порцией. Каждая серия без своей площадки получает номер здесь — и на сутки.

        Номер серии со своей страницей — номер этой страницы (`identify` по её адресу), и её запись
        могла уже завести другая комната, вставив ту же ссылку. Такую запись серия не переписывает:
        имя, постер и описание серии пишет чужой плейлист, и страницу ролика чужой комнаты он бы
        переименовал.
        """
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
            # Серия на самой странице плейлиста своего адреса не хранит (M12) — он у записи один раз; здесь
            # он восстанавливается из адреса записи. Своя страница у серии — её собственный адрес.
            episode_url = entry.get("url") or record["url"]
            episode_id = self.identify(episode_url, entry.get("item"))
            if self.links.get(episode_id) is None:
                fresh[episode_id] = {
                    "kind": "video",
                    "url": episode_url,
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
            self._keep(fresh)
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
        self._keep({item_id: record})
        if record.get("via") == "page":
            return await self._page_source(ctx, item_id, record)
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
    from yt_dlp.utils import smuggle_url

    page = url
    result = ydl.extract_info(url, download=False, process=False)
    for _ in range(HOPS):
        if not result:
            break
        kind = result.get("_type", "video")
        if kind in ("url", "url_transparent"):
            target, referer = _step(result.get("url") or "", page)
            known = route(target)
            if known is not None:
                return Walk(route=known)
            asked = smuggle_url(target, {"referer": referer}) if referer else target
            inner = ydl.extract_info(asked, download=False, process=False, ie_key=result.get("ie_key"))
            result = _transparent(result, inner) if kind == "url_transparent" else inner
            page = target
            continue
        if kind in ("playlist", "multi_video"):
            return Walk(playlist=result, entries=_first(result.get("entries"), EPISODES))
        return Walk(info=ydl.process_ie_result(result, download=False))
    raise _Unsupported("No video formats found")


def _step(raw: str, page: str) -> tuple[str, str | None]:
    """
    Адрес следующего шага — без контрабанды yt-dlp в якоре (`#__youtubedl_smuggle`): её может подложить
    сама страница, в `src` своего плеера, а `smuggle_url` разборщика чужие ключи не перебивает
    (`http_headers`, `to_generic`, …). Из верхнего слоя (его и кладёт разборщик) берётся только
    Referer, равный адресу страницы, — встроенным плеерам вроде Vimeo он нужен. Всё, что лежит под ним,
    отрезается целиком: `unsmuggle_url` снимает только последний якорь, и вложенная контрабанда
    пережила бы шаг. Своя площадка узнаётся по чистому адресу.
    """
    from yt_dlp.utils import sanitize_url, unsmuggle_url

    target, data = sanitize_url(raw, scheme="https"), {}
    if SMUGGLE in target:
        try:
            target, data = unsmuggle_url(target, {})
        except Exception:  # чужой якорь, который yt-dlp не разберёт, — просто отрезается
            data = {}
        target = target.split(SMUGGLE, 1)[0]
    referer = page if isinstance(data, dict) and data.get("referer") == page else None
    return target, referer


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


def _capped(entries: list[dict[str, Any]], overhead: int) -> list[dict[str, Any]]:
    """
    Серии, которые влезают в одну запись стора (M12): вся запись — не больше `RECORD_LIMIT` байт JSON.
    `overhead` — вес самой записи без серий (адрес, имя, постер, описание).

    Лишние отбрасываются с конца — начало плейлиста и есть то, что смотрят, а конец двухсотсерийного архива
    и так за первой порцией. Пустой список не возвращается: хотя бы первая серия остаётся, что бы ни весило
    её имя (само имя уже обрезано в `_episode`).
    """
    kept: list[dict[str, Any]] = []
    size = overhead
    for entry in entries:
        size += len(json.dumps(entry, ensure_ascii=False).encode()) + 1
        if kept and size > RECORD_LIMIT:
            break
        kept.append(entry)
    return kept


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
        "title": _clip(title, TITLE_LIMIT) or f"Видео {index}",
        "duration": _number(entry.get("duration")),
        "thumbnail": _thumbnail(entry),
    }
    if kind in ("url", "url_transparent"):
        target = entry.get("url") or ""
    else:
        own = entry.get("webpage_url") or ""
        target = own if own and normal(own) != page else ""
    if not target:
        # Серия на самой странице: адрес не хранится (он у записи один раз, M12), только номер на ней.
        return {**found, "item": index}
    from yt_dlp.utils import sanitize_url

    # Адрес серии — нормальный, как и у вставленной ссылки: номер, стор и разбор — по одному и тому же
    # адресу, и контрабанда yt-dlp в якоре (`#__youtubedl_smuggle`) в стор не попадает.
    target = normal(sanitize_url(target, scheme="https"))
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
        language = _clip(item.get("language"), CAPTION_LANG_LIMIT)
        label = _clip(item.get("format_note"), CAPTION_LABEL_LIMIT)
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
            lang = _clip(language.removesuffix("-orig"), CAPTION_LANG_LIMIT)
            tracks.append({"lang": lang, "label": _clip(label, CAPTION_LABEL_LIMIT), "auto": generated})
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
    """Постер: `thumbnail` yt-dlp, а если его нет или он негодный — самая широкая годная картинка."""
    chosen = _picture(info.get("thumbnail"))
    if chosen:
        return chosen
    pictures = [
        (_number(picture.get("width")) or 0, url)
        for picture in info.get("thumbnails") or []
        if isinstance(picture, dict) and (url := _picture(picture.get("url")))
    ]
    return max(pictures, key=lambda found: found[0])[1] if pictures else ""


def _picture(url: Any) -> str:
    """
    Адрес картинки, который можно хранить и подписывать: обычная ссылка на страницу (`address.web`), не
    длиннее `address.LONGEST`. Чужая страница может подсунуть в `og:image` что угодно и сколько угодно —
    такое на карточку не идёт.
    """
    full = absolute(str(url or ""))
    return full if full and len(full) <= address.LONGEST and address.web(full) else ""


def _candidates(sight: Sight) -> list[Seen]:
    """
    Что пробовать играть из увиденного плеером страницы, лучшим первым: HLS (мастер — первым, так их
    упорядочил плеер страниц), DASH (наш плеер соберёт его, если он «по требованию», — `mpd.py`), готовый
    файл того вида, что играет браузер. По одному каждого вида: остальные того же вида — варианты первого
    или реклама.
    """
    found: list[Seen] = []
    for kind in ("hls", "dash", "file"):
        seen = next(
            (
                seen
                for seen in sight.streams
                if seen.kind == kind and (kind != "file" or seen.ext in PLAYABLE + AUDIO_FILES)
            ),
            None,
        )
        if seen is not None:
            found.append(seen)
    return found


def _nothing(sight: Sight) -> str:
    """Почему у страницы нечего играть — тем, что видел браузер."""
    if sight.robot:
        return ROBOT
    if sight.login:
        return LOGIN
    if sight.status in (401, 403):
        return FORBIDDEN
    if sight.status in (404, 410):
        return MISSING
    return NOTHING


def _profile(item_id: str, seen: Seen, sight: Sight) -> Profile:
    cookies = dict(sight.cookies)
    return Profile(item_id, referer=seen.referer, origin=seen.origin, agent=seen.agent, cookies=cookies)


def _stream_record(seen: Seen, profile: Profile) -> dict[str, Any]:
    """Поток в записи ссылки: адрес, вид и заголовки — без cookies (они только в памяти)."""
    return {
        "stream": {"url": seen.url, "type": seen.kind, "ext": seen.ext, "heights": list(seen.heights)},
        "headers": profile.public(),
        "cookied": bool(profile.cookies),
    }


def _page_info(record: dict[str, Any]) -> dict[str, Any]:
    """Поток плеера страницы в форме ответа yt-dlp: дальше его разбирает общий `Resolver.settle`."""
    stream = record.get("stream") or {}
    url = str(stream.get("url") or "")
    extra: dict[str, Any] = {}
    if stream.get("type") == "hls":
        formats = [{"protocol": "m3u8_native", "url": url, "manifest_url": url, "ext": "mp4"}]
    elif stream.get("type") == "dash":
        # Манифест DASH разбирает общий `Resolver.settle` (`mpd.py`): форматов, как у yt-dlp, у него нет.
        formats = []
        extra["dash_manifest"] = url
    else:
        ext = str(stream.get("ext") or "mp4")
        # Звук без картинки — дорожкой звука: `ranked_files` берёт его, только если картинок нет вовсе.
        sound = {"vcodec": "none"} if ext in AUDIO_FILES else {}
        formats = [{"protocol": urlsplit(url).scheme, "url": url, "ext": ext, **sound}]
    return {
        "title": record.get("title") or "",
        "thumbnail": record.get("thumbnail") or "",
        "duration": record.get("duration"),
        "webpage_url": record.get("url") or "",
        "formats": formats,
        **extra,
    }


def _number(value: Any) -> float | None:
    return float(value) if isinstance(value, (int, float)) and value > 0 else None


def _count(value: Any) -> int | None:
    return int(value) if isinstance(value, (int, float)) and value >= 0 else None


def _family(record: dict[str, Any]) -> str:
    return "series" if record.get("kind") == "series" else "stream"


def normal(url: str) -> str:
    """
    Нормальный адрес ссылки: схема и хост строчными, без порта по умолчанию и без якоря. Его одного
    хешируют, хранят и отдают yt-dlp: якорь сайту не уходит никогда, а в нём yt-dlp прячет свою
    контрабанду (`#__youtubedl_smuggle`: чужой Referer, «разбирай как generic»).
    """
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
