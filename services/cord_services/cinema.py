"""Кинозал: комната смотрит YouTube или Twitch, а видео берёт **сервер**, не браузер.

ПОЧЕМУ НЕ ВСТРАИВАЕМЫЙ ПЛЕЕР. Он был, и с машины сервера работал. У человека — нет: из его
сети `youtube.com` и `twitch.tv` попросту недоступны, и встраивание в этом случае не лечится
ничем — рамка чужая, ходит она из браузера. Поэтому источник переехал на сервер: он достаёт
плейлист и сегменты, а комнате отдаёт их со своего адреса. Заодно исчезли и чужие скрипты на
странице, и послабления в CSP, и «выберите качество в шестерёнке YouTube» — качество теперь
настоящий список уровней HLS, которым управляет наш собственный плеер.

ЧТО ИМЕННО ПРОКСИРУЕТСЯ. Только то, на что мы сами выдали подпись: адрес, срок и HMAC на
`INTERNAL_SECRET`, да ещё и хост из белого списка. Без этого открытый прокси чужого трафика
на своей машине — вопрос одного любопытного, а не времени. У длинных плейлистов подпись
заменена нумерацией — см. {@link Reels}, — но правило то же: наружу уходит только то, что мы
сами туда записали.

Поиск и каталог не требуют ни ключей, ни аккаунтов: YouTube — через yt-dlp (`ytsearch` и
вкладка `/videos` канала), Twitch — через их публичный GraphQL с тем же клиентским
идентификатором, которым пользуются streamlink и twitch-dl.
"""

from __future__ import annotations

import asyncio
import base64
import gzip
import hmac
import os
import re
import time
from hashlib import sha256
from typing import Any, Awaitable, Callable, Literal
from urllib.parse import urlencode, urljoin, urlsplit

import httpx
from fastapi import APIRouter, Header, HTTPException, Query
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

PREFIX = "/api/v1/services/cinema"

# Сколько живёт выданная подпись. Ссылки YouTube сами протухают за шесть часов, Twitch
# обновляет свои чаще; пять часов — меньше обоих сроков, и переоткрытие всё равно дешёвое.
SIGNATURE_TTL = 5 * 3600
# Обложки живут дольше: они не меняются и ничего не стоят.
IMAGE_TTL = 24 * 3600

ALLOWED_HOSTS = (
    "googlevideo.com",
    "youtube.com",
    "ytimg.com",
    "ggpht.com",
    # Картинки каналов YouTube лежат здесь, а не на `ytimg`. Пускать сюда можно только с нашей
    # подписью — как и всё остальное; без этого хоста страница канала была бы без лица.
    "googleusercontent.com",
    "ttvnw.net",
    "jtvnw.net",
    "twitchcdn.net",
    "twitch.tv",
    "akamaized.net",
)

TWITCH_GQL = "https://gql.twitch.tv/gql"
# Открытый идентификатор веб-клиента Twitch. Не секрет и не наш: его отдаёт их же страница,
# и на нём работают streamlink и twitch-dl.
TWITCH_CLIENT = "kimne78kx3ncx6brgo4mv6wki5h1ko"

Provider = Literal["youtube", "twitch"]
Kind = Literal["video", "channel"]

# Имя канала приходит от браузера и уходит в чужой адрес, поэтому проверяется здесь, а не
# «где-нибудь потом»: у YouTube это `UC…` или `@псевдоним`, у Twitch — логин.
CHANNEL_ID = re.compile(r"^[A-Za-z0-9_.@-]{1,80}$")


class Resolve(BaseModel):
    provider: Provider
    contentId: str = Field(min_length=1, max_length=64, pattern=r"[A-Za-z0-9_-]+")
    kind: Kind = "video"


def allowed(url: str) -> bool:
    host = (urlsplit(url).hostname or "").lower()
    return urlsplit(url).scheme == "https" and any(
        host == name or host.endswith("." + name) for name in ALLOWED_HOSTS
    )


class Signer:
    """Подпись адреса и срока. Ключ тот же, которым служба доказывает ядру, что она своя."""

    def __init__(self, secret: str):
        self._secret = (secret or "cord-cinema").encode()

    def sign(self, url: str, ttl: int = SIGNATURE_TTL) -> dict[str, str]:
        expires = str(int(time.time()) + ttl)
        packed = base64.urlsafe_b64encode(url.encode()).decode().rstrip("=")
        return {"u": packed, "e": expires, "s": self._digest(packed, expires)}

    def open(self, packed: str, expires: str, signature: str) -> str:
        if not hmac.compare_digest(signature, self._digest(packed, expires)):
            raise HTTPException(403, "Ссылка не подписана этим сервером")
        if not expires.isdigit() or int(expires) < time.time():
            raise HTTPException(410, "Ссылка устарела, откройте видео заново")
        try:
            url = base64.urlsafe_b64decode(packed + "=" * (-len(packed) % 4)).decode()
        except Exception:
            raise HTTPException(400, "Неразборчивая ссылка") from None
        if not allowed(url):
            raise HTTPException(403, "Этот адрес не обслуживается")
        return url

    def name(self, url: str) -> str:
        """Короткое имя адреса: то же самое доказательство, что и подпись, но без адреса внутри."""
        return self._digest(url, "reel")[:24]

    def _digest(self, packed: str, expires: str) -> str:
        return hmac.new(self._secret, f"{packed}|{expires}".encode(), sha256).hexdigest()[:32]


def proxied(signer: Signer, url: str, route: str, ttl: int = SIGNATURE_TTL) -> str:
    return f"{PREFIX}/{route}?" + urlencode(signer.sign(url, ttl))


def master_playlist(body: str) -> bool:
    """Мастер это или уже список сегментов. От ответа зависит, чем считать ссылки внутри."""
    return "#EXT-X-STREAM-INF" in body or "#EXT-X-MEDIA:" in body


def finished_playlist(body: str) -> bool:
    """Целое произведение или край живого эфира: у первого список сегментов больше не меняется."""
    return "#EXT-X-ENDLIST" in body or "#EXT-X-PLAYLIST-TYPE:VOD" in body


