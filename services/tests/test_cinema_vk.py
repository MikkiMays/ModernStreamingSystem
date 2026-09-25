"""
VK Видео в кинозале: что служба отдаёт по настоящим ответам площадки.

ОТКУДА ОТВЕТЫ. `fixtures/vk/` — ответы api.vkvideo.ru, login.vk.ru и api.live.vkvideo.ru, снятые
запросами с сервера 24.09.2026 и обрезанные: по пять-шесть роликов, без адресов файлов, пикселей
статистики и `track_code`, описания — до 120 знаков. Токен в ответе входа выдуманный: настоящий в
фикстуры не попадает. Адрес сервера в адресах потока заменён на 203.0.113.7 (адрес для примеров).
Если тесту нужен случай, которого в снятом нет, он берёт настоящую запись и меняет в ней ровно одно
поле — прямо в тесте, на виду.

ГДЕ ПОДМЕНА. Сеть — транспортом httpx: тест знает адреса и методы площадки, а не то, какой метод
какой класс зовёт. Часы — свои: от них зависят срок токена и подпись адресов.
"""

import asyncio
import copy
import json
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import httpx
from fastapi import HTTPException
from fastapi.testclient import TestClient

from cord_services.cinema import Cinema, Reels, Signer, rewrite
from cord_services.cinema.memo import Memo
from cord_services.cinema.net import USER_AGENT, NetConfig
from cord_services.cinema.providers import PROVIDERS
from cord_services.cinema.providers.vk import BROWSER, People, Vk, _picture
from cord_services.cinema.registry import Features, Kit
from cord_services.cinema.resolve import Resolver, YtDlp, ytdlp
from cord_services.cinema.transport.signer import proxied

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "vk"
# Сразу после съёмки: анонимный токен из неё живёт до 1 790 351 185 (сутки).
NOW = 1_790_265_000.0
EXPIRES = 1_790_351_185
SECRET = "secret"
DAY = 24 * 3600
ROOM = str(uuid.uuid4())
TOKEN = "anonym.test-token-not-real"
SECOND = "anonym.second-test-token"

SECTIONS = json.loads((FIXTURES / "catalog-sections.json").read_text())["response"]["catalog"]["sections"]
ALL = SECTIONS[0]["id"]


def recorded(name):
    """Снятый ответ площадки; каждый раз — свежая копия."""
    path = FIXTURES / name
    text = path.read_text(encoding="utf-8")
    return json.loads(text) if path.suffix == ".json" else text


def image(url):
    """Картинка у нас: подписанный на сутки адрес маршрута `image` от имени VK."""
    return proxied(Signer(SECRET), url, "image", DAY, provider="vk")


def frame(item, width):
    """Кадр ролика без полей этой ширины — так в ответе площадки, без всякого выбора."""
    return next(
        entry["url"] for entry in item["image"] if entry["width"] == width and not entry.get("with_padding")
    )


def names(data):
    return {-group["id"]: group["name"] for group in data.get("groups", [])}


def video_card(item, author):
    """Ролик так, как его отдаёт каталог VK: ключи и пустоты — как у плиток YouTube."""
    return {
        "provider": "vk",
        "kind": "video",
        "id": f"{item['owner_id']}_{item['id']}",
        "title": item["title"],
        "author": author,
        "channelId": str(item["owner_id"]),
        "duration": item["duration"] or None,
        "live": False,
        "viewers": None,
        "views": item["views"],
        # Плитке — кадр 720×405, а не исходник 1280 и больше: сетке крупнее не нужно.
        "poster": image(frame(item, 720)),
    }


class Stage(unittest.IsolatedAsyncioTestCase):
    """Свои часы и сеть, которая знает только вход, API и API эфиров VK — и то, что ей велели."""

    def setUp(self):
        self.now = NOW
        clock = patch("time.time", side_effect=lambda: self.now)
        clock.start()
        self.addCleanup(clock.stop)
        self.seen = []
        self.logins = []
        self.entries = []
        self.calls = []
        self.api = {}
        self.blogs = {}
        self.cinema = Cinema(SECRET, httpx.AsyncClient(transport=httpx.MockTransport(self.serve)))
        self.vk = self.cinema.registry.get("vk")

    async def asyncTearDown(self):
        await self.cinema.close()

    # --- что отвечает площадка ---------------------------------------------------------

    def answer(self, method, body, status=200, **form):
        """Ответ метода API на эти поля формы (без токена). Несколько — по очереди, последний — всегда."""
        self.api.setdefault(self.key(method, form), []).append((status, body))

    def key(self, method, form):
        return method + "?" + "&".join(f"{name}={value}" for name, value in sorted(form.items()))

    def serve(self, request):
        self.seen.append(request)
        agent = request.headers.get("user-agent", "")
        assert "Chrome/" in agent, agent
        host = request.url.host
        if host == "login.vk.ru":
            assert request.method == "POST" and request.url.params["act"] == "get_anonym_token"
            form = {name: values[0] for name, values in parse_qs(request.content.decode()).items()}
            self.logins.append(form)
            assert request.headers["origin"] == "https://vkvideo.ru", request.headers
            status, body = self.entries.pop(0) if self.entries else (200, recorded("token.json"))
            if isinstance(body, BaseException):
                raise body
            return httpx.Response(status, **({"text": body} if isinstance(body, str) else {"json": body}))
        if host == "api.vkvideo.ru":
            assert request.method == "POST"
            # Токен — только в теле запроса: в адресе он оседал бы в журналах всех прокси по пути.
            assert "access_token" not in str(request.url), request.url
            assert dict(request.url.params) == {"v": "5.289", "client_id": "52461373", "lang": "ru"}
            assert request.headers["origin"] == "https://vkvideo.ru"
            assert request.headers["referer"] == "https://vkvideo.ru/"
            method = request.url.path.removeprefix("/method/")
            form = {name: values[0] for name, values in parse_qs(request.content.decode()).items()}
            token = form.pop("access_token")
            self.calls.append((method, form, token))
            answers = self.api.get(self.key(method, form))
            if not answers:
                raise AssertionError(f"Площадку спросили о неожиданном: {self.key(method, form)}")
            status, body = answers.pop(0) if len(answers) > 1 else answers[0]
            if isinstance(body, BaseException):
                raise body
            return httpx.Response(status, json=body)
        if host == "api.live.vkvideo.ru":
            slug = request.url.path.split("/")[3]
            status, body = self.blogs[slug]
            if isinstance(body, BaseException):
                raise body
            return httpx.Response(status, json=body)
        raise AssertionError(f"Неожиданный запрос наружу: {request.url}")

    def methods(self):
        return [method for method, _, _ in self.calls]

    def sections(self):
        self.answer("catalog.getVideo", recorded("catalog-sections.json"), need_blocks="1", owner_id="0")

    async def refused(self, action, status, detail):
        with self.assertRaises(HTTPException) as refusal:
            await action
        self.assertEqual((refusal.exception.status_code, refusal.exception.detail), (status, detail))


