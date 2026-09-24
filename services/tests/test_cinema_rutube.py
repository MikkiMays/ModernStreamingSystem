"""
Rutube в кинозале: что служба отдаёт по настоящим ответам площадки.

ОТКУДА ОТВЕТЫ. `fixtures/rutube/` — ответы rutube.ru, снятые запросами с сервера 24.09.2026 и
обрезанные до нескольких записей (длинные описания — до 120 знаков, рекламу и статистику плеера —
долой). Значения, которые здесь проверяются, в них те же, что прислала площадка. Если тесту
нужен случай, которого в снятом нет (платный ролик, дубликат эфира в двух группах), он берёт
настоящую запись и меняет в ней ровно одно поле — прямо в тесте, на виду.

ГДЕ ПОДМЕНА. Сеть — транспортом httpx, как у Twitch: тест знает только адреса площадки и
не знает, какой метод какой класс зовёт. Часы стоят: подпись адреса зависит от времени.
"""

import copy
import json
import os
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch
from urllib.parse import parse_qs, urlsplit

import httpx
from fastapi import HTTPException
from fastapi.responses import Response
from fastapi.testclient import TestClient

from cord_services.app import create_app
from cord_services.cinema import Cinema, Resolve, Signer, rewrite, Reels
from cord_services.cinema.captions import webvtt
from cord_services.cinema.memo import Memo
from cord_services.cinema.net import NetConfig
from cord_services.cinema.providers import PROVIDERS
from cord_services.cinema.providers.rutube import Rutube
from cord_services.cinema.registry import Features, Kit
from cord_services.cinema.resolve import YtDlp
from cord_services.cinema.transport.signer import proxied
from cord_services.core import Core

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "rutube"
# Сразу после съёмки: у адреса потока VOD срок (`expire`) — сутки от неё.
NOW = 1_790_250_000.0
SECRET = "secret"
DAY = 24 * 3600
FIVE_HOURS = 5 * 3600
ROOM = str(uuid.uuid4())

PLAY = {"no_404": "true", "referer": "https://rutube.ru", "pver": "v2", "client": "wdp"}
TV_LIVE = "https://rutube.ru/api/tags/video/%s/?limit=1000&sort=tagged_d&show_hidden_videos=False"


def recorded(name):
    """Снятый ответ площадки; каждый раз — свежая копия."""
    path = FIXTURES / name
    text = path.read_text(encoding="utf-8")
    return json.loads(text) if path.suffix == ".json" else text


def image(url):
    """Обложка у нас: подписанный на сутки адрес маршрута `image` от имени Rutube."""
    return proxied(Signer(SECRET), url, "image", DAY, provider="rutube")


def thumb(url):
    """Кадр для плитки — 480×270 (`size=m`), а не исходник 1280×720: в сетке крупнее не нужно."""
    return image(url + "?size=m")


def address(url):
    """Адрес запроса без порядка параметров: путь и отсортированные пары."""
    parts = urlsplit(url)
    pairs = sorted((key, value) for key, values in parse_qs(parts.query).items() for value in values)
    return parts.path + ("?" + "&".join(f"{key}={value}" for key, value in pairs) if pairs else "")


class Stage(unittest.IsolatedAsyncioTestCase):
    """Остановленные часы и сеть, которая знает только адреса Rutube, ответы на которые ей дали."""

    def setUp(self):
        clock = patch("time.time", return_value=NOW)
        clock.start()
        self.addCleanup(clock.stop)
        self.pages = {}
        self.seen = []
        self.cinema = Cinema(SECRET, httpx.AsyncClient(transport=httpx.MockTransport(self.serve)))

    async def asyncTearDown(self):
        await self.cinema.close()

    def answer(self, url, body, status=200, **params):
        """Ответ на `url` (путь с параметрами или без, параметры — ещё и ключами)."""
        full = url if url.startswith("https://") else "https://rutube.ru" + url
        if params:
            full += ("&" if "?" in full else "?") + "&".join(f"{k}={v}" for k, v in params.items())
        self.pages[address(full)] = (status, body)

    def serve(self, request):
        self.seen.append(request)
        assert request.url.host == "rutube.ru", f"Неожиданный запрос наружу: {request.url}"
        # Сайт площадки открывают браузером — и каталог спрашивается тем же видом.
        agent = request.headers.get("user-agent", "")
        assert agent.startswith("Mozilla/5.0") and "Chrome/" in agent, agent
        key = address(str(request.url))
        if key not in self.pages:
            raise AssertionError("Площадку спросили о неожиданном: " + key)
        status, body = self.pages[key]
        if isinstance(body, BaseException):
            raise body
        return httpx.Response(status, json=body)

    def asked(self):
        return [address(str(request.url)) for request in self.seen]

    def kept(self, memo):
        return {key: round(expiry - NOW) for key, (expiry, _) in memo._items.items()}

    async def refused(self, action, status, detail):
        with self.assertRaises(HTTPException) as refusal:
            await action
        self.assertEqual((refusal.exception.status_code, refusal.exception.detail), (status, detail))


def video_card(item, **extra):
    """Ролик так, как его отдаёт каталог Rutube: ключи и пустоты — как у плиток YouTube."""
    author = item["author"]
    card = {
        "provider": "rutube",
        "kind": "video",
        "id": item["id"],
        "title": item["title"],
        "author": author["name"],
        "channelId": str(author["id"]),
        "duration": item["duration"] or None,
        "live": False,
        "viewers": None,
        "views": item["hits"],
    }
    card.update(extra)
    card["poster"] = thumb(item["thumbnail_url"])
    return card


def live_card(item):
    """Идущий эфир ТВ: смотрится вместе, как эфир Twitch, — по номеру своего ролика."""
    author = item["author"]
    return {
        "provider": "rutube",
        "kind": "channel",
        "id": item["id"],
        "title": item["title"],
        "author": author["name"],
        "channelId": str(author["id"]),
        "duration": None,
        "live": True,
        "viewers": None,
        "views": None,
        "poster": thumb(item["thumbnail_url"]),
    }


