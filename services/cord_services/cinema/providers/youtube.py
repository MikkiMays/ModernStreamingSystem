"""YouTube: поиск, каналы и плейлисты через yt-dlp — без ключей и аккаунтов."""

from __future__ import annotations

import asyncio
import re
from typing import Any
from urllib.parse import urlencode

from fastapi import HTTPException

from .. import wire
from ..paging import PAGE, SEARCH_DEPTH, page
from ..registry import Ctx, Features, HostPolicy, Provider
from ..resolve import SourcePlan, ytdlp

YT_FLAT = {
    "quiet": True,
    "no_warnings": True,
    "skip_download": True,
    "extract_flat": True,
    "cachedir": False,
    "socket_timeout": 20,
}


class YouTube(Provider):
    id = "youtube"
    name = "YouTube"
    hosts = HostPolicy(
        # Картинки каналов лежат на `googleusercontent.com`, а не на `ytimg`: без этого хоста
        # страница канала осталась бы без лица.
        ("googlevideo.com", "youtube.com", "ytimg.com", "ggpht.com", "googleusercontent.com")
    )
    features = Features(channels=True, playlists=True, live=True)
    # В одном поле едут ролики (11 знаков), каналы (`UC…`), псевдонимы (`@имя.с.точкой`) и
    # плейлисты — поэтому форма пока ровно та, что пропускает проверка имени канала у фасада.
    # Сузить её по видам — отдельный шаг, и сделать его нужно, не сломав ни одной ссылки.
    content_id = re.compile(r"[A-Za-z0-9_.@-]{1,80}")
    # Отказ — о себе, а не о соседях: «разделы есть только у Twitch» перестало быть правдой, когда
    # разделы появились у Rutube, и перестало бы снова с каждой следующей площадкой.
    refusals = {"categories": "У YouTube разделов нет"}
    # Cookies шлём только вторым, запасным разбором: с ними YouTube отдаёт SABR и ни одного
    # мастера HLS (проверено 24.09.2026) — без них лестница качества жива, пока движок с JS
    # решает её же проверку. cookiefile входит в игру, только если первый разбор отказал
    # именно проверкой на человека (см. `resolve.YtDlp.extract`).
    cookies_fallback = True

    async def search(self, ctx: Ctx, query: str, offset: int) -> wire.SearchPage:
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
            self.memo.get(
                f"search:videos:{low}",
                lambda: asyncio.to_thread(self._videos, query, SEARCH_DEPTH),
                120,
            )
        ]
        if offset == 0:
            wanted.append(
                self.memo.get(
                    f"search:channels:{low}",
                    lambda: asyncio.to_thread(self._channels, query, 4),
                    300,
                )
            )
        found = await asyncio.gather(*wanted)
        return {**page(found[0], offset), "channels": found[1] if offset == 0 else [], "categories": []}

    async def channel(self, ctx: Ctx, channel_id: str, tab: str, offset: int) -> wire.ChannelPage:
        return await asyncio.to_thread(self._channel, channel_id, tab, offset)

    async def playlist(self, ctx: Ctx, playlist_id: str, offset: int) -> wire.PlaylistPage:
        return await asyncio.to_thread(self._playlist, playlist_id, offset)

    async def details(self, ctx: Ctx, kind: str, item_id: str) -> wire.Details:
        # Эфир YouTube — тоже ролик по своему адресу: вид страницу не меняет.
        return await asyncio.to_thread(self._details, item_id)

    async def source(self, ctx: Ctx, kind: str, item_id: str, options: dict[str, Any]) -> SourcePlan:
        # DASH из отдельных дорожек — только у YouTube: они проиндексированы и отдаются по
        # диапазонам. Эфир в DASH не собирается и здесь (это решает разбор, по самому ролику).
        return ytdlp(_watch(item_id), dash=True)

    def _videos(self, query: str, limit: int) -> list[wire.Card]:
        try:
            found = self.ytdlp.extract(f"ytsearch{limit}:{query}", YT_FLAT, self.id)
        except Exception as error:  # yt_dlp поднимает свои типы; наружу — отказ площадки, не 500
            raise HTTPException(502, f"Поиск не удался: {self.ytdlp.explain(error)}"[:200]) from None
        return [self._item(entry) for entry in found.get("entries", []) or [] if entry and entry.get("id")]

    def _channels(self, query: str, limit: int) -> list[wire.Card]:
        """
        Каналы по названию — отдельной вкладкой поиска YouTube (`sp=EgIQAg`).

        В карточке есть всё, ради чего на канал и смотрят до перехода: лицо, имя, псевдоним и
        сколько людей подписано. Ошибка здесь не ломает поиск: полка каналов пропадает, лента
        роликов остаётся.
        """
        address = "https://www.youtube.com/results?" + urlencode({"search_query": query, "sp": "EgIQAg=="})
        try:
            found = self.ytdlp.extract(address, {**YT_FLAT, "playlistend": limit}, self.id)
        except Exception:
            return []
        cards = []
        for entry in found.get("entries", []) or []:
            identity = (entry or {}).get("channel_id") or (entry or {}).get("id")
            if not entry or not identity or not str(identity).startswith("UC"):
                continue
            cards.append(
                wire.card(
                    self.id,
                    "channel",
                    identity,
                    entry.get("channel") or entry.get("title") or identity,
                    author=entry.get("uploader_id") or "",
                    channelId=identity,
                    followers=entry.get("channel_follower_count"),
                    description=(entry.get("description") or "")[:300],
                    poster=self.image(_widest(entry.get("thumbnails") or [], portrait=True)),
                )
            )
        return cards

    def _item(self, entry: dict[str, Any], channel: dict[str, str] | None = None) -> wire.Card:
        # На странице канала у роликов нет ни его имени, ни его идентификатора: они лежат
        # уровнем выше, у самой страницы. Без этого дверь «Открыть канал» со страницы ролика
        # пропадала ровно там, где по ней и ходят — при переходе с канала на канал.
        return wire.card(
            self.id,
            "video",
            entry["id"],
            entry.get("title") or "Без названия",
            author=entry.get("channel") or entry.get("uploader") or (channel or {}).get("title") or "",
            channelId=entry.get("channel_id") or (channel or {}).get("id") or None,
            duration=entry.get("duration"),
            # У ленты канала признак эфира приходит словом, а у поиска — флагом: идущий
            # прямо сейчас эфир иначе выглядел бы как обычный ролик без длительности.
            live=bool(entry.get("is_live")) or entry.get("live_status") == "is_live",
            viewers=entry.get("concurrent_view_count"),
            views=entry.get("view_count"),
            poster=self.image(f"https://i.ytimg.com/vi/{entry['id']}/mqdefault.jpg"),
        )

    def _playlist_card(self, entry: dict[str, Any], channel: dict[str, str] | None = None) -> wire.Card:
        """Плейлист в ленте канала. Смотреть его нельзя — в него заходят."""
        pictures = entry.get("thumbnails") or []
        return wire.card(
            self.id,
            "playlist",
            entry["id"],
            entry.get("title") or "Плейлист",
            # У плейлистов в ленте канала на месте имени автора стоит «View full playlist» —
            # подпись кнопки, а не чьё-то имя. Имя здесь всегда известно уровнем выше.
            author=(channel or {}).get("title") or "",
            channelId=(channel or {}).get("id") or None,
            count=entry.get("playlist_count"),
            poster=self.image(pictures[-1]["url"] if pictures else ""),
        )

    def _channel(self, channel_id: str, tab: str = "videos", offset: int = 0) -> wire.ChannelPage:
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
            found = self.ytdlp.extract(f"{_address(channel_id)}/{listing}", options, self.id)
        except Exception as error:
            if "does not have a" in str(error):
                return {"channel": None, "items": [], "next": None}
            raise HTTPException(502, f"Канал не открылся: {self.ytdlp.explain(error)}"[:200]) from None
        pictures = found.get("thumbnails") or []
        identity = {
            "id": found.get("channel_id") or channel_id,
            "title": found.get("channel") or found.get("uploader") or channel_id,
        }
        entries = [entry for entry in (found.get("entries") or []) if entry and entry.get("id")]
        card = self._playlist_card if tab == "playlists" else self._item
        items = [] if tab == "about" else [card(entry, identity) for entry in entries]
        return {
            "channel": wire.channel_head(
                self.id,
                identity["id"],
                identity["title"],
                # Псевдоним канала (`@имя`) — то, по чему его узнают и ищут, и то, чем он
                # открывается снова: ссылка на него короче и переживает переименование.
                handle=found.get("uploader_id") or (channel_id if channel_id.startswith("@") else ""),
                description=(found.get("description") or "")[:1200],
                followers=found.get("channel_follower_count"),
                live=any(item.get("live") for item in items),
                avatar=self.image(_widest(pictures, portrait=True)),
                banner=self.image(_widest(pictures, portrait=False)),
            ),
            "items": items,
            "next": str(offset + PAGE) if len(entries) >= PAGE and tab != "about" else None,
        }

    def _playlist(self, playlist_id: str, offset: int) -> wire.PlaylistPage:
        """Плейлист целиком: его собственная карточка и ролики порциями, в порядке сборки."""
        options = {
            **YT_FLAT,
            "extract_flat": "in_playlist",
            "playliststart": offset + 1,
            "playlistend": offset + PAGE,
        }
        try:
            address = f"https://www.youtube.com/playlist?list={playlist_id}"
            found = self.ytdlp.extract(address, options, self.id)
        except Exception as error:
            raise HTTPException(502, f"Плейлист не открылся: {self.ytdlp.explain(error)}"[:200]) from None
        pictures = found.get("thumbnails") or []
        identity = {
            "id": found.get("channel_id") or "",
            "title": found.get("channel") or found.get("uploader") or "",
        }
        entries = [entry for entry in (found.get("entries") or []) if entry and entry.get("id")]
        return {
            "playlist": wire.playlist_head(
                self.id,
                playlist_id,
                found.get("title") or "Плейлист",
                author=identity["title"],
                channelId=identity["id"] or None,
                description=(found.get("description") or "")[:1200],
                count=found.get("playlist_count"),
                views=found.get("view_count"),
                published=found.get("modified_date"),
                poster=self.image(pictures[-1]["url"] if pictures else ""),
            ),
            "items": [self._item(entry, identity) for entry in entries],
            "next": str(offset + PAGE) if len(entries) >= PAGE else None,
        }

    def _details(self, content_id: str) -> wire.Details:
        info = self.ytdlp.probe(_watch(content_id), self.id)
        return wire.details(
            self.id,
            "video",
            content_id,
            info.get("title") or content_id,
            author=info.get("channel") or info.get("uploader") or "",
            channelId=info.get("channel_id") or None,
            duration=None if info.get("is_live") else info.get("duration"),
            live=bool(info.get("is_live")),
            views=info.get("view_count"),
            viewers=info.get("concurrent_view_count"),
            followers=info.get("channel_follower_count"),
            published=info.get("upload_date"),
            category=(info.get("categories") or [None])[0],
            description=(info.get("description") or "")[:4000],
            poster=self.image(info.get("thumbnail") or ""),
        )


def _watch(content_id: str) -> str:
    return f"https://www.youtube.com/watch?v={content_id}"


def _address(channel_id: str) -> str:
    return (
        f"https://www.youtube.com/{channel_id}"
        if channel_id.startswith("@")
        else f"https://www.youtube.com/channel/{channel_id}"
    )


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
