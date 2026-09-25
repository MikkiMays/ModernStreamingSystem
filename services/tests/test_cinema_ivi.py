"""
ivi в кинозале: что служба отдаёт по настоящим ответам площадки.

ОТКУДА ОТВЕТЫ. `fixtures/ivi/` — ответы `api.ivi.ru`, снятые запросами с сервера 25.09.2026
(площадка отвечает по полям, которые просит служба, — `fields=`), длинные описания обрезаны и
статистика плеера (качества, раскадровки) из `localizations` убрана: код читает там только
`duration`. Бесплатного (AVOD) отсюда не видно вовсе — сервер в Германии, а ivi отдаёт бесплатное
только в России (см. `research.md`), — поэтому снятое сплошь платное (`SVOD`). Случай, которого в
снятом нет (бесплатная карточка, Россия в `geocheck/whoami`), тесты берут из настоящей записи и
меняют в ней ровно одно поле — прямо в тесте, на виду, как и у Rutube с VK.

ГДЕ ПОДМЕНА. Каталог, поиск, сериалы и подробности идут через `ctx.net` — сеть подменена
транспортом httpx, который знает только адреса `api.ivi.ru`. Проверка страны (`availability`) у
`ctx` не берёт вовсе — её сравнивают с тем, что видит сама служба при открытии кинозала, — и сеть
у неё своя, `httpx.AsyncClient` подменяется отдельно. Часы стоят там, где это важно для кэша.
"""

from __future__ import annotations

import copy
import json
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch
from urllib.parse import parse_qs, urlsplit

import httpx
from fastapi import HTTPException
from fastapi.testclient import TestClient
from yt_dlp.utils import ExtractorError, GeoRestrictedError

from cord_services.app import create_app
from cord_services.cinema import Cinema, Resolve, Signer
from cord_services.cinema.memo import Memo
from cord_services.cinema.providers import PROVIDERS
from cord_services.cinema.providers.ivi import NOT_RU, Ivi
from cord_services.cinema.registry import Ctx, Features, Kit, Match
from cord_services.cinema.resolve import PROBE, YtDlp
from cord_services.cinema.transport.signer import proxied
from cord_services.core import Core

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "ivi"
NOW = 1_790_320_000.0
SECRET = "secret"
DAY = 24 * 3600
ROOM = str(uuid.uuid4())

TILE_FIELDS = "id,title,object_type,year,years,duration,genres,posters,ivi_rating_10,content_paid_types"
EPISODE_FIELDS = (
    "id,title,object_type,episode,season,posters,localizations,genres,ivi_rating_10,content_paid_types"
)
COMPILATION_FIELDS = (
    "id,title,object_type,years,duration,genres,posters,ivi_rating_10,content_paid_types,"
    "description,seasons"
)
SINGLE_FIELDS = (
    "id,title,object_type,year,years,duration,genres,posters,ivi_rating_10,content_paid_types,"
    "description,compilation,episode,season,localizations,ivi_release_date"
)


def recorded(name: str):
    """Снятый ответ площадки; каждый раз — свежая копия, чтобы тест мог её подправить не боясь."""
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def avod(item: dict, **extra) -> dict:
    """Та же запись, но бесплатная: платность меняется одним полем, остальное — по надобности теста."""
    changed = copy.deepcopy(item)
    changed["content_paid_types"] = ["AVOD"]
    changed.update(extra)
    return changed


def image(url: str) -> str:
    return proxied(Signer(SECRET), url, "image", DAY, provider="ivi")


def address(url: str) -> str:
    """Адрес запроса без порядка параметров: путь и отсортированные пары."""
    parts = urlsplit(url)
    pairs = sorted((key, value) for key, values in parse_qs(parts.query).items() for value in values)
    return parts.path + ("?" + "&".join(f"{key}={value}" for key, value in pairs) if pairs else "")


