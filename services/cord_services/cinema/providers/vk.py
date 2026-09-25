"""
VK Видео: разделы площадки, поиск по видео и сообществам, сообщества с плейлистами и эфиры —
через API её же сайта (`api.vkvideo.ru`), с анонимным входом.

ВХОД. Каталог VK Видео без токена не отвечает вовсе (ошибка 5), а аккаунта у кинозала нет и
быть не должно. Сайт площадки берёт себе анонимный токен сам (`login.vk.ru/?act=get_anonym_token`)
публичным веб-клиентом — так же его берёт и служба (`AnonymousToken`): один на всех, пока до конца
суток его жизни больше пяти минут, одним запросом на всех, кто пришёл без него разом.

ОТКУДА ЧТО. Разделы — `catalog.getVideo`: какие они, решает площадка по адресу сервера (из
Германии «Фильмов» и «Сериалов» нет, из России они будут), поэтому ни один раздел здесь не вписан.
Лента раздела — `catalog.getSection`, её продолжение — `catalog.getBlockItems` от метки прошлой
страницы. Поиск — `catalog.getVideoSearchWeb2` (с `content_type=author` — сообщества), его
продолжение — `catalog.getSection` от метки. Сообщество — `groups.getById` (человек —
`users.get`), его ролики и плейлисты — `video.get` и `video.getAlbums`, плейлист —
`video.getAlbumById` и `video.get` с `album_id`. Всё проверено живыми запросами 24.09.2026.

ПОТОК — через yt-dlp, по адресу страницы ролика (`vkvideo.ru/video<владелец>_<номер>`) или канала
VK Видео Live (`live.vkvideo.ru/<канал>`): мастер HLS с `*.vkuser.net` и `*.okcdn.ru`, субтитры
отдельными файлами. Токен для этого не нужен: ролик по ссылке открывается и тогда, когда каталог
площадки не отвечает.

ЧТО НЕ ПОКАЗЫВАЕТСЯ. Ролик, который площадка отсюда не играет (`restriction.can_play == 0`:
«Недоступно в вашем регионе», удалённое), и эфир, который ещё не начался, в каталог не попадают;
если такой всё же попросить — отказ словами.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

import httpx
from fastapi import HTTPException

from .. import address, wire
from ..paging import MAX_OFFSET, PAGE
from ..registry import CATALOG_TIMEOUT, Ctx, Features, HostPolicy, Match, Provider
from ..resolve import SourcePlan, ytdlp

logger = logging.getLogger(__name__)

API = "https://api.vkvideo.ru/method/"
LOGIN = "https://login.vk.ru/?act=get_anonym_token"
# Открытый API VK Видео Live (бывший VK Play Live): эфир канала и его хозяин, без всякого входа.
LIVE = "https://api.live.vkvideo.ru/v1/blog/"
# Не секрет и не наш — публичный веб-клиент vkvideo.ru. Номер и «секрет» лежат в JS самого сайта
# (`core_spa.*.js`), и этим клиентом анонимный токен берёт каждая открытая вкладка vkvideo.ru — тот
# же приём, что и открытый Client-ID веб-клиента Twitch в `twitch.py`.
CLIENT_ID = "52461373"
CLIENT_SECRET = "o557NLIkAErNhakXrQ7A"
VERSION = "5.289"
ENTRY = {
    "client_id": CLIENT_ID,
    "client_secret": CLIENT_SECRET,
    "app_id": CLIENT_ID,
    "version": "1",
    "scopes": "audio_anonymous,video_anonymous,photos_anonymous,profile_anonymous",
    "isApiOauthAnonymEnabled": "false",
}
QUERY = {"v": VERSION, "client_id": CLIENT_ID, "lang": "ru"}
# Браузер, которым служба спрашивает VK. Не украшение: адрес потока площадка выдаёт под класс
# браузера (`srcAg=CHROME` в самом адресе), и её CDN отдаёт плейлист и кусочки только ему — на
# имя кинозала (`Cord/1.0`) тот же мастер отвечает 400, а после второго такого отказа адрес
# перестаёт открываться совсем (проверено 24.09.2026).
BROWSER = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/140.0.0.0 Safari/537.36"
)
# С чем их сайт ходит в свой API: каталог спрашивается тем же видом.
SITE = {"User-Agent": BROWSER, "Origin": "https://vkvideo.ru", "Referer": "https://vkvideo.ru/"}

# Ролик VK — `<владелец>_<номер>`: у сообщества владелец с минусом, у человека без. `[0-9]`, а не
# `\d`: `\d` пропустил бы и арабско-индийские цифры, а в адрес площадки уходит строка.
VIDEO = re.compile(r"(-?[0-9]{1,19})_([0-9]{1,19})")
# Сообщество (с минусом) или человек — владелец роликов и плейлистов.
OWNER = re.compile(r"-?[1-9][0-9]{0,18}")

# Ссылки VK — точным списком хостов: все домены площадки с их `www.`, `m.`, `new.` и `vksport.`, и
# отдельно VK Видео Live (с прежними `live.vkplay.ru` и `vkplay.live`).
SITE_HOSTS = frozenset(
    prefix + domain
    for prefix in ("", "www.", "m.", "new.", "vksport.")
    for domain in ("vk.com", "vk.ru", "vkvideo.ru")
)
LIVE_HOSTS = frozenset({"live.vkvideo.ru", "live.vkplay.ru", "vkplay.live"})
# Страница ролика — часть пути `video-1_2` (и внутри пути плейлиста), клип `clip-1_2` и запись эфира
# `live-1_2`: идёт ли эфир сейчас, скажет поток, а не адрес. Ролик поверх страницы — `?z=video-1_2…`.
VIDEO_PAGE = re.compile(r"(?:video|clip|live)(-?[0-9]{1,19}_[0-9]{1,19})")
LAYER = re.compile(r"(?:video|clip)(-?[0-9]{1,19}_[0-9]{1,19})(?=/|$)")
# Канал VK Видео Live — его имя; сообщество по номеру — `club…`, `public…` и `event…`; все ролики
# владельца — `videos<владелец>`, а его плейлист в старом адресе — там же, `?section=album_<номер>`.
SLUG = re.compile(r"[A-Za-z0-9_]{1,64}")
COMMUNITY_PAGE = re.compile(r"(?:club|public|event)([1-9][0-9]{0,18})")
VIDEOS_PAGE = re.compile(r"videos(-?[1-9][0-9]{0,18})")
ALBUM_SECTION = re.compile(r"album_([0-9]{1,19})")

# Ответ API, после которого токен надо взять заново: 5 — «вход не принят» (так отвечает и
# запрос без токена), 1116 — «анонимный токен недействителен».
STALE = frozenset({5, 1116})
# «Такого нет»: 100 — неверный параметр (чужой номер), 104 — не найдено, 113 и 125 — нет такого
# человека или сообщества.
ABSENT = frozenset({100, 104, 113, 125})
# «Закрыто»: 15 и 204 — доступ запрещён (так же площадка отвечает и на сообщество, которого нет),
# 18 — страница удалена, 30 — профиль закрыт, 203 — закрытое сообщество.
CLOSED = frozenset({15, 18, 30, 203, 204})
# «Слишком часто»: 6 — больше трёх вопросов в секунду, 9 — флуд, 29 — предел на метод.
BUSY = frozenset({6, 9, 29})

SILENT = "VK Видео не ответил на запрос каталога"
NO_ENTRY = "VK Видео не пустил каталог: анонимный вход не принят"
SHUT = "VK Видео не показывает это: доступ закрыт"
FLOOD = "VK Видео просит подождать: слишком много запросов подряд"
BLOCKED = "VK Видео не показывает это видео с нашего сервера: ограничение страны или прав на показ"
GONE = "Это видео удалено с VK Видео"
OFF_AIR = "Этот эфир VK Видео Live сейчас не идёт"
NOT_YET = "Этот эфир VK Видео ещё не начался"

# Лента, которую площадка листает только «от прошлой страницы», глубже этого не листается: номер
# страницы — это курсор, и каждый шаг за пределы памяти — ещё один запрос по цепочке.
DEEPEST = 30
# Сколько страниц площадки служба берёт за одну порцию, если на них нечего показать (всё
# «недоступно в регионе»): пустую порцию «Показать ещё» у зрителя тут же попросило бы снова.
READ_AHEAD = 3
# Сколько живёт память о странице ленты: метки продолжения у площадки долгие, а свежесть раздела
# за десять минут не меняется так, чтобы это было видно.
FEED_TTL = 600
# Кадр для плитки — первый без полей шире 440 px (720×405 в ответах площадки): исходник 1280×720
# и больше идёт через наш сервер и наш канал, а сетке крупнее не нужно. Страница ролика — шире 960.
TILE = 440
ART = 960


@dataclass(frozen=True)
class Leaf:
    """
    Страница ленты площадки: карточки, метка, от которой площадка отдаст следующую (`after`), и
    чья это метка (`owner`: у раздела — ряд, у поиска — раздел выдачи).
    """

    cards: tuple[wire.Card, ...]
    after: str | None
    owner: str = ""


class People:
    """Кто есть кто в ответе площадки: сообщества (`groups`) — по минусу, люди (`profiles`) — по плюсу."""

    def __init__(self, data: Any):
        data = data if isinstance(data, dict) else {}
        self.groups = _by_id(data.get("groups"))
        self.profiles = _by_id(data.get("profiles"))

    def get(self, owner: int) -> dict[str, Any]:
        return (self.groups.get(-owner) if owner < 0 else self.profiles.get(owner)) or {}

    def name(self, owner: int) -> str:
        face = self.get(owner)
        full = " ".join(part for part in (face.get("first_name"), face.get("last_name")) if part)
        return face.get("name") or full


def _by_id(entries: Any) -> dict[int, dict[str, Any]]:
    return {
        entry["id"]: entry
        for entry in entries or []
        if isinstance(entry, dict) and isinstance(entry.get("id"), int)
    }


def _picture(images: Any, wanted: int) -> str:
    """
    Кадр нужной ширины: первый без полей не уже `wanted`, а нет такого — самый широкий.

    Кадров у ролика с десяток: с полями (`with_padding` — вписанные в 4:3) и без, от 130 px до 4K.
    С полями — только если без полей нет вовсе: плитка у нас 16:9, и чёрные полосы в ней лишние.
    """
    found = [
        image
        for image in images or []
        if isinstance(image, dict)
        and isinstance(image.get("url"), str)
        and isinstance(image.get("width"), int)
    ]
    plain = [image for image in found if not image.get("with_padding")] or found
    plain.sort(key=lambda image: image["width"])
    fitting = next((image for image in plain if image["width"] >= wanted), plain[-1] if plain else None)
    return fitting["url"] if fitting else ""


def _live(item: dict[str, Any]) -> bool:
    """
    Идёт ли эфир прямо сейчас.

    `live_status` у площадки — `started` (идёт), `upcoming` (ещё не начался) и `postlive` (эфир
    кончился, осталась запись — это обычный ролик с перемоткой). Флаг `live: 1` она ставит и
    записи прошедшего эфира, поэтому сам по себе он «идёт сейчас» не значит — только без
    `live_status`.
    """
    status = item.get("live_status")
    return status == "started" or (status is None and item.get("live") == 1)


def _watchable(item: dict[str, Any]) -> bool:
    """Можно ли это показать комнате: площадка отсюда играет, и эфир не «ещё не начался»."""
    restriction = item.get("restriction")
    if isinstance(restriction, dict) and restriction.get("can_play") == 0:
        return False
    if item.get("content_restricted"):
        return False
    return item.get("live_status") in (None, "started", "postlive")


def _gone(face: dict[str, Any]) -> bool:
    """
    Сообщества (или человека) нет: удалённое площадка помечает `deactivated`, а на номер, которого
    не было никогда, отвечает пустышкой с именем «DELETED» — без пометки (проверено 24.09.2026).
    """
    return not face or bool(face.get("deactivated")) or face.get("name") == "DELETED"


def _plain(text: Any) -> str:
    """Текст площадки без её неразрывных пробелов: в отказе они выглядят обычными, но ищутся хуже."""
    return str(text or "").replace("\xa0", " ").strip()


def _day(stamp: Any) -> str | None:
    if not isinstance(stamp, int) or stamp <= 0:
        return None
    return datetime.fromtimestamp(stamp, timezone.utc).strftime("%Y-%m-%d")


def _code(body: dict[str, Any]) -> int | None:
    error = body.get("error")
    if not isinstance(error, dict):
        return None
    code = error.get("error_code")
    return code if isinstance(code, int) else 0


class AnonymousToken:
    """
    Анонимный токен VK: один на службу, пока до конца его срока больше пяти минут.

    Одним полётом: двадцать вопросов, пришедших без токена разом, ждут один запрос ко входу, а не
    делают двадцать, — вход площадки отвечает «429 Too Many Requests» уже на пятый подряд
    (проверено 24.09.2026). По той же причине отказ входа помнится полминуты: каталог без токена
    отвечает сразу, а не стучится во вход снова на каждом вопросе.

    Токен не попадает ни в журнал, ни в текст отказа: он уходит только телом запроса.
    """

    # За сколько до конца срока токен уже не выдаётся: вопрос, начатый с ним, должен успеть.
    SLACK = 300.0
    # Сколько после отказа входа не спрашивать его снова.
    PAUSE = 30.0

    def __init__(self, fetch: Callable[[httpx.AsyncClient], Awaitable[tuple[str, float]]]):
        self._fetch = fetch
        self._value: str | None = None
        self._until = 0.0
        self._flight: asyncio.Future[str] | None = None
        self._resting_until = 0.0

    async def get(self, net: httpx.AsyncClient) -> str:
        now = time.time()
        if self._value is not None and now < self._until:
            return self._value
        if self._flight is None:
            if now < self._resting_until:
                raise HTTPException(502, NO_ENTRY)
            self._flight = asyncio.ensure_future(self._take(net))
            self._flight.add_done_callback(self._land)
        # Отмена одного ждущего не отменяет вход для остальных.
        return await asyncio.shield(self._flight)

    def forget(self, stale: str) -> None:
        """
        Площадка токен не признала — забыть. Только его: пока этот вопрос шёл, соседний мог уже
        взять новый, и забыть новый значило бы спросить вход ещё раз зря.
        """
        if self._value == stale:
            self._value, self._until = None, 0.0

    async def _take(self, net: httpx.AsyncClient) -> str:
        try:
            value, expires = await self._fetch(net)
        except HTTPException:
            self._resting_until = time.time() + self.PAUSE
            raise
        self._value, self._until = value, expires - self.SLACK
        return value

    def _land(self, flight: asyncio.Future[str]) -> None:
        if self._flight is flight:
            self._flight = None
        # Ждать могло быть уже некому: отказ входа забирается здесь, иначе asyncio напишет в журнал
        # «Task exception was never retrieved» про обычный отказ площадки.
        if not flight.cancelled():
            flight.exception()


class Vk(Provider):
    id = "vk"
    name = "VK Видео"
    # Каждый хост — из живых ответов 24.09.2026 (14 роликов из разделов, поиска и плейлиста, 4
    # эфира VK, 1 канал VK Видео Live): `*.vkuser.net` — мастер, варианты, кусочки и субтитры
    # роликов (vk6-3…vk6-15); `*.okcdn.ru` — эфиры (vkvsd*), VK Видео Live (vsd*), запасные CDN
    # роликов (vkvd*) и кадры (`iv.okcdn.ru`); `*.userapi.com` и `*.vkuserphoto.ru` — кадры, обложки
    # плейлистов, лица сообществ и людей; `images.live.vkvideo.ru` — лица и обложки VK Видео Live.
    # `vk.com`, `vk.ru` и `mycdn.me` в ответах с потоком и картинками не встретились ни разу (на
    # `*.ms.vk.ru` — только пиксели статистики), поэтому их здесь нет; как и всего `vkvideo.ru`:
    # остальное на нём — страницы, а не картинки.
    hosts = HostPolicy(("vkuser.net", "okcdn.ru", "userapi.com", "vkuserphoto.ru", "images.live.vkvideo.ru"))
    features = Features(channels=True, playlists=True, categories=True, live=True)
    # Ролик или эфир VK (`<владелец>_<номер>`) и канал VK Видео Live (имя канала): вид различает
    # их сам — ролик бывает только `video`, канал Live только `channel`.
    content_id = re.compile(r"-?[0-9]{1,19}_[0-9]{1,19}|[A-Za-z0-9_]{1,64}")
    # Номер раздела у VK — её строка в полсотни знаков (`PUldVA8AR0Rz…`), без слэшей и точек.
    category_id = re.compile(r"[A-Za-z0-9_-]{1,128}")
    user_agent = BROWSER
    refusals = {"series": "У VK Видео сериалов отдельной страницей нет"}

    def __init__(self, kit):
        super().__init__(kit)
        self.token = AnonymousToken(self._enter)

    # --- ссылка -------------------------------------------------------------------------

    def match(self, url: str) -> Match | None:
        """
        Ролик — на всех доменах площадки: страница (`video-1_2`, `clip-1_2`, `live-1_2`, и внутри
        пути плейлиста), ролик поверх страницы (`?z=video-1_2…`) и встраиваемый плеер
        (`video_ext.php?oid=-1&id=2`). Канал VK Видео Live (`live.vkvideo.ru/<канал>`) — это `channel`
        на странице ролика, как идущий эфир в каталоге. Плейлист — `playlist/-1_2` (и старый
        `videos-1?section=album_2`), сообщество — `club1`, `public1`, `event1` и все его ролики
        `videos-1`.

        Ссылка открывает ролик и тогда, когда каталог VK лежит: узнаётся она без токена и без
        вопроса к площадке. Сообщество по короткому имени (`vkvideo.ru/@имя`) так не узнать — его
        номер знает только площадка, а служба по ссылке не ходит.
        """
        found = address.parse(url)
        if found is None:
            return None
        if found.host in LIVE_HOSTS:
            slug = found.path[0] if len(found.path) == 1 else ""
            return Match("channel", slug, "item") if SLUG.fullmatch(slug) else None
        if found.host not in SITE_HOSTS:
            return None
        layer = LAYER.match(found.query.get("z", ""))
        if layer:
            return Match("video", layer[1], "item")
        path = found.path
        if path[:1] == ("video_ext.php",):
            identity = f"{found.query.get('oid', '')}_{found.query.get('id', '')}"
            return Match("video", identity, "item") if VIDEO.fullmatch(identity) else None
        for part in path:
            page = VIDEO_PAGE.fullmatch(part)
            if page:
                return Match("video", page[1], "item")
        if len(path) >= 2 and path[-2] == "playlist" and VIDEO.fullmatch(path[-1]):
            return Match("playlist", path[-1], "playlist")
        if len(path) != 1:
            return None
        community = COMMUNITY_PAGE.fullmatch(path[0])
        if community:
            return Match("channel", f"-{community[1]}", "channel")
        videos = VIDEOS_PAGE.fullmatch(path[0])
        if not videos:
            return None
        album = ALBUM_SECTION.fullmatch(found.query.get("section", ""))
        if album:
            return Match("playlist", f"{videos[1]}_{album[1]}", "playlist")
        return Match("channel", videos[1], "channel")

    # --- каталог ------------------------------------------------------------------------

    async def search(self, ctx: Ctx, query: str, offset: int) -> wire.SearchPage:
        """
        Набрано — ролики лентой и сообщества полкой над ней. Пусто — ничего: витрина VK — это её
        разделы (`categories`), а не отдельная выдача.

        Сообщества — отдельный поиск площадки (`content_type=author`): в общей выдаче она ставит
        одно сообщество, а на её вкладке «Каналы» их десяток. Идут оба разом; сбой полки — пустая
        полка, а не сломанная выдача.
        """
        if not query:
            return {"items": [], "next": None, "channels": [], "categories": []}
        low = query.lower()[:120]
        wanted = [
            self._portion(
                f"search:{low}",
                lambda: self._found(ctx, query),
                lambda leaf: self._found_more(ctx, leaf),
                offset,
            )
        ]
        if not offset:
            wanted.append(
                self._shelf(self.memo.get(f"authors:{low}", lambda: self._authors(ctx, query), 300))
            )
        found = await asyncio.gather(*wanted)
        return {**found[0], "channels": found[1] if not offset else [], "categories": []}

    async def categories(self, ctx: Ctx, query: str, offset: int) -> wire.Page:
        """
        Разделы площадки — одной порцией и в её порядке: какие они, решает сама площадка по адресу
        сервера, и первым у неё всегда «Все».
        """
        items = await self.memo.get("sections", lambda: self._sections(ctx), 3600)
        if query:
            items = [item for item in items if query.lower() in item["title"].lower()]
        return {"items": items[offset:], "next": None}

    async def category(self, ctx: Ctx, category_id: str, offset: int) -> wire.CategoryPage:
        """Раздел: его карточка и ролики, как их показывает площадка, порцией на её страницу."""
        sections = await self.memo.get("sections", lambda: self._sections(ctx), 3600)
        head = next((item for item in sections if item["id"] == category_id), None)
        if head is None:
            raise HTTPException(404, "Такого раздела на VK Видео нет")
        found = await self._portion(
            f"section:{category_id}",
            lambda: self._section(ctx, category_id),
            lambda leaf: self._section_more(ctx, leaf),
            offset,
        )
        return {"category": head, **found}

    async def channel(self, ctx: Ctx, channel_id: str, tab: str, offset: int) -> wire.ChannelPage:
        """
        Сообщество (или человек): шапка, ролики и плейлисты — по вкладке, по тридцать.

        Других вкладок у страницы нет; на них — шапка и пустая лента, как у Rutube.
        """
        if not OWNER.fullmatch(channel_id):
            raise HTTPException(400, "Непонятное имя сообщества")
        head = self.memo.get(f"face:{channel_id}", lambda: self._head(ctx, channel_id), 300)
        if tab == "videos":
            feed = self._videos(ctx, channel_id, None, offset)
        elif tab == "playlists":
            feed = self._albums(ctx, channel_id, offset)
        else:
            return {"channel": await head, "items": [], "next": None}
        channel, found = await asyncio.gather(head, feed, return_exceptions=True)
        # Шапка — первой: «такого сообщества нет» важнее, чем то, что у него нет и роликов.
        for answer in (channel, found):
            if isinstance(answer, BaseException):
                raise answer
        if tab == "playlists":
            # У плейлиста в ленте имя хозяина — то же, что в шапке: площадка его в списке не повторяет.
            found = {**found, "items": [{**card, "author": channel["title"]} for card in found["items"]]}
        return {"channel": channel, **found}

    async def playlist(self, ctx: Ctx, playlist_id: str, offset: int) -> wire.PlaylistPage:
        """Плейлист: его шапка и ролики в порядке, в котором их собрал хозяин, по тридцать."""
        match = VIDEO.fullmatch(playlist_id)
        if not match:
            raise HTTPException(400, "Непонятный адрес плейлиста")
        owner, album = match.groups()
        head, found = await asyncio.gather(
            self.memo.get(f"album:{playlist_id}", lambda: self._album(ctx, owner, album), 300),
            self._videos(ctx, owner, album, offset),
            return_exceptions=True,
        )
        for answer in (head, found):
            if isinstance(answer, BaseException):
                raise answer
        return {"playlist": head, **found}

    async def details(self, ctx: Ctx, kind: str, item_id: str) -> wire.Details:
        if not VIDEO.fullmatch(item_id):
            if kind != "channel":
                raise HTTPException(400, "Непонятный адрес видео")
            return await self._stream_page(ctx, item_id)
        data = self._object(await self._call(ctx, "video.get", {"videos": item_id, "extended": "1"}))
        item = next((entry for entry in data.get("items") or [] if isinstance(entry, dict)), None)
        if item is None or not isinstance(item.get("owner_id"), int):
            raise HTTPException(404, "Такого видео на VK Видео нет")
        refusal = self._refusal_for(item)
        if refusal:
            raise refusal
        people = People(data)
        owner = item["owner_id"]
        face = people.get(owner)
        live = _live(item)
        return wire.details(
            self.id,
            kind,
            item_id,
            item.get("title") or "Видео VK",
            author=people.name(owner),
            channelId=str(owner),
            channelAvatar=self.image(face.get("photo_200") or face.get("photo_100") or ""),
            duration=None if live else item.get("duration") or None,
            live=live,
            views=None if live else item.get("views"),
            viewers=item.get("spectators") if live else None,
            followers=face.get("members_count") or face.get("followers_count"),
            published=_day(item.get("date")),
            description=(item.get("description") or "")[:4000],
            poster=self.image(_picture(item.get("image"), ART)),
        )

    # --- поток --------------------------------------------------------------------------

    async def source(self, ctx: Ctx, kind: str, item_id: str, options: dict[str, Any]) -> SourcePlan:
        """
        Поток — у yt-dlp, по адресу страницы ролика или канала VK Видео Live.

        Перед разбором — вопрос к API площадки: если ролик отсюда не играет, отказ звучит её же
        словами и сразу, а не английским текстом yt-dlp через пару секунд. Если API не ответил
        (каталог лёг, токена нет), разбор идёт всё равно: ролик по ссылке должен открываться и
        тогда. Мастер HLS у VK субтитров не несёт — их yt-dlp отдаёт отдельным списком.
        """
        if not VIDEO.fullmatch(item_id):
            if kind != "channel":
                raise HTTPException(400, "Непонятный адрес видео")
            await self._on_air(ctx, item_id)
            return ytdlp(f"https://live.vkvideo.ru/{item_id}")
        await self._playable(ctx, item_id)
        return ytdlp(f"https://vkvideo.ru/video{item_id}", hls_subtitles=False)

    async def _playable(self, ctx: Ctx, item_id: str) -> None:
        try:
            data = self._object(await self._call(ctx, "video.get", {"videos": item_id}))
        except HTTPException as failure:
            # Молчание, флуд и непринятый вход (502) — не свойство ролика: разбираем так, ролик по ссылке
            # должен открываться и при лёгшем каталоге. А отказ площадки про сам ролик (403 «доступ закрыт»,
            # 404) — это ответ ей и звучит по-русски (T10), а не английским текстом yt-dlp через пару секунд.
            if failure.status_code != 502:
                raise
            logger.info(
                "кинозал: VK не ответил о ролике перед разбором (%s) — разбираем так", failure.status_code
            )
            return
        item = next((entry for entry in data.get("items") or [] if isinstance(entry, dict)), None)
        if item is None:
            raise HTTPException(404, "Такого видео на VK Видео нет")
        refusal = self._refusal_for(item)
        if refusal:
            raise refusal
        # Страница эфира, который ещё не начался, открывается, а поток у него появится только с
        # началом: yt-dlp ответил бы «No video formats found».
        if item.get("live_status") not in (None, "started", "postlive"):
            raise HTTPException(404, NOT_YET)

    async def _on_air(self, ctx: Ctx, slug: str) -> None:
        try:
            stream = await self._blog(ctx, slug)
        except HTTPException as failure:
            if failure.status_code == 404:
                raise
            return
        if stream.get("isOnline") is False:
            raise HTTPException(404, OFF_AIR)

    @staticmethod
    def _refusal_for(item: dict[str, Any]) -> HTTPException | None:
        """
        Почему площадка не играет этот ролик — или `None`, если играет.

        Своими словами площадка говорит зрителю своего сайта («Недоступно в вашем регионе. Если у
        вас включён VPN…»), а здесь смотрит комната через наш сервер, и сказать это нужно про него.
        """
        restriction = item.get("restriction") if isinstance(item.get("restriction"), dict) else {}
        if restriction.get("can_play") != 0 and not item.get("content_restricted"):
            return None
        said = _plain(restriction.get("title") or item.get("content_restricted_message"))
        if restriction.get("icon_name") == "delete_outline" or "удал" in said.lower():
            return HTTPException(404, GONE)
        if "регион" in said.lower():
            return HTTPException(403, BLOCKED)
        return HTTPException(403, f"VK Видео не показывает это видео: {said}"[:300] if said else SHUT)

    # --- что площадка отвечает ------------------------------------------------------------

    async def _enter(self, net: httpx.AsyncClient) -> tuple[str, float]:
        """Анонимный токен и его срок. Ни токен, ни ответ входа в журнал не идут."""
        try:
            response = await net.post(LOGIN, data=ENTRY, headers=SITE, timeout=CATALOG_TIMEOUT)
            body = response.json()
        except (httpx.HTTPError, ValueError):
            raise HTTPException(502, NO_ENTRY) from None
        data = body.get("data") if isinstance(body, dict) else None
        value = data.get("access_token") if isinstance(data, dict) else None
        if response.status_code != 200 or not isinstance(value, str) or not value:
            raise HTTPException(502, NO_ENTRY)
        expires = data.get("expired_at")
        # Срок площадка называет всегда (сутки от выдачи); если однажды не назовёт — хватит и часа.
        if not isinstance(expires, (int, float)) or isinstance(expires, bool):
            expires = time.time() + 3600
        return value, float(expires)

    async def _call(
        self, ctx: Ctx, method: str, params: dict[str, str], *, missing: str | None = None
    ) -> Any:
        """
        Ответ метода API или отказ словами.

        Токен, который площадка не признала (5, 1116), забывается, и вопрос повторяется с новым —
        один раз: второй отказ подряд — это уже не устаревший токен, а закрытый вход.
        """
        token = await self.token.get(ctx.net)
        body = await self._ask(ctx, method, params, token)
        if _code(body) in STALE:
            self.token.forget(token)
            token = await self.token.get(ctx.net)
            body = await self._ask(ctx, method, params, token)
        code = _code(body)
        if code is None:
            return body.get("response")
        if code in STALE:
            raise HTTPException(502, NO_ENTRY)
        if code in ABSENT and missing:
            raise HTTPException(404, missing)
        if code in CLOSED:
            raise HTTPException(403, SHUT)
        if code in BUSY:
            raise HTTPException(502, FLOOD)
        raise HTTPException(502, SILENT)

    async def _ask(self, ctx: Ctx, method: str, params: dict[str, str], token: str) -> dict[str, Any]:
        """Один запрос к API. Токен — только в теле: в адресе он попал бы в журналы прокси."""
        try:
            response = await ctx.net.post(
                API + method,
                params=QUERY,
                data={**params, "access_token": token},
                headers=SITE,
                timeout=CATALOG_TIMEOUT,
            )
            body = response.json()
        except (httpx.HTTPError, ValueError):
            raise HTTPException(502, SILENT) from None
        # Отказ площадка присылает и с кодом 500 (ошибка 10) — решает тело, а не код ответа.
        if not isinstance(body, dict) or ("response" not in body and "error" not in body):
            raise HTTPException(502, SILENT)
        return body

    async def _blog(self, ctx: Ctx, slug: str) -> dict[str, Any]:
        """Эфир канала VK Видео Live и его хозяин — открытым API, без токена."""
        try:
            response = await ctx.net.get(
                f"{LIVE}{slug}/public_video_stream", headers={"User-Agent": BROWSER}, timeout=CATALOG_TIMEOUT
            )
            body = response.json()
        except (httpx.HTTPError, ValueError):
            raise HTTPException(502, SILENT) from None
        if response.status_code == 404:
            raise HTTPException(404, "Такого канала на VK Видео Live нет")
        if response.status_code != 200 or not isinstance(body, dict):
            raise HTTPException(502, SILENT)
        return body

    @staticmethod
    def _object(data: Any) -> dict[str, Any]:
        """Ответ, который обязан быть объектом: что-то другое — площадка ответила не то (502)."""
        if not isinstance(data, dict):
            raise HTTPException(502, SILENT)
        return data

    async def _portion(
        self,
        key: str,
        first: Callable[[], Awaitable[Leaf]],
        more: Callable[[Leaf], Awaitable[Leaf]],
        offset: int,
    ) -> wire.Page:
        """
        Порция ленты, которую площадка листает только «от прошлой страницы» (`next_from`).

        Курсор — номер страницы площадки: метку продолжения знает только прошлая страница, поэтому
        страница `N` — это шаг по цепочке от первой. Каждая страница помнится под своей меткой
        (`FEED_TTL`), и листание подряд стоит одного запроса на порцию; заново вся цепочка
        проходится, только если память о ней кончилась. Глубже `DEEPEST` лента не листается.

        Страница, на которой показать нечего (всё «недоступно в регионе»), не отдаётся зрителю
        пустой порцией: служба сама берёт следующую, но не больше `READ_AHEAD` страниц за раз.
        """
        if offset > DEEPEST:
            return {"items": [], "next": None}
        leaf = await self.memo.get(f"{key}:0", first, FEED_TTL)
        for number in range(1, offset + 1):
            if not leaf.after:
                return {"items": [], "next": None}
            leaf = await self._next(key, number, leaf, more)
        index, steps = offset, 1
        while not leaf.cards and leaf.after and steps < READ_AHEAD and index < DEEPEST:
            index, steps = index + 1, steps + 1
            leaf = await self._next(key, index, leaf, more)
        following = index + 1 if leaf.after and index < DEEPEST else None
        return {"items": list(leaf.cards), "next": None if following is None else str(following)}

    async def _next(self, key: str, number: int, leaf: Leaf, more: Callable[[Leaf], Awaitable[Leaf]]) -> Leaf:
        # Метка — в ключе: если первая страница за это время сменилась, её продолжение — другая
        # цепочка, а не старая страница под новым номером.
        return await self.memo.get(f"{key}:{number}:{leaf.after}", lambda: more(leaf), FEED_TTL)

    async def _shelf(self, shelf: Awaitable[Any]) -> list[wire.Card]:
        """Полка сообществ: её сбой — пустая полка, а не сломанная выдача (в память пустота не идёт)."""
        try:
            return await shelf
        except HTTPException as failure:
            logger.warning("кинозал: полка сообществ VK не собралась: %s", failure.detail)
            return []

    # --- что из этого получается ------------------------------------------------------------

    def _video(self, item: dict[str, Any], people: People) -> wire.Card | None:
        """
        Ролик или эфир как карточка каталога.

        Идущий эфир — это `channel` под номером своего ролика: его смотрят с края, как эфир Twitch.
        Запись прошедшего эфира — обычный ролик.
        """
        owner, number = item.get("owner_id"), item.get("id")
        if not isinstance(owner, int) or not isinstance(number, int) or not _watchable(item):
            return None
        live = _live(item)
        return wire.card(
            self.id,
            "channel" if live else "video",
            f"{owner}_{number}",
            item.get("title") or ("Прямой эфир" if live else "Видео VK"),
            author=people.name(owner),
            channelId=str(owner),
            duration=None if live else item.get("duration") or None,
            live=live,
            viewers=item.get("spectators") if live else None,
            views=None if live else item.get("views"),
            poster=self.image(_picture(item.get("image"), TILE)),
        )

    def _leaf(self, blocks: list[dict[str, Any]], data: dict[str, Any], after: Any, owner: str) -> Leaf:
        """Страница из рядов площадки: ролики рядов по порядку, каждый один раз."""
        known: dict[str, dict[str, Any]] = {}
        for entry in [*(data.get("videos") or []), *(data.get("catalog_videos") or [])]:
            video = entry.get("video") if isinstance(entry, dict) and "video" in entry else entry
            if (
                isinstance(video, dict)
                and isinstance(video.get("owner_id"), int)
                and isinstance(video.get("id"), int)
            ):
                known.setdefault(f"{video['owner_id']}_{video['id']}", video)
        people = People(data)
        cards: list[wire.Card] = []
        seen: set[str] = set()
        for block in blocks:
            for identity in block.get("videos_ids") or []:
                item = known.get(identity) if isinstance(identity, str) else None
                found = self._video(item, people) if item else None
                if found and found["id"] not in seen:
                    seen.add(found["id"])
                    cards.append(found)
        return Leaf(tuple(cards), after if isinstance(after, str) and after else None, owner)

    async def _sections(self, ctx: Ctx) -> list[wire.CategoryCard]:
        data = self._object(await self._call(ctx, "catalog.getVideo", {"need_blocks": "1", "owner_id": "0"}))
        sections = (data.get("catalog") or {}).get("sections") or []
        return [
            wire.category_card(self.id, entry["id"], entry.get("title") or "")
            for entry in sections
            if isinstance(entry, dict)
            and isinstance(entry.get("id"), str)
            and self.category_id.fullmatch(entry["id"])
        ]

    async def _section(self, ctx: Ctx, section_id: str) -> Leaf:
        """
        Первая страница раздела — его ряд роликов. Ряд берётся сеткой (`grid`), если площадка
        отдала несколько: так их показывает её сайт, а ряды-«ползунки» — это подборки сверху.
        """
        data = self._object(
            await self._call(
                ctx,
                "catalog.getSection",
                {"section_id": section_id},
                missing="Такого раздела на VK Видео нет",
            )
        )
        blocks = [
            block
            for block in (data.get("section") or {}).get("blocks") or []
            if isinstance(block, dict) and block.get("data_type") == "videos"
        ]
        grid = [block for block in blocks if (block.get("layout") or {}).get("name") == "grid"]
        block = (grid or blocks or [None])[0]
        if block is None:
            return Leaf((), None)
        return self._leaf([block], data, block.get("next_from"), str(block.get("id") or ""))

    async def _section_more(self, ctx: Ctx, leaf: Leaf) -> Leaf:
        """Продолжение ряда раздела: `catalog.getBlockItems` от его метки."""
        data = self._object(
            await self._call(
                ctx, "catalog.getBlockItems", {"block_id": leaf.owner, "start_from": leaf.after or ""}
            )
        )
        block = data.get("block") if isinstance(data.get("block"), dict) else {}
        return self._leaf([block], data, block.get("next_from"), leaf.owner)

    async def _found(self, ctx: Ctx, query: str) -> Leaf:
        """
        Первая страница поиска: ряды «Все видео» по порядку. Ряды клипов (вертикальные короткие) и
        «новых видео автора» (они же — на его странице) в ленту не идут.
        """
        data = self._object(await self._call(ctx, "catalog.getVideoSearchWeb2", {"q": query[:120]}))
        section = next(
            (entry for entry in (data.get("catalog") or {}).get("sections") or [] if isinstance(entry, dict)),
            {},
        )
        return self._leaf(
            self._results(section), data, section.get("next_from"), str(section.get("id") or "")
        )

    async def _found_more(self, ctx: Ctx, leaf: Leaf) -> Leaf:
        """Продолжение поиска: раздел выдачи от его метки (`catalog.getSection`)."""
        data = self._object(
            await self._call(
                ctx, "catalog.getSection", {"section_id": leaf.owner, "start_from": leaf.after or ""}
            )
        )
        section = data.get("section") if isinstance(data.get("section"), dict) else {}
        return self._leaf(self._results(section), data, section.get("next_from"), leaf.owner)

    @staticmethod
    def _results(section: dict[str, Any]) -> list[dict[str, Any]]:
        return [
            block
            for block in section.get("blocks") or []
            if isinstance(block, dict) and block.get("data_type") == "catalog_videos"
        ]

    async def _authors(self, ctx: Ctx, query: str) -> list[wire.Card]:
        """Сообщества и люди по имени — вкладка «Каналы» поиска площадки."""
        data = self._object(
            await self._call(ctx, "catalog.getVideoSearchWeb2", {"q": query[:120], "content_type": "author"})
        )
        people = People(data)
        cards: list[wire.Card] = []
        for section in (data.get("catalog") or {}).get("sections") or []:
            for block in (section or {}).get("blocks") or []:
                if not isinstance(block, dict) or block.get("data_type") != "search_authors":
                    continue
                for entry in block.get("search_author_items") or []:
                    owner = entry.get("id") if isinstance(entry, dict) else None
                    if isinstance(owner, int) and owner and (found := self._face(owner, people)):
                        cards.append(found)
        return cards

    def _face(self, owner: int, people: People) -> wire.Card | None:
        """Сообщество (или человек) в находках: лицо, имя и сколько подписано. В него заходят."""
        face = people.get(owner)
        if _gone(face):
            return None
        return wire.card(
            self.id,
            "channel",
            str(owner),
            people.name(owner) or "Сообщество",
            channelId=str(owner),
            followers=face.get("members_count") or face.get("followers_count"),
            description=_plain(face.get("activity"))[:300],
            poster=self.image(face.get("photo_200") or face.get("photo_100") or ""),
        )

    async def _head(self, ctx: Ctx, owner: str) -> wire.ChannelHead:
        """Шапка страницы: сообщество (`groups.getById`) или человек (`users.get`)."""
        number = int(owner)
        missing = "Такого сообщества на VK Видео нет"
        if number < 0:
            data = self._object(
                await self._call(
                    ctx,
                    "groups.getById",
                    {
                        "group_ids": str(-number),
                        "fields": "members_count,activity,description,cover,photo_200,verified,screen_name",
                    },
                    missing=missing,
                )
            )
            face = next((entry for entry in data.get("groups") or [] if isinstance(entry, dict)), None)
        else:
            people = await self._call(
                ctx,
                "users.get",
                {"user_ids": owner, "fields": "photo_200,followers_count,screen_name"},
                missing=missing,
            )
            face = next((entry for entry in people or [] if isinstance(entry, dict)), None)
        if _gone(face or {}):
            raise HTTPException(404, missing)
        name = face.get("name") or " ".join(
            part for part in (face.get("first_name"), face.get("last_name")) if part
        )
        covers = [image for image in (face.get("cover") or {}).get("images") or [] if isinstance(image, dict)]
        return wire.channel_head(
            self.id,
            owner,
            name or "Сообщество",
            description=(face.get("description") or "")[:1200],
            followers=face.get("members_count") or face.get("followers_count"),
            category=_plain(face.get("activity")) or None,
            avatar=self.image(face.get("photo_200") or ""),
            banner=self.image(_picture(covers, 1080)) if covers else None,
        )

    async def _videos(self, ctx: Ctx, owner: str, album: str | None, offset: int) -> wire.Page:
        """Ролики сообщества или плейлиста: `video.get` листается смещением, по тридцать."""
        params = {"owner_id": owner, "count": str(PAGE), "offset": str(offset), "extended": "1"}
        if album is not None:
            params["album_id"] = album
        data = self._object(
            await self._call(
                ctx, "video.get", params, missing="Такого плейлиста на VK Видео нет" if album else None
            )
        )
        people = People(data)
        cards = [
            found
            for item in data.get("items") or []
            if isinstance(item, dict) and (found := self._video(item, people))
        ]
        total = data.get("count") if isinstance(data.get("count"), int) else 0
        following = offset + PAGE
        return {
            "items": cards,
            "next": str(following) if following < total and following <= MAX_OFFSET else None,
        }

    async def _albums(self, ctx: Ctx, owner: str, offset: int) -> wire.Page:
        """
        Плейлисты сообщества. Пустые и служебные (номер меньше нуля: «Загруженные» и подобные)
        в ленту не идут: заходить в них незачем.
        """
        data = self._object(
            await self._call(
                ctx,
                "video.getAlbums",
                {"owner_id": owner, "count": str(PAGE), "offset": str(offset), "extended": "1"},
            )
        )
        cards = [
            self._album_card(entry)
            for entry in data.get("items") or []
            if isinstance(entry, dict)
            and isinstance(entry.get("id"), int)
            and entry["id"] > 0
            and isinstance(entry.get("owner_id"), int)
            and entry.get("count")
        ]
        total = data.get("count") if isinstance(data.get("count"), int) else 0
        following = offset + PAGE
        return {
            "items": cards,
            "next": str(following) if following < total and following <= MAX_OFFSET else None,
        }

    def _album_card(self, entry: dict[str, Any]) -> wire.Card:
        return wire.card(
            self.id,
            "playlist",
            f"{entry['owner_id']}_{entry['id']}",
            entry.get("title") or "Плейлист",
            channelId=str(entry["owner_id"]),
            count=entry.get("count"),
            poster=self.image(_picture(entry.get("image"), 320)),
        )

    async def _album(self, ctx: Ctx, owner: str, album: str) -> wire.PlaylistHead:
        head, entry = await asyncio.gather(
            self.memo.get(f"face:{owner}", lambda: self._head(ctx, owner), 300),
            self._call(
                ctx,
                "video.getAlbumById",
                {"owner_id": owner, "album_id": album},
                missing="Такого плейлиста на VK Видео нет",
            ),
            return_exceptions=True,
        )
        if isinstance(entry, BaseException):
            raise entry
        entry = self._object(entry)
        # Хозяин не ответил — плейлист всё равно открывается, просто без имени автора.
        name = head["title"] if isinstance(head, dict) else ""
        return wire.playlist_head(
            self.id,
            f"{owner}_{album}",
            entry.get("title") or "Плейлист",
            author=name,
            channelId=owner,
            count=entry.get("count"),
            published=_day(entry.get("updated_time")),
            poster=self.image(_picture(entry.get("image"), ART)),
        )

    async def _stream_page(self, ctx: Ctx, slug: str) -> wire.Details:
        """
        Страница эфира VK Видео Live: название эфира, хозяин и сколько смотрят.

        Двери «Открыть канал» у неё нет: канал Live — не сообщество VK, и страницы сообщества у
        него в кинозале нет.
        """
        stream = await self._blog(ctx, slug)
        user = stream.get("user") if isinstance(stream.get("user"), dict) else {}
        online = bool(stream.get("isOnline"))
        count = stream.get("count") if isinstance(stream.get("count"), dict) else {}
        return wire.details(
            self.id,
            "channel",
            slug,
            _plain(stream.get("title")) or user.get("displayName") or slug,
            author=user.get("displayName") or user.get("nick") or slug,
            channelAvatar=self.image(user.get("avatarUrl") or ""),
            live=online,
            viewers=count.get("viewers") if online else None,
            category=(stream.get("category") or {}).get("title")
            if isinstance(stream.get("category"), dict)
            else None,
            poster=self.image(stream.get("previewUrl") or stream.get("channelCoverImageUrl") or ""),
        )