class Reels:
    """
    Сегменты досмотренного до конца плейлиста — под номером, а не под подписью.

    ПОЧЕМУ. Плейлист VOD перечисляет **все** сегменты до последнего, а один адрес сегмента у
    YouTube — тысяча двести символов, из которых тысяча сто шестьдесят девять одинаковые.
    Тринадцатичасовой ролик — это 9370 строк и 11 МБ, а после подписи каждой строки 16 МБ, и
    всё это браузер обязан скачать **до первого кадра**. Отсюда и жалоба: короткое открывается
    сразу, фильм — «висит».

    Поэтому в плейлисте стоит `seg/<имя>/<номер>` — сорок байт вместо тысячи с лишним, и те же
    9370 строк весят уже около трёхсот килобайт. Сам список живёт здесь, у нас, и хранится
    общим началом плюс хвосты: различаются адреса только байтовым диапазоном и номером.

    Имя считается от адреса плейлиста тем же ключом, что и подпись: угадать его нельзя, а
    комната, смотрящая одно и то же, получает одно имя на всех — и один разбор вместо пяти.

    Живой эфир сюда не попадает: у него номера сегментов уезжают вперёд каждые несколько
    секунд, а плейлист и без того короткий.
    """

    def __init__(self, signer: Signer, ttl: float = SIGNATURE_TTL, capacity: int = 24):
        self.signer = signer
        self.ttl = ttl
        self.capacity = capacity
        self._items: dict[str, tuple[float, str, list[str]]] = {}

    def remember(self, playlist_url: str, targets: list[str]) -> str:
        key = self.signer.name(playlist_url)
        shared = os.path.commonprefix(targets) if targets else ""
        self._items.pop(key, None)
        self._items[key] = (time.time(), shared, [target[len(shared) :] for target in targets])
        while len(self._items) > self.capacity:
            self._items.pop(next(iter(self._items)))
        return key

    def find(self, key: str, index: int) -> str:
        found = self._items.get(key)
        if not found or time.time() - found[0] > self.ttl:
            raise HTTPException(410, "Список кусочков устарел, откройте видео заново")
        _, shared, tails = found
        if index < 0 or index >= len(tails):
            raise HTTPException(404, "Такого кусочка в этом видео нет")
        # Срок считается от последнего обращения, а не от разбора: трёхчасовой фильм иначе
        # разваливался бы на середине. Заодно список переезжает в конец очереди на выселение —
        # то, что смотрят прямо сейчас, не должно уходить ради того, что открыли и бросили.
        self._items.pop(key)
        self._items[key] = (time.time(), shared, tails)
        return shared + tails[index]


def _attribute(line: str, base: str, signer: Signer) -> str:
    """Ссылка внутри тега: дорожка звука в мастере, карта инициализации и ключи в сегментах."""
    if 'URI="' not in line:
        return line
    head, _, rest = line.partition('URI="')
    inner, _, tail = rest.partition('"')
    target = urljoin(base, inner)
    if not allowed(target):
        return line
    kind = "playlist" if line.startswith("#EXT-X-MEDIA") else "fetch"
    return f'{head}URI="{proxied(signer, target, kind)}"{tail}'


def rewrite(body: str, base: str, signer: Signer, reels: Reels | None = None) -> str:
    """
    Переписывает плейлист на свои адреса.

    Внутри мастера все ссылки — плейлисты, внутри списка сегментов — сегменты и ключи. Поэтому
    вид плейлиста определяется один раз для всего тела, а не угадывается по каждой ссылке:
    у YouTube вариант выглядит как `/api/manifest/hls_playlist/...` без всякого `.m3u8`, и любая
    догадка по расширению ошиблась бы на нём первой же строкой.

    Досмотренному до конца списку сегментов достаётся нумерация вместо подписи, если есть куда
    её записать ({@link Reels}); живому эфиру и мастеру — подпись, как и раньше.
    """
    if reels is not None and not master_playlist(body) and finished_playlist(body):
        return _numbered(body, base, signer, reels)
    route = "playlist" if master_playlist(body) else "fetch"
    lines = []
    for line in body.splitlines():
        if not line:
            lines.append(line)
        elif line.startswith("#"):
            lines.append(_attribute(line, base, signer))
        else:
            target = urljoin(base, line.strip())
            lines.append(proxied(signer, target, route) if allowed(target) else line)
    return "\n".join(lines) + "\n"


def _numbered(body: str, base: str, signer: Signer, reels: Reels) -> str:
    """
    То же самое, но сегменты нумеруются.

    Номер относительный — `seg/<имя>/<номер>`, — и это не экономия ради экономии: плейлист
    лежит по адресу `…/cinema/playlist?u=…`, и относительная ссылка разворачивается браузером
    в `…/cinema/seg/<имя>/<номер>` сама. Абсолютный путь стоил бы двадцати шести лишних байт
    на каждой из десяти тысяч строк.
    """
    targets: list[str] = []
    shape: list[str | None] = []
    for line in body.splitlines():
        if not line:
            shape.append(line)
        elif line.startswith("#"):
            shape.append(_attribute(line, base, signer))
        else:
            target = urljoin(base, line.strip())
            if allowed(target):
                shape.append(None)
                targets.append(target)
            else:
                shape.append(line)
    key = reels.remember(base, targets)
    lines = []
    number = 0
    for line in shape:
        if line is None:
            lines.append(f"seg/{key}/{number}")
            number += 1
        else:
            lines.append(line)
    return "\n".join(lines) + "\n"


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


TWITCH_CHANNEL = """{ user(login: "%s") { id login displayName description
  profileImageURL(width: 300) bannerImageURL
  followers { totalCount }
  stream { id title viewersCount previewImageURL(width: 440, height: 248) game { name } }
  videos(first: %d, sort: TIME) { edges { node { id title lengthSeconds viewCount
    publishedAt previewThumbnailURL(width: 440, height: 248) game { name } } } } } }"""

TWITCH_VIDEO = """{ video(id: "%s") { id title lengthSeconds viewCount publishedAt
  description previewThumbnailURL(width: 440, height: 248) game { name }
  owner { login displayName profileImageURL(width: 300) followers { totalCount } } } }"""

# Категория Twitch — это игра или раздел вроде «Just Chatting». Берётся по числовому
# идентификатору, а не по названию: имя приходит из браузера, а идентификатор проверяется
# одной цифровой проверкой и не может стать ничем иным.
TWITCH_CATEGORY = """{ game(id: "%s") { id name displayName viewersCount
  boxArtURL(width: 285, height: 380)
  streams(first: %d) { edges { node { id title viewersCount
    previewImageURL(width: 440, height: 248) broadcaster { login displayName }
    game { name } } } } } }"""

YT_FLAT = {
    "quiet": True,
    "no_warnings": True,
    "skip_download": True,
    "extract_flat": True,
    "cachedir": False,
    "socket_timeout": 20,
}

