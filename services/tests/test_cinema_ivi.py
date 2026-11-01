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

import asyncio
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

from cord_services.app import create_app
from cord_services.cinema import Cinema, Resolve, Signer, reach
from cord_services.cinema.memo import Memo
from cord_services.cinema.providers import PROVIDERS
from cord_services.cinema.providers.ivi import NOT_RU, Ivi
from cord_services.cinema.registry import Ctx, Features, Kit, Match
from cord_services.cinema.resolve import YtDlp
from cord_services.cinema.transport.signer import proxied
from cord_services.core import Core
from cord_services.webapp import Refusal

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "ivi"
NOW = 1_790_320_000.0
SECRET = "secret"
DAY = 24 * 3600
ROOM = str(uuid.uuid4())

TILE_FIELDS = (
    "id,title,object_type,year,years,duration,genres,posters,ivi_rating_10,content_paid_types,drm_only"
)
EPISODE_FIELDS = (
    "id,title,object_type,episode,season,posters,localizations,genres,ivi_rating_10,content_paid_types,"
    "drm_only"
)
COMPILATION_FIELDS = (
    "id,title,object_type,years,duration,genres,posters,ivi_rating_10,content_paid_types,"
    "description,seasons"
)
SINGLE_FIELDS = (
    "id,title,object_type,year,years,duration,genres,posters,ivi_rating_10,content_paid_types,"
    "description,compilation,episode,season,localizations,ivi_release_date,drm_only"
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
    """
    Остановленные часы и сеть, которая знает только адреса `api.ivi.ru`, ответы на которые ей дали.

    Сервер — в России: так площадка уже ответила на `geocheck/whoami` (память площадки), и её проверка
    страны (`Ivi.gate`) пропускает вопросы, не спрашивая сеть. Сервер за границей — `RegionTests`.
    Плеерное API (`POST /light/`) отвечает `self.light`, если тест его назначил.
    """

    def setUp(self):
        clock = patch("time.time", return_value=NOW)
        clock.start()
        self.addCleanup(clock.stop)
        self.pages: dict[str, tuple[int, object]] = {}
        self.seen: list[httpx.Request] = []
        self.light = None
        self.cinema = Cinema(SECRET, httpx.AsyncClient(transport=httpx.MockTransport(self.serve)))
        self.cinema.registry.get("ivi").memo.put("availability", (True, None), 3600)

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
        if request.method == "POST" and request.url.path == "/light/" and self.light is not None:
            return self.light(request)
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

    def test_its_hosts_are_the_site_its_picture_storage_and_its_cdn(self):
        for host in (
            "ivi.ru", "www.ivi.ru", "thumbs.dfs.ivi.ru", "storyboard.dfs.ivi.ru", "dfs.ivi.ru",
            "vod-1.cdn.ivi.ru", "ivi.tv", "www.ivi.tv",
        ):
            self.assertTrue(Ivi.hosts.allows(host), host)
        for host in ("evil-ivi.ru", "ivi.ru.evil.com", "ivi.tv.evil.com", "googlevideo.com"):
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

    async def test_every_catalog_question_waits_ten_seconds_not_a_minute(self):
        # Шестьдесят секунд чтения у клиента площадки — для тел видео; вопрос каталога — десять.
        self.answer("/mobileapi/categories/v7/", recorded("categories.json"))
        self.answer(
            "/mobileapi/catalogue/v7/",
            recorded("catalogue-movies.json"),
            category="14",
            fields=TILE_FIELDS,
            paid_type="AVOD",
            **{"from": "0", "to": "29", "app_version": "870"},
        )
        await self.cinema.category("ivi", "14", room=ROOM)
        self.assertTrue(self.seen)
        for request in self.seen:
            self.assertEqual(
                request.extensions["timeout"],
                {"connect": 5.0, "read": 10.0, "write": 10.0, "pool": 10.0},
                request.url,
            )

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

    async def test_a_film_only_under_drm_is_not_shown_but_a_series_marked_so_is(self):
        """`drm_only` у ролика — его не сыграть ничем, кроме плеера площадки: карточки нет. У сериала
        целиком пометка серии не прячет — у серий она своя, и отбор идёт по ним (R172)."""
        self.answer("/mobileapi/categories/v7/", {"result": []})
        show, _, film = recorded("catalogue-movies.json")["result"]
        rows = [avod(film, drm_only=True), avod(show, drm_only=True), avod(film, id=990001)]
        self.answer(
            "/mobileapi/catalogue/v7/",
            {"result": rows},
            category="14",
            fields=TILE_FIELDS,
            paid_type="AVOD",
            **{"from": "0", "to": "29", "app_version": "870"},
        )
        found = await self.cinema.category("ivi", "14", room=ROOM)
        self.assertEqual([item["id"] for item in found["items"]], [str(show["id"]), "990001"])

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
        # Сериал, где эта серия — единственная бесплатная: «следующей» нет.
        show = recorded("compilationinfo-molodezhka.json")
        show["result"]["seasons"] = [{"season_id": 1, "number": 1}]
        self.answer("/mobileapi/compilationinfo/v7/", show, id="18701", fields=COMPILATION_FIELDS)
        self.answer(
            "/mobileapi/videofromcompilation/v7/",
            {"result": [{**info, "id": 567680}]},
            id="18701", season="1", fields=EPISODE_FIELDS, paid_type="AVOD",
            **{"from": "0", "to": "19"},
        )
        found = await self.cinema.details("ivi", "567680", "video", room=ROOM)
        self.assertEqual(found["series"], "18701")
        self.assertEqual(found["duration"], info["localizations"][0]["duration"])
        self.assertNotIn("next", found)

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


class NextEpisodeTests(Stage):
    """
    «Следующая серия» (T17) у ivi: страница серии отдаёт `next` — следующую бесплатную серию того же
    сериала, по тем же запросам, что и список серий (`compilationinfo`, `videofromcompilation`).
    """

    def serve_episode(self, season=1, episode=1):
        """Серия «Молодёжки» (17830): снятая карточка серии, где поменяны сериал, сезон и номер."""
        self.answer("/mobileapi/categories/v7/", recorded("categories.json"))
        info = avod(recorded("videoinfo-episode.json")["result"], season=season, episode=episode)
        info["compilation"]["id"] = 17830
        self.answer("/mobileapi/videoinfo/v7/", {"result": info}, id="567680", fields=SINGLE_FIELDS)
        self.answer(
            "/mobileapi/compilationinfo/v7/", recorded("compilationinfo-molodezhka.json"),
            id="17830", fields=COMPILATION_FIELDS,
        )
        return info

    def season(self, number, items, start=0):
        self.answer(
            "/mobileapi/videofromcompilation/v7/",
            {"result": items},
            id="17830", season=str(number), fields=EPISODE_FIELDS, paid_type="AVOD",
            **{"from": str(start), "to": str(start + 19)},
        )

    def episodes(self, season):
        found = recorded("videofromcompilation-molodezhka-s2.json")["result"]
        return [avod(item, season=season) for item in found]

    async def test_the_next_episode_of_the_same_season(self):
        self.serve_episode()
        episodes = self.episodes(1)
        episodes[0]["id"] = 567680
        self.season(1, episodes)
        found = await self.cinema.details("ivi", "567680", "video", room=ROOM)
        self.assertEqual(found["next"]["id"], str(episodes[1]["id"]))
        self.assertEqual(found["next"]["badge"], "2 серия")
        self.assertEqual(found["next"]["series"], "17830")

    async def test_after_the_last_free_episode_of_a_season_comes_the_first_of_the_next(self):
        self.serve_episode()
        self.season(1, [{**self.episodes(1)[0], "id": 567680}])
        second = self.episodes(2)
        self.season(2, second)
        found = await self.cinema.details("ivi", "567680", "video", room=ROOM)
        self.assertEqual(found["next"]["id"], str(second[0]["id"]))

    async def test_a_full_portion_continues_on_the_next_one(self):
        self.serve_episode()
        filler = [{**self.episodes(1)[0], "id": 700000 + number} for number in range(19)]
        self.season(1, [*filler, {**self.episodes(1)[0], "id": 567680}])
        later = self.episodes(1)[2]
        self.season(1, [later], start=20)
        found = await self.cinema.details("ivi", "567680", "video", room=ROOM)
        self.assertEqual(found["next"]["id"], str(later["id"]))

    async def test_the_last_episode_of_the_last_season_has_no_next(self):
        self.serve_episode(season=2)
        self.season(2, [{**self.episodes(2)[0], "id": 567680}])
        found = await self.cinema.details("ivi", "567680", "video", room=ROOM)
        self.assertNotIn("next", found)

    async def test_the_platform_failing_leaves_the_page_without_next(self):
        self.serve_episode()
        self.answer(
            "/mobileapi/videofromcompilation/v7/", {}, status=500,
            id="17830", season="1", fields=EPISODE_FIELDS, paid_type="AVOD", **{"from": "0", "to": "19"},
        )
        found = await self.cinema.details("ivi", "567680", "video", room=ROOM)
        self.assertEqual(found["series"], "17830")
        self.assertNotIn("next", found)

    async def test_a_film_asks_for_nothing_but_itself(self):
        self.answer("/mobileapi/categories/v7/", recorded("categories.json"))
        info = avod(recorded("videoinfo-movie.json")["result"])
        self.answer("/mobileapi/videoinfo/v7/", {"result": info}, id="53141", fields=SINGLE_FIELDS)
        found = await self.cinema.details("ivi", "53141", "video", room=ROOM)
        self.assertNotIn("next", found)
        paths = sorted(key.split("?")[0] for key in self.asked())
        self.assertEqual(paths, ["/mobileapi/categories/v7/", "/mobileapi/videoinfo/v7/"])


# Узел CDN ivi — выдуманный: настоящих файлов бесплатного с сервера в Германии не увидеть (см. шапку).
CDN = "https://vod-1.cdn.ivi.ru/storage/contents/53141"
# Подпись плеерного API — ключом экстрактора yt-dlp (`IviIE._LIGHT_KEY`), как у самой службы.
LIGHT_KEY = b"\xf1\x02\x32\xb7\xbc\x5c\x7a\xe8\xf7\x96\xc1\x33\x2b\x27\xa1\x8c"


def file_entry(content_format: str, url: str | None = None) -> dict:
    """Строка `files` ответа плеера площадки: имя формата, адрес, размер — как их читает yt-dlp."""
    return {
        "content_format": content_format,
        "url": url or f"{CDN}/{content_format}.mp4?sign=abc",
        "size_in_bytes": 123456789,
    }


def played(*files: dict) -> dict:
    """Ответ `da.content.get` с файлами (форма — по экстрактору `ivi` у yt-dlp: `result.files[]`)."""
    return {"result": {"title": "Иван Васильевич меняет профессию", "files": list(files)}}


class PlayerStage(Stage):
    """Плеерное API площадки и её CDN: `self.player` — ответ на `da.content.get`, `self.cdn` — файлы."""

    def setUp(self):
        super().setUp()
        self.player: dict | Exception = played()
        self.cdn: dict[str, tuple[int, str, str]] = {}
        self.light_calls: list[tuple[dict, dict, bytes]] = []
        self.light = self.answer_light
        self.stage_video(avod(recorded("videoinfo-movie.json")["result"]))

    def answer_light(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        self.light_calls.append((body, dict(request.url.params), request.content))
        if body["method"] == "da.timestamp.get":
            return httpx.Response(200, json={"result": "cJRsvNxRr1w"})
        if isinstance(self.player, Exception):
            raise self.player
        return httpx.Response(200, json=self.player)

    def serve(self, request: httpx.Request) -> httpx.Response:
        host = request.url.host
        if request.method == "GET" and host != "api.ivi.ru":
            self.seen.append(request)
            status, kind, text = self.cdn.get(str(request.url), (404, "text/plain", ""))
            if status in (301, 302):
                return httpx.Response(status, headers={"location": text})
            return httpx.Response(status, headers={"content-type": kind}, content=text.encode())
        return super().serve(request)

    def stage_video(self, item):
        self.answer("/mobileapi/videoinfo/v7/", {"result": item}, id=str(item["id"]), fields=SINGLE_FIELDS)

    def live(self, url: str, kind: str = "video/mp4"):
        self.cdn[url] = (206, kind, "x")

    async def plan(self):
        return await self.cinema.registry.get("ivi").source(self.ctx(), "video", "53141", {})

    async def refusal(self, status, code, detail):
        with self.assertRaises(Refusal) as refused:
            await self.plan()
        found = refused.exception
        self.assertEqual((found.status_code, found.code, found.detail), (status, code, detail))
        self.assertEqual(found.extra["provider"], "ivi")
        return found


class SourceTests(PlayerStage):
    async def test_a_free_film_plays_its_best_open_file_and_never_the_protected_one(self):
        best = file_entry("MP4-HD720")
        self.player = played(
            file_entry("MP4-lo"), best, file_entry("DASH-MDRM-HD1080"), file_entry("MP4-HD1080-FPS-")
        )
        for entry in self.player["result"]["files"]:
            self.live(entry["url"])
        with patch.object(YtDlp, "extract") as extract:
            plan = await self.plan()
        extract.assert_not_called()
        self.assertEqual((plan.via, plan.kind, plan.url), ("direct", "file", best["url"]))
        self.assertEqual(plan.title, "Иван Васильевич меняет профессию")
        # Длительность — из карточки площадки (`localizations[0].duration`), а не из ответа плеера.
        movie = recorded("videoinfo-movie.json")["result"]
        self.assertEqual(plan.duration, movie["localizations"][0]["duration"])
        # Вопрос плеерному API — тот же, что у yt-dlp: время, затем `da.content.get` сайта s353 с подписью
        # CMAC/Blowfish над временем и телом.
        from Cryptodome.Cipher import Blowfish
        from Cryptodome.Hash import CMAC

        (first, _, _), (second, params, raw) = self.light_calls
        self.assertEqual(first, {"method": "da.timestamp.get", "params": []})
        self.assertEqual(second["method"], "da.content.get")
        self.assertEqual(second["params"][0], "53141")
        self.assertEqual(second["params"][1]["site"], "s353")
        self.assertEqual(second["params"][1]["contentid"], "53141")
        sign = CMAC.new(LIGHT_KEY, b"cJRsvNxRr1w" + raw, ciphermod=Blowfish).hexdigest()
        self.assertEqual(params, {"ts": "cJRsvNxRr1w", "sign": sign})
        # Защищённые файлы не спрашивались вовсе: проверен только выбранный.
        checked = [str(request.url) for request in self.seen if request.url.host != "api.ivi.ru"]
        self.assertEqual(checked, [best["url"]])

    async def test_a_dead_best_file_gives_way_to_the_next_that_answers(self):
        good = file_entry("MP4-lo")
        self.player = played(file_entry("MP4-HD720"), good)
        self.live(good["url"])
        plan = await self.plan()
        self.assertEqual((plan.kind, plan.url), ("file", good["url"]))

    async def test_a_redirect_to_the_cdn_node_is_followed_by_the_check(self):
        moved = file_entry("MP4-HD720")
        node = "https://node-7.cdn.ivi.ru/f/53141.mp4"
        self.player = played(moved)
        self.cdn[moved["url"]] = (302, "", node)
        self.live(node)
        plan = await self.plan()
        self.assertEqual(plan.url, moved["url"])
        # Узел отдаёт переадресацией — и прокси пройдёт её сам, шагами по политике (`follows_redirects`).
        self.assertTrue(Ivi.follows_redirects)

    async def test_a_file_named_over_http_is_asked_over_https(self):
        plain = file_entry("MP4-hi", url="http://vod-1.cdn.ivi.ru/storage/contents/53141/hi.mp4")
        self.player = played(plain)
        self.live("https://vod-1.cdn.ivi.ru/storage/contents/53141/hi.mp4")
        plan = await self.plan()
        self.assertEqual(plan.url, "https://vod-1.cdn.ivi.ru/storage/contents/53141/hi.mp4")

    async def test_an_open_hls_list_beats_files_and_a_locked_one_does_not(self):
        master = f"{CDN}/master.m3u8"
        child = f"{CDN}/720.m3u8"
        self.player = played(file_entry("HLS-HD720", url=master), file_entry("MP4-hi"))
        self.live(self.player["result"]["files"][1]["url"])
        hls = "application/vnd.apple.mpegurl"
        self.cdn[master] = (200, hls, "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n720.m3u8\n")
        self.cdn[child] = (200, hls, "#EXTM3U\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST\n")
        plan = await self.plan()
        self.assertEqual((plan.kind, plan.url), ("hls", master))
        # Тот же список с ключом SAMPLE-AES — уже защита: играет файл.
        self.cdn[child] = (
            200,
            hls,
            '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://k"\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST\n',
        )
        plan = await self.plan()
        self.assertEqual(plan.kind, "file")

    async def test_the_platforms_refusals_are_said_in_their_own_words(self):
        for origin, status, code, detail in (
            ("NotAllowedForLocation", 403, "CINEMA_GEO", "ivi не показывает это видео в стране сервера"),
            ("ContentNotPaid", 403, "CINEMA_PAID", "Это платное видео ivi — показать его комнате нельзя"),
            ("ContentYetUnavailable", 403, "CINEMA_NOT_YET", "Это видео на ivi ещё не вышло"),
            ("NoRedisValidData", 404, "CINEMA_NO_VIDEO", "Такого видео на ivi нет"),
        ):
            self.player = {"error": {"code": 4500, "origin": origin, "message": "…"}}
            await self.refusal(status, code, detail)

    async def test_anything_else_is_a_short_phrase_and_the_reason_goes_to_the_log(self):
        self.player = {
            "error": {"code": 4512, "origin": "WrongVersion", "message": "Не смогли определить версию"}
        }
        with self.assertLogs("cord_services.cinema.providers.ivi", "WARNING") as log:
            found = await self.refusal(
                502, "CINEMA_STREAM_FAILED", "ivi не отдал это видео — попробуйте позже или другое"
            )
        self.assertNotIn("WrongVersion", found.detail)
        self.assertIn("WrongVersion 4512 Не смогли определить версию", log.output[0])

    async def test_only_protected_files_are_called_protected(self):
        self.player = played(file_entry("DASH-MDRM-HD1080"), file_entry("HLS-FPS-HD720"))
        with self.assertLogs("cord_services.cinema.providers.ivi", "WARNING") as log:
            await self.refusal(
                403,
                "CINEMA_PROTECTED",
                "ivi отдаёт это видео только под защитой — показать его комнате нельзя",
            )
        self.assertIn("DASH-MDRM-HD1080, HLS-FPS-HD720", log.output[0])

    async def test_files_on_a_foreign_host_are_not_signed_and_the_host_goes_to_the_log(self):
        self.player = played(file_entry("MP4-HD720", url="https://cdn.example.net/a.mp4?token=secret"))
        with self.assertLogs("cord_services.cinema.providers.ivi", "WARNING") as log:
            await self.refusal(
                502, "CINEMA_STREAM_FAILED", "ivi не отдал это видео — попробуйте позже или другое"
            )
        self.assertIn("cdn.example.net", log.output[0])
        self.assertNotIn("secret", "\n".join(log.output))
        self.assertEqual([r for r in self.seen if r.url.host == "cdn.example.net"], [])

    async def test_a_paid_video_never_reaches_the_player_api(self):
        self.stage_video(recorded("videoinfo-movie.json")["result"])  # осталась платной
        await self.refusal(403, "CINEMA_PAID", "Это платное видео ivi — показать его комнате нельзя")
        self.assertEqual(self.light_calls, [])

    async def test_drm_only_is_refused_before_the_player_api(self):
        self.stage_video(avod(recorded("videoinfo-movie.json")["result"], drm_only=True))
        await self.refusal(
            403, "CINEMA_PROTECTED", "ivi отдаёт это видео только под защитой — показать его комнате нельзя"
        )
        self.assertEqual(self.light_calls, [])

    async def test_a_silent_player_api_is_a_failure_the_breaker_counts_as_network(self):
        self.player = httpx.ConnectError("no route")
        with self.assertLogs("cord_services.cinema.providers.ivi", "WARNING"):
            found = await self.refusal(
                502, "CINEMA_STREAM_FAILED", "ivi не отдал это видео — попробуйте позже или другое"
            )
        self.assertTrue(reach.network(found))


class ResolveRouteTests(PlayerStage):
    """Через настоящий `resolve`: план ivi подключён к нему, и пул потоков yt-dlp он не трогает вовсе."""

    async def test_the_resolve_route_plays_ivis_file_through_our_proxy_without_yt_dlp(self):
        best = file_entry("MP4-HD720")
        self.player = played(best)
        self.live(best["url"])
        with patch.object(YtDlp, "extract") as extract:
            found = await self.cinema.resolve(
                Resolve(provider="ivi", contentId="53141", kind="video", adaptive=True), room=ROOM
            )
        extract.assert_not_called()
        self.assertEqual(self.cinema.ytdlp.busy, {})
        self.assertEqual(found["kind"], "file")
        self.assertEqual(found["title"], "Иван Васильевич меняет профессию")
        self.assertTrue(found["url"].startswith("/api/v1/services/cinema/fetch?"))
        self.assertEqual(self.cinema.signer.open("fetch", *_signed(found["url"])), best["url"])


def _signed(url: str) -> tuple[str, str, str, str]:
    query = parse_qs(urlsplit(url).query)
    return query["u"][0], query["e"][0], query["s"][0], query["p"][0]


class RegionTests(unittest.IsolatedAsyncioTestCase):
    """Сервер не в России: каждый вопрос к ivi — отказ сразу, со страной сервера, и без каталога."""

    async def asyncSetUp(self):
        self.seen: list[httpx.Request] = []
        self.country = "DE"

        def serve(request: httpx.Request) -> httpx.Response:
            self.seen.append(request)
            if request.url.path.endswith("/geocheck/whoami/v6/"):
                if self.country is None:
                    raise httpx.ConnectError("no route")
                return httpx.Response(200, json={"result": {"country_code": self.country}})
            return httpx.Response(200, json={"result": []})

        self.cinema = Cinema(SECRET, httpx.AsyncClient(transport=httpx.MockTransport(serve)))

    async def asyncTearDown(self):
        await self.cinema.close()

    async def refused(self, action):
        with self.assertRaises(Refusal) as refusal:
            await action
        found = refusal.exception
        self.assertEqual(
            (found.status_code, found.code, found.detail),
            (403, "CINEMA_REGION", "ivi показывает фильмы только на серверах в России"),
        )
        self.assertEqual(found.extra, {"provider": "ivi", "code": "CINEMA_REGION", "country": "DE"})

    async def test_the_list_names_the_region_and_the_servers_country(self):
        entries = (await self.cinema.providers())["providers"]
        ivi = next(entry for entry in entries if entry["id"] == "ivi")
        self.assertEqual(
            (ivi["available"], ivi["reason"], ivi["code"], ivi["country"]),
            (False, NOT_RU, "CINEMA_REGION", "DE"),
        )

    async def test_every_question_is_refused_at_once_without_asking_the_catalog(self):
        for action in (
            self.cinema.categories("ivi", room=ROOM),
            self.cinema.category("ivi", "14", room=ROOM),
            self.cinema.search("ivi", "Иван", room=ROOM),
            self.cinema.series("ivi", "17830", room=ROOM),
            self.cinema.details("ivi", "53141", "video", room=ROOM),
            self.cinema.resolve(Resolve(provider="ivi", contentId="53141", kind="video"), room=ROOM),
            self.cinema.link("https://www.ivi.ru/watch/53141", room=ROOM),
        ):
            await self.refused(action)
        # Страну спросили один раз — дальше она в памяти; каталога не спрашивали вовсе.
        self.assertEqual([request.url.path for request in self.seen], ["/mobileapi/geocheck/whoami/v6/"])

    async def test_a_flickering_breaker_does_not_hide_the_true_reason(self):
        await self.cinema.providers()
        ivi = self.cinema.registry.get("ivi")
        state = self.cinema.reach.gauge(ivi)
        self.cinema.reach._open(state, "probe")
        entries = (await self.cinema.providers())["providers"]
        entry = next(entry for entry in entries if entry["id"] == "ivi")
        self.assertEqual(entry["code"], "CINEMA_REGION")
        await self.refused(self.cinema.category("ivi", "14", room=ROOM))

    async def test_an_unknown_country_lets_the_question_through_to_the_platform(self):
        self.country = None
        found = await self.cinema.category("ivi", "14", room=ROOM)
        self.assertEqual(found["items"], [])
        self.assertIn("/mobileapi/catalogue/v7/", [request.url.path for request in self.seen])


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
        app.state.cinema.net._clients["ivi"] = self._whoami()
        return TestClient(app, headers={"Authorization": "Bearer member.secret"})

    def _whoami(self):
        # Проверка страны ivi спрашивает клиентом самой площадки (`Net.client_for("ivi")`). В CI у контейнера
        # службы есть сеть: без подмены список площадок ходил бы в api.ivi.ru (I1). Ответ — «Германия».
        def handler(request):
            assert request.url.host == "api.ivi.ru", request.url
            return httpx.Response(200, json={"result": {"country_code": "DE"}})

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        self.addCleanup(lambda: asyncio.run(client.aclose()))
        return client

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
