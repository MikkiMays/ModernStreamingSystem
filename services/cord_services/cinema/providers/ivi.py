"""
ivi: только бесплатное — фильмы, сериалы и мультфильмы каталогом площадки, поток через yt-dlp.

ОТКУДА ЧТО. Каталог — открытый мобильный JSON площадки (`api.ivi.ru/mobileapi`), без ключей и
входа: три раздела-вкладки (`category=14` Фильмы, `15` Сериалы, `17` Мультфильмы), поиск по всем
разом, сериал — шапка и сезоны (`compilationinfo`) и серии открытого сезона (`videofromcompilation`),
подробности одной карточки — `videoinfo` (он же для ролика, он же для серии сериала). Названия
жанров площадка отдаёт отдельным списком (`categories`) — номерами в карточке иначе не сказать
ничего человеку. Поток — yt-dlp по странице ролика: своего мастера у ivi нет, а её же API потока
(внутри самого yt-dlp) сам решает, какие форматы отдать, отбрасывая защищённые DRM.

ЧТО НЕ ПОКАЗЫВАЕТСЯ. Владелец решил: в кинозале — только то, что ivi отдаёт бесплатно, с рекламой
(AVOD); платное — по подписке, разово или в аренду — не показывается никогда. Отбор двойной: своей
строкой у площадки (`paid_type=AVOD` в каждом запросе каталога) и ещё раз здесь, по присланному
`content_paid_types`, — если фильтр площадки когда-нибудь промолчит, служба не должна повторить его
ошибку. Показ работает только из России (`geocheck/whoami` это подтверждает): из любой другой
страны карточка площадки в списке гаснет с понятной причиной, а не пустым каталогом, который
выглядел бы как поломка.

ЧЕГО ЗДЕСЬ НЕТ. Хост настоящего видеопотока (не картинок — они с `dfs.ivi.ru`) с этого сервера
не проверить: бесплатное отсюда не открывается вовсе (см. выше), а платное — открылось бы, но не
отдало бы поток без подписки. Первый настоящий просмотр из России — и есть проверка: см. отчёт
задачи, там команда для установки владельца.
"""

from __future__ import annotations

import asyncio
import re
from typing import Any

import httpx
from fastapi import HTTPException

from .. import address, wire
from ..paging import MAX_OFFSET, PAGE
from ..registry import Ctx, Features, HostPolicy, Match, Provider
from ..resolve import PROBE, SourcePlan

API = "https://api.ivi.ru/mobileapi/"
APP_VERSION = "870"

WHOAMI = API + "geocheck/whoami/v6/"
CATEGORIES = API + "categories/v7/"
CATALOGUE = API + "catalogue/v7/"
SEARCH = API + "search/v7/"
COMPILATION_INFO = API + "compilationinfo/v7/"
VIDEO_FROM_COMPILATION = API + "videofromcompilation/v7/"
VIDEO_INFO = API + "videoinfo/v7/"

# Сколько ждать проверку страны: список площадок не должен зависеть от одной медленной — общий
# срок `Cinema.AVAILABILITY_TIMEOUT` — 3 с, здесь с запасом меньше.
WHOAMI_TIMEOUT = 2.5
# Как долго верить ответу о стране: гео не меняется каждую минуту, а спрашивать его у площадки
# на каждое открытие кинозала незачем.
AVAILABILITY_TTL = 3600
# Сколько площадка кладёт в одну порцию сериала — как у Rutube: сезон полсотни серий длиннее, чем
# долистывают за раз.
EPISODES_PAGE = 20

