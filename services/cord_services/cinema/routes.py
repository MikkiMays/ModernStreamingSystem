"""Маршруты кинозала: обычные — под проверкой участника комнаты, служебные — открытые по
подписи для самого плеера."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Header, Query

from .facade import Cinema, Kind, Resolve, Tab
from .transport.signer import PREFIX

# Площадка — строка, а не перечень в схеме: её проверяет реестр. Незнакомая или выключенная
# получает 400 с человеческим текстом, а не 422 со схемой валидации.
ProviderId = Annotated[str, Query(max_length=32)]
# Площадка в подписанной ссылке: её проверяет подпись, а не схема запроса.
Signed = Annotated[str, Query(max_length=32)]


def routes(cinema: Cinema, core) -> APIRouter:
    router = APIRouter()

    @router.get("/api/v1/services/rooms/{room_id}/cinema/providers")
    async def providers(room_id: str, authorization: str = Header()):
        await core.member(room_id, authorization)
        return await cinema.providers()

    @router.get("/api/v1/services/rooms/{room_id}/cinema/search")
    async def search(
        room_id: str,
        provider: ProviderId,
        query: str = Query(default="", max_length=120),
        cursor: str = Query(default="", max_length=12),
        authorization: str = Header(),
    ):
        await core.member(room_id, authorization)
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
        await core.member(room_id, authorization)
        return await cinema.channel(provider, id, tab, cursor, room=room_id)

    @router.get("/api/v1/services/rooms/{room_id}/cinema/playlist")
    async def playlist_page(
        room_id: str,
        provider: ProviderId,
        id: str = Query(max_length=80),
        cursor: str = Query(default="", max_length=12),
        authorization: str = Header(),
    ):
        await core.member(room_id, authorization)
        return await cinema.playlist(provider, id, cursor, room=room_id)

    @router.get("/api/v1/services/rooms/{room_id}/cinema/categories")
    async def categories(
        room_id: str,
        provider: ProviderId,
        query: str = Query(default="", max_length=120),
        cursor: str = Query(default="", max_length=12),
        authorization: str = Header(),
    ):
        await core.member(room_id, authorization)
        return await cinema.categories(provider, query, cursor, room=room_id)

    @router.get("/api/v1/services/rooms/{room_id}/cinema/category")
    async def category(
        room_id: str,
        provider: ProviderId,
        id: str = Query(max_length=20),
        cursor: str = Query(default="", max_length=12),
        authorization: str = Header(),
    ):
        await core.member(room_id, authorization)
        return await cinema.category(provider, id, cursor, room=room_id)

    @router.get("/api/v1/services/rooms/{room_id}/cinema/details")
    async def details(
        room_id: str,
        provider: ProviderId,
        id: str = Query(max_length=80),
        kind: Kind = "video",
        authorization: str = Header(),
    ):
        await core.member(room_id, authorization)
        return await cinema.details(provider, id, kind, room=room_id)

    @router.post("/api/v1/services/rooms/{room_id}/cinema/resolve")
    async def resolve(room_id: str, request: Resolve, authorization: str = Header()):
        await core.member(room_id, authorization)
        return await cinema.resolve(request, room=room_id)

    # Эти открыты по подписи, а не по заголовку: их дёргает сам плеер, десятками запросов
    # в минуту, и заголовок авторизации в теги `<video>` и сегменты HLS не поставишь. Подпись
    # знает свой маршрут и свою площадку (`p`): ссылка без `p` — выданная до этого — получит
    # 403, и плеер переоткроет источник сам.
    @router.get(PREFIX + "/playlist")
    async def playlist(
        u: str, e: str, s: str, p: Signed = "", accept_encoding: str | None = Header(default=None)
    ):
        return await cinema.manifest(cinema.signer.open("playlist", u, e, s, p), accept_encoding, p)

    @router.get(PREFIX + "/fetch")
    async def fetch(u: str, e: str, s: str, p: Signed = "", range: str | None = Header(default=None)):
        return await cinema.fetch(cinema.signer.open("fetch", u, e, s, p), range)

    @router.get(PREFIX + "/dash/{key}")
    async def dash(key: str):
        return cinema.dash(key)

    # Сегмент фильма — по номеру в уже разобранном плейлисте. Имя плейлиста подписано тем же
    # ключом, а сам список составлен нами и содержит только адреса, разрешённые его площадке.
    @router.get(PREFIX + "/seg/{key}/{index}")
    async def segment(key: str, index: int, range: str | None = Header(default=None)):
        return await cinema.fetch(cinema.reels.find(key, index).url, range)

    @router.get(PREFIX + "/image")
    async def image(u: str, e: str, s: str, p: Signed = ""):
        return await cinema.fetch(cinema.signer.open("image", u, e, s, p), None)

    return router
