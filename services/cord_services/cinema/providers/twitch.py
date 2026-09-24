"""Twitch: эфиры, каналы и разделы через их публичный GraphQL — без ключей и аккаунтов."""

from __future__ import annotations

import asyncio
import json
import re
from typing import Any

import httpx
from fastapi import HTTPException

from .. import wire
from ..paging import PAGE, page
from ..registry import Ctx, Features, HostPolicy, Provider
from ..resolve import SourcePlan, ytdlp

TWITCH_GQL = "https://gql.twitch.tv/gql"
# Открытый идентификатор веб-клиента Twitch. Не секрет и не наш: его отдаёт их же страница,
# и на нём работают streamlink и twitch-dl.
TWITCH_CLIENT = "kimne78kx3ncx6brgo4mv6wki5h1ko"

TWITCH_CHANNEL = """{ user(login: %s) { id login displayName description
  profileImageURL(width: 300) bannerImageURL
  followers { totalCount }
  stream { id title viewersCount previewImageURL(width: 440, height: 248) game { name } }
  videos(first: %d, sort: TIME) { edges { node { id title lengthSeconds viewCount
    publishedAt previewThumbnailURL(width: 440, height: 248) game { name } } } } } }"""

TWITCH_VIDEO = """{ video(id: %s) { id title lengthSeconds viewCount publishedAt
  description previewThumbnailURL(width: 440, height: 248) game { name }
  owner { login displayName profileImageURL(width: 300) followers { totalCount } } } }"""

# Категория Twitch — это игра или раздел вроде «Just Chatting». Берётся по числовому
# идентификатору, а не по названию: имя приходит из браузера, а идентификатор проверяется
# одной цифровой проверкой и не может стать ничем иным.
TWITCH_CATEGORY = """{ game(id: %s) { id name displayName viewersCount
  boxArtURL(width: 285, height: 380)
  streams(first: %d) { edges { node { id title viewersCount
    previewImageURL(width: 440, height: 248) broadcaster { login displayName }
    game { name } } } } } }"""

# Сколько живых эфиров и записей просить у Twitch за один раз.
TWITCH_DEPTH = 100


def literal(value: str) -> str:
    r"""
    Строка для запроса GraphQL — настоящий строковый литерал, а не текст между кавычками.

    Экранирование у строк GraphQL то же, что у JSON (`\"`, `\\`, `\n`, `\uXXXX`), поэтому
    литерал собирает `json.dumps`. Раньше кавычки и обратные черты заменялись пробелами —
    искался уже другой текст, — а перевод строки уходил в литерал как есть, и Twitch отвечал
    синтаксической ошибкой. Не-ASCII остаётся как есть (`ensure_ascii=False`): для обычного
    ввода текст запроса тот же, что и раньше, до буквы.
    """
    return json.dumps(value, ensure_ascii=False)