# Поля карточки каталога и поиска: номер, вид, год, длительность (секунды), жанры (номерами —
# имена отдельным списком, `_genre_names`), постеры, рейтинг и платность — ради неё карточка и
# спрашивается. Без «лишнего» площадка отвечает и весит меньше, и фикстуры короче.
#
# ГОД — ДВУМЯ ПОЛЯМИ. У ролика (`object_type: video`, будь то фильм или серия) год один и лежит в
# `year` (число); у подборки (`object_type: compilation`) — годами показа, `years` (список, у
# долгого сериала — начало и который идёт сейчас). Каталог и поиск отдают вперемешку то и другое —
# оба поля здесь и разбирает `_year`; у одной записи бывает только одно из них (проверено
# 25.09.2026: `Иван Васильевич меняет профессию` — `year:1973`, без `years` вовсе).
TILE_FIELDS = "id,title,object_type,year,years,duration,genres,posters,ivi_rating_10,content_paid_types"
# Серия сезона: своей длительности у неё нет — она в `localizations[0].duration`; постер — с
# пометкой «это постер сериала», но плитке всё равно, чей он.
EPISODE_FIELDS = (
    "id,title,object_type,episode,season,posters,localizations,genres,ivi_rating_10,content_paid_types"
)
# Сериал целиком: то же самое плюс описание и список сезонов (`season_id`, `number`, сколько в нём
# серий) — по нему и строятся вкладки сезонов.
COMPILATION_FIELDS = (
    "id,title,object_type,years,duration,genres,posters,ivi_rating_10,content_paid_types,"
    "description,seasons"
)
# Одна карточка (ролик или серия сериала) — `compilation`, если это серия: оттуда номер сериала
# для кнопки «Все серии», а `ivi_release_date` — дата выхода для страницы ролика.
SINGLE_FIELDS = (
    "id,title,object_type,year,years,duration,genres,posters,ivi_rating_10,content_paid_types,"
    "description,compilation,episode,season,localizations,ivi_release_date"
)

# Разделы кинозала — ровно три, в этом порядке: ради них сюда и приходят. У площадки разделов
# восемь («Видео», «Аудиосериалы», «Шортс», «Для детей»…) — здесь только те, что относятся к делу;
# имена и номера — с её же `categories/v7` (проверено 25.09.2026, `mobileapi/categories/v7`).
CATEGORY_TABS: tuple[tuple[str, str], ...] = (("14", "Фильмы"), ("15", "Сериалы"), ("17", "Мультфильмы"))
CATEGORY_TITLES: dict[str, str] = dict(CATEGORY_TABS)

# Ролик, серия сериала или сам сериал (когда его спрашивают числом, не слугом) — просто число.
NUMBER = re.compile(r"[0-9]{1,12}")

# Ссылки ivi — площадка отдаёт их и на `.ru`, и на `.tv` (сама же переадресует `.ru` на `.tv` не
# из России — проверено 24.09.2026): «По ссылке» должна узнавать оба.
LINK_HOSTS = frozenset({"ivi.ru", "www.ivi.ru", "ivi.tv", "www.ivi.tv"})

NOT_RU = "ivi отдаёт бесплатное только в России"
SILENT = "ivi не ответил на запрос каталога"
PAID = "Это платное видео ivi — показать его комнате нельзя"
NO_VIDEO = "Такого видео на ivi нет"
NO_SERIES = "Такого сериала на ivi нет"
NO_SEASON = "Такого сезона у сериала нет"
NO_CATEGORY = "Такого раздела на ivi нет"
GEO_REFUSED = "ivi не показывает это видео с нашего сервера: ограничение по стране"
NOT_FREE_STREAM = "ivi не отдал бесплатный поток для этого видео — похоже, оно платное или защищено"
OPEN_FAILED = "Не удалось открыть видео"

# Так yt-dlp у ivi называет пустые форматы (все были `-MDRM-`/`-FPS-` и отсеялись) и свою же
# нынешнюю ошибку согласования версии ответа (`da.content.get`, живой прогон 25.09.2026 с этого
# сервера: без подписки площадка отвечает `ContentNotPaid` на подписанный запрос, а несведущий
# запасной запрос без подписи — этой самой ошибкой версии). Ни то ни другое не звучит понятно
# по-английски, а оба означают одно: бесплатного потока не нашлось.
NO_FORMATS = "No video formats found"
VERSION_MISMATCH = "Не смогли определить версию"


def _poster_url(posters: Any) -> str:
    """Вертикальный постер 2:3 — тот, что нужен плитке; горизонтальный ей не годится."""
    for item in posters if isinstance(posters, list) else []:
        if (
            isinstance(item, dict)
            and item.get("type") == "poster-vertical"
            and isinstance(item.get("url"), str)
        ):
            return item["url"]
    return ""


def _year(item: dict[str, Any]) -> int | None:
    """Год: у ролика — `year` (число), у подборки — первый из `years` (список). См. `TILE_FIELDS`."""
    year = item.get("year")
    if isinstance(year, int):
        return year
    years = item.get("years")
    first = years[0] if isinstance(years, list) and years else None
    return first if isinstance(first, int) else None