class PlatformTests(unittest.TestCase):
    def test_vk_is_the_fourth_platform_and_says_what_it_has(self):
        # После VK — только общий путь «По ссылке» (задача 15b): он не площадка каталога.
        self.assertEqual(
            [kind.id for kind in PROVIDERS], ["youtube", "twitch", "rutube", "vk", "ivi", "link"]
        )
        self.assertEqual(Vk.name, "VK Видео")
        self.assertEqual(Vk.features, Features(channels=True, playlists=True, categories=True, live=True))

    def test_its_addresses_are_videos_and_live_channels(self):
        for good in ("-22277933_456242578", "1_456239017", "near_you", "Igromania2"):
            self.assertTrue(Vk.content_id.fullmatch(good), good)
        for wrong in ("-22277933_", "-near_you", "a-b", "x" * 65, "٣_٤", "near you", "a/b", ""):
            self.assertIsNone(Vk.content_id.fullmatch(wrong), wrong)

    def test_its_sections_are_named_by_its_own_strings(self):
        for section in SECTIONS:
            self.assertTrue(Vk.category_id.fullmatch(section["id"]), section["id"])
        for wrong in ("a/b", "a.b", "x" * 129, ""):
            self.assertIsNone(Vk.category_id.fullmatch(wrong), wrong)

    def test_its_hosts_are_exactly_those_its_streams_and_pictures_come_from(self):
        # Каждый — из живых ответов: CDN роликов, эфиров и VK Видео Live, кадры, лица и обложки.
        for host in (
            "vk6-12.vkuser.net",
            "vk6-3.vkuser.net",
            "vkvsd22.okcdn.ru",
            "vsd162.okcdn.ru",
            "vkvd578.okcdn.ru",
            "iv.okcdn.ru",
            "sun1-91.userapi.com",
            "sun9-20.vkuserphoto.ru",
            "images.live.vkvideo.ru",
        ):
            self.assertTrue(Vk.hosts.allows(host), host)
        # Страницы, пиксели статистики и то, чего в ответах не было, — не наши.
        for host in (
            "vk.com",
            "vk.ru",
            "33212.ms.vk.ru",
            "vkvideo.ru",
            "live.vkvideo.ru",
            "api.vkvideo.ru",
            "mycdn.me",
            "vkuser.net.evil.com",
            "evilokcdn.ru",
            "googlevideo.com",
        ):
            self.assertFalse(Vk.hosts.allows(host), host)

    def test_the_platform_speaks_as_a_desktop_browser(self):
        self.assertIn("Chrome/", Vk.user_agent)
        self.assertEqual(Vk.user_agent, BROWSER)


class TokenTests(Stage):
    async def test_the_token_is_taken_once_and_kept_until_five_minutes_before_its_end(self):
        self.sections()
        await self.cinema.categories("vk", room=ROOM)
        self.assertEqual(len(self.logins), 1)
        self.assertEqual(
            self.logins[0],
            {
                "client_id": "52461373",
                "client_secret": "o557NLIkAErNhakXrQ7A",
                "app_id": "52461373",
                "version": "1",
                "scopes": "audio_anonymous,video_anonymous,photos_anonymous,profile_anonymous",
                "isApiOauthAnonymEnabled": "false",
            },
        )
        self.assertEqual([token for _, _, token in self.calls], [TOKEN])
        # Раздел за пять минут до конца суток — ещё тот же токен; позже — новый.
        self.answer("catalog.getSection", recorded("section-all.json"), section_id=ALL)
        self.now = EXPIRES - 301
        await self.cinema.category("vk", ALL, room=ROOM)
        self.assertEqual(len(self.logins), 1)
        self.now = EXPIRES - 299
        self.answer("catalog.getSection", recorded("section-music.json"), section_id=SECTIONS[3]["id"])
        await self.cinema.category("vk", SECTIONS[3]["id"], room=ROOM)
        self.assertEqual(len(self.logins), 2)

    async def test_questions_that_arrive_together_share_one_entry(self):
        details = recorded("video-details.json")
        for number in range(5):
            self.answer("video.get", details, videos=f"-211232966_{456241474 + number}", extended="1")
        await asyncio.gather(
            *(
                self.cinema.details("vk", f"-211232966_{456241474 + number}", "video", room=ROOM)
                for number in range(5)
            )
        )
        self.assertEqual(len(self.logins), 1)
        self.assertEqual(len(self.calls), 5)

    async def test_a_token_the_platform_no_longer_accepts_is_replaced_once(self):
        self.entries = [
            (200, recorded("token.json")),
            (200, {"type": "okay", "data": {"access_token": SECOND, "expired_at": EXPIRES}}),
        ]
        self.answer("catalog.getVideo", recorded("error-invalid-token.json"), need_blocks="1", owner_id="0")
        self.answer("catalog.getVideo", recorded("catalog-sections.json"), need_blocks="1", owner_id="0")
        found = await self.cinema.categories("vk", room=ROOM)
        self.assertEqual(len(found["items"]), len(SECTIONS))
        self.assertEqual(len(self.logins), 2)
        self.assertEqual([token for _, _, token in self.calls], [TOKEN, SECOND])

    async def test_a_second_refusal_in_a_row_is_a_closed_door_not_a_loop(self):
        self.answer("catalog.getVideo", recorded("error-no-token.json"), need_blocks="1", owner_id="0")
        await self.refused(
            self.cinema.categories("vk", room=ROOM),
            502,
            "VK Видео не пустил каталог: анонимный вход не принят",
        )
        self.assertEqual(len(self.logins), 2)
        self.assertEqual(len(self.calls), 2)

    async def test_a_failed_entry_rests_half_a_minute_before_asking_again(self):
        self.entries = [(429, "<html>429 Too Many Requests</html>")]
        self.sections()
        no_entry = "VK Видео не пустил каталог: анонимный вход не принят"
        await self.refused(self.cinema.categories("vk", room=ROOM), 502, no_entry)
        self.now += 29
        await self.refused(self.cinema.categories("vk", room=ROOM), 502, no_entry)
        self.assertEqual(len(self.logins), 1)
        self.now += 2
        found = await self.cinema.categories("vk", room=ROOM)
        self.assertEqual(len(self.logins), 2)
        self.assertEqual(len(found["items"]), len(SECTIONS))

    async def test_a_silent_entry_is_the_same_closed_door(self):
        self.entries = [(200, httpx.ConnectError("boom"))]
        await self.refused(
            self.cinema.categories("vk", room=ROOM),
            502,
            "VK Видео не пустил каталог: анонимный вход не принят",
        )

    async def test_the_token_is_not_written_to_the_log_even_when_everything_fails(self):
        self.answer("video.get", recorded("error-no-token.json"), videos="-211232966_456241474")
        with self.assertLogs("cord_services", "DEBUG") as log:
            plan = await self.vk.source(self.vk_ctx(), "video", "-211232966_456241474", {})
        self.assertEqual(plan.url, "https://vkvideo.ru/video-211232966_456241474")
        self.assertNotIn("anonym.", "\n".join(log.output))

    def vk_ctx(self):
        return self.cinema._ctx(ROOM, self.vk)

    def test_forgetting_a_stale_token_keeps_the_one_taken_meanwhile(self):
        vk = Vk(Kit(memo=Memo().scope("vk"), image=lambda url: None, ytdlp=YtDlp()))
        vk.token._value, vk.token._until = SECOND, NOW + 3600
        vk.token.forget(TOKEN)
        self.assertEqual(vk.token._value, SECOND)
        vk.token.forget(SECOND)
        self.assertIsNone(vk.token._value)