class PlatformTests(unittest.TestCase):
    def test_rutube_is_the_third_platform_and_says_what_it_has(self):
        self.assertEqual([kind.id for kind in PROVIDERS], ["youtube", "twitch", "rutube"])
        self.assertEqual(Rutube.name, "Rutube")
        self.assertEqual(
            Rutube.features, Features(search=True, channels=True, categories=True, series=True, live=True)
        )

    def test_its_addresses_are_the_32_hex_ids_of_its_videos(self):
        self.assertTrue(Rutube.content_id.fullmatch("c58f502c7bb34a8fcdd976b221fca292"))
        for wrong in (
            "C58F502C7BB34A8FCDD976B221FCA292",
            "c58f502c7bb34a8fcdd976b221fca29",
            "aqz-KE-bpKQ",
            "",
        ):
            self.assertIsNone(Rutube.content_id.fullmatch(wrong), wrong)

    def test_its_hosts_are_exactly_those_its_streams_and_pictures_come_from(self):
        # Каждый — из снятых ответов: балансер и CDN потока, картинки и субтитры, мастер
        # лицензионных серий (UMA). Заглушки аватаров (`static.rutubelist.ru`) не нужны: вместо
        # безликой картинки площадки плитка рисует свою.
        for host in (
            "bl.rutube.ru",
            "river-1.rutube.ru",
            "salam-de-rasc-87.rtbcdn.ru",
            "river-6-603.rtbcdn.ru",
            "pic.rtbcdn.ru",
            "vb-rtb.uma.media",
        ):
            self.assertTrue(Rutube.hosts.allows(host), host)
        for host in ("static.rutubelist.ru", "evilrutube.ru", "rutube.ru.evil.com", "googlevideo.com"):
            self.assertFalse(Rutube.hosts.allows(host), host)


class ShowcaseTests(Stage):
    """Пусто в поиске — это витрина: эфиры ТВ лентой и полка «Сериалы и шоу»."""

    def serve_showcase(self):
        self.answer("/api/feeds/tvchannels/", recorded("feed-tvchannels.json"))
        for tag in ("6264", "6208", "5979", "6238"):
            self.answer(TV_LIVE % tag, recorded(f"tag-{tag}.json"))
        self.answer("/api/feeds/movies-serials/", recorded("feed-movies-serials.json"))
        self.answer("/api/feeds/live/", recorded("feed-live.json"))
        self.answer(
            "https://rutube.ru/api/feeds/cardgroup/1554?show_hidden_videos=False&limit=20",
            recorded("cardgroup-1554.json"),
        )
        self.answer(
            "https://rutube.ru/api/feeds/cardgroup/1125?clients=wdp&show_hidden_videos=False&limit=20",
            recorded("cardgroup-1125.json"),
        )

    async def test_the_live_shelf_is_what_is_on_air_on_tv_national_first(self):
        self.serve_showcase()
        found = await self.cinema.search("rutube", "")
        federal = recorded("tag-6264.json")["results"]
        news = recorded("tag-5979.json")["results"]
        regional = recorded("tag-6208.json")["results"]
        radio = recorded("tag-6238.json")["results"]
        # Группы — в порядке площадки, только местные каналы и радио уходят в конец: девять
        # десятков местных станций иначе закрыли бы собой первую порцию. Запись эфира, которая
        # не идёт (`is_on_air: false`), здесь не эфир и в ленту не попадает.
        self.assertEqual(
            [item["id"] for item in found["items"]],
            [*(r["id"] for r in federal), news[0]["id"], *(r["id"] for r in regional), radio[0]["id"]],
        )
        self.assertEqual(found["items"][0], live_card(federal[0]))
        self.assertEqual((found["channels"], found["categories"], found["next"]), ([], [], None))

    async def test_a_channel_in_two_groups_is_shown_once(self):
        self.serve_showcase()
        news = recorded("tag-5979.json")
        news["results"].insert(0, recorded("tag-6264.json")["results"][0])
        self.answer(TV_LIVE % "5979", news)
        found = await self.cinema.search("rutube", "")
        ids = [item["id"] for item in found["items"]]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(ids[0], news["results"][0]["id"])

    async def test_the_shelf_of_series_and_shows_is_the_platform_own_picks(self):
        self.serve_showcase()
        found = await self.cinema.search("rutube", "")
        series = [entry["object"] for entry in recorded("cardgroup-1554.json")["results"]]
        shows = [entry["object"] for entry in recorded("cardgroup-1125.json")["results"]]
        # Сериал, шоу, сериал, шоу: полка показывает оба вида с первого экрана.
        self.assertEqual(
            [card["id"] for card in found["series"]],
            [str(item["id"]) for pair in zip(series, shows) for item in pair],
        )
        self.assertEqual(
            found["series"][0],
            {
                "provider": "rutube",
                "kind": "series",
                "id": str(series[0]["id"]),
                "title": series[0]["name"],
                "author": "",
                "channelId": None,
                "duration": None,
                "live": False,
                "viewers": None,
                "views": None,
                "badge": "Сериал",
                "shape": "tall",
                "poster": image(series[0]["picture"]),
            },
        )
        self.assertEqual(found["series"][1]["badge"], "Шоу")
        # У «Правда или хайп?» вида нет — и значка нет: подписывать наугад нечего.
        self.assertNotIn("badge", found["series"][3])

    async def test_what_is_sold_by_subscription_or_money_is_not_on_the_shelf(self):
        self.serve_showcase()
        series = recorded("cardgroup-1554.json")
        series["results"][0]["object"]["common_subscription_product_codes"] = ["PREMIER_RUTUBE_START"]
        series["results"][1]["object"]["is_paid"] = True
        self.answer("https://rutube.ru/api/feeds/cardgroup/1554?show_hidden_videos=False&limit=20", series)
        found = await self.cinema.search("rutube", "")
        self.assertNotIn(str(series["results"][0]["object"]["id"]), [c["id"] for c in found["series"]])
        self.assertNotIn(str(series["results"][1]["object"]["id"]), [c["id"] for c in found["series"]])
        self.assertIn(str(series["results"][2]["object"]["id"]), [c["id"] for c in found["series"]])

    async def test_a_broken_shelf_of_series_leaves_the_live_one(self):
        self.serve_showcase()
        self.answer("/api/feeds/movies-serials/", {"detail": "boom"}, status=500)
        self.answer("/api/feeds/live/", {"detail": "boom"}, status=500)
        found = await self.cinema.search("rutube", "")
        self.assertEqual(found["series"], [])
        self.assertTrue(found["items"])

    async def test_the_showcase_is_asked_once_for_everyone(self):
        self.serve_showcase()
        await self.cinema.search("rutube", "")
        before = len(self.seen)
        await self.cinema.search("rutube", "")
        self.assertEqual(len(self.seen), before)
        self.assertEqual(self.kept(self.cinema.catalog), {"rutube:live": 120, "rutube:shows": 600})

    async def test_a_feed_address_off_the_platform_api_is_not_followed(self):
        feed = recorded("feed-tvchannels.json")
        live = next(tab for tab in feed["tabs"] if tab["slug"] == "live")
        live["resources"][0]["url"] = "https://evil.example/api/tags/video/6264/"
        self.serve_showcase()
        self.answer("/api/feeds/tvchannels/", feed)
        found = await self.cinema.search("rutube", "")
        self.assertEqual({request.url.host for request in self.seen}, {"rutube.ru"})
        self.assertNotIn(recorded("tag-6264.json")["results"][0]["id"], [i["id"] for i in found["items"]])