class Stage(unittest.IsolatedAsyncioTestCase):
    """Остановленные часы и сеть, которая знает только адреса `api.ivi.ru`, ответы на которые ей дали."""

    def setUp(self):
        clock = patch("time.time", return_value=NOW)
        clock.start()
        self.addCleanup(clock.stop)
        self.pages: dict[str, tuple[int, object]] = {}
        self.seen: list[httpx.Request] = []
        self.cinema = Cinema(SECRET, httpx.AsyncClient(transport=httpx.MockTransport(self.serve)))

    async def asyncTearDown(self):
        await self.cinema.close()

    def answer(self, path: str, body, status: int = 200, **params):
        # `app_version` — на каждом запросе площадки (`Ivi._get` добавляет его сама, что бы ни
        # передал вызывающий): по умолчанию и здесь, чтобы не забывать его в каждой регистрации.
        full = "https://api.ivi.ru" + path + "?" + "&".join(
            f"{k}={v}" for k, v in {"app_version": "870", **params}.items()
        )
        self.pages[address(full)] = (status, body)

    def serve(self, request: httpx.Request) -> httpx.Response:
        self.seen.append(request)
        assert request.url.host == "api.ivi.ru", f"Неожиданный запрос наружу: {request.url}"
        key = address(str(request.url))
        if key not in self.pages:
            raise AssertionError("Площадку спросили о неожиданном: " + key)
        status, body = self.pages[key]
        return httpx.Response(status, json=body)

    def asked(self) -> list[str]:
        return [address(str(request.url)) for request in self.seen]

    def ctx(self) -> Ctx:
        return Ctx(room=ROOM, net=self.cinema.net.client_for("ivi"))

    async def refused(self, action, status, detail):
        with self.assertRaises(HTTPException) as refusal:
            await action
        self.assertEqual((refusal.exception.status_code, refusal.exception.detail), (status, detail))


def poster_card(item: dict, **extra) -> dict:
    """Карточка каталога так, как её строит `Ivi._poster`: постер 2:3, рейтинг бейджем, жанр+год чипом."""
    kind = "series" if item.get("object_type") == "compilation" else "video"
    card = {
        "provider": "ivi",
        "kind": kind,
        "id": str(item["id"]),
        "title": item["title"],
        "author": "",
        "channelId": None,
        "duration": (item.get("duration") if kind == "video" else None) or None,
        "live": False,
        "viewers": None,
        "views": None,
        "shape": "tall",
    }
    card.update(extra)
    card["poster"] = image(item["posters"][0]["url"])
    return card


class PlatformTests(unittest.TestCase):
    def test_ivi_is_the_fifth_platform_and_says_what_it_has(self):
        # ivi встаёт после VK Видео и перед общим путём «По ссылке» — он должен остаться последним.
        self.assertEqual(
            [kind.id for kind in PROVIDERS], ["youtube", "twitch", "rutube", "vk", "ivi", "link"]
        )
        self.assertEqual(Ivi.name, "ivi")
        self.assertEqual(Ivi.features, Features(search=True, categories=True, series=True))

    def test_its_addresses_are_plain_numbers(self):
        self.assertTrue(Ivi.content_id.fullmatch("53141"))
        self.assertTrue(Ivi.content_id.fullmatch("1"))
        for wrong in ("0x1", "53141a", "", "1234567890123", "-1"):
            self.assertIsNone(Ivi.content_id.fullmatch(wrong), wrong)

    def test_its_hosts_are_the_site_and_its_picture_storage(self):
        for host in ("ivi.ru", "www.ivi.ru", "thumbs.dfs.ivi.ru", "storyboard.dfs.ivi.ru", "dfs.ivi.ru"):
            self.assertTrue(Ivi.hosts.allows(host), host)
        for host in ("ivi.tv", "evil-ivi.ru", "ivi.ru.evil.com", "googlevideo.com"):
            self.assertFalse(Ivi.hosts.allows(host), host)

    def test_what_it_does_not_have_is_refused_in_its_own_words(self):
        found = Ivi(Kit(memo=Memo(), image=lambda url: None, ytdlp=YtDlp()))
        for feature, detail in (
            ("channels", "У ivi каналов нет"),
            ("playlists", "У ivi плейлистов нет"),
            ("live", "У ivi прямых эфиров нет"),
        ):
            self.assertEqual(found.refuse(feature).detail, detail)