class CatalogTests(Stage):
    async def test_the_sections_are_the_platform_own_in_its_order(self):
        self.sections()
        found = await self.cinema.categories("vk", room=ROOM)
        self.assertEqual(
            found,
            {
                "items": [
                    {
                        "provider": "vk",
                        "kind": "category",
                        "id": section["id"],
                        "title": section["title"],
                        "viewers": None,
                        "poster": None,
                    }
                    for section in SECTIONS
                ],
                "next": None,
            },
        )
        self.assertEqual(found["items"][0]["title"], "Все")
        # Разделы площадка отдаёт по адресу сервера и меняет редко: час в памяти.
        self.assertEqual(self.kept(), {"vk:sections": 3600})

    def kept(self):
        return {key: round(expiry - NOW) for key, (expiry, _) in self.cinema.catalog._items.items()}

    async def test_a_section_is_its_grid_of_videos_and_goes_on_from_its_mark(self):
        self.sections()
        first = recorded("section-all.json")
        self.answer("catalog.getSection", first, section_id=ALL)
        page = await self.cinema.category("vk", ALL, room=ROOM)
        people = names(first["response"])
        self.assertEqual(page["category"]["title"], "Все")
        self.assertEqual(
            page["items"],
            [video_card(item, people[item["owner_id"]]) for item in first["response"]["videos"]],
        )
        self.assertEqual(page["next"], "1")
        # Запись прошедшего эфира (`postlive`) — обычный ролик с перемоткой, а не эфир.
        self.assertEqual(page["items"][3]["kind"], "video")

        block = first["response"]["section"]["blocks"][0]
        second = recorded("section-all-2.json")
        self.answer("catalog.getBlockItems", second, block_id=block["id"], start_from=block["next_from"])
        more = await self.cinema.category("vk", ALL, "1", room=ROOM)
        people = names(second["response"])
        self.assertEqual(
            more["items"],
            [video_card(item, people[item["owner_id"]]) for item in second["response"]["videos"]],
        )
        self.assertEqual(more["next"], "2")
        # Первая страница — из памяти: за второй сходили один раз.
        self.assertEqual(self.methods(), ["catalog.getVideo", "catalog.getSection", "catalog.getBlockItems"])

    async def test_a_page_deep_in_a_forgotten_chain_walks_the_chain_again(self):
        self.sections()
        first = recorded("section-all.json")
        block = first["response"]["section"]["blocks"][0]
        second = recorded("section-all-2.json")
        self.answer("catalog.getSection", first, section_id=ALL)
        self.answer("catalog.getBlockItems", second, block_id=block["id"], start_from=block["next_from"])
        tail = copy.deepcopy(second)
        tail["response"]["block"]["next_from"] = None
        self.answer(
            "catalog.getBlockItems",
            tail,
            block_id=block["id"],
            start_from=second["response"]["block"]["next_from"],
        )
        found = await self.cinema.category("vk", ALL, "2", room=ROOM)
        self.assertEqual(
            self.methods()[1:], ["catalog.getSection", "catalog.getBlockItems", "catalog.getBlockItems"]
        )
        self.assertEqual(len(found["items"]), 6)
        self.assertIsNone(found["next"])
        # Дальше конца — пусто, и площадку больше не спрашивают.
        self.assertEqual(
            await self.cinema.category("vk", ALL, "3", room=ROOM), {**found, "items": [], "next": None}
        )
        self.assertEqual(len(self.calls), 4)

    async def test_a_page_with_nothing_to_show_is_skipped_by_the_service(self):
        self.sections()
        first = recorded("section-all.json")
        for item in first["response"]["videos"]:
            item["restriction"] = {"title": "Недоступно в\xa0вашем регионе", "can_play": 0}
        block = first["response"]["section"]["blocks"][0]
        self.answer("catalog.getSection", first, section_id=ALL)
        self.answer(
            "catalog.getBlockItems",
            recorded("section-all-2.json"),
            block_id=block["id"],
            start_from=block["next_from"],
        )
        page = await self.cinema.category("vk", ALL, room=ROOM)
        self.assertEqual(len(page["items"]), 6)
        self.assertEqual(page["next"], "2")

    async def test_empty_pages_are_walked_three_at_most(self):
        self.sections()
        first = recorded("section-all.json")
        first["response"]["videos"] = []
        block = first["response"]["section"]["blocks"][0]
        self.answer("catalog.getSection", first, section_id=ALL)
        empty = {
            "response": {"block": {"id": block["id"], "next_from": "more", "videos_ids": []}, "videos": []}
        }
        self.answer("catalog.getBlockItems", empty, block_id=block["id"], start_from=block["next_from"])
        self.answer("catalog.getBlockItems", empty, block_id=block["id"], start_from="more")
        page = await self.cinema.category("vk", ALL, room=ROOM)
        self.assertEqual(page, {"category": page["category"], "items": [], "next": "3"})
        self.assertEqual(
            self.methods()[1:], ["catalog.getSection", "catalog.getBlockItems", "catalog.getBlockItems"]
        )

    async def test_the_feed_is_not_walked_deeper_than_its_limit(self):
        self.sections()
        self.answer("catalog.getSection", recorded("section-all.json"), section_id=ALL)
        found = await self.cinema.category("vk", ALL, "31", room=ROOM)
        self.assertEqual((found["items"], found["next"]), ([], None))
        self.assertEqual(self.methods(), ["catalog.getVideo"])

    async def test_an_unknown_section_is_said_so_and_a_crooked_one_is_not_asked_at_all(self):
        self.sections()
        await self.refused(
            self.cinema.category("vk", "PUnknown", room=ROOM), 404, "Такого раздела на VK Видео нет"
        )
        await self.refused(self.cinema.category("vk", "a.b/c", room=ROOM), 400, "Непонятный раздел")
        self.assertEqual(self.methods(), ["catalog.getVideo"])

    async def test_search_is_the_videos_of_its_results_and_communities_above_them(self):
        query = "маша и медведь"
        found = recorded("search.json")
        authors = recorded("search-authors.json")
        self.answer("catalog.getVideoSearchWeb2", found, q=query)
        self.answer("catalog.getVideoSearchWeb2", authors, q=query, content_type="author")
        page = await self.cinema.search("vk", query, room=ROOM)
        wrappers = {
            f"{w['video']['owner_id']}_{w['video']['id']}": w["video"]
            for w in found["response"]["catalog_videos"]
        }
        # Только ряды «Все видео», по порядку; клипы, «новые видео автора» и то, что отсюда не
        # играет (три ролика «недоступно в вашем регионе»), в ленту не идут.
        self.assertEqual(
            page["items"],
            [
                video_card(wrappers[identity], "Маша и Медведь")
                for identity in ("-22277933_456242381", "-22277933_456242382", "-22277933_456242370")
            ],
        )
        self.assertEqual(page["next"], "1")
        groups = {group["id"]: group for group in authors["response"]["groups"]}
        self.assertEqual(
            page["channels"],
            [
                {
                    "provider": "vk",
                    "kind": "channel",
                    "id": str(entry["id"]),
                    "title": groups[-entry["id"]]["name"],
                    "author": "",
                    "channelId": str(entry["id"]),
                    "duration": None,
                    "live": False,
                    "viewers": None,
                    "views": None,
                    "followers": groups[-entry["id"]]["members_count"],
                    "description": groups[-entry["id"]]["activity"].replace("\xa0", " "),
                    "poster": image(groups[-entry["id"]]["photo_200"]),
                }
                for entry in authors["response"]["catalog"]["sections"][0]["blocks"][0]["search_author_items"]
            ],
        )
        self.assertEqual(page["channels"][3]["description"], "Кино и мультфильмы")
        self.assertEqual(page["categories"], [])

        section = found["response"]["catalog"]["sections"][0]
        more = recorded("search-2.json")
        self.answer("catalog.getSection", more, section_id=section["id"], start_from=section["next_from"])
        second = await self.cinema.search("vk", query, "1", room=ROOM)
        # Из четырёх роликов продолжения два отсюда не играют — в ленте их нет.
        self.assertEqual(
            [card["id"] for card in second["items"]], ["-22277933_456242380", "-22277933_456242369"]
        )
        self.assertEqual(second["channels"], [])
        # Полку сообществ второй порцией не ищут заново.
        self.assertEqual(self.methods().count("catalog.getVideoSearchWeb2"), 2)

    async def test_a_failed_communities_shelf_is_an_empty_shelf(self):
        query = "маша и медведь"
        self.answer("catalog.getVideoSearchWeb2", recorded("search.json"), q=query)
        self.answer(
            "catalog.getVideoSearchWeb2",
            {"error": {"error_code": 10}},
            status=500,
            q=query,
            content_type="author",
        )
        with self.assertLogs("cord_services.cinema.providers.vk", "WARNING"):
            page = await self.cinema.search("vk", query, room=ROOM)
        self.assertEqual(page["channels"], [])
        self.assertEqual(len(page["items"]), 3)
        self.assertNotIn("vk:authors:" + query, self.cinema.catalog._items)

    async def test_an_empty_query_asks_nothing(self):
        page = await self.cinema.search("vk", "  ", room=ROOM)
        self.assertEqual(page, {"items": [], "next": None, "channels": [], "categories": []})
        self.assertEqual(self.seen, [])

    async def test_a_live_stream_is_a_channel_and_one_not_started_is_not_shown(self):
        live = recorded("search-live.json")
        self.answer("catalog.getVideoSearchWeb2", live, q="прямой эфир")
        self.answer(
            "catalog.getVideoSearchWeb2",
            {"response": {"catalog": {"sections": []}}},
            q="прямой эфир",
            content_type="author",
        )
        page = await self.cinema.search("vk", "прямой эфир", room=ROOM)
        on_air = live["response"]["catalog_videos"][1]["video"]
        # Эфир НТВ идёт, но отсюда не играет («недоступно в вашем регионе»), а третий ещё не начался.
        self.assertEqual(
            page["items"],
            [
                {
                    "provider": "vk",
                    "kind": "channel",
                    "id": "-88298195_456260712",
                    "title": on_air["title"],
                    "author": names(live["response"])[-88298195],
                    "channelId": "-88298195",
                    "duration": None,
                    "live": True,
                    "viewers": 10,
                    "views": None,
                    "poster": image(frame(on_air, 720)),
                }
            ],
        )
        self.assertIsNone(page["next"])