class SearchTests(Stage):
    """Набранное — ролики и эфиры лентой, каналы и сериалы полками над ней."""

    QUERY = "прямой эфир"

    def serve_search(self, cards=None):
        self.answer("/api/search/video/", recorded("search-video.json"), query=self.QUERY)
        self.answer(
            "/api/search/combined/cards/list",
            cards if cards is not None else recorded("search-cards.json"),
            client="wdp",
            query=self.QUERY,
            page="1",
        )

    async def test_videos_and_live_tv_in_one_feed_without_what_is_for_adults(self):
        self.serve_search()
        found = await self.cinema.search("rutube", self.QUERY)
        results = recorded("search-video.json")["results"]
        # Идущий эфир — дверь в эфир (`channel`), ролик — ролик; «для взрослых» — мимо кинозала.
        self.assertEqual(
            found["items"],
            [video_card(results[0]), video_card(results[1]), live_card(results[2]), live_card(results[4])],
        )
        self.assertIsNone(found["next"])

    async def test_a_broadcast_that_has_ended_is_not_in_the_catalogue(self):
        # Эфир, который уже не идёт, — не эфир и не ролик: площадка отвечает на него
        # «трансляция закончилась».
        page = recorded("search-video.json")
        page["results"][2]["is_on_air"] = False
        self.serve_search()
        self.answer("/api/search/video/", page, query=self.QUERY)
        found = await self.cinema.search("rutube", self.QUERY)
        self.assertNotIn(page["results"][2]["id"], [item["id"] for item in found["items"]])
        self.assertEqual(len(found["items"]), 3)

    async def test_channels_and_series_are_shelves_over_the_feed(self):
        self.serve_search()
        found = await self.cinema.search("rutube", self.QUERY)
        cards = recorded("search-cards.json")["results"]
        channel = cards[2]
        self.assertEqual(
            found["channels"],
            [
                {
                    "provider": "rutube",
                    "kind": "channel",
                    "id": str(channel["id"]),
                    "title": channel["name"],
                    "author": "",
                    "channelId": str(channel["id"]),
                    "duration": None,
                    "live": False,
                    "viewers": None,
                    "views": None,
                    "followers": channel["subscribers_count"],
                    "description": channel["description"][:300],
                    "poster": image(channel["icon"]),
                }
            ],
        )
        self.assertEqual([card["id"] for card in found["series"]], [str(cards[0]["id"]), str(cards[1]["id"])])
        self.assertEqual(found["series"][0]["shape"], "tall")
        self.assertEqual(found["categories"], [])

    async def test_the_feed_is_cut_into_portions_of_what_was_found(self):
        # Площадка отдаёт найденное одной страницей (до ~95); порции режутся по ней, и вторая
        # порция не спрашивает ни площадку, ни полки заново.
        page = recorded("search-video.json")
        sample = page["results"][0]
        page["results"] = [{**copy.deepcopy(sample), "id": f"{n:032x}"} for n in range(40)]
        self.serve_search()
        self.answer("/api/search/video/", page, query=self.QUERY)
        first = await self.cinema.search("rutube", self.QUERY)
        self.assertEqual((len(first["items"]), first["next"]), (30, "30"))
        before = len(self.seen)
        second = await self.cinema.search("rutube", self.QUERY, "30")
        self.assertEqual(len(self.seen), before)
        self.assertEqual((len(second["items"]), second["next"]), (10, None))
        self.assertEqual((second["channels"], second["series"]), ([], []))
        self.assertEqual(second["items"][0]["id"], f"{30:032x}")

    async def test_a_broken_shelf_leaves_the_videos(self):
        self.serve_search()
        self.answer(
            "/api/search/combined/cards/list",
            {"detail": "boom"},
            status=500,
            client="wdp",
            query=self.QUERY,
            page="1",
        )
        found = await self.cinema.search("rutube", self.QUERY)
        self.assertEqual((found["channels"], found["series"]), ([], []))
        self.assertEqual(len(found["items"]), 4)

    async def test_the_platform_saying_no_is_a_bad_gateway(self):
        self.answer("/api/search/video/", {"detail": "boom"}, status=503, query=self.QUERY)
        self.answer(
            "/api/search/combined/cards/list",
            recorded("search-cards.json"),
            client="wdp",
            query=self.QUERY,
            page="1",
        )
        await self.refused(
            self.cinema.search("rutube", self.QUERY), 502, "Rutube не ответил на запрос каталога"
        )

    async def test_a_network_failure_is_a_bad_gateway_too(self):
        self.answer("/api/search/video/", httpx.ConnectError("down"), query=self.QUERY)
        self.answer(
            "/api/search/combined/cards/list",
            recorded("search-cards.json"),
            client="wdp",
            query=self.QUERY,
            page="1",
        )
        await self.refused(
            self.cinema.search("rutube", self.QUERY), 502, "Rutube не ответил на запрос каталога"
        )

    async def test_searches_are_kept_by_query_under_the_platform_name(self):
        self.serve_search()
        await self.cinema.search("rutube", self.QUERY)
        self.assertEqual(
            self.kept(self.cinema.catalog),
            {f"rutube:search:{self.QUERY}": 120, f"rutube:cards:{self.QUERY}": 300},
        )