class LinkTests(unittest.TestCase):
    def setUp(self):
        self.ivi = Ivi(Kit(memo=Memo(), image=lambda url: None, ytdlp=YtDlp()))

    def test_watch_links_open_the_numeric_id_slug_or_not(self):
        self.assertEqual(self.ivi.match("https://www.ivi.ru/watch/53141"), Match("video", "53141", "item"))
        self.assertEqual(
            self.ivi.match("https://ivi.tv/watch/dvoe_iz_lartsa/9549"), Match("video", "9549", "item")
        )
        self.assertEqual(
            self.ivi.match("https://www.ivi.ru/video/player?videoId=53141"), Match("video", "53141", "item")
        )
        # Подборка одним слугом (без числа) — у неё нет номера, по которому спрашивает наш
        # `compilationinfo`, и угадывать его лишним запросом кинозал не должен.
        for bad in (
            "https://www.ivi.ru/watch/dvoe_iz_lartsa",
            "https://www.ivi.ru/watch/dvoe_iz_lartsa/season1",
            "https://www.ivi.ru/watch/",
            "https://vk.com/video-1_1",
            "https://www.ivi.ru/video/player?videoId=abc",
        ):
            self.assertIsNone(self.ivi.match(bad), bad)


class AvailabilityTests(unittest.IsolatedAsyncioTestCase):
    """
    `availability(net)` спрашивает клиентом самой площадки (I5): её выходом наружу, а не мимо него. Тесты
    подменяют этот клиент — тем же способом, что и `ctx.net` в остальных тестах ivi (MockTransport).
    """

    @staticmethod
    def ivi():
        return Ivi(Kit(memo=Memo(), image=lambda url: None, ytdlp=YtDlp()))

    def client(self, handler):
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        self.addAsyncCleanup(client.aclose)
        return client

    def whoami(self, body):
        seen = []

        def handler(request):
            seen.append(request)
            assert request.url.host == "api.ivi.ru", request.url
            return httpx.Response(200, json=body)

        client = self.client(handler)
        return client, seen

    async def test_russia_is_available_elsewhere_is_not_with_the_platforms_own_reason(self):
        client, seen = self.whoami(recorded("whoami-de.json"))
        self.assertEqual(await self.ivi().availability(client), (False, NOT_RU))
        # Спросили тем клиентом, что дали, и именно geocheck/whoami.
        self.assertEqual(len(seen), 1)
        self.assertTrue(seen[0].url.path.endswith("/geocheck/whoami/v6/"))
        ru = recorded("whoami-de.json")
        ru["result"]["country_code"] = "RU"
        client, _ = self.whoami(ru)
        self.assertEqual(await self.ivi().availability(client), (True, None))

    async def test_it_asks_through_the_platforms_own_client_not_a_client_of_its_own(self):
        # I5: раньше проверка открывала свой `httpx.AsyncClient` мимо CINEMA_PROXY_IVI. Теперь — тот
        # клиент, что дал фасад; своего она не заводит вовсе.
        client, seen = self.whoami(recorded("whoami-de.json"))
        with patch("cord_services.cinema.providers.ivi.httpx.AsyncClient") as own:
            await self.ivi().availability(client)
        own.assert_not_called()
        self.assertEqual(len(seen), 1)

    async def test_the_answer_is_cached_for_an_hour_and_not_asked_again(self):
        client, seen = self.whoami(recorded("whoami-de.json"))
        ivi = self.ivi()
        await ivi.availability(client)
        await ivi.availability(client)
        self.assertEqual(len(seen), 1)

    async def test_a_network_failure_is_not_cached_and_becomes_the_facades_own_words(self):
        """`_whoami` поднимает исключение (ничего не подменяет мягкой заглушкой) — `Memo` не
        запоминает отказ, а `Cinema._availability` превращает его в общие слова, как у любой
        другой упавшей площадки (см. `test_availability_and_accounts_are_the_platform_own_words`
        в `test_cinema_registry.py`, где этот же путь проверен и на выдуманной площадке)."""

        def broken(request):
            raise httpx.ConnectError("no route")

        client = self.client(broken)
        ivi = self.ivi()
        with self.assertRaises(httpx.ConnectError):
            await ivi._whoami(client)
        # `availability()` идёт через ту же память: отказ наружу — тот же, и второй вопрос
        # снова бьётся в сеть, а не отвечает из кэша пустой заглушкой.
        with self.assertRaises(httpx.ConnectError):
            await ivi.availability(client)

        cinema = Cinema(SECRET, client)
        found = await cinema._availability(cinema.registry.get("ivi"))
        self.assertEqual(found, (False, "Не удалось проверить площадку"))
        await cinema.close()
        await cinema.close()


