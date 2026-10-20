"""Маршруты кинозала: обычные — под проверкой участника комнаты, служебные — открытые по
подписи для самого плеера."""

from __future__ import annotations

import uuid
from typing import Annotated, Any, Callable, Coroutine

from fastapi import APIRouter, Header, HTTPException, Query, Request, Response
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from starlette.exceptions import HTTPException as StarletteHTTPException

from .facade import Cinema, Kind, Link, Resolve, Tab
from .guard import Traffic, Watching, bind_room, bind_text
from .transport.relay import SEALED
from .transport.signer import PREFIX, ROOM

# Площадка — строка, а не перечень в схеме: её проверяет реестр. Незнакомая или выключенная
# получает 400 с человеческим текстом, а не 422 со схемой валидации.
ProviderId = Annotated[str, Query(max_length=32)]
# Площадка в подписанной ссылке: её проверяет подпись, а не схема запроса.
Signed = Annotated[str, Query(max_length=32)]
# Номер профиля заголовков потока плеера страниц — тоже под подписью; форма — номер ссылки.
Profile = Annotated[str, Query(max_length=22, pattern=r"^[A-Za-z0-9_-]*$")]


class Sealed(APIRoute):
    """
    Маршрут прокси: каждый его ответ — и отказ тоже — несёт `relay.SEALED`.

    Ответы прокси собирает фасад, и заголовки у них есть и там; здесь — граница, которую не обойти ни новым
    путём ответа, ни отказом: адрес прокси открывается вкладкой так же, как тегом `<video>`.
    """

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handler = super().get_route_handler()

        async def sealed(request: Request) -> Response:
            try:
                response = await handler(request)
            except StarletteHTTPException as refusal:
                headers = {**(refusal.headers or {}), **SEALED}
                raise HTTPException(refusal.status_code, refusal.detail, headers=headers) from None
            except RequestValidationError as invalid:
                response = await request_validation_exception_handler(request, invalid)
            response.headers.update(SEALED)
            return response

        return sealed