class CategoryTests(Stage):
    async def test_sections_are_one_portion_films_series_cartoons_and_tv_first(self):
        self.answer("/api/video/category/", recorded("categories.json"))
        found = await self.cinema.categories("rutube")
        names = {str(item["id"]): item["name"] for item in recorded("categories.json")}
        ids = [item["id"] for item in found["items"]]
        self.assertEqual(ids[:4], ["4", "5", "7", "43"])
        self.assertEqual(sorted(ids), sorted(names))
        self.assertIsNone(found["next"])
        self.assertEqual(
            found["items"][0],
            {
                "provider": "rutube",
                "kind": "category",
                "id": "4",
                "title": "Фильмы",
                "viewers": None,
                "poster": None,
            },
        )
        # Остальные — в порядке площадки.
        rest = [str(item["id"]) for item in recorded("categories.json") if str(item["id"]) not in ids[:11]]
        self.assertEqual(ids[11:], rest)

    async def test_typed_sections_are_found_by_name(self):
        self.answer("/api/video/category/", recorded("categories.json"))
        found = await self.cinema.categories("rutube", "мульт")
        self.assertEqual([item["title"] for item in found["items"]], ["Мультфильмы"])

    async def test_one_section_is_its_card_and_its_videos_page_by_page(self):
        self.answer("/api/video/category/", recorded("categories.json"))
        self.answer("/api/video/category/4/", recorded("category-4-page-1.json"), page="1")
        self.answer("/api/video/category/4/", recorded("category-4-page-2.json"), page="2")
        first = await self.cinema.category("rutube", "4")
        page = recorded("category-4-page-1.json")["results"]
        self.assertEqual(first["category"]["title"], "Фильмы")
        # «Для взрослых» мимо; страница площадки — сотня, и следующая порция начинается с неё.
        self.assertEqual(first["items"], [video_card(page[0]), video_card(page[2]), video_card(page[3])])
        self.assertEqual(first["next"], "100")
        second = await self.cinema.category("rutube", "4", first["next"])
        self.assertEqual(
            [item["id"] for item in second["items"]],
            [item["id"] for item in recorded("category-4-page-2.json")["results"]],
        )
        self.assertEqual(second["next"], "200")

    async def test_an_unknown_section_is_not_found(self):
        self.answer("/api/video/category/", recorded("categories.json"))
        await self.refused(self.cinema.category("rutube", "999"), 404, "Такого раздела на Rutube нет")


class ChannelTests(Stage):
    def serve_channel(self):
        self.answer("/api/profile/user/23460655/", recorded("profile-23460655.json"))
        self.answer("/api/video/person/23460655/", recorded("person-23460655-page-1.json"), page="1")

    async def test_the_videos_tab_is_the_profile_head_and_twenty_videos(self):
        self.serve_channel()
        found = await self.cinema.channel("rutube", "23460655")
        profile = recorded("profile-23460655.json")
        self.assertEqual(
            found["channel"],
            {
                "provider": "rutube",
                "id": "23460655",
                "title": profile["name"],
                "handle": "",
                "description": profile["description"],
                "followers": profile["subscribers_count"],
                "viewers": None,
                "live": False,
                "category": None,
                "avatar": image(profile["avatar_url"]),
                "banner": image(profile["appearance"]["cover_image"]),
            },
        )
        page = recorded("person-23460655-page-1.json")["results"]
        self.assertEqual(found["items"], [video_card(item) for item in page])
        # Страница площадки — двадцать; продолжение начинается со второй.
        self.assertEqual(found["next"], "20")

    async def test_the_about_tab_is_the_head_alone(self):
        self.serve_channel()
        found = await self.cinema.channel("rutube", "23460655", "about")
        self.assertEqual((found["items"], found["next"]), ([], None))
        self.assertEqual(found["channel"]["title"], "Первый канал")
        self.assertEqual(self.asked(), ["/api/profile/user/23460655/"])

    async def test_a_tab_rutube_does_not_have_is_empty(self):
        self.serve_channel()
        found = await self.cinema.channel("rutube", "23460655", "shorts")
        self.assertEqual((found["items"], found["next"]), ([], None))

    async def test_a_name_that_is_not_a_number_is_refused_before_asking(self):
        await self.refused(self.cinema.channel("rutube", "someone"), 400, "Непонятное имя канала")
        self.assertEqual(self.seen, [])

    async def test_an_unknown_channel_is_not_found(self):
        self.answer("/api/profile/user/1/", {"detail": "Not found"}, status=404)
        self.answer("/api/video/person/1/", {"detail": "Not found"}, status=404, page="1")
        await self.refused(self.cinema.channel("rutube", "1"), 404, "Такого канала на Rutube нет")


