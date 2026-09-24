"""
Фасад кинозала: проверка ввода → площадка из реестра → её метод → память → ответ.

О площадках он знает только то, что они сами о себе объявили (`features`): ни одной развилки
«YouTube это или Twitch» здесь нет. Ключи памяти и сроки — прежние, до буквы: клиент к ним не
привязан, но от них зависит, сколько раз мы ходим наружу. Здесь же прокси поверх подписанных
адресов — он общий для всех площадок.
"""

from __future__ import annotations

import asyncio
import gzip
import re
import time
from dataclasses import asdict
from typing import Any, Literal

import httpx
from fastapi import HTTPException
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

from . import wire
from .memo import Memo
from .paging import absolute, offset_of
from .providers import PROVIDERS
from .registry import Ctx, Kit, Provider, Registry
from .resolve import Resolver, YtDlp
from .transport.playlists import Reels, rewrite
from .transport.segments import Segments
from .transport.signer import Signer, allowed, proxied


# Обложки живут дольше: они не меняются и ничего не стоят.
IMAGE_TTL = 24 * 3600

Kind = Literal["video", "channel"]

# Имя канала приходит от браузера и уходит в чужой адрес, поэтому проверяется здесь, а не
# «где-нибудь потом»: у YouTube это `UC…` или `@псевдоним`, у Twitch — логин.
CHANNEL_ID = re.compile(r"^[A-Za-z0-9_.@-]{1,80}$")


class Resolve(BaseModel):
    # Площадку проверяет реестр, а не перечень в схеме: незнакомая или выключенная — это отказ
    # 400 с человеческим текстом, как и любой другой вопрос, на который у площадки ответа нет.
    provider: str = Field(max_length=32)
    contentId: str = Field(min_length=1, max_length=64, pattern=r"[A-Za-z0-9_-]+")
    kind: Kind = "video"
    adaptive: bool = False
    refresh: bool = False


# Что показывает страница канала. `about` — единственная без ленты: она про сам канал.
Tab = Literal["videos", "streams", "shorts", "playlists", "about"]

# Плейлист (`PL…`, `UU…`, `OLAK5uy_…`) проверяется тем же правилом, что и имя канала: строка
# уходит в чужой адрес, и всё, что не буква, цифра или знак из списка, до него не доходит.
CATALOG_ID = CHANNEL_ID
# Идентификатор категории Twitch — только цифры.
CATEGORY_ID = re.compile(r"^[0-9]{1,20}$")