class ChannelTests(Stage):
    def head(self):
        self.answer(
            "groups.getById",
            recorded("group-22277933.json"),
            group_ids="22277933",
            fields="members_count,activity,description,cover,photo_200,verified,screen_name",
        )

    async def test_a_community_is_its_head_and_its_videos_by_thirty(self):
        self.head()
        videos = recorded("video-get-22277933.json")
        self.answer("video.get", videos, owner_id="-22277933", count="30", offset="0", extended="1")
        page = await self.cinema.channel("vk", "-22277933", room=ROOM)
        group = recorded("group-22277933.json")["response"]["groups"][0]
        self.assertEqual(
            page["channel"],
            {
                "provider": "vk",
                "id": "-22277933",
                "title": "Маша и Медведь",
                "handle": "",
                "description": group["description"],
                "followers": 817250,
                "viewers": None,
                "live": False,
                "category": "Мультфильм",
                "avatar": image(group["photo_200"]),
                "banner": image(group["cover"]["images"][0]["url"]),
            },
        )
        self.assertEqual(
            page["items"], [video_card(item, "Маша и Медведь") for item in videos["response"]["items"]]
        )
        self.assertEqual(page["next"], "30")

    async def test_its_playlists_are_doors_with_their_owner_name(self):
        self.head()
        albums = recorded("albums-22277933.json")
        self.answer("video.getAlbums", albums, owner_id="-22277933", count="30", offset="0", extended="1")
        page = await self.cinema.channel("vk", "-22277933", "playlists", room=ROOM)
        first = albums["response"]["items"][0]
        self.assertEqual(
            page["items"][0],
            {
                "provider": "vk",
                "kind": "playlist",
                "id": "-22277933_56093284",
                "title": "Маша и Медведь. Сезон 8",
                "author": "Маша и Медведь",
                "channelId": "-22277933",
                "duration": None,
                "live": False,
                "viewers": None,
                "views": None,
                "count": 23,
                # У обложек плейлистов у площадки только кадры с полями: берётся 320 px.
                "poster": image(next(entry["url"] for entry in first["image"] if entry["width"] == 320)),
            },
        )
        self.assertEqual(len(page["items"]), 4)
        # Двадцать плейлистов — одна порция.
        self.assertIsNone(page["next"])

    async def test_an_empty_or_service_playlist_is_not_shown(self):
        self.head()
        albums = recorded("albums-22277933.json")
        albums["response"]["items"][1]["count"] = 0
        albums["response"]["items"][2]["id"] = -2
        self.answer("video.getAlbums", albums, owner_id="-22277933", count="30", offset="0", extended="1")
        page = await self.cinema.channel("vk", "-22277933", "playlists", room=ROOM)
        self.assertEqual([card["id"] for card in page["items"]], ["-22277933_56093284", "-22277933_56093276"])

    async def test_another_tab_is_the_head_without_asking_for_videos(self):
        self.head()
        page = await self.cinema.channel("vk", "-22277933", "about", room=ROOM)
        self.assertEqual(
            (page["channel"]["title"], page["items"], page["next"]), ("Маша и Медведь", [], None)
        )
        self.assertEqual(self.methods(), ["groups.getById"])

    async def test_a_person_is_a_channel_too(self):
        self.answer(
            "users.get", recorded("user-1.json"), user_ids="1", fields="photo_200,followers_count,screen_name"
        )
        page = await self.cinema.channel("vk", "1", "about", room=ROOM)
        self.assertEqual(page["channel"]["title"], "Павел Дуров")

    async def test_a_community_that_is_not_there_is_said_so(self):
        self.answer(
            "groups.getById",
            recorded("group-missing.json"),
            group_ids="999999999",
            fields="members_count,activity,description,cover,photo_200,verified,screen_name",
        )
        self.answer(
            "video.get",
            recorded("error-access.json"),
            owner_id="-999999999",
            count="30",
            offset="0",
            extended="1",
        )
        await self.refused(
            self.cinema.channel("vk", "-999999999", room=ROOM), 404, "Такого сообщества на VK Видео нет"
        )

    async def test_closed_videos_are_a_refusal_in_words(self):
        self.head()
        self.answer(
            "video.get",
            recorded("error-access.json"),
            owner_id="-22277933",
            count="30",
            offset="0",
            extended="1",
        )
        await self.refused(
            self.cinema.channel("vk", "-22277933", room=ROOM),
            403,
            "VK Видео не показывает это: доступ закрыт",
        )

    async def test_a_crooked_name_is_not_asked(self):
        for wrong in ("-abc", "0", "-0", "01"):
            await self.refused(self.cinema.channel("vk", wrong, room=ROOM), 400, "Непонятное имя сообщества")
        self.assertEqual(self.seen, [])