class SeriesTests(Stage):
    def serve_series(self):
        self.answer("/api/metainfo/tv/891161/", recorded("tv-891161.json"))
        self.answer("/api/metainfo/tv/891161/season/", recorded("tv-891161-season.json"))
        self.answer(
            "/api/metainfo/tv/891161/video",
            recorded("tv-891161-video-season-1-page-1.json"),
            season="1",
            page="1",
        )
        self.answer(
            "/api/metainfo/tv/891161/video",
            recorded("tv-891161-video-season-1-page-2.json"),
            season="1",
            page="2",
        )

    async def test_a_series_is_its_head_its_seasons_and_the_free_episodes_of_the_first(self):
        self.serve_series()
        found = await self.cinema.series("rutube", "891161")
        show = recorded("tv-891161.json")
        self.assertEqual(
            found["series"],
            {
                "id": "891161",
                "title": show["name"],
                "poster": image(show["picture"]),
                "description": show["description"],
                "year": 2008,
                "seasons": [{"id": str(n), "title": f"Сезон {n}"} for n in (1, 2, 3, 4)],
            },
        )
        self.assertEqual(found["season"], "1")
        episodes = recorded("tv-891161-video-season-1-page-1.json")["results"]
        # Вторая и третья серии — по подписке PREMIER: показать их комнате нельзя.
        self.assertEqual(found["items"], [video_card(episodes[0], badge="1 серия", series="891161")])
        self.assertEqual(found["next"], "20")

    async def test_episodes_continue_on_the_next_page_of_the_platform(self):
        self.serve_series()
        second = recorded("tv-891161-video-season-1-page-2.json")
        # Снятые серии второй страницы — по подписке; здесь они как будто бесплатные, чтобы
        # было что показать на второй странице.
        for item in second["results"]:
            item["common_subscription_product_codes"] = []
        self.answer("/api/metainfo/tv/891161/video", second, season="1", page="2")
        found = await self.cinema.series("rutube", "891161", "1", "20")
        self.assertEqual([item["id"] for item in found["items"]], [item["id"] for item in second["results"]])
        self.assertEqual(found["items"][0]["badge"], "21 серия")
        self.assertEqual(found["next"], "40")

    async def test_an_episode_of_a_show_is_an_issue_not_an_episode(self):
        # У телешоу серии зовутся выпусками — и площадка, и зрители говорят «3 выпуск».
        self.serve_series()
        show = recorded("tv-891161.json")
        show["type"] = {"id": 2, "name": "tvshow", "title": "Телепередача"}
        self.answer("/api/metainfo/tv/891161/", show)
        found = await self.cinema.series("rutube", "891161")
        self.assertEqual(found["items"][0]["badge"], "1 выпуск")

    async def test_a_page_of_episodes_all_sold_by_subscription_is_empty_but_goes_on(self):
        self.serve_series()
        found = await self.cinema.series("rutube", "891161", "1", "20")
        self.assertEqual((found["items"], found["next"]), ([], "40"))

    async def test_another_season_is_asked_by_its_number(self):
        self.serve_series()
        second = recorded("tv-891161-video-season-1-page-2.json")
        second["has_next"] = False
        self.answer("/api/metainfo/tv/891161/video", second, season="2", page="1")
        found = await self.cinema.series("rutube", "891161", "2")
        self.assertEqual((found["season"], found["next"]), ("2", None))
        self.assertIn("/api/metainfo/tv/891161/video?page=1&season=2", self.asked())

    async def test_the_season_of_leftovers_is_last_to_open_and_says_what_it_is(self):
        # Сезон «0» у площадки — нарезки и выпуски без сезона (так у «Универа» 2008 года).
        self.serve_series()
        seasons = recorded("tv-891161-season.json")
        seasons.insert(0, {**seasons[0], "number": 0})
        self.answer("/api/metainfo/tv/891161/season/", seasons)
        found = await self.cinema.series("rutube", "891161")
        self.assertEqual(found["season"], "1")
        self.assertEqual(found["series"]["seasons"][0], {"id": "0", "title": "Другое"})

    async def test_a_season_the_series_does_not_have_is_not_found(self):
        self.serve_series()
        await self.refused(self.cinema.series("rutube", "891161", "9"), 404, "Такого сезона у сериала нет")

    async def test_a_series_without_seasons_is_one_list(self):
        self.answer("/api/metainfo/tv/1799942/", recorded("tv-1799942.json"))
        self.answer("/api/metainfo/tv/1799942/season/", recorded("tv-1799942-season.json"))
        self.answer("/api/metainfo/tv/1799942/video", recorded("tv-1799942-video.json"), page="1")
        found = await self.cinema.series("rutube", "1799942")
        self.assertEqual((found["series"]["seasons"], found["season"], found["next"]), ([], None, None))
        episodes = recorded("tv-1799942-video.json")["results"]
        # Серия без номера (`episode: 0`) — без значка: «0 серия» ничего не говорит.
        self.assertEqual(found["items"], [video_card(item, series="1799942") for item in episodes])

    async def test_series_pages_are_kept_by_the_facade_under_the_platform_name(self):
        self.serve_series()
        await self.cinema.series("rutube", "891161")
        kept = self.kept(self.cinema.catalog)
        self.assertEqual(kept["rutube:series:891161::0"], 300)
        self.assertTrue(all(key.startswith("rutube:") for key in kept), kept)

    async def test_an_address_that_is_not_a_series_is_refused_before_asking(self):
        await self.refused(self.cinema.series("rutube", "abc"), 400, "Непонятный адрес сериала")
        await self.refused(self.cinema.series("rutube", "1/../2"), 400, "Непонятный адрес сериала")
        await self.refused(self.cinema.series("rutube", "891161", "1 2"), 400, "Непонятный сезон")
        self.assertEqual(self.seen, [])

    async def test_platforms_without_series_say_so(self):
        await self.refused(self.cinema.series("youtube", "891161"), 400, "У площадки YouTube такого нет")