class Cinema:
    def __init__(
        self,
        secret: str,
        client: httpx.AsyncClient | None = None,
        *,
        enabled: str | None = None,
    ):
        """`enabled` — какие площадки включены, строкой как в `CINEMA_PROVIDERS`; пусто — все."""
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
        self.ytdlp = YtDlp()
        self.resolver = Resolver(self.signer, self.ytdlp, self.image)
        kit = Kit(memo=self.catalog, image=self.image, ytdlp=self.ytdlp)
        self.registry = Registry((kind(kit) for kind in PROVIDERS), enabled)

    async def close(self):
        await self.client.aclose()

    def _ctx(self, room: str) -> Ctx:
        return Ctx(room=room, net=self.client)

    def _able(self, provider: str, feature: str) -> Provider:
        """
        Площадка, у которой это есть.

        Отказ звучит раньше, чем разбирается остальной ввод, — как и тогда, когда проверка
        площадки стояла первой строкой метода: у Twitch «плейлистов нет» и с кривым адресом.
        """
        source = self.registry.get(provider)
        if not getattr(source.features, feature):
            raise source.refuse(feature)
        return source

    # --- площадки ----------------------------------------------------------------------

    async def providers(self) -> dict[str, list[wire.ProviderEntry]]:
        """Какие площадки включены, работают ли они отсюда и что у каждой есть."""
        listed = list(self.registry)
        answers = await asyncio.gather(*(source.availability() for source in listed))
        return {
            "providers": [
                {
                    "id": source.id,
                    "available": available,
                    "reason": reason,
                    "account": source.features.account,
                    # Входить пока не во что: ни одной площадке аккаунт не нужен, а сейфа
                    # входов комнаты ещё нет.
                    "connected": False,
                    "features": {
                        name: value for name, value in asdict(source.features).items() if name != "account"
                    },
                }
                for source, (available, reason) in zip(listed, answers)
            ]
        }

    # --- поиск и каталог -------------------------------------------------------------

    async def search(self, provider: str, query: str, cursor: str = "", *, room: str = "") -> dict[str, Any]:
        """
        Что показать по набранному — и что показать, пока не набрано ничего.

        Ответ один на все площадки: лента карточек, а над ней полки — каналы у YouTube,
        категории у Twitch. Полка приезжает только с первой порцией: листая ленту вниз,
        каналы второй раз не ищут.
        """
        source = self._able(provider, "search")
        offset = offset_of(cursor)
        return await source.search(self._ctx(room), query.strip(), offset)

    async def channel(
        self, provider: str, channel_id: str, tab: Tab = "videos", cursor: str = "", *, room: str = ""
    ) -> dict[str, Any]:
        """
        Страница канала, вкладка за вкладкой.

        Вкладки здесь те же, что у площадки, и это не украшение: канал, у которого пять сотен
        роликов, десяток плейлистов и идущий прямо сейчас эфир, одной лентой не показывается
        никак. Каждая вкладка листается своей лентой; `about` ленты не имеет вовсе.
        """
        source = self._able(provider, "channels")
        if not CATALOG_ID.match(channel_id):
            raise HTTPException(400, "Непонятное имя канала")
        offset = offset_of(cursor)
        ctx = self._ctx(room)
        return await self.catalog.get(
            f"channel:{source.id}:{channel_id.lower()}:{tab}:{offset}",
            lambda: source.channel(ctx, channel_id, tab, offset),
            # Память короткая нарочно: сверху у канала лежит самое свежее, и «самое свежее»
            # не должно означать «самое свежее полчаса назад».
            60,
        )

    async def playlist(
        self, provider: str, playlist_id: str, cursor: str = "", *, room: str = ""
    ) -> dict[str, Any]:
        """Плейлист целиком: его описание и ролики в том порядке, в котором их собрали."""
        source = self._able(provider, "playlists")
        if not CATALOG_ID.match(playlist_id):
            raise HTTPException(400, "Непонятный адрес плейлиста")
        offset = offset_of(cursor)
        ctx = self._ctx(room)
        return await self.catalog.get(
            # Площадки в ключе нет, как не было и раньше: плейлисты пока есть только у одной.
            # Вторая площадка с плейлистами должна добавить её сюда.
            f"playlist:{playlist_id.lower()}:{offset}",
            lambda: source.playlist(ctx, playlist_id, offset),
            60,
        )

    async def categories(
        self, provider: str, query: str = "", cursor: str = "", *, room: str = ""
    ) -> dict[str, Any]:
        """Разделы площадки: что смотрят прямо сейчас, по играм и рубрикам."""
        source = self.registry.get(provider)
        if not source.features.categories:
            # Площадка без разделов отвечает пустым списком, а не отказом, — и раньше, чем
            # разбирается курсор: так кинозал отвечал всегда.
            return {"items": [], "next": None}
        offset = offset_of(cursor)
        return await source.categories(self._ctx(room), query.strip(), offset)

    async def category(
        self, provider: str, category_id: str, cursor: str = "", *, room: str = ""
    ) -> dict[str, Any]:
        """Один раздел: его карточка и эфиры, которые идут в нём сейчас."""
        source = self._able(provider, "categories")
        if not CATEGORY_ID.match(category_id):
            raise HTTPException(400, "Непонятный раздел")
        offset = offset_of(cursor)
        return await source.category(self._ctx(room), category_id, offset)

    async def details(self, provider: str, content_id: str, kind: Kind, *, room: str = "") -> dict[str, Any]:
        source = self.registry.get(provider)
        if not CHANNEL_ID.match(content_id):
            raise HTTPException(400, "Непонятный адрес видео")
        ctx = self._ctx(room)
        return await self.catalog.get(
            f"details:{source.id}:{kind}:{content_id.lower()}",
            lambda: source.details(ctx, kind, content_id),
            600,
        )

    def image(self, url: str) -> str | None:
        """Обложка у нас, а не у площадки. Адрес без схемы получает её здесь — иначе он
        не прошёл бы белый список и картинка тихо пропала бы с карточки."""
        full = absolute(url)
        return proxied(self.signer, full, "image", IMAGE_TTL) if full and allowed(full) else None

    # --- разрешение ссылки в поток ---------------------------------------------------

    async def resolve(self, request: Resolve, *, room: str = "") -> dict[str, Any]:
        # Один разбор на всю комнату: пятеро зрителей открывают одно и то же видео в одну и ту
        # же минуту, и пять запросов к площадке ради одного ответа — это просто пять ожиданий.
        # Живой эфир держится меньше: его адреса обновляются чаще, чем меняется афиша.
        source = self.registry.get(request.provider)
        key = f"{request.provider}:{request.kind}:{request.contentId}:{request.adaptive}"
        if request.refresh:
            self.sources._items.pop(key, None)
        ctx = self._ctx(room)
        return await self.sources.get(
            key,
            lambda: self._resolve(source, ctx, request),
            lambda found: min(
                45 if found["live"] else 1800,
                max(0, found["expiresAt"] / 1000 - time.time() - 60),
            ),
        )

    async def _resolve(self, source: Provider, ctx: Ctx, request: Resolve) -> dict[str, Any]:
        """Площадка говорит, откуда брать поток, а разбирает его общий `Resolver`."""
        plan = await source.source(ctx, request.kind, request.contentId, {})
        return await self.resolver.resolve(plan, ctx.net, source.id, request.contentId, request.adaptive)

    def dash(self, key: str) -> Response:
        return self.resolver.dash(key)

    # --- прокси ------------------------------------------------------------------------

    async def manifest(self, url: str, encodings: str | None = None) -> Response:
        response = await self.client.get(url, follow_redirects=False)
        if response.status_code >= 300:
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
        if range_header and not re.fullmatch(r"bytes=(?:\d+-\d*|-\d+)", range_header):
            raise HTTPException(416, "Неверный диапазон байтов")
        if (
            range_header
            and (match := re.fullmatch(r"bytes=(\d+)-(\d+)", range_header))
            and int(match[1]) > int(match[2])
        ):
            raise HTTPException(416, "Неверный диапазон байтов")
        # Целый сегмент — то, что просят все и одинаково: он идёт через общую память.
        # Частичный запрос (перемотка в готовом файле) обслуживается напрямую.
        if not range_header:
            cached = self.segments.get(url)
            if cached:
                body, kind = cached
                return Response(
                    body,
                    media_type=kind,
                    headers={"Cache-Control": "private, max-age=600"},
                )
            async with self.segments.lock(url):
                cached = self.segments.get(url)
                if cached:
                    body, kind = cached
                    return Response(
                        body,
                        media_type=kind,
                        headers={"Cache-Control": "private, max-age=600"},
                    )
                answer = await self.client.get(url, follow_redirects=False)
                if answer.status_code >= 300:
                    raise HTTPException(502, "Площадка не отдала данные")
                kind = answer.headers.get("content-type", "video/mp2t")
                self.segments.put(url, answer.content, kind)
                return Response(
                    answer.content,
                    media_type=kind,
                    headers={"Cache-Control": "private, max-age=600"},
                )
        headers = {"Range": range_header}
        request = self.client.build_request("GET", url, headers=headers)
        upstream = await self.client.send(request, stream=True, follow_redirects=False)
        if upstream.status_code >= 300:
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
            if name.lower() in ("content-length", "content-range", "accept-ranges", "content-type")
        }
        passed["Cache-Control"] = "private, max-age=600"
        return StreamingResponse(body(), status_code=upstream.status_code, headers=passed)