class CatalogTests(Stage):
    """Три вкладки известны заранее; каждый раздел — тот же `catalogue`, что видел исследователь."""

    async def test_the_three_tabs_are_known_without_asking_the_platform(self):
        found = await self.cinema.categories("ivi", room=ROOM)
        self.assertEqual(
            found,
            {
                "items": [
                    {
                        "provider": "ivi",
                        "kind": "category",
                        "id": "14",
                        "title": "Фильмы",
                        "viewers": None,
                        "poster": None,
                    },
                    {
                        "provider": "ivi",
                        "kind": "category",
                        "id": "15",
                        "title": "Сериалы",
                        "viewers": None,
                        "poster": None,
                    },
                    {
                        "provider": "ivi",
                        "kind": "category",
                        "id": "17",
                        "title": "Мультфильмы",
                        "viewers": None,
                        "poster": None,
                    },
                ],
                "next": None,
            },
        )
        self.assertEqual(self.asked(), [])

    async def test_an_unknown_tab_is_refused_by_number(self):
        await self.refused(self.cinema.category("ivi", "99", room=ROOM), 404, "Такого раздела на ivi нет")

    async def test_a_tab_shows_only_what_the_platform_marked_free_even_if_it_also_sent_paid(self):
        """`paid_type=AVOD` — своей строкой у площадки; поверх неё — свой же отбор по
        `content_paid_types`, на случай, если фильтр площадки промолчит. Проверено обоими путями
        разом: снятая страница сплошь платная (Германия), а бесплатные строки — та же запись с
        изменённым полем, «на виду»."""
        self.answer("/mobileapi/categories/v7/", recorded("categories.json"))
        movies = recorded("catalogue-movies.json")["result"]
        mixed = [avod(movies[0]), movies[1], avod(movies[2])]
        self.answer(
            "/mobileapi/catalogue/v7/",
            {"result": mixed},
            category="14",
            fields=TILE_FIELDS,
            paid_type="AVOD",
            **{"from": "0", "to": "29", "app_version": "870"},
        )
        found = await self.cinema.category("ivi", "14", room=ROOM)
        self.assertEqual(
            found["category"],
            {
                "provider": "ivi",
                "kind": "category",
                "id": "14",
                "title": "Фильмы",
                "viewers": None,
                "poster": None,
            },
        )
        self.assertEqual(len(found["items"]), 2)
        # Первая — сериал (Стеклянный дом, «Детективы · 2025», рейтинг бейджем).
        self.assertEqual(
            found["items"][0],
            poster_card(mixed[0], kind="series", category="Детективы · 2025", badge="★ 7.5"),
        )
        # Вторая — платную («Если он меня узнает») отбор убрал: её нет вовсе, следующая по счёту —
        # «Беглецы», третья запись страницы.
        self.assertEqual(found["items"][1]["id"], str(movies[2]["id"]))
        self.assertEqual(found["next"], None)

    async def test_paging_continues_while_the_platform_kept_sending_a_full_page(self):
        self.answer("/mobileapi/categories/v7/", {"result": []})
        full = [avod(recorded("catalogue-movies.json")["result"][2], id=900000 + i) for i in range(30)]
        self.answer(
            "/mobileapi/catalogue/v7/",
            {"result": full},
            category="15",
            fields=TILE_FIELDS,
            paid_type="AVOD",
            **{"from": "0", "to": "29", "app_version": "870"},
        )
        found = await self.cinema.category("ivi", "15", room=ROOM)
        self.assertEqual(found["next"], "30")
        self.assertEqual(len(found["items"]), 30)