# Сколько карточек отдаётся за один раз. Столько же YouTube кладёт в одно продолжение своей
# ленты, поэтому страница каталога и порция площадки совпадают — лишних запросов не бывает.
PAGE = 30
# Сколько роликов ищется в глубину: поиск площадка отдаёт целиком, и листание по нему уже
# ничего наружу не стоит. Два-три экрана — ровно столько, сколько долистывают.
SEARCH_DEPTH = 60
# Сколько живых эфиров и записей просить у Twitch за один раз.
TWITCH_DEPTH = 100
# Верхняя граница листания. Не защита от человека, а защита от заблудившегося запроса:
# `playliststart` в десять тысяч заставил бы yt-dlp пройти триста продолжений подряд.
MAX_OFFSET = 600

# Что показывает страница канала. `about` — единственная без ленты: она про сам канал.
Tab = Literal["videos", "streams", "shorts", "playlists", "about"]

# Плейлист (`PL…`, `UU…`, `OLAK5uy_…`) проверяется тем же правилом, что и имя канала: строка
# уходит в чужой адрес, и всё, что не буква, цифра или знак из списка, до него не доходит.
CATALOG_ID = CHANNEL_ID
# Идентификатор категории Twitch — только цифры.
CATEGORY_ID = re.compile(r"^[0-9]{1,20}$")


def offset_of(cursor: str | None) -> int:
    """
    Курсор — это место в ленте, и наружу он уходит строкой.

    Клиент передаёт его обратно, не разбирая: сегодня это номер карточки, и обеим площадкам
    этого хватает. У YouTube листание настоящее (`playliststart` у продолжения ленты), у
    Twitch — по уже полученному списку: их GraphQL отвечает на продолжение отказом
    `failed integrity check`, если спрашивать анонимно, а `first: 100` отдаёт честно.
    """
    if not cursor:
        return 0
    if not cursor.isdigit() or int(cursor) > MAX_OFFSET:
        raise HTTPException(400, "Дальше листать нечего")
    return int(cursor)


def page(items: list[Any], offset: int, limit: int = PAGE) -> dict[str, Any]:
    """Порция уже полученного списка и место, с которого продолжать."""
    chunk = items[offset : offset + limit]
    return {"items": chunk, "next": str(offset + limit) if offset + limit < len(items) else None}


def absolute(url: str | None) -> str:
    """Адреса картинок у YouTube бывают без схемы (`//yt3.ggpht.com/…`) — с ней они в белом списке."""
    if not url:
        return ""
    return "https:" + url if url.startswith("//") else url


