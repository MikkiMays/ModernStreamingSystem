"""
ivi: только бесплатное — фильмы, сериалы и мультфильмы каталогом площадки, поток — её плеерным API.

ОТКУДА ЧТО. Каталог — открытый мобильный JSON площадки (`api.ivi.ru/mobileapi`), без ключей и
входа: три раздела-вкладки (`category=14` Фильмы, `15` Сериалы, `17` Мультфильмы), поиск по всем
разом, сериал — шапка и сезоны (`compilationinfo`) и серии открытого сезона (`videofromcompilation`),
подробности одной карточки — `videoinfo` (он же для ролика, он же для серии сериала). Названия
жанров площадка отдаёт отдельным списком (`categories`) — номерами в карточке иначе не сказать
ничего человеку.

ПОТОК — ТЕМ ЖЕ ВОПРОСОМ, ЧТО У yt-dlp, НО САМИ (R172). Файлы ролика отдаёт плеерное API площадки
(`api.ivi.ru/light/`, `da.content.get` с подписью CMAC — ровно тот вопрос, который задаёт экстрактор
`ivi` у yt-dlp, и его же ключом). Раньше его задавал yt-dlp в пуле потоков, и это стоило трёх бед:
поток пула не прервать — зависший разбор ivi держал место, пока ждали YouTube, VK и музыка; отказ
площадки yt-dlp прятал за повтором старым способом (`site=s183`), который сейчас отвечает только «не
смогли определить версию», — любой отказ звучал одинаково; и он же качал страницу ролика (650 КБ) ради
названия серии, которое у нас уже есть из каталога. Теперь вопрос асинхронный, под сроком фасада и
отменяется вместе с ним; отказ площадки — её причиной (`ORIGINS`), подробности — в журнал службы.

ЧТО НЕ ПОКАЗЫВАЕТСЯ. Владелец решил: в кинозале — только то, что ivi отдаёт бесплатно, с рекламой
(AVOD); платное — по подписке, разово или в аренду — не показывается никогда. Отбор двойной: своей
строкой у площадки (`paid_type=AVOD` в каждом запросе каталога) и ещё раз здесь, по присланному
`content_paid_types`, — если фильтр площадки когда-нибудь промолчит, служба не должна повторить его
ошибку. Ролик, который площадка отдаёт только под DRM (`drm_only`), тоже не показывается: у файлов
под защитой (`-MDRM-`, `-FPS-`) ключ выдаётся плееру площадки, а не нам. Показ работает только из
России (`geocheck/whoami` это подтверждает): с сервера в другой стране каждый вопрос к ivi получает
отказ сразу (`CINEMA_REGION` со страной сервера), а не пустую витрину, которая выглядела бы поломкой.

ЧЕГО ЗДЕСЬ НЕТ. Хост файлов ivi с сервера в Германии не увидеть: бесплатное отсюда не открывается
вовсе. Файл с хоста вне политики (`hosts`) не подписывается, и в журнал идёт имя этого хоста — одна
строка, по которой политику дополняют.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any
from urllib.parse import urlsplit

import httpx
from fastapi import HTTPException

from ...webapp import Refusal
from .. import address, drm, wire
from ..paging import MAX_OFFSET, PAGE
from ..registry import CATALOG_TIMEOUT, Ctx, Features, HostPolicy, Match, Provider
from ..resolve import SourcePlan, direct
from ..transport.signer import allowed

logger = logging.getLogger(__name__)

API = "https://api.ivi.ru/mobileapi/"
APP_VERSION = "870"

WHOAMI = API + "geocheck/whoami/v6/"
CATEGORIES = API + "categories/v7/"
CATALOGUE = API + "catalogue/v7/"
SEARCH = API + "search/v7/"
COMPILATION_INFO = API + "compilationinfo/v7/"
VIDEO_FROM_COMPILATION = API + "videofromcompilation/v7/"
VIDEO_INFO = API + "videoinfo/v7/"
# Плеерное API площадки: время для подписи и сам ответ плеера (файлы ролика).
LIGHT = "https://api.ivi.ru/light/"
# Какой «сайт» называет себя плеер: тот же, что у yt-dlp, — единственный, у которого ответ подписан.
SITE = "s353"

# Сколько ждать проверку страны: список площадок не должен зависеть от одной медленной — общий
# срок `Cinema.AVAILABILITY_TIMEOUT` — 3 с, здесь с запасом меньше.
WHOAMI_TIMEOUT = 2.5
# Как долго верить ответу о стране: гео не меняется каждую минуту, а спрашивать его у площадки
# на каждое открытие кинозала незачем.
AVAILABILITY_TTL = 3600
# Сколько площадка кладёт в одну порцию сериала — как у Rutube: сезон полсотни серий длиннее, чем
# долистывают за раз.
EPISODES_PAGE = 20
# Сколько порций сериала служба смотрит, ища «следующую серию» (T17), — двести серий на весь поиск.
NEXT_PORTIONS = 10

# Поля карточки каталога и поиска: номер, вид, год, длительность (секунды), жанры (номерами —
# имена отдельным списком, `_genre_names`), постеры, рейтинг и платность — ради неё карточка и
# спрашивается. Без «лишнего» площадка отвечает и весит меньше, и фикстуры короче.
#
# ГОД — ДВУМЯ ПОЛЯМИ. У ролика (`object_type: video`, будь то фильм или серия) год один и лежит в
# `year` (число); у подборки (`object_type: compilation`) — годами показа, `years` (список, у
# долгого сериала — начало и который идёт сейчас). Каталог и поиск отдают вперемешку то и другое —
# оба поля здесь и разбирает `_year`; у одной записи бывает только одно из них (проверено
# 25.09.2026: `Иван Васильевич меняет профессию` — `year:1973`, без `years` вовсе).
#
# `drm_only` — площадка отдаёт ролик только под DRM: такую карточку комнате не показать, и витрина её не
# показывает (R172).
TILE_FIELDS = (
    "id,title,object_type,year,years,duration,genres,posters,ivi_rating_10,content_paid_types,drm_only"
)
# Серия сезона: своей длительности у неё нет — она в `localizations[0].duration`; постер — с
# пометкой «это постер сериала», но плитке всё равно, чей он.
EPISODE_FIELDS = (
    "id,title,object_type,episode,season,posters,localizations,genres,ivi_rating_10,content_paid_types,"
    "drm_only"
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
    "description,compilation,episode,season,localizations,ivi_release_date,drm_only"
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

NOT_RU = "ivi показывает фильмы только на серверах в России"
SILENT = "ivi не ответил на запрос каталога"
NO_VIDEO = "Такого видео на ivi нет"
NO_SERIES = "Такого сериала на ivi нет"
NO_SEASON = "Такого сезона у сериала нет"
NO_CATEGORY = "Такого раздела на ivi нет"

# Файлы под защитой: `-MDRM-` и `-FPS-` — как их отбрасывает yt-dlp; остальное — на случай новых имён.
PROTECTED_FORMAT = re.compile(r"-MDRM-|-FPS-|DRM|WIDEVINE|PLAYREADY|FAIRPLAY", re.IGNORECASE)
# Порядок качества готовых файлов, худший первым (`IviIE._KNOWN_FORMATS` без FLV — его браузер не играет).
MP4_QUALITY = ("MP4-low-mobile", "MP4-mobile", "MP4-lo", "MP4-hi", "MP4-SHQ", "MP4-HD720", "MP4-HD1080")
# Сколько файлов проверить живыми (`drm.answers`), прежде чем отказать: как у общего разбора.
FILE_CHECKS = 3


def _light_key() -> bytes | None:
    """
    Ключ подписи плеерного API — тот же, которым подписывает экстрактор `ivi` у yt-dlp: свой мы не
    заводим и не прячем, он едет с yt-dlp и обновляется вместе с ним. Нет экстрактора — нет и ключа.
    """
    try:
        from yt_dlp.extractor.ivi import IviIE  # тяжёлый модуль — только когда правда нужен
    except Exception:
        return None
    key = getattr(IviIE, "_LIGHT_KEY", None)
    return key if isinstance(key, bytes) and key else None


def _sign(key: bytes, timestamp: str, body: bytes) -> str:
    from Cryptodome.Cipher import Blowfish
    from Cryptodome.Hash import CMAC

    return CMAC.new(key, timestamp.encode() + body, ciphermod=Blowfish).hexdigest()


def protected(content_format: str) -> bool:
    """Файл под DRM: ключ к нему получает только плеер площадки."""
    return bool(PROTECTED_FORMAT.search(content_format))


def _mp4_rank(content_format: str) -> int:
    """Чем лучше файл, тем больше; незнакомое имя `MP4-…` — ниже знакомых, но выше ничего."""
    return MP4_QUALITY.index(content_format) + 1 if content_format in MP4_QUALITY else 0


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
    # Всё под `ivi.ru` (картинки и раскадровки — `thumbs.dfs.ivi.ru`, `storyboard.dfs.ivi.ru`, проверено
    # 25.09.2026 настоящими ответами каталога) и `ivi.tv` — так площадка зовёт себя не из России. Хост
    # файлов с этого сервера не увидеть: бесплатное отсюда не отдаётся вовсе (см. `availability`). Файл с
    # другого хоста не подписывается, а его имя уходит в журнал (`_files`) — по нему сюда добавляют строку.
    hosts = HostPolicy(("ivi.ru", "ivi.tv"))
    # Файлы площадки отдаёт её CDN, и узел бывает переадресацией: прокси проходит её сам, каждым шагом
    # по политике хостов (`Cinema._send`), — как и проверка файла (`drm.answers`).
    follows_redirects = True
    # Список HLS с ключом DRM прокси не отдаёт (`drm.hls`): у ivi защиту видно и в имени формата, но
    # вторая проверка ничего не стоит.
    refuses_drm = True
    # Хост каталога и проверки страны (`api.ivi.ru`): на пустой GET — короткий отказ, его пробе хватает.
    probe = "https://api.ivi.ru/"
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
        # Страна сервера — рядом с ответом и на тот же срок: клиент назовёт её человеку на его языке.
        self.memo.put("country", country.upper()[:2], AVAILABILITY_TTL)
        return (True, None) if country == "RU" else (False, NOT_RU)

    def known_availability(self) -> tuple[bool, str | None] | None:
        """Что площадка уже знает о себе, не спрашивая сеть (`Provider.known_availability`)."""
        return self.memo.peek("availability")

    def unavailable_extra(self) -> dict[str, Any]:
        """Страна сервера рядом с отказом: «ivi — только в России, а этот сервер — в Германии»."""
        country = self.memo.peek("country")
        return {"code": "CINEMA_REGION", **({"country": country} if country else {})}

    async def gate(self, net: httpx.AsyncClient) -> None:
        """
        Отказ сразу, если сервер не в России (R172): вопросы каталога и потока к площадке отсюда
        бессмысленны — бесплатное она не отдаёт ни строкой, а пустая витрина и «не удалось открыть» на
        каждом фильме выглядели поломкой. Не знаем страну (площадка молчит) — пропускаем: тогда ответит
        сама площадка или её автомат (`reach.py`).
        """
        try:
            available, _ = await self.availability(net)
        except Exception:
            return
        if not available:
            raise Refusal(
                403,
                "CINEMA_REGION",
                "ivi показывает фильмы только на серверах в России",
                extra={"provider": self.id, **self.unavailable_extra()},
            )

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
        extra: dict[str, Any] = (
            {"series": str(compilation["id"])}
            if isinstance(compilation, dict) and isinstance(compilation.get("id"), int)
            else {}
        )
        if extra:
            following = await self._following(ctx, extra["series"], item_id, info)
            if following is not None:
                extra["next"] = following
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

    async def _following(
        self, ctx: Ctx, series_id: str, item_id: str, info: dict[str, Any]
    ) -> wire.Card | None:
        """
        Следующая серия — для «Следующая серия» в плеере (T17): следующая бесплатная в сезоне этой
        серии, а после последней — первая бесплатная из следующих сезонов. Запросы и ключи памяти — те
        же, что у страницы сериала (`compilationinfo`, порции `videofromcompilation` по двадцать), и
        платное сюда не попадает тем же двойным отбором. Неудача у площадки — просто нет кнопки.
        """
        try:
            show = await self.memo.get(
                f"compilation:{series_id}", lambda: self._compilationinfo(ctx, series_id), 600
            )
            numbers = [
                str(entry["number"])
                for entry in show.get("seasons") or []
                if isinstance(entry, dict) and isinstance(entry.get("number"), int)
            ]
            line: list[str | None] = [None]
            if numbers:
                own = str(info["season"]) if isinstance(info.get("season"), int) else None
                if own not in numbers:
                    return None
                line = numbers[numbers.index(own) :]
            budget = NEXT_PORTIONS
            seen = False
            for season in line:
                offset: str | None = "0"
                while offset is not None and budget > 0:
                    budget -= 1
                    params: dict[str, str] = {"id": series_id, "fields": EPISODE_FIELDS}
                    if season is not None:
                        params["season"] = season
                    raw, offset = await self._raw_page(
                        ctx, VIDEO_FROM_COMPILATION, params, EPISODES_PAGE, int(offset),
                        memo=(f"episodes:{series_id}:{season}", 300), season=season,
                    )
                    for item in raw:
                        if not seen:
                            seen = str(item.get("id")) == item_id
                            continue
                        card = self._episode(item, series_id)
                        if card is not None:
                            return card
                if not seen:
                    # Своей серии в своём сезоне не нашлось — гадать, какая «следующая», незачем.
                    return None
        except HTTPException:
            return None
        return None

    # --- поток --------------------------------------------------------------------------

    async def source(self, ctx: Ctx, kind: str, item_id: str, options: dict[str, Any]) -> SourcePlan:
        """
        Поток: своя проверка (`videoinfo`: только AVOD и не «только под DRM») — отказ сразу и словами,
        затем ответ плеера площадки (`_played`) и из его файлов — первый живой без защиты (`_stream`).
        Список HLS без защиты, если площадка его дала, лучше файла: в нём лестница качества.
        """
        info = await self._videoinfo(ctx, item_id)
        self._allow(info)
        played = await self._played(ctx, item_id)
        url, stream = await self._stream(ctx, item_id, played.get("files"))
        return direct(
            stream,
            url,
            title=info.get("title") or played.get("title") or "",
            duration=_duration(info),
            poster=_poster_url(info.get("posters")) or None,
        )

    async def _played(self, ctx: Ctx, item_id: str) -> dict[str, Any]:
        """
        Ответ плеера площадки (`da.content.get`) — тот же вопрос с той же подписью, что задаёт yt-dlp
        (`yt_dlp/extractor/ivi.py`): время площадки, подпись CMAC/Blowfish ключом экстрактора над
        временем и телом, сам вопрос. Отказ площадки — её причиной (`_refused`).
        """
        key = _light_key()
        if key is None:
            raise self._failed(item_id, "у yt-dlp нет экстрактора ivi с ключом подписи")
        stamp = await self._light(ctx, item_id, {"method": "da.timestamp.get", "params": []})
        timestamp = stamp.get("result")
        if not isinstance(timestamp, str) or not timestamp:
            raise self._failed(item_id, "площадка не дала время для подписи")
        asked = {
            "method": "da.content.get",
            "params": [
                item_id,
                {"site": SITE, "referrer": f"http://www.ivi.ru/watch/{item_id}", "contentid": item_id},
            ],
        }
        body = json.dumps(asked).encode()
        answer = await self._light(
            ctx, item_id, body, params={"ts": timestamp, "sign": _sign(key, timestamp, body)}
        )
        error = answer.get("error")
        if isinstance(error, dict):
            raise self._refused(item_id, error)
        result = answer.get("result")
        if not isinstance(result, dict):
            raise self._failed(item_id, "в ответе плеера нет result")
        return result

    async def _light(
        self, ctx: Ctx, item_id: str, payload: dict[str, Any] | bytes, params: dict[str, str] | None = None
    ) -> dict[str, Any]:
        """Один вопрос плеерному API. Сеть и мусор — общий отказ; исходная ошибка остаётся в цепочке:
        по ней автомат площадки (`reach.network`) отличает сбой сети от отказа словами."""
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        try:
            response = await ctx.net.post(LIGHT, content=body, params=params, timeout=CATALOG_TIMEOUT)
            data = response.json()
        except (httpx.HTTPError, ValueError) as error:
            raise self._failed(item_id, f"плеерное API: {type(error).__name__}") from error
        if response.status_code != 200 or not isinstance(data, dict):
            raise self._failed(item_id, f"плеерное API ответило {response.status_code}")
        return data

    def _refused(self, item_id: str, error: dict[str, Any]) -> Refusal:
        """Отказ плеера площадки (`error.origin`) — человеку её причиной, журналу — целиком."""
        origin = str(error.get("origin") or "")
        extra = {"provider": self.id}
        if origin == "NotAllowedForLocation":
            return Refusal(403, "CINEMA_GEO", "ivi не показывает это видео в стране сервера", extra=extra)
        if origin == "ContentNotPaid":
            return Refusal(
                403, "CINEMA_PAID", "Это платное видео ivi — показать его комнате нельзя", extra=extra
            )
        if origin == "ContentYetUnavailable":
            return Refusal(403, "CINEMA_NOT_YET", "Это видео на ivi ещё не вышло", extra=extra)
        if origin == "NoRedisValidData":
            return Refusal(404, "CINEMA_NO_VIDEO", "Такого видео на ivi нет", extra=extra)
        code = error.get("code")
        message = str(error.get("message") or "")[:200]
        return self._failed(item_id, f"плеер площадки отказал: {origin or '?'} {code} {message}")

    def _failed(self, item_id: str, why: str) -> Refusal:
        """Поток не открылся по причине, которую человеку не объяснить: ему — коротко, журналу — `why`."""
        logger.warning("кинозал: ivi %s: %s", item_id, why)
        return Refusal(
            502,
            "CINEMA_STREAM_FAILED",
            "ivi не отдал это видео — попробуйте позже или другое",
            extra={"provider": self.id},
        )

    async def _stream(self, ctx: Ctx, item_id: str, files: Any) -> tuple[str, str]:
        """
        Что играть: список HLS без защиты — если площадка его дала и он читается без ключа DRM, — иначе
        лучший готовый MP4, который площадка действительно отдаёт (`drm.answers`, переадресация — шагами
        по политике хостов). Файл под защитой, вид, которого браузер не играет (FLV), и хост вне политики
        не берутся; что было и почему не взято — в журнал одной строкой, без адресов файлов.
        """
        lists: list[str] = []
        mp4: list[tuple[int, str]] = []
        names: list[str] = []
        closed = 0
        strangers: set[str] = set()
        for entry in files if isinstance(files, list) else []:
            if not isinstance(entry, dict) or not isinstance(entry.get("url"), str):
                continue
            name = str(entry.get("content_format") or "?")[:40]
            names.append(name)
            if protected(name):
                closed += 1
                continue
            parts = urlsplit(entry["url"])
            # Площадкам каталога прокси открывает только https: файл, названный по http, спрашиваем
            # по https — CDN площадки отдаёт его и так.
            url = entry["url"] if parts.scheme == "https" else parts._replace(scheme="https").geturl()
            host = (parts.hostname or "").lower()
            if parts.scheme not in ("https", "http") or not host:
                continue
            if not allowed(url, self.hosts):
                strangers.add(host)
                continue
            path = parts.path.lower()
            if "HLS" in name.upper() or path.endswith(".m3u8"):
                lists.append(url)
            elif name.upper().startswith("MP4") or path.endswith(".mp4"):
                mp4.append((_mp4_rank(name), url))
        mp4.sort(key=lambda pair: pair[0], reverse=True)

        def allows(target: str) -> bool:
            return allowed(target, self.hosts)

        for url in lists[:1]:
            try:
                live = await drm.inspect_hls(ctx.net, url, allows, locked=True)
            except (HTTPException, drm.Locked):
                continue
            if live is False:
                return url, "hls"
        for _, url in mp4[:FILE_CHECKS]:
            if await drm.answers(ctx.net, url, allows, media_only=True):
                return url, "file"
        listed = ", ".join(names) or "нет"
        if strangers:
            hosts = ", ".join(sorted(strangers))
            logger.warning("кинозал: ivi %s: файлы на хостах вне политики площадки: %s", item_id, hosts)
        if closed and not lists and not mp4 and not strangers:
            logger.warning("кинозал: ivi %s: только под защитой (форматы: %s)", item_id, listed)
            raise Refusal(
                403,
                "CINEMA_PROTECTED",
                "ivi отдаёт это видео только под защитой — показать его комнате нельзя",
                extra={"provider": self.id},
            )
        raise self._failed(item_id, f"ни один файл не открылся (форматы: {listed})"[:400])

    # --- что площадка отвечает ------------------------------------------------------------

    async def _get(self, ctx: Ctx, url: str, params: dict[str, str]) -> dict[str, Any]:
        """
        JSON площадки как есть. Сеть, молчание и мусор вместо JSON — общий отказ (502); у ivi
        `{"error": {...}}` приходит с кодом 200 (пустой ответ, платное, чужая версия — разные
        поводы под одним же кодом), и что это значит здесь, решает каждый вызывающий сам.
        """
        try:
            response = await ctx.net.get(
                url, params={**params, "app_version": APP_VERSION}, timeout=CATALOG_TIMEOUT
            )
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
        """
        Можно ли это показать комнате: бесплатное (AVOD) — и не «только под DRM» (`drm_only`). Пометка
        DRM у сериала целиком (`compilation`) серии не прячет: у них она своя, и отбор — по ним.
        """
        if "AVOD" not in (item.get("content_paid_types") or []):
            return False
        return not (item.get("drm_only") is True and item.get("object_type") != "compilation")

    def _allow(self, info: dict[str, Any]) -> None:
        extra = {"provider": self.id}
        if "AVOD" not in (info.get("content_paid_types") or []):
            raise Refusal(
                403, "CINEMA_PAID", "Это платное видео ivi — показать его комнате нельзя", extra=extra
            )
        if not self._shown(info):
            raise Refusal(
                403,
                "CINEMA_PROTECTED",
                "ivi отдаёт это видео только под защитой — показать его комнате нельзя",
                extra=extra,
            )

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