class SearchTests(Stage):
    async def test_empty_query_is_the_tabs_not_a_feed(self):
        found = await self.cinema.search("ivi", "", room=ROOM)
        self.assertEqual(found, {"items": [], "next": None, "channels": [], "categories": []})
        self.assertEqual(self.asked(), [])

    async def test_a_search_keeps_only_what_is_free(self):
        self.answer("/mobileapi/categories/v7/", recorded("categories.json"))
        rows = recorded("search-ivan.json")["result"]
        mixed = [avod(rows[0]), rows[1]]
        self.answer(
            "/mobileapi/search/v7/",
            {"result": mixed},
            query="Иван",
            fields=TILE_FIELDS,
            paid_type="AVOD",
            **{"from": "0", "to": "29", "app_version": "870"},
        )
        found = await self.cinema.search("ivi", "Иван", room=ROOM)
        self.assertEqual(len(found["items"]), 1)
        self.assertEqual(found["items"][0]["id"], str(rows[0]["id"]))
        self.assertEqual(found["channels"], [])
        self.assertEqual(found["categories"], [])


class SeriesTests(Stage):
    def serve_show(self):
        self.answer(
            "/mobileapi/compilationinfo/v7/", recorded("compilationinfo-molodezhka.json"),
            id="17830", fields=COMPILATION_FIELDS,
        )

    async def test_the_first_real_season_opens_by_default_and_lists_its_free_episodes(self):
        self.serve_show()
        one = avod(recorded("videofromcompilation-molodezhka-s2.json")["result"][0], season=1)
        self.answer(
            "/mobileapi/videofromcompilation/v7/",
            {"result": [one]},
            id="17830", season="1", fields=EPISODE_FIELDS, paid_type="AVOD",
            **{"from": "0", "to": "19", "app_version": "870"},
        )
        found = await self.cinema.series("ivi", "17830", room=ROOM)
        self.assertEqual(found["season"], "1")
        self.assertEqual(found["series"]["title"], "Молодёжка. Новая смена")
        self.assertEqual(found["series"]["year"], 2024)
        self.assertEqual(
            found["series"]["seasons"], [{"id": "1", "title": "Сезон 1"}, {"id": "2", "title": "Сезон 2"}]
        )
        self.assertEqual(len(found["items"]), 1)
        self.assertEqual(found["items"][0]["series"], "17830")
        self.assertEqual(found["items"][0]["badge"], "1 серия")
        self.assertEqual(found["items"][0]["duration"], one["localizations"][0]["duration"])

    async def test_an_unknown_season_is_refused_and_a_paid_episode_never_becomes_a_card(self):
        self.serve_show()
        await self.refused(
            self.cinema.series("ivi", "17830", season="9", room=ROOM), 404, "Такого сезона у сериала нет"
        )
        episodes = recorded("videofromcompilation-molodezhka-s2.json")["result"]  # остаются платными
        self.answer(
            "/mobileapi/videofromcompilation/v7/",
            {"result": episodes},
            id="17830", season="2", fields=EPISODE_FIELDS, paid_type="AVOD",
            **{"from": "0", "to": "19", "app_version": "870"},
        )
        found = await self.cinema.series("ivi", "17830", season="2", room=ROOM)
        self.assertEqual(found["items"], [])

    async def test_a_stray_episode_from_the_wrong_season_is_dropped_defensively(self):
        """Свой отбор поверх `season=` площадки: если она вдруг пришлёт чужой сезон, карточка
        всё равно не появится."""
        self.serve_show()
        wrong = avod(recorded("videofromcompilation-molodezhka-s2.json")["result"][0], season=2)
        self.answer(
            "/mobileapi/videofromcompilation/v7/",
            {"result": [wrong]},
            id="17830", season="1", fields=EPISODE_FIELDS, paid_type="AVOD",
            **{"from": "0", "to": "19", "app_version": "870"},
        )
        found = await self.cinema.series("ivi", "17830", room=ROOM)
        self.assertEqual(found["items"], [])

    async def test_an_unknown_series_is_refused(self):
        self.answer(
            "/mobileapi/compilationinfo/v7/", {"error": {"message": "empty answer", "code": 301}},
            id="1", fields=COMPILATION_FIELDS,
        )
        await self.refused(self.cinema.series("ivi", "1", room=ROOM), 404, "Такого сериала на ivi нет")