class PlaylistTests(Stage):
    async def test_a_playlist_is_its_head_and_its_videos_in_order(self):
        self.answer(
            "groups.getById",
            recorded("group-22277933.json"),
            group_ids="22277933",
            fields="members_count,activity,description,cover,photo_200,verified,screen_name",
        )
        album = recorded("album-22277933_56093284.json")
        self.answer("video.getAlbumById", album, owner_id="-22277933", album_id="56093284")
        videos = recorded("album-videos-22277933_56093284.json")
        self.answer(
            "video.get",
            videos,
            owner_id="-22277933",
            album_id="56093284",
            count="30",
            offset="0",
            extended="1",
        )
        page = await self.cinema.playlist("vk", "-22277933_56093284", room=ROOM)
        self.assertEqual(
            page["playlist"],
            {
                "provider": "vk",
                "kind": "playlist",
                "id": "-22277933_56093284",
                "title": "Маша и Медведь. Сезон 8",
                "author": "Маша и Медведь",
                "channelId": "-22277933",
                "description": "",
                "count": 23,
                "views": None,
                "published": "2026-09-10",
                "poster": image(
                    next(entry["url"] for entry in album["response"]["image"] if entry["width"] == 800)
                ),
            },
        )
        self.assertEqual(
            page["items"], [video_card(item, "Маша и Медведь") for item in videos["response"]["items"]]
        )
        self.assertIsNone(page["next"])

    async def test_a_playlist_that_is_not_there_is_said_so(self):
        self.answer(
            "groups.getById",
            recorded("group-22277933.json"),
            group_ids="22277933",
            fields="members_count,activity,description,cover,photo_200,verified,screen_name",
        )
        self.answer("video.getAlbumById", recorded("error-album.json"), owner_id="-22277933", album_id="1")
        self.answer(
            "video.get",
            recorded("error-album.json"),
            owner_id="-22277933",
            album_id="1",
            count="30",
            offset="0",
            extended="1",
        )
        await self.refused(
            self.cinema.playlist("vk", "-22277933_1", room=ROOM), 404, "Такого плейлиста на VK Видео нет"
        )

    async def test_a_crooked_address_is_not_asked(self):
        await self.refused(self.cinema.playlist("vk", "PLabc", room=ROOM), 400, "Непонятный адрес плейлиста")
        self.assertEqual(self.seen, [])


