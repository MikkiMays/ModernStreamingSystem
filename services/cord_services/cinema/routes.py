"""Маршруты кинозала: обычные — под проверкой участника комнаты, служебные — открытые по
подписи для самого плеера."""

from __future__ import annotations

from fastapi import APIRouter, Header, Query

from .facade import PREFIX, Cinema, Kind, Provider, Resolve, Tab


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

    @router.get(PREFIX + "/dash/{key}")
    async def dash(key: str):
        return cinema.dash(key)

    # Сегмент фильма — по номеру в уже разобранном плейлисте. Имя плейлиста подписано тем же
    # ключом, а сам список составлен нами и содержит только разрешённые адреса.
    @router.get(PREFIX + "/seg/{key}/{index}")
    async def segment(key: str, index: int, range: str | None = Header(default=None)):
        return await cinema.fetch(cinema.reels.find(key, index), range)

    @router.get(PREFIX + "/image")
    async def image(u: str, e: str, s: str):
        return await cinema.fetch(cinema.signer.open(u, e, s), None)

    return router