class DetailsTests(Stage):
    async def test_an_episode_page_knows_its_author_numbers_and_series(self):
        video = "2ef6c76f797a803f88980667635aa3db"
        info = recorded(f"video-{video}.json")
        self.answer(f"/api/video/{video}/", info)
        found = await self.cinema.details("rutube", video, "video")
        self.assertEqual(
            found,
            {
                "provider": "rutube",
                "kind": "video",
                "id": video,
                "title": info["title"],
                "author": info["author"]["name"],
                "channelId": str(info["author"]["id"]),
                "channelAvatar": image(info["author"]["avatar_url"]),
                "duration": info["duration"],
                "live": False,
                "views": info["hits"],
                "viewers": None,
                "followers": None,
                "published": info["publication_ts"][:10],
                "category": info["category"]["name"],
                "description": info["description"],
                "poster": image(info["thumbnail_url"] + "?size=l"),
                "series": str(info["tv_show_id"]),
            },
        )

    async def test_a_live_channel_page_has_no_length_and_no_count_of_views(self):
        video = "c58f502c7bb34a8fcdd976b221fca292"
        # У эфира «Звезды» площадка тоже держит `tv_show_id` — но «все серии» у идущего эфира
        # ничего не значат, и двери к ним у страницы эфира нет.
        self.answer(f"/api/video/{video}/", {**recorded(f"video-{video}.json"), "tv_show_id": 24022})
        found = await self.cinema.details("rutube", video, "channel")
        self.assertEqual(
            (found["kind"], found["live"], found["duration"], found["views"]), ("channel", True, None, None)
        )
        self.assertNotIn("series", found)

    async def test_what_is_for_adults_or_for_money_has_no_page(self):
        video = "2ef6c76f797a803f88980667635aa3db"
        for field, value, detail in (
            ("is_adult", True, "Видео Rutube с пометкой «для взрослых» в кинозал не попадает"),
            ("is_paid", True, "Это платное видео Rutube — показать его комнате нельзя"),
            (
                "common_subscription_product_codes",
                ["PREMIER_RUTUBE_START"],
                "Это видео Rutube показывает только по подписке — показать его комнате нельзя",
            ),
        ):
            info = recorded(f"video-{video}.json")
            info[field] = value
            self.answer(f"/api/video/{video}/", info)
            self.cinema.catalog = Memo()
            await self.refused(self.cinema.details("rutube", video, "video"), 403, detail)

    async def test_a_video_that_is_gone_is_not_found(self):
        video = "0" * 32
        self.answer(f"/api/video/{video}/", {"detail": "Not found"}, status=404)
        await self.refused(self.cinema.details("rutube", video, "video"), 404, "Такого видео на Rutube нет")

    async def test_an_address_that_is_not_a_rutube_id_is_refused(self):
        await self.refused(
            self.cinema.details("rutube", "aqz-KE-bpKQ", "video"), 400, "Непонятный адрес видео"
        )


class SourceTests(Stage):
    def play(self, video, name, status=200):
        self.answer(f"/api/play/options/{video}/", recorded(name), status=status, **PLAY)

    def info(self, video, name=None, **changes):
        body = recorded(name or "video-2ef6c76f797a803f88980667635aa3db.json")
        body.update(changes)
        self.answer(f"/api/video/{video}/", body)

    async def test_a_video_is_its_balancer_playlist_signed_with_its_captions(self):
        video = "eb7cb809ae8917df1ab8fd493dd36d0f"
        self.play(video, "play-vod.json")
        self.info(video)
        found = await self.cinema.resolve(Resolve(provider="rutube", contentId=video), room=ROOM)
        options = recorded("play-vod.json")
        signer = Signer(SECRET)
        caption = options["captions"][0]
        self.assertEqual(
            found,
            {
                "provider": "rutube",
                "contentId": video,
                "title": options["title"],
                "author": options["author"]["name"],
                "duration": options["duration"] / 1000,
                "live": False,
                "kind": "hls",
                "url": proxied(
                    signer, options["video_balancer"]["m3u8"], "playlist", FIVE_HOURS, provider="rutube"
                ),
                "expiresAt": int((NOW + FIVE_HOURS) * 1000),
                "notice": None,
                "language": "",
                # Субтитры площадки — SRT, а `<track>` читает только WebVTT: их отдаёт маршрут,
                # который переводит одно в другое по дороге.
                "captions": [
                    {
                        "lang": "ru",
                        "label": caption["langTitle"],
                        "auto": False,
                        "url": proxied(signer, caption["file"], "subtitles", provider="rutube"),
                    }
                ],
                "poster": image(options["thumbnail_url"]),
            },
        )
        self.assertEqual(self.kept(self.cinema.sources), {f"rutube:video:{video}:False": 1800})

    async def test_a_live_channel_is_its_live_playlist(self):
        video = "c58f502c7bb34a8fcdd976b221fca292"
        self.play(video, "play-live.json")
        self.info(video, f"video-{video}.json")
        found = await self.cinema.resolve(
            Resolve(provider="rutube", contentId=video, kind="channel"), room=ROOM
        )
        options = recorded("play-live.json")
        self.assertEqual(
            (found["live"], found["duration"], found["captions"], found["kind"]), (True, None, [], "hls")
        )
        self.assertEqual(
            found["url"],
            proxied(
                Signer(SECRET),
                options["live_streams"]["hls"][0]["url"],
                "playlist",
                FIVE_HOURS,
                provider="rutube",
            ),
        )
        self.assertEqual(self.kept(self.cinema.sources), {f"rutube:channel:{video}:False": 45})

    async def test_what_is_sold_by_subscription_is_refused_in_plain_words(self):
        video = "b9bd0c1afd82e8cbffda03772db5a12e"
        self.play(video, "play-subscription.json", status=244)
        self.info(video)
        await self.refused(
            self.cinema.resolve(Resolve(provider="rutube", contentId=video), room=ROOM),
            403,
            "Это видео Rutube показывает только по подписке — показать его комнате нельзя",
        )

    async def test_what_the_platform_does_not_show_from_here_is_refused_in_plain_words(self):
        video = "7bd264d08bce224b56c3fdc31b252280"
        self.play(video, "play-blocked.json", status=244)
        self.info(video)
        await self.refused(
            self.cinema.resolve(Resolve(provider="rutube", contentId=video), room=ROOM),
            403,
            "Rutube не показывает это видео с нашего сервера: ограничение страны или прав на показ",
        )

    async def test_any_other_stub_of_the_player_is_its_own_words(self):
        video = "16efa50d11b6bcbda339f8410ea6e1d4"
        stub = recorded("play-blocked.json")
        stub["detail"] = {
            "name": "stream_yet_finished",
            "type": "player_stub",
            "languages": [
                {"lang": "rus", "title": "Трансляция закончилась", "description": "Скоро здесь будет запись"}
            ],
        }
        self.answer(f"/api/play/options/{video}/", stub, status=244, **PLAY)
        self.info(video)
        await self.refused(
            self.cinema.resolve(Resolve(provider="rutube", contentId=video), room=ROOM),
            404,
            "Rutube: Трансляция закончилась. Скоро здесь будет запись",
        )

    async def test_paid_adult_and_protected_videos_are_refused(self):
        video = "eb7cb809ae8917df1ab8fd493dd36d0f"
        cases = (
            ({"is_paid": True}, {}, "Это платное видео Rutube — показать его комнате нельзя"),
            ({"is_adult": True}, {}, "Видео Rutube с пометкой «для взрослых» в кинозал не попадает"),
            ({}, {"drm_token": "token"}, "Видео Rutube защищено DRM — показать его комнате нельзя"),
        )
        for info, options, detail in cases:
            body = recorded("play-vod.json")
            body.update(options)
            self.answer(f"/api/play/options/{video}/", body, **PLAY)
            self.info(video, **info)
            self.cinema.sources = Memo(capacity=64)
            await self.refused(
                self.cinema.resolve(Resolve(provider="rutube", contentId=video, refresh=True), room=ROOM),
                403,
                detail,
            )

    async def test_nothing_playable_is_an_honest_refusal(self):
        video = "eb7cb809ae8917df1ab8fd493dd36d0f"
        body = recorded("play-vod.json")
        body["video_balancer"] = {}
        self.answer(f"/api/play/options/{video}/", body, **PLAY)
        self.info(video)
        await self.refused(
            self.cinema.resolve(Resolve(provider="rutube", contentId=video), room=ROOM),
            502,
            "Rutube не отдал поток для этого видео. Попробуйте другое",
        )

    async def test_the_platform_failing_is_a_bad_gateway(self):
        video = "eb7cb809ae8917df1ab8fd493dd36d0f"
        self.answer(f"/api/play/options/{video}/", {"detail": "boom"}, status=500, **PLAY)
        self.info(video)
        await self.refused(
            self.cinema.resolve(Resolve(provider="rutube", contentId=video), room=ROOM),
            502,
            "Rutube не отдал видео",
        )