def _duration(item: dict[str, Any]) -> float | None:
    """
    Длительность в секундах: у ролика и подборки — своим полем, у серии сериала — только в
    `localizations[0].duration` (у самой серии поля `duration` нет вовсе).
    """
    value = item.get("duration")
    if isinstance(value, (int, float)) and value > 0:
        return float(value)
    for entry in item.get("localizations") or []:
        if (
            isinstance(entry, dict)
            and isinstance(entry.get("duration"), (int, float))
            and entry["duration"] > 0
        ):
            return float(entry["duration"])
    return None


def _rating(item: dict[str, Any]) -> str | None:
    value = item.get("ivi_rating_10")
    return f"★ {value:.1f}" if isinstance(value, (int, float)) and value > 0 else None


def _genre(item: dict[str, Any], names: dict[int, str]) -> str | None:
    for value in item.get("genres") or []:
        if isinstance(value, int) and value in names:
            return names[value]
    return None


def _meta_line(item: dict[str, Any], names: dict[int, str], *, rating: bool) -> str | None:
    """Жанр, год и — где есть место для ещё одной строки (страница ролика) — рейтинг, одной строкой."""
    parts = [_genre(item, names), str(_year(item) or "") or None]
    if rating:
        parts.append(_rating(item))
    line = " · ".join(part for part in parts if part)
    return line or None