class Twitch(Provider):
    id = "twitch"
    name = "Twitch"
    hosts = HostPolicy(("ttvnw.net", "jtvnw.net", "twitchcdn.net", "twitch.tv", "akamaized.net"))
    features = Features(channels=True, categories=True, live=True)
    # Логины, номера записей и разделов. Форма — та же, что пропускает проверка имени канала
    # у фасада: сужать её — отдельный шаг, который не должен сломать ни одной ссылки.
    content_id = re.compile(r"[A-Za-z0-9_.@-]{1,80}")
    # Прежний текст, слово в слово: плейлисты до сих пор есть только у YouTube.
    refusals = {"playlists": "Плейлисты есть только у YouTube"}

    async def search(self, ctx: Ctx, query: str, offset: int) -> wire.SearchPage:
        """Пусто — это витрина живых эфиров; набрано — каналы лентой и категории полкой."""
        if not query:
            streams = await self.memo.get("live", lambda: self._popular(ctx), 60)
            return {**page(streams, offset), "channels": [], "categories": []}
        low = query.lower()
        channels, categories = await asyncio.gather(
            self.memo.get(f"search:{low}", lambda: self._search(ctx, query), 120),
            self.memo.get(f"games:{low}", lambda: self._games(ctx, query), 300),
        )
        return {**page(channels, offset), "channels": [], "categories": categories[:8] if offset == 0 else []}

    async def channel(self, ctx: Ctx, channel_id: str, tab: str, offset: int) -> wire.ChannelPage:
        """
        Страница канала Twitch порциями.

        Порция режется по уже полученному списку, а не спрашивается заново: продолжение
        Twitch анонимному клиенту не отдаёт, зато сотню записей отдаёт одним ответом. Идущий
        эфир стоит первым и только в первой порции — ниже по ленте ему не место.
        """
        # Сырые данные канала — под `user:`, а не `channel:`: `channel:` у фасада занят
        # готовыми страницами. Логин Twitch к регистру безразличен — поэтому ключ строчный.
        found = await self.memo.get(f"user:{channel_id.lower()}", lambda: self._channel(ctx, channel_id), 60)
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

    async def categories(self, ctx: Ctx, query: str, offset: int) -> wire.Page:
        """Разделы Twitch: что смотрят прямо сейчас, по играм и рубрикам."""
        items = await self.memo.get(
            f"games:{query.lower()}" if query else "games",
            lambda: self._games(ctx, query),
            300 if query else 120,
        )
        return page(items, offset)

    async def category(self, ctx: Ctx, category_id: str, offset: int) -> wire.CategoryPage:
        """Один раздел Twitch: его карточка и эфиры, которые идут в нём сейчас."""
        found = await self.memo.get(f"category:{category_id}", lambda: self._category(ctx, category_id), 60)
        return {"category": found["category"], **page(found["items"], offset)}

    async def details(self, ctx: Ctx, kind: str, item_id: str) -> wire.Details | wire.ChannelDetails:
        if kind == "channel":
            found = await self._channel(ctx, item_id)
            head = found["channel"]
            live = next((item for item in found["items"] if item["live"]), None)
            return wire.channel_details(
                head,
                title=(live or {}).get("title") or head["title"],
                poster=(live or {}).get("poster") or head["banner"],
            )
        data = await self._gql(ctx, TWITCH_VIDEO % literal(item_id[:40]))
        video = data.get("video")
        if not video:
            raise HTTPException(404, "Такой записи на Twitch нет")
        owner = video.get("owner") or {}
        return wire.details(
            self.id,
            "video",
            item_id,
            video.get("title") or "Прошлая трансляция",
            author=owner.get("displayName") or owner.get("login") or "",
            channelId=owner.get("login"),
            channelAvatar=self.image(owner.get("profileImageURL") or ""),
            duration=video.get("lengthSeconds"),
            views=video.get("viewCount"),
            followers=(owner.get("followers") or {}).get("totalCount"),
            published=(video.get("publishedAt") or "")[:10],
            category=(video.get("game") or {}).get("name"),
            description=(video.get("description") or "")[:4000],
            poster=self.image(video.get("previewThumbnailURL") or ""),
        )

    async def source(self, ctx: Ctx, kind: str, item_id: str, options: dict[str, Any]) -> SourcePlan:
        # Запись смотрится по своему номеру, эфир — по имени канала. DASH у Twitch не
        # собирается: его дорожки не отдаются отдельными индексированными файлами.
        if kind == "video":
            return ytdlp(f"https://www.twitch.tv/videos/{item_id}")
        return ytdlp(f"https://www.twitch.tv/{item_id}")

    async def _gql(self, ctx: Ctx, query: str) -> dict[str, Any]:
        # Сеть, молчание и мусор вместо JSON — это тоже «не ответил», а не ошибка сервера: раньше
        # обрыв связи с Twitch отдавал комнате 500 с трассировкой в журнале.
        silent = HTTPException(502, "Twitch не ответил на запрос каталога")
        try:
            response = await ctx.net.post(
                TWITCH_GQL,
                json={"query": query},
                headers={"Client-ID": TWITCH_CLIENT},
            )
            body = response.json() if response.status_code == 200 else None
        except (httpx.HTTPError, ValueError):
            raise silent from None
        if not isinstance(body, dict):
            raise silent
        if body.get("errors"):
            raise HTTPException(502, "Twitch отказал в запросе каталога")
        data = body.get("data")
        return data if isinstance(data, dict) else {}

    def _live(self, node: dict[str, Any]) -> wire.Card | None:
        """Идущий эфир как карточка каталога. Смотрится он по имени канала, а не по номеру эфира."""
        caster = node.get("broadcaster") or {}
        if not caster.get("login"):
            return None
        return wire.card(
            self.id,
            "channel",
            caster["login"],
            node.get("title") or caster.get("displayName") or "",
            author=caster.get("displayName") or caster["login"],
            channelId=caster["login"],
            live=True,
            viewers=node.get("viewersCount"),
            category=(node.get("game") or {}).get("name"),
            poster=self.image(node.get("previewImageURL") or ""),
        )

    async def _popular(self, ctx: Ctx) -> list[wire.Card]:
        # Тридцать — не наша скромность, а предел самого Twitch: `first` больше тридцати он
        # отвергает, а на продолжение анонимному клиенту отвечает отказом о проверке целостности.
        data = await self._gql(
            ctx,
            "{ streams(first: 30) { edges { node { id title viewersCount "
            "previewImageURL(width: 440, height: 248) broadcaster { login displayName } "
            "game { name } } } } }",
        )
        items = []
        for edge in (data.get("streams") or {}).get("edges", []) or []:
            found = self._live(edge.get("node") or {})
            if found:
                items.append(found)
        return items

    async def _games(self, ctx: Ctx, query: str = "") -> list[wire.CategoryCard]:
        """
        Разделы Twitch: список рубрик с обложкой и числом смотрящих.

        Пустой запрос — витрина по популярности, набранный — поиск по названию. Это те же
        категории, по которым на Twitch и ходят: «что сейчас играют» там выбирают раньше, чем
        «кого смотреть».
        """
        if query:
            data = await self._gql(
                ctx,
                '{ searchFor(userQuery: %s, platform: "web", target: {index: GAME}) '
                "{ games { items { id name displayName viewersCount "
                "boxArtURL(width: 285, height: 380) } } } }" % literal(query[:60]),
            )
            nodes = ((data.get("searchFor") or {}).get("games") or {}).get("items") or []
        else:
            data = await self._gql(
                ctx,
                "{ games(first: %d) { edges { node { id name displayName viewersCount "
                "boxArtURL(width: 285, height: 380) } } } }" % TWITCH_DEPTH,
            )
            nodes = [edge.get("node") or {} for edge in (data.get("games") or {}).get("edges", []) or []]
        return [self._section(node) for node in nodes if node.get("id")]

    def _section(self, node: dict[str, Any]) -> wire.CategoryCard:
        return wire.category_card(
            self.id,
            str(node["id"]),
            node.get("displayName") or node.get("name") or "",
            viewers=node.get("viewersCount"),
            poster=self.image(node.get("boxArtURL") or ""),
        )

    async def _category(self, ctx: Ctx, category_id: str) -> dict[str, Any]:
        data = await self._gql(ctx, TWITCH_CATEGORY % (literal(category_id), TWITCH_DEPTH))
        game = data.get("game")
        if not game:
            raise HTTPException(404, "Такого раздела на Twitch нет")
        items = []
        for edge in (game.get("streams") or {}).get("edges", []) or []:
            found = self._live(edge.get("node") or {})
            if found:
                items.append(found)
        return {"category": self._section(game), "items": items}

    async def _search(self, ctx: Ctx, query: str, limit: int = TWITCH_DEPTH) -> list[wire.Card]:
        data = await self._gql(
            ctx,
            '{ searchFor(userQuery: %s, platform: "web", target: {index: CHANNEL}) '
            "{ channels { items { id login displayName profileImageURL(width: 300) "
            "stream { viewersCount previewImageURL(width: 440, height: 248) game { name } } "
            "} } } }" % literal(query[:60]),
        )
        items = []
        channels = ((data.get("searchFor") or {}).get("channels") or {}).get("items") or []
        for channel in channels[:limit]:
            stream = channel.get("stream") or {}
            items.append(
                wire.card(
                    self.id,
                    "channel",
                    channel.get("login"),
                    channel.get("displayName") or channel.get("login") or "",
                    author=channel.get("displayName") or "",
                    channelId=channel.get("login"),
                    live=bool(stream),
                    viewers=stream.get("viewersCount"),
                    category=(stream.get("game") or {}).get("name"),
                    poster=self.image(stream.get("previewImageURL") or channel.get("profileImageURL") or ""),
                )
            )
        # Живые каналы выше: список, где эфир вперемешку с молчащими, читается хуже.
        items.sort(key=lambda item: (not item["live"], -(item.get("viewers") or 0)))
        return items

    async def _channel(self, ctx: Ctx, login: str) -> dict[str, Any]:
        data = await self._gql(ctx, TWITCH_CHANNEL % (literal(login[:40]), TWITCH_DEPTH))
        user = data.get("user")
        if not user:
            raise HTTPException(404, "Такого канала на Twitch нет")
        stream = user.get("stream") or {}
        items: list[wire.Card] = []
        if stream:
            items.append(
                wire.card(
                    self.id,
                    "channel",
                    user["login"],
                    stream.get("title") or user.get("displayName") or "",
                    author=user.get("displayName") or user["login"],
                    channelId=user["login"],
                    live=True,
                    viewers=stream.get("viewersCount"),
                    category=(stream.get("game") or {}).get("name"),
                    poster=self.image(stream.get("previewImageURL") or ""),
                )
            )
        for edge in (user.get("videos") or {}).get("edges", []) or []:
            node = edge.get("node") or {}
            if not node.get("id"):
                continue
            items.append(
                wire.card(
                    self.id,
                    # Запись эфира — это ролик с позицией, а не живой канал: её можно ставить
                    # на паузу и перематывать, и комната смотрит её с одной секунды.
                    "video",
                    node["id"],
                    node.get("title") or "Прошлая трансляция",
                    author=user.get("displayName") or user["login"],
                    channelId=user["login"],
                    duration=node.get("lengthSeconds"),
                    views=node.get("viewCount"),
                    category=(node.get("game") or {}).get("name"),
                    published=(node.get("publishedAt") or "")[:10],
                    poster=self.image(node.get("previewThumbnailURL") or ""),
                )
            )
        return {
            "channel": wire.channel_head(
                self.id,
                user["login"],
                user.get("displayName") or user["login"],
                handle=user["login"],
                description=(user.get("description") or "")[:1200],
                followers=(user.get("followers") or {}).get("totalCount"),
                viewers=stream.get("viewersCount"),
                live=bool(stream),
                category=(stream.get("game") or {}).get("name"),
                avatar=self.image(user.get("profileImageURL") or ""),
                banner=self.image(user.get("bannerImageURL") or ""),
            ),
            "items": items,
        }