class NetTests(unittest.IsolatedAsyncioTestCase):
    async def test_rutube_goes_out_through_its_own_client(self):
        # Свой клиент — значит, свой выход: `CINEMA_PROXY_RUTUBE` действует только на Rutube.
        cinema = Cinema("secret", net=NetConfig(proxies={"rutube": "http://proxy.example:3128"}))
        self.addAsyncCleanup(cinema.close)
        asked = []

        def client_for(provider):
            asked.append(provider)
            return httpx.AsyncClient(
                transport=httpx.MockTransport(
                    lambda request: httpx.Response(200, json=recorded("categories.json"))
                )
            )

        with patch.object(cinema.net, "client_for", client_for):
            await cinema.categories("rutube")
        self.assertEqual(asked, ["rutube"])
        self.assertEqual(cinema.net.config.proxy_for("rutube"), "http://proxy.example:3128")


class PlaylistTests(unittest.TestCase):
    """Настоящие плейлисты Rutube через наш прокси: все их адреса — у нас, и ни одного чужого."""

    def setUp(self):
        self.signer = Signer(SECRET, {"rutube": Rutube.hosts}.get)

    def test_the_master_lists_both_cdn_copies_and_both_are_signed(self):
        options = recorded("play-vod.json")
        body = rewrite(
            recorded("master-vod.m3u8"), options["video_balancer"]["m3u8"], self.signer, provider="rutube"
        )
        addresses = [line for line in body.splitlines() if line and not line.startswith("#")]
        self.assertTrue(addresses)
        self.assertTrue(
            all(line.startswith("/api/v1/services/cinema/playlist?") for line in addresses), addresses
        )
        self.assertEqual(
            {urlsplit(self.opened("playlist", line)).hostname.split(".", 1)[1] for line in addresses},
            {"rtbcdn.ru", "rutube.ru"},
        )

    def test_a_licensed_master_on_uma_is_signed_too(self):
        options = recorded("play-uma.json")
        body = rewrite(
            recorded("master-uma.m3u8"), options["video_balancer"]["m3u8"], self.signer, provider="rutube"
        )
        addresses = [line for line in body.splitlines() if line and not line.startswith("#")]
        self.assertTrue(all(line.startswith("/api/v1/services/cinema/playlist?") for line in addresses))

    def test_a_film_is_numbered_and_a_live_stream_is_signed_segment_by_segment(self):
        reels = Reels(self.signer)
        base = recorded("variant-vod.url").strip()
        film = rewrite(recorded("variant-vod.m3u8"), base, self.signer, reels, provider="rutube")
        self.assertIn("seg/", film)
        live_base = recorded("variant-live.url").strip()
        live = rewrite(recorded("variant-live.m3u8"), live_base, self.signer, reels, provider="rutube")
        segments = [line for line in live.splitlines() if line and not line.startswith("#")]
        self.assertTrue(all(line.startswith("/api/v1/services/cinema/fetch?") for line in segments))
        # Время кадра у эфира остаётся как было: по нему комната встанет на одну секунду.
        self.assertIn("#EXT-X-PROGRAM-DATE-TIME:", live)

    def opened(self, route, line):
        query = parse_qs(urlsplit(line).query)
        return self.signer.open(route, query["u"][0], query["e"][0], query["s"][0], query["p"][0])