class DetailsTests(Stage):
    async def test_the_video_page_has_the_same_keys_as_youtube_and_twitch(self):
        details = recorded("video-details.json")
        self.answer("video.get", details, videos="-211232966_456241474", extended="1")
        page = await self.cinema.details("vk", "-211232966_456241474", "video", room=ROOM)
        item = details["response"]["items"][0]
        group = details["response"]["groups"][0]
        self.assertEqual(
            page,
            {
                "provider": "vk",
                "kind": "video",
                "id": "-211232966_456241474",
                "title": item["title"],
                "author": "Натальная карта",
                "channelId": "-211232966",
                "channelAvatar": image(group["photo_200"]),
                "duration": 8661,
                "live": False,
                "views": item["views"],
                "viewers": None,
                "followers": 2097846,
                "published": "2026-07-31",
                "category": None,
                "description": item["description"],
                # Странице — кадр шире 960 px: 1024×576, а не 4K.
                "poster": image(frame(item, 1024)),
            },
        )

    async def test_what_does_not_play_from_here_is_refused_in_words_about_our_server(self):
        # Второй ролик снятого ответа — «Недоступно в вашем регионе» (`restriction.can_play: 0`).
        details = recorded("video-details.json")
        details["response"]["items"] = details["response"]["items"][1:]
        self.answer("video.get", details, videos="-22277933_456241677", extended="1")
        await self.refused(
            self.cinema.details("vk", "-22277933_456241677", "video", room=ROOM),
            403,
            "VK Видео не показывает это видео с нашего сервера: ограничение страны или прав на показ",
        )
        self.answer("video.get", recorded("video-deleted.json"), videos="-22277933_1", extended="1")
        await self.refused(
            self.cinema.details("vk", "-22277933_1", "video", room=ROOM), 404, "Это видео удалено с VK Видео"
        )

    async def test_a_recording_of_a_finished_stream_is_a_video_not_a_live_channel(self):
        # Флаг `live: 1` площадка ставит и записи прошедшего эфира (`live_status: postlive`): это
        # ролик с перемоткой, а не эфир, который смотрят с края.
        recording = recorded("video-postlive.json")
        self.answer("video.get", recording, videos="-211045618_456243735", extended="1")
        page = await self.cinema.details("vk", "-211045618_456243735", "video", room=ROOM)
        self.assertEqual((page["live"], page["duration"], page["views"]), (False, 2662, 158))
        item = recording["response"]["items"][0]
        card = self.vk._video(item, People(recording["response"]))
        self.assertEqual((card["kind"], card["live"], card["duration"]), ("video", False, 2662))

    async def test_a_live_channel_page_of_vk_video_live(self):
        stream = recorded("live-near_you.json")
        self.blogs["near_you"] = (200, stream)
        page = await self.cinema.details("vk", "near_you", "channel", room=ROOM)
        self.assertEqual(
            page,
            {
                "provider": "vk",
                "kind": "channel",
                "id": "near_you",
                "title": stream["title"],
                "author": "Near_You",
                # Канал Live — не сообщество VK: двери «Открыть канал» у страницы нет.
                "channelId": None,
                "channelAvatar": image(stream["user"]["avatarUrl"]),
                "duration": None,
                "live": True,
                "views": None,
                "viewers": 1486,
                "followers": None,
                "published": None,
                "category": "МИР ТАНКОВ",
                "description": "",
                # Кадра эфира площадка не дала (`previewUrl` пуст) — обложка канала.
                "poster": image(stream["channelCoverImageUrl"]),
            },
        )
        self.assertEqual(self.calls, [])

    async def test_a_live_channel_is_never_a_video_and_a_missing_one_is_said_so(self):
        await self.refused(
            self.cinema.details("vk", "near_you", "video", room=ROOM), 400, "Непонятный адрес видео"
        )
        self.blogs["nobody_here"] = (404, recorded("live-missing.json")["body"])
        await self.refused(
            self.cinema.details("vk", "nobody_here", "channel", room=ROOM),
            404,
            "Такого канала на VK Видео Live нет",
        )