def routes(cinema: Cinema, core, traffic: Traffic | None = None) -> APIRouter:
    router = APIRouter()
    # Маршруты прокси — отдельной группой: их ответы и отказы запечатаны (`Sealed`).
    signed = APIRouter(route_class=Sealed)
    # Прокси — не бесплатный канал (A8): адреса под встречей живут, пока она смотрит кино, а байты
    # считаются на встречу и на сервер за сутки (`guard.py`).
    traffic = traffic or Traffic.from_env()
    watching = Watching(core)

    @router.get("/api/v1/services/rooms/{room_id}/cinema/providers")
    async def providers(room_id: str, authorization: str = Header()):
        await core.member(room_id, authorization, action="cinema.browse")
        return await cinema.providers()

    @router.get("/api/v1/services/rooms/{room_id}/cinema/search")
    async def search(
        room_id: str,
        provider: ProviderId,
        query: str = Query(default="", max_length=120),
        cursor: str = Query(default="", max_length=12),
        authorization: str = Header(),
    ):
        await core.member(room_id, authorization, action="cinema.browse")
        return await cinema.search(provider, query, cursor, room=room_id)

    @router.get("/api/v1/services/rooms/{room_id}/cinema/channel")
    async def channel(
        room_id: str,
        provider: ProviderId,
        id: str = Query(max_length=80),
        tab: Tab = "videos",
        cursor: str = Query(default="", max_length=12),
        authorization: str = Header(),
    ):
        await core.member(room_id, authorization, action="cinema.browse")
        return await cinema.channel(provider, id, tab, cursor, room=room_id)

    @router.get("/api/v1/services/rooms/{room_id}/cinema/playlist")
    async def playlist_page(
        room_id: str,
        provider: ProviderId,
        id: str = Query(max_length=80),
        cursor: str = Query(default="", max_length=12),
        authorization: str = Header(),
    ):
        await core.member(room_id, authorization, action="cinema.browse")
        return await cinema.playlist(provider, id, cursor, room=room_id)

    @router.get("/api/v1/services/rooms/{room_id}/cinema/categories")
    async def categories(
        room_id: str,
        provider: ProviderId,
        query: str = Query(default="", max_length=120),
        cursor: str = Query(default="", max_length=12),
        authorization: str = Header(),
    ):
        await core.member(room_id, authorization, action="cinema.browse")
        return await cinema.categories(provider, query, cursor, room=room_id)

    # Номер раздела длиннее прежних двадцати знаков только у VK Видео (её строка — полсотни);
    # форму номера проверяет сама площадка (`Provider.category_id`).
    @router.get("/api/v1/services/rooms/{room_id}/cinema/category")
    async def category(
        room_id: str,
        provider: ProviderId,
        id: str = Query(max_length=128),
        cursor: str = Query(default="", max_length=12),
        authorization: str = Header(),
    ):
        await core.member(room_id, authorization, action="cinema.browse")
        return await cinema.category(provider, id, cursor, room=room_id)

    @router.get("/api/v1/services/rooms/{room_id}/cinema/series")
    async def series(
        room_id: str,
        provider: ProviderId,
        id: str = Query(max_length=64),
        season: str = Query(default="", max_length=64),
        cursor: str = Query(default="", max_length=12),
        authorization: str = Header(),
    ):
        await core.member(room_id, authorization, action="cinema.browse")
        return await cinema.series(provider, id, season, cursor, room=room_id)

    @router.get("/api/v1/services/rooms/{room_id}/cinema/details")
    async def details(
        room_id: str,
        provider: ProviderId,
        id: str = Query(max_length=80),
        kind: Kind = "video",
        authorization: str = Header(),
    ):
        await core.member(room_id, authorization, action="cinema.browse")
        return await cinema.details(provider, id, kind, room=room_id)

    @router.post("/api/v1/services/rooms/{room_id}/cinema/resolve")
    async def resolve(room_id: str, request: Resolve, authorization: str = Header()):
        # Поток для своего плеера нужен каждому зрителю открытого ролика, а не только тому,
        # кто его открыл: право — «участник», флаг интеграций здесь не участвует.
        await core.member(room_id, authorization, action="cinema.resolve")
        # Разбор общий на всех зрителей ролика; адреса в ответе — уже этой встречи (A8).
        return bind_room(await cinema.resolve(request, room=room_id), str(uuid.UUID(room_id)), cinema.signer)

    # Вставленная ссылка: чья она и на какой странице её открыть. POST, а не GET: ссылка — это
    # ввод человека до двух тысяч знаков, и в адресе запроса (а с ним в журналах прокси) ей не место.
    @router.post("/api/v1/services/rooms/{room_id}/cinema/link")
    async def link(room_id: str, request: Link, authorization: str = Header()):
        await core.member(room_id, authorization, action="cinema.browse")
        return await cinema.link(request.url, room=room_id)

    # Эти открыты по подписи, а не по заголовку: их дёргает сам плеер, десятками запросов
    # в минуту, и заголовок авторизации в теги `<video>` и сегменты HLS не поставишь. Подпись
    # знает свой маршрут и свою площадку (`p`): ссылка без `p` — выданная до этого — получит
    # 403, и плеер переоткроет источник сам.
    @signed.get(PREFIX + "/playlist")
    async def playlist(
        u: str,
        e: str,
        s: str,
        p: Signed = "",
        h: Profile = "",
        accept_encoding: str | None = Header(default=None),
    ):
        url = cinema.signer.open("playlist", u, e, s, p, h)
        traffic.admit("")
        return traffic.wrap(await cinema.manifest(url, accept_encoding, p, profile_id=h), "")

    @signed.get(PREFIX + "/fetch")
    async def fetch(
        u: str, e: str, s: str, p: Signed = "", h: Profile = "", range: str | None = Header(default=None)
    ):
        url = cinema.signer.open("fetch", u, e, s, p, h)
        traffic.admit("")
        return traffic.wrap(await cinema.fetch(url, range, p, profile_id=h), "")

    @signed.get(PREFIX + "/dash/{key}")
    async def dash(key: str):
        return cinema.dash(key)

    # Сегмент фильма — по номеру в уже разобранном плейлисте. Имя плейлиста подписано тем же
    # ключом, а сам список составлен нами и содержит только адреса, разрешённые его площадке.
    @signed.get(PREFIX + "/seg/{key}/{index}")
    async def segment(key: str, index: int, range: str | None = Header(default=None)):
        reel = cinema.reels.find(key, index)
        traffic.admit("")
        return traffic.wrap(
            await cinema.fetch(reel.url, range, reel.provider, profile_id=reel.profile or ""), ""
        )

    @signed.get(PREFIX + "/image")
    async def image(u: str, e: str, s: str, p: Signed = ""):
        url = cinema.signer.open("image", u, e, s, p)
        traffic.admit("")
        return traffic.wrap(await cinema.fetch(url, None, p), "")

    # Субтитры площадки, переведённые в WebVTT: `<track>` другого вида не читает.
    @signed.get(PREFIX + "/subtitles")
    async def subtitles(u: str, e: str, s: str, p: Signed = "", h: Profile = ""):
        return await cinema.subtitles(cinema.signer.open("subtitles", u, e, s, p, h), p, profile_id=h)

    # Те же маршруты под встречей: `…/cinema/r/<встреча>/…` (A8). Номер встречи — в подписи адреса, и
    # прокси пускает, пока встреча открыта и смотрит кино, а каждый байт к зрителю засчитывает ей.
    # Вложенные адреса плейлиста подписываются под той же встречей (`ROOM`), относительные адреса
    # сегментов остаются под ней сами.
    async def admitted(room: str) -> str:
        await watching.require(room)
        traffic.admit(room)
        return room

    @signed.get(PREFIX + "/r/{room}/playlist")
    async def room_playlist(
        room: str,
        u: str,
        e: str,
        s: str,
        p: Signed = "",
        h: Profile = "",
        accept_encoding: str | None = Header(default=None),
    ):
        url = cinema.signer.open("playlist", u, e, s, p, h, room=room)
        await admitted(room)
        token = ROOM.set(room)
        try:
            response = await cinema.manifest(url, accept_encoding, p, profile_id=h)
        finally:
            ROOM.reset(token)
        return traffic.wrap(response, room)

    @signed.get(PREFIX + "/r/{room}/fetch")
    async def room_fetch(
        room: str,
        u: str,
        e: str,
        s: str,
        p: Signed = "",
        h: Profile = "",
        range: str | None = Header(default=None),
    ):
        url = cinema.signer.open("fetch", u, e, s, p, h, room=room)
        await admitted(room)
        return traffic.wrap(await cinema.fetch(url, range, p, profile_id=h), room)

    @signed.get(PREFIX + "/r/{room}/dash/{key}")
    async def room_dash(room: str, key: str):
        await admitted(room)
        manifest = cinema.dash(key)
        manifest.body = bind_text(manifest.body.decode(), room, cinema.signer).encode()
        manifest.headers["content-length"] = str(len(manifest.body))
        return traffic.wrap(manifest, room)

    @signed.get(PREFIX + "/r/{room}/seg/{key}/{index}")
    async def room_segment(room: str, key: str, index: int, range: str | None = Header(default=None)):
        await admitted(room)
        reel = cinema.reels.find(key, index)
        return traffic.wrap(
            await cinema.fetch(reel.url, range, reel.provider, profile_id=reel.profile or ""), room
        )

    @signed.get(PREFIX + "/r/{room}/image")
    async def room_image(room: str, u: str, e: str, s: str, p: Signed = ""):
        url = cinema.signer.open("image", u, e, s, p, room=room)
        await admitted(room)
        return traffic.wrap(await cinema.fetch(url, None, p), room)

    @signed.get(PREFIX + "/r/{room}/subtitles")
    async def room_subtitles(room: str, u: str, e: str, s: str, p: Signed = "", h: Profile = ""):
        url = cinema.signer.open("subtitles", u, e, s, p, h, room=room)
        await admitted(room)
        return traffic.wrap(await cinema.subtitles(url, p, profile_id=h), room)

    router.include_router(signed)
    return router