class Ivi(Provider):
    id = "ivi"
    name = "ivi"
    # `dfs.ivi.ru` — хранилище картинок и раскадровок (`thumbs.dfs.ivi.ru`, `storyboard.dfs.ivi.ru`,
    # проверено 25.09.2026 настоящими ответами каталога). Хост самого потока с этого сервера не
    # увидеть: бесплатное отсюда не отдаётся вовсе (см. `availability`), платное отдало бы отказ
    # раньше, чем адрес файла. Первая настоящая проверка потока — из России, владельцем; если её
    # CDN-хост окажется другим, сюда добавляется одна строка (см. отчёт задачи).
    hosts = HostPolicy(("ivi.ru", "dfs.ivi.ru"))
    features = Features(search=True, categories=True, series=True)
    content_id = NUMBER
    refusals = {
        "channels": "У ivi каналов нет",
        "playlists": "У ivi плейлистов нет",
        "live": "У ivi прямых эфиров нет",
    }

    # --- доступность ----------------------------------------------------------------------

    async def availability(self, net: httpx.AsyncClient) -> tuple[bool, str | None]:
        """
        Работает ли ivi отсюда: единственная площадка кинозала, у которой это не всегда «да».

        Спрашивается клиентом самой площадки (`net` = `Net.client_for("ivi")`): её выходом наружу —
        `CINEMA_PROXY_IVI` или общий, — тем же, что каталог и yt-dlp. Раньше проверка шла мимо него, своим
        клиентом, и сервер за границей с российским прокси всё равно видел ivi выключенной. Ответ час в
        памяти, чтобы не спрашивать площадку на каждое открытие панели; отказ сети в память не попадает
        (`Memo.get` кэширует только значение) — так минутный сбой не гасит карточку на час.
        """
        return await self.memo.get("availability", lambda: self._whoami(net), AVAILABILITY_TTL)

    async def _whoami(self, net: httpx.AsyncClient) -> tuple[bool, str | None]:
        response = await net.get(WHOAMI, params={"app_version": APP_VERSION}, timeout=WHOAMI_TIMEOUT)
        result = response.json()["result"]
        country = result["country_code"]
        if not isinstance(country, str) or not country:
            raise ValueError("ivi geocheck/whoami: нет country_code")
        return (True, None) if country == "RU" else (False, NOT_RU)

    # --- ссылка -----------------------------------------------------------------------------

    def match(self, url: str) -> Match | None:
        """
        Ролик по `watch/<номер>` и `watch/<слаг>/<номер>` — слаг у площадки не значит ничего,
        решает только число в конце (так же читает ссылку и сам yt-dlp). Подборку по одному слову
        (`watch/<слаг>`, без числа) кинозал не узнаёт: у неё нет числового номера, а угадать его
        без лишнего запроса нельзя — такая ссылка уйдёт «По ссылке» общим путём.
        """
        found = address.parse(url)
        if found is None or found.host not in LINK_HOSTS:
            return None
        path = found.path
        if path[:1] == ("watch",) and len(path) in (2, 3):
            tail = path[-1]
            return Match("video", tail, "item") if self.content_id.fullmatch(tail) else None
        if path[:2] == ("video", "player"):
            video_id = found.query.get("videoId", "")
            return Match("video", video_id, "item") if self.content_id.fullmatch(video_id) else None
        return None

    # --- каталог ------------------------------------------------------------------------

    async def search(self, ctx: Ctx, query: str, offset: int) -> wire.SearchPage:
        """Пусто — ничего: витрина ivi — это три вкладки (`categories`/`category`), не выдача."""
        if not query:
            return {"items": [], "next": None, "channels": [], "categories": []}
        low = query.strip()[:120]
        names, (raw, following) = await asyncio.gather(
            self._genres(ctx),
            self._raw_page(
                ctx, SEARCH, {"query": low, "fields": TILE_FIELDS}, PAGE, offset,
                memo=(f"search:{low.lower()}", 120),
            ),
        )
        items = [found for item in raw if (found := self._poster(item, names))]
        return {"items": items, "next": following, "channels": [], "categories": []}

    async def categories(self, ctx: Ctx, query: str, offset: int) -> wire.Page:
        """Три вкладки, известные заранее: спрашивать площадку не о чем."""
        items = [wire.category_card(self.id, cid, title) for cid, title in CATEGORY_TABS]
        if query:
            low = query.lower()
            items = [item for item in items if low in item["title"].lower()]
        return {"items": items[offset:], "next": None}

    async def category(self, ctx: Ctx, category_id: str, offset: int) -> wire.CategoryPage:
        title = CATEGORY_TITLES.get(category_id)
        if title is None:
            raise HTTPException(404, NO_CATEGORY)
        names, (raw, following) = await asyncio.gather(
            self._genres(ctx),
            self._raw_page(
                ctx, CATALOGUE, {"category": category_id, "fields": TILE_FIELDS}, PAGE, offset,
                memo=(f"category:{category_id}", 300),
            ),
        )
        items = [found for item in raw if (found := self._poster(item, names))]
        head = wire.category_card(self.id, category_id, title)
        return {"category": head, "items": items, "next": following}

    async def series(self, ctx: Ctx, series_id: str, season: str | None, offset: int) -> wire.SeriesPage:
        """Сериал: шапка и сезоны из `compilationinfo`, серии открытого сезона — из `videofromcompilation`."""
        show = await self.memo.get(
            f"compilation:{series_id}", lambda: self._compilationinfo(ctx, series_id), 600
        )
        numbers = [
            str(entry["number"])
            for entry in show.get("seasons") or []
            if isinstance(entry, dict) and isinstance(entry.get("number"), int)
        ]
        if season is None:
            season = numbers[0] if numbers else None
        elif season not in numbers:
            raise HTTPException(404, NO_SEASON)
        params: dict[str, str] = {"id": series_id, "fields": EPISODE_FIELDS}
        if season is not None:
            params["season"] = season
        raw, following = await self._raw_page(
            ctx, VIDEO_FROM_COMPILATION, params, EPISODES_PAGE, offset,
            memo=(f"episodes:{series_id}:{season}", 300), season=season,
        )
        items = [found for item in raw if (found := self._episode(item, series_id))]
        return {
            "series": wire.series_head(
                series_id,
                show.get("title") or "Сериал",
                poster=self.image(_poster_url(show.get("posters"))),
                description=(show.get("description") or "")[:4000],
                year=_year(show),
                seasons=[{"id": number, "title": f"Сезон {number}"} for number in numbers],
            ),
            "season": season,
            "items": items,
            "next": following,
        }

    async def details(self, ctx: Ctx, kind: str, item_id: str) -> wire.Details:
        """
        Подробности одной карточки — ролика или серии сериала (у площадки это один и тот же вид,
        `object_type: video`, и один и тот же запрос — `videoinfo`).
        """
        info, names = await asyncio.gather(self._videoinfo(ctx, item_id), self._genres(ctx))
        self._allow(info)
        compilation = info.get("compilation")
        extra = (
            {"series": str(compilation["id"])}
            if isinstance(compilation, dict) and isinstance(compilation.get("id"), int)
            else {}
        )
        return wire.details(
            self.id,
            kind,
            item_id,
            info.get("title") or "Видео ivi",
            duration=_duration(info),
            category=_meta_line(info, names, rating=True),
            published=(info.get("ivi_release_date") or "")[:10] or None,
            description=(info.get("description") or "")[:4000],
            poster=self.image(_poster_url(info.get("posters"))),
            **extra,
        )

    # --- поток --------------------------------------------------------------------------

    async def source(self, ctx: Ctx, kind: str, item_id: str, options: dict[str, Any]) -> SourcePlan:
        """
        Поток — только yt-dlp: своего мастера у ivi нет. Перед разбором — своя проверка
        (`videoinfo`): если это не AVOD, отказ звучит по-русски и сразу, а не английским текстом
        yt-dlp через пару секунд. Разбор — здесь же, а не в общем `Resolver`: так гео и «бесплатного
        потока нет» тоже звучат по-русски, а удачный разбор `Resolver` получает уже готовым
        (`info=`) — вторично ту же страницу yt-dlp не открывает.
        """
        info = await self._videoinfo(ctx, item_id)
        self._allow(info)
        url = f"https://www.ivi.ru/watch/{item_id}"
        try:
            found = await asyncio.to_thread(self.ytdlp.extract, url, PROBE, self.id)
        except HTTPException:
            raise
        except Exception as error:  # yt_dlp поднимает свои типы — ловим широко, решает текст/вид
            raise self._refusal(error) from None
        return SourcePlan("ytdlp", url, info=found, subtitles="any", files=("mp4",))

    def _refusal(self, error: Exception) -> HTTPException:
        from yt_dlp.utils import GeoRestrictedError  # тяжёлый модуль — только когда правда нужен

        if isinstance(error, GeoRestrictedError):
            return HTTPException(403, GEO_REFUSED)
        text = str(error)
        if NO_FORMATS in text or VERSION_MISMATCH in text:
            return HTTPException(403, NOT_FREE_STREAM)
        return HTTPException(502, f"{OPEN_FAILED}: {self.ytdlp.explain(error)}"[:300])

    # --- что площадка отвечает ------------------------------------------------------------

    async def _get(self, ctx: Ctx, url: str, params: dict[str, str]) -> dict[str, Any]:
        """
        JSON площадки как есть. Сеть, молчание и мусор вместо JSON — общий отказ (502); у ivi
        `{"error": {...}}` приходит с кодом 200 (пустой ответ, платное, чужая версия — разные
        поводы под одним же кодом), и что это значит здесь, решает каждый вызывающий сам.
        """
        try:
            response = await ctx.net.get(url, params={**params, "app_version": APP_VERSION})
        except httpx.HTTPError:
            raise HTTPException(502, SILENT) from None
        if response.status_code != 200:
            raise HTTPException(502, SILENT)
        try:
            data = response.json()
        except ValueError:
            raise HTTPException(502, SILENT) from None
        return data if isinstance(data, dict) else {}

    async def _raw_page(
        self,
        ctx: Ctx,
        url: str,
        params: dict[str, str],
        size: int,
        offset: int,
        *,
        memo: tuple[str, float],
        season: str | None = None,
    ) -> tuple[list[dict[str, Any]], str | None]:
        """
        Порция площадки: `from`/`to` — включительно оба конца (`to=0&from=0` — одна запись,
        проверено 25.09.2026). Бесплатное — уже её же фильтром (`paid_type=AVOD`), но карточка
        строится только из того, что подтвердило это само (`content_paid_types`): фильтр площадки
        может однажды промолчать, а комната не должна увидеть платное вместо пустой полки.

        Курсор — по количеству, что пришло от площадки, а не по тому, что после отбора: узкая
        полка после отбора не должна выглядеть площадке концом ленты, которой не было.
        """
        asked = {**params, "paid_type": "AVOD", "from": str(offset), "to": str(offset + size - 1)}
        key, ttl = memo
        data = await self.memo.get(f"{key}:{offset}", lambda: self._get(ctx, url, asked), ttl)
        found = data.get("result")
        found = [item for item in found if isinstance(item, dict)] if isinstance(found, list) else []
        kept = [item for item in found if self._shown(item)]
        if season is not None:
            # Свой отбор поверх фильтра площадки: сезон у площадки в её `season=`, а здесь ещё раз
            # по собственному полю серии — на случай, если фильтр площадки не сработает как надо.
            kept = [item for item in kept if str(item.get("season")) == season]
        following = str(offset + size) if len(found) >= size else None
        if following is not None and int(following) > MAX_OFFSET:
            following = None
        return kept, following

    async def _videoinfo(self, ctx: Ctx, item_id: str) -> dict[str, Any]:
        data = await self._get(ctx, VIDEO_INFO, {"id": item_id, "fields": SINGLE_FIELDS})
        result = data.get("result")
        if not isinstance(result, dict):
            raise HTTPException(404, NO_VIDEO)
        return result

    async def _compilationinfo(self, ctx: Ctx, series_id: str) -> dict[str, Any]:
        data = await self._get(ctx, COMPILATION_INFO, {"id": series_id, "fields": COMPILATION_FIELDS})
        result = data.get("result")
        if not isinstance(result, dict):
            raise HTTPException(404, NO_SERIES)
        return result

    async def _genres(self, ctx: Ctx) -> dict[int, str]:
        """Имя жанра по номеру — с `categories/v7` (у неё же и разделы, но их берёт `CATEGORY_TABS`).

        Раз в сутки: список жанров площадка меняет не чаще, чем список её разделов. Сбой —
        пустой словарь, а не сломанная лента: жанр на карточке необязателен, а лента — нет.
        """
        try:
            return await self.memo.get("genres", lambda: self._fetch_genres(ctx), 24 * 3600)
        except HTTPException:
            return {}

    async def _fetch_genres(self, ctx: Ctx) -> dict[int, str]:
        data = await self._get(ctx, CATEGORIES, {})
        found: dict[int, str] = {}
        for category in data.get("result") or []:
            if not isinstance(category, dict):
                continue
            for genre in category.get("genres") or []:
                if isinstance(genre, dict) and isinstance(genre.get("id"), int) and genre.get("title"):
                    found[genre["id"]] = genre["title"]
        return found

    # --- что из этого получается ------------------------------------------------------------

    @staticmethod
    def _shown(item: dict[str, Any]) -> bool:
        """Можно ли это показать комнате: бесплатное (AVOD) — и никак иначе."""
        return "AVOD" in (item.get("content_paid_types") or [])

    def _allow(self, info: dict[str, Any]) -> None:
        if not self._shown(info):
            raise HTTPException(403, PAID)

    def _poster(self, item: dict[str, Any], names: dict[int, str]) -> wire.Card | None:
        """
        Фильм, мультфильм или сериал — постером 2:3, как афиша в кинотеатре: у ivi это витрина
        целиком, а не отдельная полка (в отличие от Rutube, где так выглядит только «Сериалы и
        шоу»). Вид решает `object_type`: `compilation` — это сериал (дверь на его страницу),
        всё прочее — ролик, который смотрится сразу.
        """
        identity = item.get("id")
        if not isinstance(identity, int) or not self.content_id.fullmatch(str(identity)):
            return None
        kind = "series" if item.get("object_type") == "compilation" else "video"
        extra: dict[str, Any] = {}
        rating = _rating(item)
        if rating:
            extra["badge"] = rating
        line = _meta_line(item, names, rating=False)
        if line:
            extra["category"] = line
        return wire.card(
            self.id,
            kind,
            str(identity),
            item.get("title") or "Видео ivi",
            # Общая длительность подборки (у долгого сериала — сутки) на афише вводит в заблуждение,
            # поэтому у сериала её нет: секунды нужны только там, где обещают ролик, а не витрину.
            duration=_duration(item) if kind == "video" else None,
            poster=self.image(_poster_url(item.get("posters"))),
            shape="tall",
            **extra,
        )

    def _episode(self, item: dict[str, Any], series_id: str) -> wire.Card | None:
        identity = item.get("id")
        if not isinstance(identity, int) or not self.content_id.fullmatch(str(identity)):
            return None
        extra: dict[str, Any] = {"series": series_id}
        number = item.get("episode")
        if isinstance(number, int) and number > 0:
            extra["badge"] = f"{number} серия"
        return wire.card(
            self.id,
            "video",
            str(identity),
            item.get("title") or "Серия",
            duration=_duration(item),
            poster=self.image(_poster_url(item.get("posters"))),
            **extra,
        )