class DetailsTests(Stage):
    def serve_genres(self):
        self.answer("/mobileapi/categories/v7/", recorded("categories.json"))

    async def test_a_free_movie_shows_genre_year_rating_and_release_date(self):
        self.serve_genres()
        info = avod(recorded("videoinfo-movie.json")["result"])
        self.answer("/mobileapi/videoinfo/v7/", {"result": info}, id="53141", fields=SINGLE_FIELDS)
        found = await self.cinema.details("ivi", "53141", "video", room=ROOM)
        self.assertEqual(found["title"], "Иван Васильевич меняет профессию")
        self.assertEqual(found["category"], "Комедии · 1973 · ★ 8.8")
        self.assertEqual(found["published"], "2011-10-01")
        self.assertNotIn("series", found)
        self.assertEqual(found["poster"], image(info["posters"][0]["url"]))

    async def test_an_episode_points_back_to_its_series(self):
        self.serve_genres()
        info = avod(recorded("videoinfo-episode.json")["result"])
        self.answer("/mobileapi/videoinfo/v7/", {"result": info}, id="567680", fields=SINGLE_FIELDS)
        found = await self.cinema.details("ivi", "567680", "video", room=ROOM)
        self.assertEqual(found["series"], "18701")
        self.assertEqual(found["duration"], info["localizations"][0]["duration"])

    async def test_a_paid_video_is_refused_before_anything_is_shown(self):
        self.serve_genres()
        info = recorded("videoinfo-movie.json")["result"]  # осталась платной
        self.answer("/mobileapi/videoinfo/v7/", {"result": info}, id="53141", fields=SINGLE_FIELDS)
        await self.refused(
            self.cinema.details("ivi", "53141", "video", room=ROOM),
            403,
            "Это платное видео ivi — показать его комнате нельзя",
        )

    async def test_a_missing_video_is_a_clean_404(self):
        self.answer(
            "/mobileapi/videoinfo/v7/", {"error": {"message": "empty answer", "code": 301}},
            id="1", fields=SINGLE_FIELDS,
        )
        await self.refused(
            self.cinema.details("ivi", "1", "video", room=ROOM), 404, "Такого видео на ivi нет"
        )


