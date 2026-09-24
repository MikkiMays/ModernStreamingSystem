"""
Rutube: эфиры ТВ, сериалы и шоу, разделы, каналы и поиск — через открытый JSON самой площадки.

ОТКУДА ЧТО. Всё, что показывает каталог, площадка отдаёт своему же сайту обычным JSON, без ключей
и аккаунтов: поиск (`api/search/video` — одна страница, до сотни роликов), каналы и сериалы по
имени (`api/search/combined/cards`), разделы (`api/video/category`), каналы (`api/video/person`
и `api/profile/user`), сериалы (`api/metainfo/tv`), эфиры ТВ (лента `api/feeds/tvchannels`, её
вкладка «ТВ онлайн»). Поток — тоже их JSON: `api/play/options` отдаёт готовый мастер HLS, так
что yt-dlp здесь не нужен вовсе — он сделал бы тот же запрос, только на полторы секунды дольше.

ЧТО НЕ ПОКАЗЫВАЕТСЯ. Платное (`is_paid`), по подписке (`common_subscription_product_codes` — так
площадка метит серии PREMIER и START), под DRM (`drm_token`) и «для взрослых» (`is_adult`) в
каталог не попадает, а если его всё же попросить, отказ звучит человеческими словами. Показать
комнате то, что площадка отдаёт одному зрителю под его подпиской, нельзя: ключа от такого видео
у сервера нет и быть не может.
"""

from __future__ import annotations

import asyncio
import logging
import re
from itertools import chain, zip_longest
from typing import Any, Awaitable, Callable
from urllib.parse import urlsplit

import httpx
from fastapi import HTTPException

from .. import wire
from ..paging import PAGE, page
from ..registry import Ctx, Features, HostPolicy, Provider
from ..resolve import SourcePlan, direct

logger = logging.getLogger(__name__)

API = "https://rutube.ru/api/"
# Сайт площадки открывают браузером, и каталог спрашивается тем же видом: запросы идут через
# их защиту (QRATOR), и выделяться из обычного трафика площадки им незачем.
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/140.0.0.0 Safari/537.36"
    )
}
# С чем сайт площадки спрашивает поток. Без `no_404` на снятое видео приходит страница 404
# вместо объяснения, почему его нет.
PLAY = {"no_404": "true", "referer": "https://rutube.ru", "pver": "v2", "client": "wdp"}

# Сколько площадка кладёт на одну страницу: раздел, канал, серии сезона.
CATEGORY_PAGE = 100
PERSON_PAGE = 20
EPISODES_PAGE = 20

# Номер канала, сериала и сезона у Rutube — просто число. `[0-9]`, а не `\d`: `\d` пропустил бы и
# арабско-индийские цифры, а в адрес площадки уходит строка.
NUMBER = re.compile(r"[0-9]{1,12}")

# Разделы, ради которых в кинозал и приходят, — первыми: фильмы, сериалы, мультфильмы,
# телепередачи, детское, аниме, юмор, музыка, спорт, игры, новости. Остальные — в порядке
# площадки (он у неё по номеру раздела, и первым там стоит «Обзоры и распаковки товаров»).
FIRST = ("4", "5", "7", "43", "42", "41", "19", "6", "16", "22", "8")

# Эфиры ТВ — вкладка «ТВ онлайн» ленты «Телеканалы». Местные каналы и радио уходят в конец: их
# девять десятков и шесть, и первыми они закрыли бы собой федеральные и новостные.
TV_FEED = ("tvchannels", "live")
LAST = ("Региональные", "Радиостанции")

# Полка «Сериалы и шоу» — подборки самой площадки: первая подборка вкладки «Сериалы» страницы
# «Кино и сериалы» и первая — главной «ТВ онлайн» (там это «Телешоу»). Номера подборок площадка
# меняет, поэтому они берутся с её страниц, а не вписаны сюда. Список `api/metainfo/tv` для
# витрины не годится: он по номеру, и первым в нём стоит «Deleted TV show» 2011 года.
SHOWCASE = (("movies-serials", "serials"), ("live", "main"))
# Значок на постере: что это за дверь. Вид, которого здесь нет, остаётся без значка.
KINDS = {"series": "Сериал", "playlist_series": "Сериал", "tvshow": "Шоу", "movie": "Фильм"}
# Как зовётся одна серия: у телешоу это выпуск — так говорят и площадка, и зрители.
EPISODES = {"tvshow": "выпуск"}