class Cinema:
    def __init__(self, secret: str, client: httpx.AsyncClient | None = None):
        self.signer = Signer(secret)
        self.segments = Segments()
        self.reels = Reels(self.signer)
        self.catalog = Memo()
        self.sources = Memo(capacity=64)
        self.client = client or httpx.AsyncClient(
            timeout=httpx.Timeout(20.0, read=60.0),
            follow_redirects=True,
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Cord/1.0"},
        )

    async def close(self):
        await self.client.aclose()

    # --- поиск и каталог -------------------------------------------------------------

    async def search(self, provider: Provider, query: str, cursor: str = "") -> dict[str, Any]:
        """
        Что показать по набранному — и что показать, пока не набрано ничего.

        Ответ один на обе площадки: лента карточек, а над ней полки — каналы у YouTube,
        категории у Twitch. Полка приезжает только с первой порцией: листая ленту вниз,
        каналы второй раз не ищут.
        """
        offset = offset_of(cursor)
        query = query.strip()
        if provider == "twitch":
            return await self._twitch_catalog(query, offset)
        return await self._youtube_catalog(query, offset)

    async def _youtube_catalog(self, query: str, offset: int) -> dict[str, Any]:
        """
        Поиск YouTube: ролики лентой, каналы полкой.

        ПОЧЕМУ ДВА ЗАПРОСА. `ytsearch` отдаёт **только ролики** — набрав имя канала, человек
        получал что угодно про него, кроме его самого, и дверь на канал находилась лишь через
        чужой ролик. Вкладка «Каналы» у самого YouTube — это отдельный поиск (`sp=EgIQAg`), и
        здесь он такой же отдельный: идут оба разом, а ждём мы того, кто медленнее.
        """
        if len(query) < 2:
            return {"items": [], "channels": [], "categories": [], "next": None}
        low = query.lower()
        wanted = [
            self.catalog.get(
                f"search:youtube:{low}",
                lambda: asyncio.to_thread(self._youtube_videos, query, SEARCH_DEPTH),
                120,
            )
        ]
        if offset == 0:
            wanted.append(
                self.catalog.get(
                    f"search:youtube:channels:{low}",
                    lambda: asyncio.to_thread(self._youtube_channels, query, 4),
                    300,
                )
            )
        found = await asyncio.gather(*wanted)
        return {**page(found[0], offset), "channels": found[1] if offset == 0 else [], "categories": []}

    async def _twitch_catalog(self, query: str, offset: int) -> dict[str, Any]:
        """Пусто — это витрина живых эфиров; набрано — каналы лентой и категории полкой."""
        if not query:
            streams = await self.catalog.get("twitch:live", self._twitch_popular, 60)
            return {**page(streams, offset), "channels": [], "categories": []}
        low = query.lower()
        channels, categories = await asyncio.gather(
            self.catalog.get(f"twitch:search:{low}", lambda: self._twitch_search(query), 120),
            self.catalog.get(f"twitch:games:{low}", lambda: self._twitch_games(query), 300),
        )
        return {**page(channels, offset), "channels": [], "categories": categories[:8] if offset == 0 else []}

    async def channel(
        self, provider: Provider, channel_id: str, tab: Tab = "videos", cursor: str = ""
    ) -> dict[str, Any]:
        """
        Страница канала, вкладка за вкладкой.

        Вкладки здесь те же, что у площадки, и это не украшение: канал, у которого пять сотен
        роликов, десяток плейлистов и идущий прямо сейчас эфир, одной лентой не показывается
        никак. Каждая вкладка листается своей лентой; `about` ленты не имеет вовсе.
        """
        if not CATALOG_ID.match(channel_id):
            raise HTTPException(400, "Непонятное имя канала")
        offset = offset_of(cursor)
        return await self.catalog.get(
            f"channel:{provider}:{channel_id.lower()}:{tab}:{offset}",
            lambda: (
                asyncio.to_thread(self._youtube_channel, channel_id, tab, offset)
                if provider == "youtube"
                else self._twitch_channel_page(channel_id, tab, offset)
            ),
            # Память короткая нарочно: сверху у канала лежит самое свежее, и «самое свежее»
            # не должно означать «самое свежее полчаса назад».
            60,
        )

    async def playlist(self, provider: Provider, playlist_id: str, cursor: str = "") -> dict[str, Any]:
        """Плейлист целиком: его описание и ролики в том порядке, в котором их собрали."""
        if provider != "youtube":
            raise HTTPException(400, "Плейлисты есть только у YouTube")
        if not CATALOG_ID.match(playlist_id):
            raise HTTPException(400, "Непонятный адрес плейлиста")
        offset = offset_of(cursor)
        return await self.catalog.get(
            f"playlist:{playlist_id.lower()}:{offset}",
            lambda: asyncio.to_thread(self._youtube_playlist, playlist_id, offset),
            60,
        )

    async def categories(self, provider: Provider, query: str = "", cursor: str = "") -> dict[str, Any]:
        """Разделы Twitch: что смотрят прямо сейчас, по играм и рубрикам."""
        if provider != "twitch":
            return {"items": [], "next": None}
        offset = offset_of(cursor)
        query = query.strip()
        items = await self.catalog.get(
            f"twitch:games:{query.lower()}" if query else "twitch:games",
            lambda: self._twitch_games(query),
            300 if query else 120,
        )
        return page(items, offset)

    async def category(self, provider: Provider, category_id: str, cursor: str = "") -> dict[str, Any]:
        """Один раздел Twitch: его карточка и эфиры, которые идут в нём сейчас."""
        if provider != "twitch":
            raise HTTPException(400, "Разделы есть только у Twitch")
        if not CATEGORY_ID.match(category_id):
            raise HTTPException(400, "Непонятный раздел")
        offset = offset_of(cursor)
        found = await self.catalog.get(
            f"twitch:category:{category_id}", lambda: self._twitch_category(category_id), 60
        )
        return {"category": found["category"], **page(found["items"], offset)}

    async def details(self, provider: Provider, content_id: str, kind: Kind) -> dict[str, Any]:
        if not CHANNEL_ID.match(content_id):
            raise HTTPException(400, "Непонятный адрес видео")
        return await self.catalog.get(
            f"details:{provider}:{kind}:{content_id.lower()}",
            lambda: (
                asyncio.to_thread(self._youtube_details, content_id)
                if provider == "youtube"
                else self._twitch_details(content_id, kind)
            ),
            600,
        )

    @staticmethod
    def _extract(address: str, options: dict[str, Any]) -> dict[str, Any]:
        import yt_dlp

        with yt_dlp.YoutubeDL(options) as ydl:
            return ydl.extract_info(address, download=False) or {}

    def _youtube_videos(self, query: str, limit: int):
        found = self._extract(f"ytsearch{limit}:{query}", YT_FLAT)
        return [
            self._youtube_item(entry)
            for entry in found.get("entries", []) or []
            if entry and entry.get("id")
        ]

    def _youtube_channels(self, query: str, limit: int):
        """
        Каналы по названию — отдельной вкладкой поиска YouTube (`sp=EgIQAg`).

        В карточке есть всё, ради чего на канал и смотрят до перехода: лицо, имя, псевдоним и
        сколько людей подписано. Ошибка здесь не ломает поиск: полка каналов пропадает, лента
        роликов остаётся.
        """
        address = "https://www.youtube.com/results?" + urlencode(
            {"search_query": query, "sp": "EgIQAg=="}
        )
        try:
            found = self._extract(address, {**YT_FLAT, "playlistend": limit})
        except Exception:
            return []
        cards = []
        for entry in found.get("entries", []) or []:
            identity = (entry or {}).get("channel_id") or (entry or {}).get("id")
            if not entry or not identity or not str(identity).startswith("UC"):
                continue
            cards.append(
                {
                    "provider": "youtube",
                    "kind": "channel",
                    "id": identity,
                    "title": entry.get("channel") or entry.get("title") or identity,
                    "author": entry.get("uploader_id") or "",
                    "channelId": identity,
                    "duration": None,
                    "live": False,
                    "viewers": None,
                    "views": None,
                    "followers": entry.get("channel_follower_count"),
                    "description": (entry.get("description") or "")[:300],
                    "poster": self.image(self._widest(entry.get("thumbnails") or [], portrait=True)),
                }
            )
        return cards

    def _youtube_item(
        self, entry: dict[str, Any], channel: dict[str, str] | None = None
    ) -> dict[str, Any]:
        # На странице канала у роликов нет ни его имени, ни его идентификатора: они лежат
        # уровнем выше, у самой страницы. Без этого дверь «Открыть канал» со страницы ролика
        # пропадала ровно там, где по ней и ходят — при переходе с канала на канал.
        return {
            "provider": "youtube",
            "kind": "video",
            "id": entry["id"],
            "title": entry.get("title") or "Без названия",
            "author": entry.get("channel") or entry.get("uploader") or (channel or {}).get("title") or "",
            "channelId": entry.get("channel_id") or (channel or {}).get("id") or None,
            "duration": entry.get("duration"),
            # У ленты канала признак эфира приходит словом, а у поиска — флагом: идущий
            # прямо сейчас эфир иначе выглядел бы как обычный ролик без длительности.
            "live": bool(entry.get("is_live")) or entry.get("live_status") == "is_live",
            "viewers": entry.get("concurrent_view_count"),
            "views": entry.get("view_count"),
            "poster": self.image(f"https://i.ytimg.com/vi/{entry['id']}/mqdefault.jpg"),
        }

    def _youtube_playlist_card(
        self, entry: dict[str, Any], channel: dict[str, str] | None = None
    ) -> dict[str, Any]:
        """Плейлист в ленте канала. Смотреть его нельзя — в него заходят."""
        pictures = entry.get("thumbnails") or []
        return {
            "provider": "youtube",
            "kind": "playlist",
            "id": entry["id"],
            "title": entry.get("title") or "Плейлист",
            # У плейлистов в ленте канала на месте имени автора стоит «View full playlist» —
            # подпись кнопки, а не чьё-то имя. Имя здесь всегда известно уровнем выше.
            "author": (channel or {}).get("title") or "",
            "channelId": (channel or {}).get("id") or None,
            "duration": None,
            "live": False,
            "viewers": None,
            "views": None,
            "count": entry.get("playlist_count"),
            "poster": self.image(pictures[-1]["url"] if pictures else ""),
        }

    @staticmethod
    def _youtube_address(channel_id: str) -> str:
        return (
            f"https://www.youtube.com/{channel_id}"
            if channel_id.startswith("@")
            else f"https://www.youtube.com/channel/{channel_id}"
        )

    def _youtube_channel(self, channel_id: str, tab: Tab = "videos", offset: int = 0) -> dict[str, Any]:
        """
        Одна вкладка канала и одна порция её ленты.

        `about` ленты не имеет, но шапка нужна и ей — поэтому спрашивается та же вкладка
        роликов, только одной строкой: дешевле, чем отдельный разбор главной страницы.

        Вкладки у канала бывают не все: у кого-то нет трансляций, у кого-то коротких роликов.
        Площадка отвечает на это отказом, и отказ здесь — это пустая вкладка, а не сломанная
        страница: шапка канала к этому моменту уже показана.
        """
        listing = "videos" if tab == "about" else tab
        options = {
            **YT_FLAT,
            "extract_flat": "in_playlist",
            "playliststart": offset + 1,
            "playlistend": offset + (1 if tab == "about" else PAGE),
        }
        try:
            found = self._extract(f"{self._youtube_address(channel_id)}/{listing}", options)
        except Exception as error:
            if "does not have a" in str(error):
                return {"channel": None, "items": [], "next": None}
            raise HTTPException(502, f"Канал не открылся: {error}"[:200]) from None
        pictures = found.get("thumbnails") or []
        identity = {
            "id": found.get("channel_id") or channel_id,
            "title": found.get("channel") or found.get("uploader") or channel_id,
        }
        entries = [entry for entry in (found.get("entries") or []) if entry and entry.get("id")]
        card = self._youtube_playlist_card if tab == "playlists" else self._youtube_item
        items = [] if tab == "about" else [card(entry, identity) for entry in entries]
        return {
            "channel": {
                "provider": "youtube",
                "id": identity["id"],
                "title": identity["title"],
                # Псевдоним канала (`@имя`) — то, по чему его узнают и ищут, и то, чем он
                # открывается снова: ссылка на него короче и переживает переименование.
                "handle": found.get("uploader_id") or (channel_id if channel_id.startswith("@") else ""),
                "description": (found.get("description") or "")[:1200],
                "followers": found.get("channel_follower_count"),
                "viewers": None,
                "live": any(item.get("live") for item in items),
                "category": None,
                "avatar": self.image(self._widest(pictures, portrait=True)),
                "banner": self.image(self._widest(pictures, portrait=False)),
            },
            "items": items,
            "next": str(offset + PAGE) if len(entries) >= PAGE and tab != "about" else None,
        }

    def _youtube_playlist(self, playlist_id: str, offset: int) -> dict[str, Any]:
        """Плейлист целиком: его собственная карточка и ролики порциями, в порядке сборки."""
        options = {
            **YT_FLAT,
            "extract_flat": "in_playlist",
            "playliststart": offset + 1,
            "playlistend": offset + PAGE,
        }
        try:
            found = self._extract(
                f"https://www.youtube.com/playlist?list={playlist_id}", options
            )
        except Exception as error:
            raise HTTPException(502, f"Плейлист не открылся: {error}"[:200]) from None
        pictures = found.get("thumbnails") or []
        identity = {
            "id": found.get("channel_id") or "",
            "title": found.get("channel") or found.get("uploader") or "",
        }
        entries = [entry for entry in (found.get("entries") or []) if entry and entry.get("id")]
        return {
            "playlist": {
                "provider": "youtube",
                "kind": "playlist",
                "id": playlist_id,
                "title": found.get("title") or "Плейлист",
                "author": identity["title"],
                "channelId": identity["id"] or None,
                "description": (found.get("description") or "")[:1200],
                "count": found.get("playlist_count"),
                "views": found.get("view_count"),
                "published": found.get("modified_date"),
                "poster": self.image(pictures[-1]["url"] if pictures else ""),
            },
            "items": [self._youtube_item(entry, identity) for entry in entries],
            "next": str(offset + PAGE) if len(entries) >= PAGE else None,
        }

    @staticmethod
    def _widest(pictures: list[dict[str, Any]], portrait: bool) -> str:
        """
        Лицо канала и его полоса лежат в одном списке, и отличаются только формой кадра.

        Квадратное — это аватар, вытянутое в четыре ширины — шапка. Разделять их по именам
        полей нельзя: имён у yt-dlp для этого нет, а форма есть у каждой картинки.
        """
        fitting = [
            picture
            for picture in pictures
            if picture.get("url")
            and picture.get("width")
            and picture.get("height")
            and (
                (picture["width"] / picture["height"] < 1.6)
                if portrait
                else (picture["width"] / picture["height"] > 3)
            )
        ]
        if not fitting:
            return ""
        return max(fitting, key=lambda picture: picture["width"])["url"]

    def _youtube_details(self, content_id: str) -> dict[str, Any]:
        info = self._probe(f"https://www.youtube.com/watch?v={content_id}")
        return {
            "provider": "youtube",
            "kind": "video",
            "id": content_id,
            "title": info.get("title") or content_id,
            "author": info.get("channel") or info.get("uploader") or "",
            "channelId": info.get("channel_id") or None,
            "channelAvatar": None,
            "duration": None if info.get("is_live") else info.get("duration"),
            "live": bool(info.get("is_live")),
            "views": info.get("view_count"),
            "viewers": info.get("concurrent_view_count"),
            "followers": info.get("channel_follower_count"),
            "published": info.get("upload_date"),
            "category": (info.get("categories") or [None])[0],
            "description": (info.get("description") or "")[:4000],
            "poster": self.image(info.get("thumbnail") or ""),
        }

    async def _twitch_gql(self, query: str) -> dict[str, Any]:
        response = await self.client.post(
            TWITCH_GQL,
            json={"query": query},
            headers={"Client-ID": TWITCH_CLIENT},
        )
        if response.status_code != 200:
            raise HTTPException(502, "Twitch не ответил на запрос каталога")
        body = response.json()
        if body.get("errors"):
            raise HTTPException(502, "Twitch отказал в запросе каталога")
        return body.get("data") or {}

    def _twitch_stream(self, node: dict[str, Any]) -> dict[str, Any] | None:
        """Идущий эфир как карточка каталога. Смотрится он по имени канала, а не по номеру эфира."""
        caster = node.get("broadcaster") or {}
        if not caster.get("login"):
            return None
        return {
            "provider": "twitch",
            "kind": "channel",
            "id": caster["login"],
            "title": node.get("title") or caster.get("displayName") or "",
            "author": caster.get("displayName") or caster["login"],
            "channelId": caster["login"],
            "duration": None,
            "live": True,
            "viewers": node.get("viewersCount"),
            "views": None,
            "category": (node.get("game") or {}).get("name"),
            "poster": self.image(node.get("previewImageURL") or ""),
        }

    async def _twitch_popular(self):
        # Тридцать — не наша скромность, а предел самого Twitch: `first` больше тридцати он
        # отвергает, а на продолжение анонимному клиенту отвечает отказом о проверке целостности.
        data = await self._twitch_gql(
            "{ streams(first: 30) { edges { node { id title viewersCount "
            "previewImageURL(width: 440, height: 248) broadcaster { login displayName } "
            "game { name } } } } }"
        )
        items = []
        for edge in (data.get("streams") or {}).get("edges", []) or []:
            found = self._twitch_stream(edge.get("node") or {})
            if found:
                items.append(found)
        return items

    async def _twitch_games(self, query: str = ""):
        """
        Разделы Twitch: список рубрик с обложкой и числом смотрящих.

        Пустой запрос — витрина по популярности, набранный — поиск по названию. Это те же
        категории, по которым на Twitch и ходят: «что сейчас играют» там выбирают раньше, чем
        «кого смотреть».
        """
        if query:
            safe = query.replace("\\", " ").replace('"', " ")[:60]
            data = await self._twitch_gql(
                '{ searchFor(userQuery: "%s", platform: "web", target: {index: GAME}) '
                "{ games { items { id name displayName viewersCount "
                "boxArtURL(width: 285, height: 380) } } } }" % safe
            )
            nodes = ((data.get("searchFor") or {}).get("games") or {}).get("items") or []
        else:
            data = await self._twitch_gql(
                "{ games(first: %d) { edges { node { id name displayName viewersCount "
                "boxArtURL(width: 285, height: 380) } } } }" % TWITCH_DEPTH
            )
            nodes = [edge.get("node") or {} for edge in (data.get("games") or {}).get("edges", []) or []]
        return [
            {
                "provider": "twitch",
                "kind": "category",
                "id": str(node["id"]),
                "title": node.get("displayName") or node.get("name") or "",
                "viewers": node.get("viewersCount"),
                "poster": self.image(node.get("boxArtURL") or ""),
            }
            for node in nodes
            if node.get("id")
        ]

    async def _twitch_category(self, category_id: str) -> dict[str, Any]:
        data = await self._twitch_gql(TWITCH_CATEGORY % (category_id, TWITCH_DEPTH))
        game = data.get("game")
        if not game:
            raise HTTPException(404, "Такого раздела на Twitch нет")
        items = []
        for edge in (game.get("streams") or {}).get("edges", []) or []:
            found = self._twitch_stream(edge.get("node") or {})
            if found:
                items.append(found)
        return {
            "category": {
                "provider": "twitch",
                "kind": "category",
                "id": str(game["id"]),
                "title": game.get("displayName") or game.get("name") or "",
                "viewers": game.get("viewersCount"),
                "poster": self.image(game.get("boxArtURL") or ""),
            },
            "items": items,
        }

    async def _twitch_search(self, query: str, limit: int = TWITCH_DEPTH):
        safe = query.replace("\\", " ").replace('"', " ")[:60]
        data = await self._twitch_gql(
            '{ searchFor(userQuery: "%s", platform: "web", target: {index: CHANNEL}) '
            "{ channels { items { id login displayName profileImageURL(width: 300) "
            "stream { viewersCount previewImageURL(width: 440, height: 248) game { name } } "
            "} } } }" % safe
        )
        items = []
        channels = ((data.get("searchFor") or {}).get("channels") or {}).get("items") or []
        for channel in channels[:limit]:
            stream = channel.get("stream") or {}
            items.append(
                {
                    "provider": "twitch",
                    "kind": "channel",
                    "id": channel.get("login"),
                    "title": channel.get("displayName") or channel.get("login") or "",
                    "author": channel.get("displayName") or "",
                    "channelId": channel.get("login"),
                    "duration": None,
                    "live": bool(stream),
                    "viewers": stream.get("viewersCount"),
                    "views": None,
                    "category": (stream.get("game") or {}).get("name"),
                    "poster": self.image(
                        stream.get("previewImageURL") or channel.get("profileImageURL") or ""
                    ),
                }
            )
        # Живые каналы выше: список, где эфир вперемешку с молчащими, читается хуже.
        items.sort(key=lambda item: (not item["live"], -(item.get("viewers") or 0)))
        return items

    async def _twitch_channel_page(self, login: str, tab: Tab, offset: int) -> dict[str, Any]:
        """
        Страница канала Twitch порциями.

        Порция режется по уже полученному списку, а не спрашивается заново: продолжение
        Twitch анонимному клиенту не отдаёт, зато сотню записей отдаёт одним ответом. Идущий
        эфир стоит первым и только в первой порции — ниже по ленте ему не место.
        """
        found = await self.catalog.get(
            f"twitch:channel:{login.lower()}", lambda: self._twitch_channel(login), 60
        )
        if tab == "about":
            return {"channel": found["channel"], "items": [], "next": None}
        live = [item for item in found["items"] if item["live"]]
        records = [item for item in found["items"] if not item["live"]]
        if tab == "streams":
            return {"channel": found["channel"], **page(live, offset)}
        return {
            "channel": found["channel"],
            "items": (live if offset == 0 else []) + records[offset : offset + PAGE],
            "next": str(offset + PAGE) if len(records) > offset + PAGE else None,
        }

    async def _twitch_channel(self, login: str) -> dict[str, Any]:
        data = await self._twitch_gql(TWITCH_CHANNEL % (login.replace('"', "")[:40], TWITCH_DEPTH))
        user = data.get("user")
        if not user:
            raise HTTPException(404, "Такого канала на Twitch нет")
        stream = user.get("stream") or {}
        items: list[dict[str, Any]] = []
        if stream:
            items.append(
                {
                    "provider": "twitch",
                    "kind": "channel",
                    "id": user["login"],
                    "title": stream.get("title") or user.get("displayName") or "",
                    "author": user.get("displayName") or user["login"],
                    "channelId": user["login"],
                    "duration": None,
                    "live": True,
                    "viewers": stream.get("viewersCount"),
                    "views": None,
                    "category": (stream.get("game") or {}).get("name"),
                    "poster": self.image(stream.get("previewImageURL") or ""),
                }
            )
        for edge in (user.get("videos") or {}).get("edges", []) or []:
            node = edge.get("node") or {}
            if not node.get("id"):
                continue
            items.append(
                {
                    "provider": "twitch",
                    # Запись эфира — это ролик с позицией, а не живой канал: её можно ставить
                    # на паузу и перематывать, и комната смотрит её с одной секунды.
                    "kind": "video",
                    "id": node["id"],
                    "title": node.get("title") or "Прошлая трансляция",
                    "author": user.get("displayName") or user["login"],
                    "channelId": user["login"],
                    "duration": node.get("lengthSeconds"),
                    "live": False,
                    "viewers": None,
                    "views": node.get("viewCount"),
                    "category": (node.get("game") or {}).get("name"),
                    "published": (node.get("publishedAt") or "")[:10],
                    "poster": self.image(node.get("previewThumbnailURL") or ""),
                }
            )
        return {
            "channel": {
                "provider": "twitch",
                "id": user["login"],
                "title": user.get("displayName") or user["login"],
                "handle": user["login"],
                "description": (user.get("description") or "")[:1200],
                "followers": (user.get("followers") or {}).get("totalCount"),
                "viewers": stream.get("viewersCount"),
                "live": bool(stream),
                "category": (stream.get("game") or {}).get("name"),
                "avatar": self.image(user.get("profileImageURL") or ""),
                "banner": self.image(user.get("bannerImageURL") or ""),
            },
            "items": items,
        }

    async def _twitch_details(self, content_id: str, kind: Kind) -> dict[str, Any]:
        if kind == "channel":
            page = await self._twitch_channel(content_id)
            channel = page["channel"]
            live = next((item for item in page["items"] if item["live"]), None)
            return {
                **channel,
                "kind": "channel",
                "title": (live or {}).get("title") or channel["title"],
                "author": channel["title"],
                "channelId": channel["id"],
                "channelAvatar": channel["avatar"],
                "duration": None,
                "views": None,
                "published": None,
                "poster": (live or {}).get("poster") or channel["banner"],
            }
        data = await self._twitch_gql(TWITCH_VIDEO % content_id.replace('"', "")[:40])
        video = data.get("video")
        if not video:
            raise HTTPException(404, "Такой записи на Twitch нет")
        owner = video.get("owner") or {}
        return {
            "provider": "twitch",
            "kind": "video",
            "id": content_id,
            "title": video.get("title") or "Прошлая трансляция",
            "author": owner.get("displayName") or owner.get("login") or "",
            "channelId": owner.get("login"),
            "channelAvatar": self.image(owner.get("profileImageURL") or ""),
            "duration": video.get("lengthSeconds"),
            "live": False,
            "views": video.get("viewCount"),
            "viewers": None,
            "followers": (owner.get("followers") or {}).get("totalCount"),
            "published": (video.get("publishedAt") or "")[:10],
            "category": (video.get("game") or {}).get("name"),
            "description": (video.get("description") or "")[:4000],
            "poster": self.image(video.get("previewThumbnailURL") or ""),
        }

    def image(self, url: str) -> str | None:
        """Обложка у нас, а не у площадки. Адрес без схемы получает её здесь — иначе он
        не прошёл бы белый список и картинка тихо пропала бы с карточки."""
        full = absolute(url)
        return proxied(self.signer, full, "image", IMAGE_TTL) if full and allowed(full) else None

    # --- разрешение ссылки в поток ---------------------------------------------------

    async def resolve(self, request: Resolve) -> dict[str, Any]:
        # Один разбор на всю комнату: пятеро зрителей открывают одно и то же видео в одну и ту
        # же минуту, и пять запросов к площадке ради одного ответа — это просто пять ожиданий.
        # Живой эфир держится меньше: его адреса обновляются чаще, чем меняется афиша.
        return await self.sources.get(
            f"{request.provider}:{request.kind}:{request.contentId}",
            lambda: self._resolve(request),
            lambda source: 45 if source["live"] else 1800,
        )

    async def _resolve(self, request: Resolve) -> dict[str, Any]:
        if request.provider == "youtube":
            source = f"https://www.youtube.com/watch?v={request.contentId}"
        elif request.kind == "video":
            source = f"https://www.twitch.tv/videos/{request.contentId}"
        else:
            source = f"https://www.twitch.tv/{request.contentId}"
        info = await asyncio.to_thread(self._probe, source)
        stream, kind = self._stream(info)
        if not stream:
            raise HTTPException(
                502, "Площадка не отдала поток для этого видео. Попробуйте другое"
            )
        poster = info.get("thumbnail") or ""
        return {
            "provider": request.provider,
            "contentId": request.contentId,
            "title": info.get("title") or request.contentId,
            "author": info.get("uploader") or info.get("channel") or "",
            "duration": None if info.get("is_live") else info.get("duration"),
            "live": bool(info.get("is_live")),
            "kind": kind,
            "url": proxied(self.signer, stream, "playlist" if kind == "hls" else "fetch"),
            "poster": self.image(poster),
        }

    def _probe(self, source: str) -> dict[str, Any]:
        import yt_dlp

        options = {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "noplaylist": True,
            "cachedir": False,
            "socket_timeout": 20,
        }
        try:
            with yt_dlp.YoutubeDL(options) as ydl:
                return ydl.extract_info(source, download=False) or {}
        except Exception as error:  # yt_dlp поднимает свои типы; наружу идёт человеческий текст
            raise HTTPException(502, f"Не удалось открыть видео: {error}"[:300]) from None

    @staticmethod
    def _stream(info: dict[str, Any]) -> tuple[str | None, str]:
        """
        Что отдать плееру: мастер HLS — если площадка его предлагает, иначе готовый файл.

        HLS предпочтительнее не из красоты: в нём лежат **все** уровни качества сразу, и выбор
        между ними делает наш плеер, а не площадка. Обычный файл остаётся запасным ходом для
        тех роликов, которым YouTube плейлиста не даёт; там качество одно.
        """
        formats = info.get("formats") or []
        for item in formats:
            if str(item.get("protocol", "")).startswith("m3u8") and item.get("manifest_url"):
                return item["manifest_url"], "hls"
        if info.get("manifest_url"):
            return info["manifest_url"], "hls"
        progressive = [
            item
            for item in formats
            if item.get("acodec") not in (None, "none")
            and item.get("vcodec") not in (None, "none")
            and item.get("url")
            and str(item.get("protocol", "")).startswith("http")
        ]
        progressive.sort(key=lambda item: (item.get("height") or 0, item.get("tbr") or 0))
        if progressive:
            return progressive[-1]["url"], "file"
        return (info.get("url"), "file") if info.get("url") else (None, "file")

    # --- прокси ------------------------------------------------------------------------

    async def manifest(self, url: str, encodings: str | None = None) -> Response:
        response = await self.client.get(url)
        if response.status_code >= 400:
            raise HTTPException(502, "Площадка не отдала плейлист")
        body = rewrite(response.text, str(response.url), self.signer, self.reels)
        headers = {"Cache-Control": "no-store"}
        payload = body.encode()
        # Плейлист фильма — это тысячи почти одинаковых строк. Сжатие снимает с них ещё
        # порядок, и делать это стоит именно здесь: у сегментов сжимать нечего, они уже видео.
        if "gzip" in (encodings or "") and len(payload) > 4096:
            payload = gzip.compress(payload, 6)
            headers["Content-Encoding"] = "gzip"
        return Response(payload, media_type="application/vnd.apple.mpegurl", headers=headers)

    async def fetch(self, url: str, range_header: str | None) -> Response:
        # Целый сегмент — то, что просят все и одинаково: он идёт через общую память.
        # Частичный запрос (перемотка в готовом файле) обслуживается напрямую.
        if not range_header:
            cached = self.segments.get(url)
            if cached:
                body, kind = cached
                return Response(body, media_type=kind, headers={"Cache-Control": "private, max-age=600"})
            async with self.segments.lock(url):
                cached = self.segments.get(url)
                if cached:
                    body, kind = cached
                    return Response(
                        body, media_type=kind, headers={"Cache-Control": "private, max-age=600"}
                    )
                answer = await self.client.get(url)
                if answer.status_code >= 400:
                    raise HTTPException(502, "Площадка не отдала данные")
                kind = answer.headers.get("content-type", "video/mp2t")
                self.segments.put(url, answer.content, kind)
                return Response(
                    answer.content, media_type=kind, headers={"Cache-Control": "private, max-age=600"}
                )
        headers = {"Range": range_header}
        request = self.client.build_request("GET", url, headers=headers)
        upstream = await self.client.send(request, stream=True)
        if upstream.status_code >= 400:
            await upstream.aclose()
            raise HTTPException(502, "Площадка не отдала данные")

        async def body():
            try:
                async for chunk in upstream.aiter_raw():
                    yield chunk
            finally:
                await upstream.aclose()

        passed = {
            name: value
            for name, value in upstream.headers.items()
            if name.lower()
            in ("content-length", "content-range", "accept-ranges", "content-type")
        }
        passed["Cache-Control"] = "private, max-age=600"
        return StreamingResponse(body(), status_code=upstream.status_code, headers=passed)