class SourceTests(Stage):
    def stage_video(self, item):
        self.answer("/mobileapi/videoinfo/v7/", {"result": item}, id=str(item["id"]), fields=SINGLE_FIELDS)

    async def test_a_paid_video_never_reaches_yt_dlp(self):
        self.stage_video(recorded("videoinfo-movie.json")["result"])
        with patch.object(YtDlp, "extract") as extract:
            await self.refused(
                self.cinema.registry.get("ivi").source(self.ctx(), "video", "53141", {}),
                403,
                "Это платное видео ivi — показать его комнате нельзя",
            )
        extract.assert_not_called()

    async def test_a_free_video_builds_a_plan_the_resolver_will_not_re_open(self):
        """Разбор идёт в `source()` самом: удачный вызов `Resolver` получает уже готовым (`info=`)
        и второй раз ту же страницу yt-dlp не открывает — проверено тем, что `extract` позвали
        ровно один раз, с адресом ролика и общими опциями (`PROBE`)."""
        info = avod(recorded("videoinfo-movie.json")["result"])
        self.stage_video(info)
        parsed = {"id": "53141", "title": "у yt-dlp своё имя", "formats": []}
        with patch.object(YtDlp, "extract", return_value=parsed) as extract:
            plan = await self.cinema.registry.get("ivi").source(self.ctx(), "video", "53141", {})
        extract.assert_called_once_with("https://www.ivi.ru/watch/53141", PROBE, "ivi")
        self.assertEqual(plan.via, "ytdlp")
        self.assertEqual(plan.url, "https://www.ivi.ru/watch/53141")
        self.assertIs(plan.info, parsed)
        self.assertEqual(plan.files, ("mp4",))
        self.assertEqual(plan.subtitles, "any")

    async def test_geo_drm_and_anything_else_get_their_own_clear_words(self):
        info = avod(recorded("videoinfo-movie.json")["result"])
        for error, status, detail in (
            (
                GeoRestrictedError("nope", countries=["RU"]),
                403,
                "ivi не показывает это видео с нашего сервера: ограничение по стране",
            ),
            (
                ExtractorError("No video formats found!", expected=True),
                403,
                "ivi не отдал бесплатный поток для этого видео — похоже, оно платное или защищено",
            ),
            (
                ExtractorError(
                    "Unable to download video 53141: Не смогли определить версию по переданным "
                    "site=s183 и app_version=None",
                    expected=True,
                ),
                403,
                "ivi не отдал бесплатный поток для этого видео — похоже, оно платное или защищено",
            ),
            (ConnectionError("boom"), 502, None),
        ):
            self.pages.clear()
            self.seen.clear()
            self.stage_video(info)
            with patch.object(YtDlp, "extract", side_effect=error):
                with self.assertRaises(HTTPException) as refusal:
                    await self.cinema.registry.get("ivi").source(self.ctx(), "video", "53141", {})
            self.assertEqual(refusal.exception.status_code, status)
            if detail is not None:
                self.assertEqual(refusal.exception.detail, detail)
            else:
                self.assertTrue(refusal.exception.detail.startswith("Не удалось открыть видео:"))


class ResolveRouteTests(Stage):
    """Один прогон через настоящий маршрут `resolve` — доказать, что `source()` подключён к нему,
    а не только к прямому вызову площадки в тестах выше."""

    async def test_the_resolve_route_uses_ivis_own_plan(self):
        info = avod(recorded("videoinfo-movie.json")["result"])
        self.answer("/mobileapi/videoinfo/v7/", {"result": info}, id="53141", fields=SINGLE_FIELDS)
        parsed = {"id": "53141", "title": "Иван Васильевич меняет профессию", "formats": []}
        with patch.object(YtDlp, "extract", return_value=parsed):
            with self.assertRaises(HTTPException) as refusal:
                await self.cinema.resolve(
                    Resolve(provider="ivi", contentId="53141", kind="video", adaptive=True), room=ROOM
                )
        # Разобранного набора форматов у yt-dlp нет (пуст нарочно) — общий `Resolver` откажет уже
        # сам, своими словами, не английским текстом yt-dlp: этим и доказано, что `source()`
        # передал план дальше, а не проглотил его.
        self.assertEqual(refusal.exception.status_code, 502)
        self.assertEqual(
            refusal.exception.detail, "Площадка не отдала поток для этого видео. Попробуйте другое"
        )


class RouteTests(unittest.TestCase):
    """Кинозал целиком, через настоящий FastAPI — участие в комнате подменено, сеть блокирует
    MockTransport."""

    def serve(self):
        root = tempfile.TemporaryDirectory()
        self.addCleanup(root.cleanup)
        self.core = Core("http://core.test", "internal-test")
        self.core.member = AsyncMock(return_value=({"id": ROOM}, {"id": "member"}))
        app = create_app(Path(root.name), self.core, telegram_enabled=False)
        self.addCleanup(app.state.store.db.close)
        return TestClient(app, headers={"Authorization": "Bearer member.secret"})

    def test_ivi_is_listed_between_vk_and_link_with_its_own_accent_features(self):
        client = self.serve()
        entries = client.get(f"/api/v1/services/rooms/{ROOM}/cinema/providers").json()["providers"]
        self.assertEqual(
            [entry["id"] for entry in entries], ["youtube", "twitch", "rutube", "vk", "ivi", "link"]
        )
        self.assertEqual(
            entries[4]["features"],
            {
                "search": True,
                "channels": False,
                "playlists": False,
                "categories": True,
                "series": True,
                "live": False,
            },
        )


if __name__ == "__main__":
    unittest.main()