SILENT = "Rutube не ответил на запрос каталога"
ADULT = "Видео Rutube с пометкой «для взрослых» в кинозал не попадает"
PAID = "Это платное видео Rutube — показать его комнате нельзя"
SUBSCRIPTION = "Это видео Rutube показывает только по подписке — показать его комнате нельзя"
DRM = "Видео Rutube защищено DRM — показать его комнате нельзя"
BLOCKED = "Rutube не показывает это видео с нашего сервера: ограничение страны или прав на показ"


class Missing(Exception):
    """Площадка ответила 404: такой страницы у неё нет (или листать дальше некуда)."""


def results(data: Any) -> list[dict[str, Any]]:
    """Записи страницы площадки; всё, что не запись, отбрасывается здесь, а не в каждом месте."""
    found = data.get("results") if isinstance(data, dict) else data
    return [item for item in found or [] if isinstance(item, dict)]


def ours(url: Any) -> bool:
    """Адрес из ответа площадки, по которому можно идти дальше: только её же API."""
    if not isinstance(url, str):
        return False
    parts = urlsplit(url)
    return parts.scheme == "https" and parts.hostname == "rutube.ru" and parts.path.startswith("/api/")


def sized(url: Any, size: str) -> str:
    """
    Кадр нужного размера. Исходник у площадки — 1280×720 и полтораста килобайт, а плитке сетки
    хватает 480×270 (`size=m`, тридцать килобайт); страница ролика берёт 640×360 (`size=l`).
    Картинки идут через наш сервер, поэтому разница — это наш канал, а не только время.
    """
    if not isinstance(url, str) or not url:
        return ""
    return url if "?" in url else f"{url}?size={size}"


def year(show: dict[str, Any]) -> int | None:
    for value in (show.get("year"), show.get("year_start")):
        if isinstance(value, str) and re.fullmatch(r"[0-9]{4}", value):
            return int(value)
    return None


def season_title(number: str) -> str:
    # Сезон «0» у площадки — всё, что к сезонам не отнесли: нарезки, анонсы, выпуски без номера.
    return "Другое" if number == "0" else f"Сезон {number}"