class SourceTests(Stage):
    def ctx(self):
        return self.cinema._ctx(ROOM, self.vk)

    async def test_a_video_is_parsed_by_yt_dlp_with_its_subtitles_kept_apart(self):
        self.answer("video.get", recorded("video-details.json"), videos="-211232966_456241474")
        plan = await self.vk.source(self.ctx(), "video", "-211232966_456241474", {})
        self.assertEqual(plan, ytdlp("https://vkvideo.ru/video-211232966_456241474", hls_subtitles=False))
        self.assertEqual(self.methods(), ["video.get"])

    async def test_what_does_not_play_from_here_is_refused_before_yt_dlp(self):
        details = recorded("video-details.json")
        details["response"]["items"] = details["response"]["items"][1:]
        self.answer("video.get", details, videos="-22277933_456241677")
        await self.refused(
            self.vk.source(self.ctx(), "video", "-22277933_456241677", {}),
            403,
            "VK Видео не показывает это видео с нашего сервера: ограничение страны или прав на показ",
        )

    async def test_a_stream_not_yet_started_is_refused(self):
        live = recorded("search-live.json")["response"]["catalog_videos"][2]["video"]
        self.answer("video.get", {"response": {"count": 1, "items": [live]}}, videos="-165617900_456240161")
        await self.refused(
            self.vk.source(self.ctx(), "channel", "-165617900_456240161", {}),
            404,
            "Этот эфир VK Видео ещё не начался",
        )

    async def test_the_link_still_opens_when_the_catalog_is_down(self):
        # Вход закрыт — каталог молчит, но ролик по ссылке разбирает yt-dlp, которому токен не нужен.
        self.entries = [(429, "<html>429 Too Many Requests</html>")]
        with self.assertLogs("cord_services.cinema.providers.vk", "INFO"):
            plan = await self.vk.source(self.ctx(), "video", "-22277933_456242578", {})
        self.assertEqual(plan.url, "https://vkvideo.ru/video-22277933_456242578")
        self.assertEqual(self.calls, [])

    async def test_a_closed_video_is_refused_in_russian_not_swallowed(self):
        # T10: «доступ закрыт» (код 15 → 403) — это ответ площадки про сам ролик, и он должен дойти до
        # человека по-русски, а не проглотиться, чтобы yt-dlp ответил английской ошибкой.
        self.answer("video.get", {"error": {"error_code": 15, "error_msg": "Access denied"}}, videos="-1_1")
        await self.refused(
            self.vk.source(self.ctx(), "video", "-1_1", {}), 403, "VK Видео не показывает это: доступ закрыт"
        )

    async def test_a_vk_video_live_channel_is_parsed_only_while_on_air(self):
        self.blogs["near_you"] = (200, recorded("live-near_you.json"))
        plan = await self.vk.source(self.ctx(), "channel", "near_you", {})
        self.assertEqual(plan, ytdlp("https://live.vkvideo.ru/near_you"))
        self.blogs["igromania"] = (200, recorded("live-igromania.json"))
        await self.refused(
            self.vk.source(self.ctx(), "channel", "igromania", {}),
            404,
            "Этот эфир VK Видео Live сейчас не идёт",
        )
        self.blogs["nobody_here"] = (404, recorded("live-missing.json")["body"])
        await self.refused(
            self.vk.source(self.ctx(), "channel", "nobody_here", {}),
            404,
            "Такого канала на VK Видео Live нет",
        )
        # Открытый API эфиров не ответил — разбор всё равно идёт: решит yt-dlp.
        self.blogs["quiet"] = (200, httpx.ConnectError("boom"))
        plan = await self.vk.source(self.ctx(), "channel", "quiet", {})
        self.assertEqual(plan.url, "https://live.vkvideo.ru/quiet")
        await self.refused(self.vk.source(self.ctx(), "video", "near_you", {}), 400, "Непонятный адрес видео")


class PictureTests(unittest.TestCase):
    def test_a_frame_without_padding_wins_over_a_padded_one_of_the_right_width(self):
        # Кадры с полями (`with_padding`) — вписанные в 4:3 с чёрными полосами; плитке 16:9 они не
        # годятся, пока есть кадр без полей. Здесь у настоящего кадра с полями (130×96) изменена
        # одна ширина — на 480: он шире 440, но уже 720 и был бы выбран, если бы поля не учитывались.
        item = recorded("section-all.json")["response"]["videos"][0]
        padded = next(entry for entry in item["image"] if entry.get("with_padding"))
        padded["width"] = 480
        self.assertEqual(_picture(item["image"], 440), frame(item, 720))
        # Только кадры с полями — берётся из них (так у обложек плейлистов).
        album = recorded("albums-22277933.json")["response"]["items"][0]
        self.assertEqual(_picture(album["image"], 320), album["image"][2]["url"])
        self.assertEqual(_picture([], 440), "")


class ResolveTests(unittest.IsolatedAsyncioTestCase):
    """Общий разбор на ответе yt-dlp для ролика VK: поток, субтитры и обложка — у нас, от имени VK."""

    def setUp(self):
        clock = patch("time.time", return_value=NOW)
        clock.start()
        self.addCleanup(clock.stop)
        self.signer = Signer(SECRET, {"vk": Vk.hosts}.get)
        master = recorded("master-vod.url").strip()
        self.info = {
            "title": "Маша и Медведь. Сезон 8. Серия",
            "uploader": "Маша и Медведь",
            "duration": 420,
            "is_live": False,
            "thumbnail": "https://sun9-36.userapi.com/impg/frame.jpg",
            "formats": [
                {
                    "format_id": "hls_fmp4-12_4-Audio",
                    "protocol": "m3u8_native",
                    "manifest_url": master,
                    "url": master,
                }
            ],
            # Так yt-dlp отдаёт субтитры VK: одна дорожка `ru` в двух видах, мастер HLS их не несёт.
            "subtitles": {
                "ru": [
                    {"ext": "vtt", "url": "https://vk6-15.vkuser.net/?type=2&ix=1&id=17138302323445"},
                    {"ext": "Ru AUTO", "url": "https://vk6-15.vkuser.net/?type=2&ix=1&id=17138302323445"},
                ]
            },
        }

    async def resolve(self, plan):
        ytdlp_door = YtDlp()
        with patch.object(ytdlp_door, "probe", return_value=self.info):
            resolver = Resolver(self.signer, ytdlp_door, lambda url, provider: f"poster:{provider}:{url}")
            return await resolver.resolve(plan, None, "vk", "-22277933_456242578", True)

    async def test_vk_subtitles_come_with_its_hls_stream(self):
        found = await self.resolve(ytdlp("https://vkvideo.ru/video-22277933_456242578", hls_subtitles=False))
        self.assertEqual(found["kind"], "hls")
        self.assertEqual(
            found["url"],
            proxied(self.signer, recorded("master-vod.url").strip(), "playlist", 5 * 3600, provider="vk"),
        )
        self.assertEqual(
            found["captions"],
            [
                {
                    "lang": "ru",
                    "label": "ru",
                    "auto": False,
                    "url": proxied(
                        self.signer,
                        "https://vk6-15.vkuser.net/?type=2&ix=1&id=17138302323445",
                        "fetch",
                        provider="vk",
                    ),
                }
            ],
        )
        self.assertEqual(found["poster"], "poster:vk:https://sun9-36.userapi.com/impg/frame.jpg")

    async def test_a_platform_whose_master_carries_its_subtitles_still_does_not_get_them_twice(self):
        # Прежнее поведение YouTube: ручные субтитры лежат в мастере HLS, отдельным списком их нет.
        found = await self.resolve(ytdlp("https://vkvideo.ru/video-22277933_456242578"))
        self.assertEqual(found["captions"], [])


