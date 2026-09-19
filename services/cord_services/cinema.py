"""Кинозал: комната смотрит YouTube или Twitch, а видео берёт **сервер**, не браузер.

ПОЧЕМУ НЕ ВСТРАИВАЕМЫЙ ПЛЕЕР. Он был, и с машины сервера работал. У человека — нет: из его
сети `youtube.com` и `twitch.tv` попросту недоступны, и встраивание в этом случае не лечится
ничем — рамка чужая, ходит она из браузера. Поэтому источник переехал на сервер: он достаёт
плейлист и сегменты, а комнате отдаёт их со своего адреса. Заодно исчезли и чужие скрипты на
странице, и послабления в CSP, и «выберите качество в шестерёнке YouTube» — качество теперь
настоящий список уровней HLS, которым управляет наш собственный плеер.

ЧТО ИМЕННО ПРОКСИРУЕТСЯ. Только то, на что мы сами выдали подпись: адрес, срок и HMAC на
`INTERNAL_SECRET`, да ещё и хост из белого списка. Без этого открытый прокси чужого трафика
на своей машине — вопрос одного любопытного, а не времени.

Поиск и каталог не требуют ни ключей, ни аккаунтов: YouTube — через `ytsearch` у yt-dlp,
Twitch — через их публичный GraphQL с тем же клиентским идентификатором, которым пользуются
streamlink и twitch-dl.
"""

from __future__ import annotations

import asyncio
import base64
import hmac
import time
from hashlib import sha256
from typing import Any, Literal
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


class Resolve(BaseModel):
    provider: Provider
    contentId: str = Field(min_length=1, max_length=64, pattern=r"[A-Za-z0-9_-]+")
    kind: Literal["video", "channel"] = "video"


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

    def _digest(self, packed: str, expires: str) -> str:
        return hmac.new(self._secret, f"{packed}|{expires}".encode(), sha256).hexdigest()[:32]


def proxied(signer: Signer, url: str, route: str, ttl: int = SIGNATURE_TTL) -> str:
    return f"{PREFIX}/{route}?" + urlencode(signer.sign(url, ttl))


def master_playlist(body: str) -> bool:
    """Мастер это или уже список сегментов. От ответа зависит, чем считать ссылки внутри."""
    return "#EXT-X-STREAM-INF" in body or "#EXT-X-MEDIA:" in body


def rewrite(body: str, base: str, signer: Signer) -> str:
    """
    Переписывает плейлист на свои адреса.

    Внутри мастера все ссылки — плейлисты, внутри списка сегментов — сегменты и ключи. Поэтому
    вид плейлиста определяется один раз для всего тела, а не угадывается по каждой ссылке:
    у YouTube вариант выглядит как `/api/manifest/hls_playlist/...` без всякого `.m3u8`, и любая
    догадка по расширению ошиблась бы на нём первой же строкой.
    """
    route = "playlist" if master_playlist(body) else "fetch"
    lines = []
    for line in body.splitlines():
        if not line:
            lines.append(line)
            continue
        if line.startswith("#"):
            # Атрибуты с URI: аудиодорожки в мастере, карта инициализации и ключи в сегментах.
            if 'URI="' in line:
                head, _, rest = line.partition('URI="')
                inner, _, tail = rest.partition('"')
                target = urljoin(base, inner)
                if allowed(target):
                    kind = "playlist" if line.startswith("#EXT-X-MEDIA") else "fetch"
                    line = f'{head}URI="{proxied(signer, target, kind)}"{tail}'
            lines.append(line)
            continue
        target = urljoin(base, line.strip())
        lines.append(proxied(signer, target, route) if allowed(target) else line)
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

    def __init__(self, capacity: int = 192 * 1024 * 1024, ttl: float = 120.0, largest: int = 12 * 1024 * 1024):
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