class Rutube(Provider):
    id = "rutube"
    name = "Rutube"
    # Каждый хост — из настоящих ответов: `bl.rutube.ru` (балансер: мастер VOD и эфира),
    # `river-*.rutube.ru` и `*.rtbcdn.ru` (варианты и кусочки, у каждой ступени две копии на
    # двух CDN), `pic.rtbcdn.ru` (кадры, постеры, лица и субтитры), `vb-rtb.uma.media` (мастер
    # лицензионных серий, например PREMIER). Заглушки аватаров `static.rutubelist.ru` сюда не
    # входят: вместо безликой картинки площадки плитка рисует свою.
    hosts = HostPolicy(("rutube.ru", "rtbcdn.ru", "uma.media"))
    features = Features(channels=True, categories=True, series=True, live=True)
    # Ролик и эфир у Rutube — 32 шестнадцатеричных знака строчными.
    content_id = re.compile(r"[0-9a-f]{32}")

    # --- каталог ------------------------------------------------------------------------

    async def search(self, ctx: Ctx, query: str, offset: int) -> wire.SearchPage:
        """
        Пусто — это витрина: эфиры ТВ лентой и полка «Сериалы и шоу». Набрано — ролики и эфиры
        лентой, каналы и сериалы полками над ней.

        Найденное площадка отдаёт одной страницей (`page=2` у неё всегда пуста), поэтому
        порции режутся по уже полученному, как у Twitch, и вторая порция полок не спрашивает.
        """
        if not query:
            wanted = [self.memo.get("live", lambda: self._live(ctx), 120)]
            if not offset:
                wanted.append(self._shelf(self.memo.get("shows", lambda: self._shows(ctx), 600), []))
            found = await asyncio.gather(*wanted)
            shows = found[1] if not offset else []
            return {**page(found[0], offset), "channels": [], "categories": [], "series": shows}
        low = query.lower()
        wanted = [self.memo.get(f"search:{low}", lambda: self._search(ctx, query), 120)]
        if not offset:
            wanted.append(
                self._shelf(self.memo.get(f"cards:{low}", lambda: self._cards(ctx, query), 300), ([], []))
            )
        found = await asyncio.gather(*wanted)
        channels, series = found[1] if not offset else ([], [])
        return {**page(found[0], offset), "channels": channels, "categories": [], "series": series}

    async def categories(self, ctx: Ctx, query: str, offset: int) -> wire.Page:
        """
        Разделы Rutube — одной порцией: их четыре десятка, и это ряд кнопок над витриной, а не
        лента, которую листают.
        """
        items = await self.memo.get("categories", lambda: self._sections(ctx), 3600)
        if query:
            items = [item for item in items if query.lower() in item["title"].lower()]
        return {"items": items[offset:], "next": None}

    async def category(self, ctx: Ctx, category_id: str, offset: int) -> wire.CategoryPage:
        """Раздел: его карточка и ролики, самые свежие сверху, — как их показывает площадка."""
        sections = await self.memo.get("categories", lambda: self._sections(ctx), 3600)
        head = next((item for item in sections if item["id"] == category_id), None)
        if head is None:
            raise HTTPException(404, "Такого раздела на Rutube нет")
        found = await self._portion(
            ctx,
            f"video/category/{category_id}/",
            {},
            CATEGORY_PAGE,
            offset,
            self._video,
            memo=(f"category:{category_id}", 300),
        )
        return {"category": head, **found}

    async def channel(self, ctx: Ctx, channel_id: str, tab: str, offset: int) -> wire.ChannelPage:
        """
        Канал: шапка из профиля и его ролики по двадцать, как на самой площадке.

        Вкладок у канала две — «Видео» и «О канале»; на остальные (трансляции, короткие,
        плейлисты) лента пуста, а шапка на месте.
        """
        if not NUMBER.fullmatch(channel_id):
            raise HTTPException(400, "Непонятное имя канала")
        head = self.memo.get(f"profile:{channel_id}", lambda: self._profile(ctx, channel_id), 300)
        if tab != "videos":
            return {"channel": await head, "items": [], "next": None}
        channel, found = await asyncio.gather(
            head,
            self._portion(ctx, f"video/person/{channel_id}/", {}, PERSON_PAGE, offset, self._video),
            return_exceptions=True,
        )
        # Шапка — первой: «такого канала нет» важнее, чем то, что у несуществующего канала нет
        # и роликов.
        for answer in (channel, found):
            if isinstance(answer, BaseException):
                raise answer
        return {"channel": channel, **found}

    async def series(self, ctx: Ctx, series_id: str, season: str | None, offset: int) -> wire.SeriesPage:
        """
        Сериал: шапка, сезоны и серии открытого сезона по двадцать.

        Серии по подписке в ленту не попадают — показать их комнате нельзя, — поэтому у сериалов
        PREMIER и START видны только бесплатные серии: бывает, что одна первая, бывает, что ни
        одной. Какие серии бесплатны, площадка меняет сама и часто.
        """
        if not NUMBER.fullmatch(series_id):
            raise HTTPException(400, "Непонятный адрес сериала")
        show, numbers = await asyncio.gather(
            self.memo.get(
                f"tv:{series_id}",
                lambda: self._get(ctx, f"metainfo/tv/{series_id}/", missing="Такого сериала на Rutube нет"),
                600,
            ),
            self.memo.get(f"seasons:{series_id}", lambda: self._seasons(ctx, series_id), 600),
        )
        show = self._object(show)
        if season is None and numbers:
            # Площадка открывает первый настоящий сезон, а не «другое» под номером ноль.
            season = next((number for number in numbers if number != "0"), numbers[0])
        elif season is not None and season not in numbers:
            raise HTTPException(404, "Такого сезона у сериала нет")
        word = EPISODES.get((show.get("type") or {}).get("name"), "серия")
        found = await self._portion(
            ctx,
            f"metainfo/tv/{series_id}/video",
            {"season": season} if season is not None else {},
            EPISODES_PAGE,
            offset,
            lambda item: self._video(item, series=series_id, episode=word),
        )
        return {
            "series": wire.series_head(
                series_id,
                show.get("name") or "Сериал",
                poster=self.image(show.get("picture") or show.get("poster_url") or ""),
                description=(show.get("description") or "")[:4000],
                year=year(show),
                seasons=[{"id": number, "title": season_title(number)} for number in numbers],
            ),
            "season": season,
            **found,
        }

    async def details(self, ctx: Ctx, kind: str, item_id: str) -> wire.Details:
        info = self._object(await self._get(ctx, f"video/{item_id}/", missing="Такого видео на Rutube нет"))
        self._allow(info)
        live = bool(info.get("is_livestream")) and bool(info.get("is_on_air"))
        author = info.get("author") or {}
        # Дверь ко всем сериям — только у серии: у идущего эфира `tv_show_id` площадка тоже
        # держит, но «все серии» эфира ничего не значат.
        extra = {"series": str(info["tv_show_id"])} if info.get("tv_show_id") and not live else {}
        return wire.details(
            self.id,
            kind,
            item_id,
            info.get("title") or "Видео Rutube",
            author=author.get("name") or "",
            channelId=str(author["id"]) if author.get("id") else None,
            channelAvatar=self.image(author.get("avatar_url") or ""),
            duration=None if live else info.get("duration") or None,
            live=live,
            # У эфира ТВ площадка считает просмотры с первого дня канала: сотня миллионов под
            # «смотрят сейчас» ничего не говорит.
            views=None if live else info.get("hits"),
            published=(info.get("publication_ts") or "")[:10] or None,
            category=(info.get("category") or {}).get("name"),
            description=(info.get("description") or "")[:4000],
            poster=self.image(sized(info.get("thumbnail_url"), "l")),
            **extra,
        )

    # --- поток --------------------------------------------------------------------------

    async def source(self, ctx: Ctx, kind: str, item_id: str, options: dict[str, Any]) -> SourcePlan:
        """
        Поток — из того же ответа, что и у плеера площадки: мастер VOD с балансера или мастер
        эфира. Субтитры — оттуда же; они SRT, и WebVTT из них делает маршрут `subtitles`.

        Платность и пометка «для взрослых» есть только в карточке ролика (`api/video`), а
        подписка, DRM и запрет по стране — только в ответе плеера. Поэтому спрашиваются оба,
        разом: ждать приходится одного, а отказ звучит точнее.
        """
        options_answer, info = await asyncio.gather(
            self._play(ctx, item_id), self._info(ctx, item_id), return_exceptions=True
        )
        if isinstance(info, dict):
            self._allow(info)
        if isinstance(options_answer, BaseException):
            raise options_answer
        play = options_answer
        if play.get("is_adult"):
            raise HTTPException(403, ADULT)
        if play.get("drm_token"):
            raise HTTPException(403, DRM)
        balancer = (play.get("video_balancer") or {}).get("m3u8")
        streams = [
            item for item in (play.get("live_streams") or {}).get("hls") or [] if isinstance(item, dict)
        ]
        live_url = streams[0].get("url") if streams else None
        # Эфир — если его просили или если, кроме эфира, у ролика ничего нет.
        url, live = (
            (live_url, True) if live_url and (kind == "channel" or not balancer) else (balancer, False)
        )
        if not isinstance(url, str) or not url:
            raise HTTPException(502, "Rutube не отдал поток для этого видео. Попробуйте другое")
        milliseconds = play.get("duration")
        return direct(
            "hls",
            url,
            live=live,
            title=play.get("title") or "",
            author=(play.get("author") or {}).get("name") or "",
            duration=None if live or not milliseconds else milliseconds / 1000,
            poster=play.get("thumbnail_url") or None,
            captions=tuple(self._captions(play.get("captions"))),
        )

    def _captions(self, found: Any) -> list[dict[str, Any]]:
        tracks = []
        for track in found or []:
            if not isinstance(track, dict) or not isinstance(track.get("file"), str):
                continue
            parts = urlsplit(track["file"])
            if parts.scheme != "https" or not self.hosts.allows(parts.hostname or ""):
                continue
            tracks.append(
                {
                    "lang": track.get("code") or "",
                    # «Русский • Авто» — запасное имя: плеер называет язык сам, на языке смотрящего.
                    "label": track.get("langTitle") or track.get("code") or "",
                    "auto": bool(track.get("is_autogenerated")),
                    "url": track["file"],
                }
            )
        return tracks

    async def _play(self, ctx: Ctx, item_id: str) -> dict[str, Any]:
        """Ответ плеера площадки. Её «заглушка» (код 244 и `detail`) — это отказ, и сказан он словами."""
        try:
            response = await ctx.net.get(f"{API}play/options/{item_id}/", params=PLAY, headers=HEADERS)
            body = response.json()
        except (httpx.HTTPError, ValueError):
            raise HTTPException(502, "Rutube не отдал видео") from None
        if not isinstance(body, dict):
            raise HTTPException(502, "Rutube не отдал видео")
        stub = body.get("detail")
        if isinstance(stub, dict):
            raise self._stub(stub)
        if response.status_code == 404:
            raise HTTPException(404, "Такого видео на Rutube нет")
        if response.status_code != 200:
            raise HTTPException(502, "Rutube не отдал видео")
        return body

    @staticmethod
    def _stub(stub: dict[str, Any]) -> HTTPException:
        """
        Заглушка плеера — почему площадка не отдаёт видео.

        Подписку и запрет по стране площадка объясняет зрителю своего сайта («…VPN…»), а
        здесь смотрит комната через наш сервер, и сказать это нужно про него. Остальное —
        «трансляция закончилась» и подобное — её же словами.
        """
        if stub.get("type") == "common_subscription":
            return HTTPException(403, SUBSCRIPTION)
        if stub.get("type") == "blocking_rule":
            return HTTPException(403, BLOCKED)
        said = next((entry for entry in stub.get("languages") or [] if isinstance(entry, dict)), {})
        words = ". ".join(
            str(part).strip().rstrip(".") for part in (said.get("title"), said.get("description")) if part
        )
        return HTTPException(404, f"Rutube: {words}"[:300] if words else "Rutube не отдал это видео")

    async def _info(self, ctx: Ctx, item_id: str) -> dict[str, Any] | None:
        """Карточка ролика ради пометок; без неё поток всё равно открывается — пометки есть и у плеера."""
        try:
            return await self._get(ctx, f"video/{item_id}/")
        except HTTPException:
            return None

    def _allow(self, info: dict[str, Any]) -> None:
        if info.get("is_adult"):
            raise HTTPException(403, ADULT)
        if info.get("is_paid"):
            raise HTTPException(403, PAID)
        if info.get("common_subscription_product_codes"):
            raise HTTPException(403, SUBSCRIPTION)

    # --- что площадка отвечает ------------------------------------------------------------

    async def _get(
        self,
        ctx: Ctx,
        path: str,
        params: dict[str, str] | None = None,
        *,
        missing: str | None = None,
        absent: bool = False,
    ) -> Any:
        return await self._json(ctx, API + path, params, missing=missing, absent=absent)

    async def _json(
        self,
        ctx: Ctx,
        url: str,
        params: dict[str, str] | None = None,
        *,
        missing: str | None = None,
        absent: bool = False,
    ) -> Any:
        """
        JSON площадки или отказ.

        404 — это «такого нет» (`missing`: текст для человека), «листать дальше некуда»
        (`absent`: `Missing` для того, кто это ждёт) или, если не ждали ни того ни другого, та
        же неудача, что и любая другая. Сеть, молчание и мусор вместо JSON — «площадка не
        ответила» (502), а не ошибка нашего сервера: так же, как у Twitch.
        """
        try:
            response = await ctx.net.get(url, params=params, headers=HEADERS)
        except httpx.HTTPError:
            raise HTTPException(502, SILENT) from None
        if response.status_code == 404 and missing:
            raise HTTPException(404, missing)
        if response.status_code == 404 and absent:
            raise Missing(url)
        if response.status_code != 200:
            raise HTTPException(502, SILENT)
        try:
            return response.json()
        except ValueError:
            raise HTTPException(502, SILENT) from None

    @staticmethod
    def _object(data: Any) -> dict[str, Any]:
        """Ответ, который обязан быть объектом: что-то другое — площадка ответила не то (502)."""
        if not isinstance(data, dict):
            raise HTTPException(502, SILENT)
        return data

    async def _portion(
        self,
        ctx: Ctx,
        path: str,
        params: dict[str, str],
        per_page: int,
        offset: int,
        card: Callable[[dict[str, Any]], wire.Card | None],
        *,
        memo: tuple[str, float] | None = None,
    ) -> wire.Page:
        """
        Порция ленты, которую площадка листает страницами по `per_page`.

        Курсор — место в ленте площадки: `номер страницы × per_page + место в её отобранном`.
        Страница берётся целиком, отбирается (платное и «для взрослых» — мимо) и режется по
        нашей порции; следующая порция начинается или дальше на той же странице, или с первой
        записи следующей. Отобранное бывает короче страницы — поэтому курсор и считает место в
        отобранном, а не в пришедшем: так ни одна запись не пропадает между порциями.
        """
        number, start = divmod(offset, per_page)
        params = {**params, "page": str(number + 1)}
        if memo:
            key, ttl = memo
            found = await self.memo.get(
                f"{key}:{number + 1}", lambda: self._listing(ctx, path, params, card), ttl
            )
        else:
            found = await self._listing(ctx, path, params, card)
        items = found["items"]
        if start + PAGE < len(items):
            following: int | None = offset + PAGE
        elif found["more"]:
            following = (number + 1) * per_page
        else:
            following = None
        return {"items": items[start : start + PAGE], "next": None if following is None else str(following)}

    async def _listing(
        self,
        ctx: Ctx,
        path: str,
        params: dict[str, str],
        card: Callable[[dict[str, Any]], wire.Card | None],
    ) -> dict[str, Any]:
        try:
            data = await self._get(ctx, path, params, absent=True)
        except Missing:
            # Страницы дальше последней у площадки нет — это конец ленты, а не ошибка.
            return {"items": [], "more": False}
        cards = [found for item in results(data) if (found := card(item))]
        return {"items": cards, "more": bool(isinstance(data, dict) and data.get("has_next"))}

    @staticmethod
    async def _shelf(shelf: Awaitable[Any], empty: Any) -> Any:
        """
        Полка над лентой: её сбой — пустая полка, а не сломанная страница.

        Пустота в память не попадает (память хранит только ответы), и следующий вопрос снова
        идёт к площадке.
        """
        try:
            return await shelf
        except HTTPException as failure:
            logger.warning("кинозал: полка Rutube не собралась: %s", failure.detail)
            return empty

    # --- что из этого получается ------------------------------------------------------------

    @staticmethod
    def _shown(item: dict[str, Any]) -> bool:
        """Можно ли это показать комнате: не платное, не по подписке, не «для взрослых», не снятое."""
        return not (
            item.get("is_adult")
            or item.get("is_paid")
            or item.get("common_subscription_product_codes")
            or item.get("is_hidden")
            or item.get("is_deleted")
        )

    def _video(
        self, item: dict[str, Any], *, series: str | None = None, episode: str = "серия"
    ) -> wire.Card | None:
        """
        Ролик или эфир как карточка каталога.

        Идущий эфир ТВ — это `channel` (его смотрят с края, как эфир Twitch) под номером своего
        ролика. Эфир, который уже не идёт, — не эфир и не ролик: площадка отвечает на него
        «трансляция закончилась», поэтому в каталог он не попадает вовсе.
        """
        identity = item.get("id")
        if not isinstance(identity, str) or not self.content_id.fullmatch(identity) or not self._shown(item):
            return None
        author = item.get("author") or {}
        face = {
            "author": author.get("name") or "",
            "channelId": str(author["id"]) if author.get("id") else None,
            "poster": self.image(sized(item.get("thumbnail_url"), "m")),
        }
        if item.get("is_livestream"):
            if not item.get("is_on_air"):
                return None
            return wire.card(
                self.id, "channel", identity, item.get("title") or "Прямой эфир", live=True, **face
            )
        extra: dict[str, Any] = {}
        if series:
            extra["series"] = series
            number = item.get("episode")
            # Серия без номера (`0`) — без значка: «0 серия» ничего не говорит.
            if isinstance(number, int) and number > 0:
                extra["badge"] = f"{number} {episode}"
        return wire.card(
            self.id,
            "video",
            identity,
            item.get("title") or "Видео Rutube",
            duration=item.get("duration") or None,
            views=item.get("hits"),
            **face,
            **extra,
        )

    def _show(self, show: dict[str, Any]) -> wire.Card | None:
        """Сериал, шоу или фильм сериалом — дверь на его страницу, постером 2:3."""
        if not isinstance(show.get("id"), int) or not self._shown(show):
            return None
        badge = KINDS.get((show.get("type") or {}).get("name"))
        return wire.card(
            self.id,
            "series",
            str(show["id"]),
            show.get("name") or "Сериал",
            shape="tall",
            poster=self.image(show.get("picture") or show.get("poster_url") or ""),
            **({"badge": badge} if badge else {}),
        )

    def _face(self, channel: dict[str, Any]) -> wire.Card | None:
        """Канал в находках: лицо, имя и сколько подписано. Это дверь, его не включают."""
        if not isinstance(channel.get("id"), int):
            return None
        identity = str(channel["id"])
        return wire.card(
            self.id,
            "channel",
            identity,
            channel.get("name") or "Канал",
            channelId=identity,
            followers=channel.get("subscribers_count"),
            description=(channel.get("description") or "")[:300],
            poster=self.image(channel.get("icon") or ""),
        )

    async def _search(self, ctx: Ctx, query: str) -> list[wire.Card]:
        data = await self._get(ctx, "search/video/", {"query": query[:120]})
        return [found for item in results(data) if (found := self._video(item))]

    async def _cards(self, ctx: Ctx, query: str) -> tuple[list[wire.Card], list[wire.Card]]:
        """Каналы и сериалы по имени — то, что сайт площадки ставит над найденными роликами."""
        data = await self._get(
            ctx, "search/combined/cards/list", {"client": "wdp", "query": query[:120], "page": "1"}
        )
        channels: list[wire.Card] = []
        shows: list[wire.Card] = []
        for entry in results(data):
            if (entry.get("type") or {}).get("name") == "userchannel":
                found = self._face(entry)
                if found:
                    channels.append(found)
            elif "/metainfo/tv/" in str(entry.get("content") or ""):
                found = self._show(entry)
                if found:
                    shows.append(found)
        return channels, shows

    async def _live(self, ctx: Ctx) -> list[wire.Card]:
        """Эфиры ТВ по группам площадки, каждый канал один раз."""
        feed = await self._get(ctx, f"feeds/{TV_FEED[0]}/")
        groups = [
            resource
            for resource in self._tab(feed, TV_FEED[1])
            if (resource.get("content_type") or {}).get("model") == "tag" and ours(resource.get("url"))
        ]
        groups.sort(key=lambda resource: resource.get("name") in LAST)
        answers = await asyncio.gather(
            *(self._json(ctx, resource["url"]) for resource in groups), return_exceptions=True
        )
        cards: list[wire.Card] = []
        seen: set[str] = set()
        for answer in answers:
            if isinstance(answer, BaseException):
                # Одна группа не ответила — остальные эфиры всё равно показываются.
                logger.warning("кинозал: группа эфиров Rutube не ответила: %s", type(answer).__name__)
                continue
            for item in results(answer):
                found = self._video(item) if item.get("is_livestream") else None
                if found and found["id"] not in seen:
                    seen.add(found["id"])
                    cards.append(found)
        if groups and all(isinstance(answer, BaseException) for answer in answers):
            raise HTTPException(502, SILENT)
        return cards

    async def _shows(self, ctx: Ctx) -> list[wire.Card]:
        """Полка «Сериалы и шоу»: подборки площадки через одну — сериал, шоу, сериал, шоу."""
        picks = await asyncio.gather(
            *(self._picks(ctx, feed, tab) for feed, tab in SHOWCASE), return_exceptions=True
        )
        good = [found for found in picks if not isinstance(found, BaseException)]
        if not good:
            raise HTTPException(502, SILENT)
        cards: list[wire.Card] = []
        seen: set[str] = set()
        for found in chain.from_iterable(zip_longest(*good)):
            if found and found["id"] not in seen:
                seen.add(found["id"])
                cards.append(found)
        return cards

    async def _picks(self, ctx: Ctx, feed: str, tab: str) -> list[wire.Card]:
        page_of_feed = await self._get(ctx, f"feeds/{feed}/")
        group = next(
            (
                resource["url"]
                for resource in self._tab(page_of_feed, tab)
                if (resource.get("content_type") or {}).get("model") == "subscriptiontvseries"
                and ours(resource.get("url"))
            ),
            None,
        )
        if group is None:
            return []
        data = await self._json(ctx, group)
        return [
            found
            for entry in results(data)
            if (entry.get("content_type") or {}).get("model") == "tv"
            and not entry.get("is_adult")
            and (found := self._show(entry.get("object") or {}))
        ]

    @staticmethod
    def _tab(feed: Any, slug: str) -> list[dict[str, Any]]:
        tabs = feed.get("tabs") if isinstance(feed, dict) else None
        tab = next((tab for tab in tabs or [] if isinstance(tab, dict) and tab.get("slug") == slug), {})
        return [resource for resource in tab.get("resources") or [] if isinstance(resource, dict)]

    async def _sections(self, ctx: Ctx) -> list[wire.CategoryCard]:
        data = await self._get(ctx, "video/category/")
        cards = [
            wire.category_card(self.id, str(item["id"]), item.get("name") or "")
            for item in results(data)
            if isinstance(item.get("id"), int)
        ]
        order = {identity: place for place, identity in enumerate(FIRST)}
        # Сортировка устойчивая: всё, чего нет в `FIRST`, остаётся в порядке площадки.
        return sorted(cards, key=lambda card: order.get(card["id"], len(FIRST)))

    async def _profile(self, ctx: Ctx, channel_id: str) -> wire.ChannelHead:
        profile = self._object(
            await self._get(ctx, f"profile/user/{channel_id}/", missing="Такого канала на Rutube нет")
        )
        return wire.channel_head(
            self.id,
            channel_id,
            profile.get("name") or "Канал",
            description=(profile.get("description") or "")[:1200],
            followers=profile.get("subscribers_count"),
            avatar=self.image(profile.get("avatar_url") or ""),
            banner=self.image((profile.get("appearance") or {}).get("cover_image") or ""),
        )

    async def _seasons(self, ctx: Ctx, series_id: str) -> list[str]:
        try:
            data = await self._get(ctx, f"metainfo/tv/{series_id}/season/", absent=True)
        except Missing:
            return []
        return [str(entry["number"]) for entry in results(data) if isinstance(entry.get("number"), int)]