class PlaylistRewriteTests(unittest.TestCase):
    """Настоящие плейлисты VK через наш прокси: все их адреса — у нас, и ни одного чужого."""

    def setUp(self):
        self.signer = Signer(SECRET, {"vk": Vk.hosts}.get)

    def opened(self, route, line):
        query = parse_qs(urlsplit(line).query)
        return self.signer.open(route, query["u"][0], query["e"][0], query["s"][0], query["p"][0])

    def test_the_vod_master_signs_every_variant_and_every_voice(self):
        body = rewrite(
            recorded("master-vod.m3u8"), recorded("master-vod.url").strip(), self.signer, provider="vk"
        )
        variants = [line for line in body.splitlines() if line and not line.startswith("#")]
        voices = [line.split('URI="')[1].split('"')[0] for line in body.splitlines() if 'URI="' in line]
        self.assertTrue(variants and voices)
        for line in variants + voices:
            self.assertTrue(line.startswith("/api/v1/services/cinema/playlist?"), line)
            self.assertTrue(urlsplit(self.opened("playlist", line)).hostname.endswith(".vkuser.net"))

    def test_the_vod_variant_is_numbered_and_its_map_is_signed(self):
        reels = Reels(self.signer)
        body = rewrite(
            recorded("variant-vod.m3u8"),
            recorded("variant-vod.url").strip(),
            self.signer,
            reels,
            provider="vk",
        )
        segments = [line for line in body.splitlines() if line and not line.startswith("#")]
        self.assertTrue(segments and all(line.startswith("seg/") for line in segments), segments)
        # Кусочки fMP4 — диапазоны одного файла: диапазоны остаются, карта инициализации — у нас.
        self.assertIn("#EXT-X-BYTERANGE:", body)
        mapped = next(line for line in body.splitlines() if line.startswith("#EXT-X-MAP:"))
        self.assertIn('URI="/api/v1/services/cinema/fetch?', mapped)

    def test_live_streams_are_signed_segment_by_segment_and_keep_their_time(self):
        for name in ("live", "vklive"):
            base = recorded(f"variant-{name}.url").strip()
            body = rewrite(
                recorded(f"variant-{name}.m3u8"), base, self.signer, Reels(self.signer), provider="vk"
            )
            segments = [line for line in body.splitlines() if line and not line.startswith("#")]
            self.assertTrue(segments, name)
            for line in segments:
                self.assertTrue(line.startswith("/api/v1/services/cinema/fetch?"), line)
                self.assertTrue(urlsplit(self.opened("fetch", line)).hostname.endswith(".okcdn.ru"))
            self.assertIn("#EXT-X-PROGRAM-DATE-TIME:", body)
        master = rewrite(
            recorded("master-vklive.m3u8"), recorded("master-vklive.url").strip(), self.signer, provider="vk"
        )
        variants = [line for line in master.splitlines() if line and not line.startswith("#")]
        self.assertTrue(
            variants and all(line.startswith("/api/v1/services/cinema/playlist?") for line in variants)
        )


class NetTests(unittest.IsolatedAsyncioTestCase):
    async def test_vk_goes_out_as_a_browser_and_the_rest_as_the_cinema(self):
        # CDN VK отдаёт поток только браузеру, для которого выдан адрес (`srcAg=CHROME`); остальные
        # площадки представляются, как и раньше, именем кинозала.
        cinema = Cinema(SECRET, net=NetConfig(proxies={"vk": "http://proxy.example:3128"}))
        self.addAsyncCleanup(cinema.close)
        self.assertEqual(cinema.net.client_for("vk").headers["user-agent"], BROWSER)
        for other in ("youtube", "twitch", "rutube"):
            self.assertEqual(cinema.net.client_for(other).headers["user-agent"], USER_AGENT)
        self.assertEqual(cinema.net.config.proxy_for("vk"), "http://proxy.example:3128")


class RouteTests(unittest.TestCase):
    def test_a_long_vk_section_number_passes_the_route_and_twitch_keeps_its_own_form(self):
        cinema = Cinema(
            SECRET, httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(500)))
        )

        class Core:
            async def member(self, room, authorization):
                return {"id": room}, {"id": "member"}

        from fastapi import FastAPI

        from cord_services.cinema import routes

        app = FastAPI()
        app.include_router(routes(cinema, Core()))
        client = TestClient(app, headers={"Authorization": "Bearer member.secret"})
        seen = []

        async def category(ctx, category_id, offset):
            seen.append((category_id, offset))
            return {"category": {"id": category_id}, "items": [], "next": None}

        vk = cinema.registry.get("vk")
        with patch.object(vk, "category", category):
            answer = client.get(
                f"/api/v1/services/rooms/{ROOM}/cinema/category", params={"provider": "vk", "id": ALL}
            )
        self.assertEqual(answer.status_code, 200, answer.text)
        self.assertEqual(seen, [(ALL, 0)])
        answer = client.get(
            f"/api/v1/services/rooms/{ROOM}/cinema/category", params={"provider": "twitch", "id": "abc"}
        )
        self.assertEqual((answer.status_code, answer.json()), (400, {"detail": "Непонятный раздел"}))


if __name__ == "__main__":
    unittest.main()