class Cinema:
    def __init__(self, secret: str, client: httpx.AsyncClient | None = None):
        self.signer = Signer(secret)
        self.segments = Segments()
        self.client = client or httpx.AsyncClient(
            timeout=httpx.Timeout(20.0, read=60.0),
            follow_redirects=True,
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Cord/1.0"},
        )

    async def close(self):
        await self.client.aclose()

    # --- поиск и каталог -------------------------------------------------------------

    async def search(self, provider: Provider, query: str, limit: int = 24):
        query = query.strip()
        if not query:
            return []
        if provider == "youtube":
            return await asyncio.to_thread(self._youtube_search, query, limit)
        return await self._twitch_search(query, limit)

    async def popular(self, provider: Provider, limit: int = 24):
        if provider == "twitch":
            return await self._twitch_popular(limit)
        # У YouTube «популярное» без ключа Data API — это лента, которую он показывает
        # серверу, а не человеку. Честнее ничего не обещать и оставить поиск.
        return []

    def _youtube_search(self, query: str, limit: int):
        import yt_dlp

        options = {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "extract_flat": True,
            "cachedir": False,
            "socket_timeout": 20,
        }
        with yt_dlp.YoutubeDL(options) as ydl:
            found = ydl.extract_info(f"ytsearch{limit}:{query}", download=False)
        items = []
        for entry in (found or {}).get("entries", []) or []:
            if not entry.get("id"):
                continue
            items.append(
                {
                    "provider": "youtube",
                    "kind": "video",
                    "id": entry["id"],
                    "title": entry.get("title") or "Без названия",
                    "author": entry.get("channel") or entry.get("uploader") or "",
                    "duration": entry.get("duration"),
                    "live": bool(entry.get("is_live")),
                    "viewers": entry.get("concurrent_view_count"),
                    "poster": self.image(
                        f"https://i.ytimg.com/vi/{entry['id']}/mqdefault.jpg"
                    ),
                }
            )
        return items

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

    async def _twitch_popular(self, limit: int):
        data = await self._twitch_gql(
            "{ streams(first: %d) { edges { node { id title viewersCount "
            "previewImageURL(width: 440, height: 248) broadcaster { login displayName } "
            "game { name } } } } }" % min(limit, 40)
        )
        items = []
        for edge in (data.get("streams") or {}).get("edges", []) or []:
            node = edge.get("node") or {}
            caster = node.get("broadcaster") or {}
            if not caster.get("login"):
                continue
            items.append(
                {
                    "provider": "twitch",
                    "kind": "channel",
                    "id": caster["login"],
                    "title": node.get("title") or caster.get("displayName") or "",
                    "author": caster.get("displayName") or caster["login"],
                    "duration": None,
                    "live": True,
                    "viewers": node.get("viewersCount"),
                    "category": (node.get("game") or {}).get("name"),
                    "poster": self.image(node.get("previewImageURL") or ""),
                }
            )
        return items

    async def _twitch_search(self, query: str, limit: int):
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
                    "duration": None,
                    "live": bool(stream),
                    "viewers": stream.get("viewersCount"),
                    "category": (stream.get("game") or {}).get("name"),
                    "poster": self.image(
                        stream.get("previewImageURL") or channel.get("profileImageURL") or ""
                    ),
                }
            )
        # Живые каналы выше: список, где эфир вперемешку с молчащими, читается хуже.
        items.sort(key=lambda item: (not item["live"], -(item.get("viewers") or 0)))
        return items

    def image(self, url: str) -> str | None:
        return proxied(self.signer, url, "image", IMAGE_TTL) if url and allowed(url) else None

    # --- разрешение ссылки в поток ---------------------------------------------------

    async def resolve(self, request: Resolve) -> dict[str, Any]:
        source = (
            f"https://www.youtube.com/watch?v={request.contentId}"
            if request.provider == "youtube"
            else f"https://www.twitch.tv/{request.contentId}"
        )
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

    async def playlist(self, url: str) -> Response:
        response = await self.client.get(url)
        if response.status_code >= 400:
            raise HTTPException(502, "Площадка не отдала плейлист")
        body = rewrite(response.text, str(response.url), self.signer)
        return Response(
            body,
            media_type="application/vnd.apple.mpegurl",
            headers={"Cache-Control": "no-store"},
        )

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
        authorization: str = Header(),
    ):
        await core.member(room_id, authorization)
        items = (
            await cinema.popular(provider)
            if not query.strip()
            else await cinema.search(provider, query)
        )
        return {"items": items}

    @router.post("/api/v1/services/rooms/{room_id}/cinema/resolve")
    async def resolve(room_id: str, request: Resolve, authorization: str = Header()):
        await core.member(room_id, authorization)
        return await cinema.resolve(request)

    # Эти два открыты по подписи, а не по заголовку: их дёргает сам плеер, десятками запросов
    # в минуту, и заголовок авторизации в теги `<video>` и сегменты HLS не поставишь.
    @router.get(PREFIX + "/playlist")
    async def playlist(u: str, e: str, s: str):
        return await cinema.playlist(cinema.signer.open(u, e, s))

    @router.get(PREFIX + "/fetch")
    async def fetch(u: str, e: str, s: str, range: str | None = Header(default=None)):
        return await cinema.fetch(cinema.signer.open(u, e, s), range)

    @router.get(PREFIX + "/image")
    async def image(u: str, e: str, s: str):
        return await cinema.fetch(cinema.signer.open(u, e, s), None)

    return router