def routes(cinema: Cinema, core) -> APIRouter:
    router = APIRouter()

    @router.get("/api/v1/services/rooms/{room_id}/cinema/search")
    async def search(
        room_id: str,
        provider: Provider,
        query: str = Query(default="", max_length=120),
        cursor: str = Query(default="", max_length=12),
        authorization: str = Header(),
    ):
        await core.member(room_id, authorization)
        return await cinema.search(provider, query, cursor)

    @router.get("/api/v1/services/rooms/{room_id}/cinema/channel")
    async def channel(
        room_id: str,
        provider: Provider,
        id: str = Query(max_length=80),
        tab: Tab = "videos",
        cursor: str = Query(default="", max_length=12),
        authorization: str = Header(),
    ):
        await core.member(room_id, authorization)
        return await cinema.channel(provider, id, tab, cursor)

    @router.get("/api/v1/services/rooms/{room_id}/cinema/playlist")
    async def playlist_page(
        room_id: str,
        provider: Provider,
        id: str = Query(max_length=80),
        cursor: str = Query(default="", max_length=12),
        authorization: str = Header(),
    ):
        await core.member(room_id, authorization)
        return await cinema.playlist(provider, id, cursor)

    @router.get("/api/v1/services/rooms/{room_id}/cinema/categories")
    async def categories(
        room_id: str,
        provider: Provider,
        query: str = Query(default="", max_length=120),
        cursor: str = Query(default="", max_length=12),
        authorization: str = Header(),
    ):
        await core.member(room_id, authorization)
        return await cinema.categories(provider, query, cursor)

    @router.get("/api/v1/services/rooms/{room_id}/cinema/category")
    async def category(
        room_id: str,
        provider: Provider,
        id: str = Query(max_length=20),
        cursor: str = Query(default="", max_length=12),
        authorization: str = Header(),
    ):
        await core.member(room_id, authorization)
        return await cinema.category(provider, id, cursor)

    @router.get("/api/v1/services/rooms/{room_id}/cinema/details")
    async def details(
        room_id: str,
        provider: Provider,
        id: str = Query(max_length=80),
        kind: Kind = "video",
        authorization: str = Header(),
    ):
        await core.member(room_id, authorization)
        return await cinema.details(provider, id, kind)

    @router.post("/api/v1/services/rooms/{room_id}/cinema/resolve")
    async def resolve(room_id: str, request: Resolve, authorization: str = Header()):
        await core.member(room_id, authorization)
        return await cinema.resolve(request)

    # Эти открыты по подписи, а не по заголовку: их дёргает сам плеер, десятками запросов
    # в минуту, и заголовок авторизации в теги `<video>` и сегменты HLS не поставишь.
    @router.get(PREFIX + "/playlist")
    async def playlist(u: str, e: str, s: str, accept_encoding: str | None = Header(default=None)):
        return await cinema.manifest(cinema.signer.open(u, e, s), accept_encoding)

    @router.get(PREFIX + "/fetch")
    async def fetch(u: str, e: str, s: str, range: str | None = Header(default=None)):
        return await cinema.fetch(cinema.signer.open(u, e, s), range)

    # Сегмент фильма — по номеру в уже разобранном плейлисте. Имя плейлиста подписано тем же
    # ключом, а сам список составлен нами и содержит только разрешённые адреса.
    @router.get(PREFIX + "/seg/{key}/{index}")
    async def segment(key: str, index: int, range: str | None = Header(default=None)):
        return await cinema.fetch(cinema.reels.find(key, index), range)

    @router.get(PREFIX + "/image")
    async def image(u: str, e: str, s: str):
        return await cinema.fetch(cinema.signer.open(u, e, s), None)

    return router