class SubtitleTests(unittest.TestCase):
    def test_srt_becomes_webvtt(self):
        text = webvtt(recorded("captions.srt").encode())
        self.assertTrue(text.startswith("WEBVTT\n\n"))
        self.assertIn("00:00:07.120 --> 00:00:17.240\nШУМ ВЕРТОЛЁТА", text)
        self.assertNotIn(",120", text)

    def test_windows_line_ends_a_byte_order_mark_and_short_hours_are_fixed(self):
        source = "﻿1\r\n0:00:01,5 --> 0:00:02,25\r\nПривет\r\n".encode("utf-8")
        self.assertEqual(webvtt(source), "WEBVTT\n\n1\n00:00:01.500 --> 00:00:02.250\nПривет\n")

    def test_old_files_in_windows_1251_are_read_too(self):
        source = "1\n00:00:01,000 --> 00:00:02,000\nПривет\n".encode("cp1251")
        self.assertIn("Привет", webvtt(source))

    def test_webvtt_passes_as_it_is(self):
        source = "WEBVTT\n\n00:01.000 --> 00:02.000\nHi, there\n"
        self.assertEqual(webvtt(source.encode()), source)

    def test_a_comma_in_the_text_is_not_a_time(self):
        source = "1\n00:00:01,000 --> 00:00:02,000\nРаз, два, 00:00:03,000\n".encode()
        self.assertIn("\nРаз, два, 00:00:03,000\n", webvtt(source))


class SubtitleRouteTests(unittest.IsolatedAsyncioTestCase):
    async def test_the_route_opens_only_its_own_signature_and_answers_webvtt(self):
        cinema = Cinema(SECRET, httpx.AsyncClient(transport=httpx.MockTransport(self.serve)))
        self.addAsyncCleanup(cinema.close)
        url = "https://pic.rtbcdn.ru/subtitle/86/71/8671001ac257808dfb5ea68d51243e4e.srt"
        response = await cinema.subtitles(url, "rutube")
        self.assertEqual(response.media_type, "text/vtt; charset=utf-8")
        self.assertTrue(response.body.decode().startswith("WEBVTT"))
        self.assertEqual(response.headers["cache-control"], "private, max-age=600")
        parts = cinema.signer.sign(url, 60, "subtitles", "rutube")
        self.assertEqual(cinema.signer.open("subtitles", parts["u"], parts["e"], parts["s"], parts["p"]), url)
        with self.assertRaises(HTTPException):
            cinema.signer.open("fetch", parts["u"], parts["e"], parts["s"], parts["p"])

    async def test_a_file_too_big_to_be_subtitles_is_refused(self):
        cinema = Cinema(
            SECRET,
            httpx.AsyncClient(
                transport=httpx.MockTransport(lambda request: httpx.Response(200, content=b"x" * (3 << 20)))
            ),
        )
        self.addAsyncCleanup(cinema.close)
        with self.assertRaises(HTTPException) as refusal:
            await cinema.subtitles("https://pic.rtbcdn.ru/subtitle/x.srt", "rutube")
        self.assertEqual(refusal.exception.status_code, 502)

    def serve(self, request):
        return httpx.Response(200, content=recorded("captions.srt").encode())


class RouteTests(unittest.TestCase):
    """Маршрут сериала через настоящий FastAPI: участие в комнате подменено, сеть — нет."""

    def serve(self):
        root = tempfile.TemporaryDirectory()
        self.addCleanup(root.cleanup)
        core = Core("http://core.test", "internal-test")
        core.member = AsyncMock(return_value=({"id": ROOM}, {"id": "member"}))
        with patch.dict(os.environ, {}):
            os.environ.pop("CINEMA_PROVIDERS", None)
            app = create_app(Path(root.name), core, telegram_enabled=False)
        self.addCleanup(app.state.store.db.close)
        self.app = app
        return TestClient(app, headers={"Authorization": "Bearer member.secret"})

    def test_the_series_route_answers_with_the_series_shape(self):
        client = self.serve()
        page = {
            "series": {
                "id": "1",
                "title": "Т",
                "poster": None,
                "description": "",
                "year": None,
                "seasons": [],
            },
            "season": None,
            "items": [],
            "next": None,
        }
        with patch.object(Rutube, "series", AsyncMock(return_value=page)) as asked:
            answer = client.get(
                f"/api/v1/services/rooms/{ROOM}/cinema/series",
                params={"provider": "rutube", "id": "891161", "season": "2", "cursor": ""},
            )
        self.assertEqual((answer.status_code, answer.json()), (200, page))
        self.assertEqual(asked.await_args.args[1:], ("891161", "2", 0))

    def test_the_platforms_list_now_names_rutube_with_series_and_live(self):
        client = self.serve()
        entries = client.get(f"/api/v1/services/rooms/{ROOM}/cinema/providers").json()["providers"]
        self.assertEqual([entry["id"] for entry in entries], ["youtube", "twitch", "rutube"])
        self.assertEqual(
            entries[2]["features"],
            {
                "search": True,
                "channels": True,
                "playlists": False,
                "categories": True,
                "series": True,
                "live": True,
            },
        )

    def test_the_subtitles_route_is_open_by_signature(self):
        client = self.serve()
        cinema = self.app.state.cinema
        url = "https://pic.rtbcdn.ru/subtitle/x.srt"
        signed = proxied(cinema.signer, url, "subtitles", provider="rutube")
        vtt = Response(b"WEBVTT\n\n", media_type="text/vtt; charset=utf-8")
        with patch.object(Cinema, "subtitles", AsyncMock(return_value=vtt)) as asked:
            answer = client.get(signed)
        self.assertEqual((answer.status_code, answer.text), (200, "WEBVTT\n\n"))
        self.assertEqual(asked.await_args.args, (url, "rutube"))


class KitTests(unittest.TestCase):
    def test_the_provider_is_built_like_the_others(self):
        rutube = Rutube(Kit(memo=Memo(), image=lambda url: None, ytdlp=YtDlp()))
        self.assertEqual(rutube.id, "rutube")


if __name__ == "__main__":
    unittest.main()
