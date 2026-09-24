"""
Реестр площадок кинозала: кто включён, что у кого есть и чем отвечают на остальное.

Здесь — то, что появилось вместе с реестром: настройка `CINEMA_PROVIDERS`, маршрут
`providers`, отказ `Unsupported` с прежними текстами, сборщики карточек с прежними ключами и
план источника, которым площадка говорит, откуда брать поток. Что ответы каталога остались
прежними слово в слово, проверяет `test_cinema_providers.py`.
"""

import os
import re
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient

from cord_services.app import create_app
from cord_services.cinema import Memo, Signer, wire
from cord_services.cinema.facade import CHANNEL_ID
from cord_services.cinema.providers import PROVIDERS
from cord_services.cinema.providers.twitch import Twitch
from cord_services.cinema.providers.youtube import YouTube
from cord_services.cinema.registry import Ctx, Features, HostPolicy, Kit, Provider, Registry, Unsupported
from cord_services.cinema.resolve import Resolver, YtDlp, direct, ytdlp
from cord_services.cinema.transport.signer import proxied
from cord_services.core import Core

ROOM = str(uuid.uuid4())
NOW = 1_800_000_000.0

# Общий список хостов, которым прокси проверял адреса до задачи 4. Теперь его держат площадки —
# каждая свою часть, и вместе ровно этот список: ни потеряно, ни добавлено ни одного хоста.
FORMER_ALLOWED_HOSTS = (
    "googlevideo.com",
    "youtube.com",
    "ytimg.com",
    "ggpht.com",
    "googleusercontent.com",
    "ttvnw.net",
    "jtvnw.net",
    "twitchcdn.net",
    "twitch.tv",
    "akamaized.net",
)

# Ключи в том порядке, в каком их отдавал прод: ответы службы, снятые с meet.nikg.tech для
# браузерных тестов (`web/e2e/fixtures/cinema/*.json`). Тесты службы каталога `web/` не видят,
# поэтому списки переписаны сюда — и любое изменение провода станет правкой этих строк.
VIDEO_CARD = [
    "provider",
    "kind",
    "id",
    "title",
    "author",
    "channelId",
    "duration",
    "live",
    "viewers",
    "views",
]
RECORDED = {
    # youtube-search-big-buck-bunny.json: items[0], channels[0]; youtube-channel-playlists.json: items[0]
    "youtube video": [*VIDEO_CARD, "poster"],
    "youtube channel": [*VIDEO_CARD, "followers", "description", "poster"],
    "youtube playlist": [*VIDEO_CARD, "count", "poster"],
    # twitch-channel-videos.json: items[0] (эфир), items[1] (запись); twitch-search.json: items[0]
    "twitch live": [*VIDEO_CARD, "category", "poster"],
    "twitch record": [*VIDEO_CARD, "category", "published", "poster"],
    # twitch-categories.json: items[0]; twitch-category.json: category
    "category": ["provider", "kind", "id", "title", "viewers", "poster"],
    # youtube-channel-videos.json и twitch-channel-videos.json: channel
    "channel head": [
        "provider",
        "id",
        "title",
        "handle",
        "description",
        "followers",
        "viewers",
        "live",
        "category",
        "avatar",
        "banner",
    ],
    # youtube-playlist.json: playlist
    "playlist head": [
        "provider",
        "kind",
        "id",
        "title",
        "author",
        "channelId",
        "description",
        "count",
        "views",
        "published",
        "poster",
    ],
    # youtube-details.json
    "details": [
        "provider",
        "kind",
        "id",
        "title",
        "author",
        "channelId",
        "channelAvatar",
        "duration",
        "live",
        "views",
        "viewers",
        "followers",
        "published",
        "category",
        "description",
        "poster",
    ],
    # twitch-details.json (канал)
    "channel details": [
        "provider",
        "id",
        "title",
        "handle",
        "description",
        "followers",
        "viewers",
        "live",
        "category",
        "avatar",
        "banner",
        "kind",
        "author",
        "channelId",
        "channelAvatar",
        "duration",
        "views",
        "published",
        "poster",
    ],
}


def kit():
    return Kit(memo=Memo(), image=lambda url: None, ytdlp=YtDlp())


def everyone():
    return [kind(kit()) for kind in PROVIDERS]


class RegistryTests(unittest.TestCase):
    def test_every_platform_the_cinema_knows_is_on_by_default(self):
        for enabled in (None, "", " , "):
            self.assertEqual([p.id for p in Registry(everyone(), enabled)], ["youtube", "twitch", "rutube"])

    def test_the_setting_chooses_platforms_but_not_their_order(self):
        registry = Registry(everyone(), " Twitch ,youtube")
        self.assertEqual([p.id for p in registry], ["youtube", "twitch"])

    def test_a_platform_switched_off_is_refused_as_clearly_as_an_unknown_one(self):
        registry = Registry(everyone(), "twitch")
        self.assertEqual([p.id for p in registry], ["twitch"])
        self.assertIsInstance(registry.get("twitch"), Twitch)
        for asked, detail in (
            ("youtube", "Эта площадка выключена на этом сервере"),
            ("vimeo", "Такой площадки в кинозале нет"),
            ("YouTube", "Такой площадки в кинозале нет"),
        ):
            with self.assertRaises(Unsupported) as refusal:
                registry.get(asked)
            self.assertEqual((refusal.exception.status_code, refusal.exception.detail), (400, detail))

    def test_an_unknown_name_is_one_line_in_the_log_not_a_crash(self):
        with self.assertLogs("cord_services.cinema.registry", "WARNING") as log:
            registry = Registry(everyone(), "twitch, vk, ivi")
        self.assertEqual([p.id for p in registry], ["twitch"])
        self.assertEqual(len(log.records), 1)
        self.assertIn("vk, ivi", log.output[0])

    def test_only_unknown_names_leave_the_cinema_without_platforms(self):
        # Просили только то, чего нет, — значит, и включать нечего: «все» здесь было бы
        # догадкой против прямо написанной настройки.
        with self.assertLogs("cord_services.cinema.registry", "WARNING"):
            registry = Registry(everyone(), "vk")
        self.assertEqual(list(registry), [])

    def test_a_setting_of_known_names_is_silent(self):
        with self.assertNoLogs("cord_services.cinema.registry"):
            Registry(everyone(), "youtube,twitch")

    def test_a_refusal_is_a_bad_request_wherever_it_is_raised(self):
        refusal = Unsupported("Этого нет")
        self.assertIsInstance(refusal, HTTPException)
        self.assertEqual((refusal.status_code, refusal.detail), (400, "Этого нет"))


class PlatformTests(unittest.IsolatedAsyncioTestCase):
    def test_what_each_platform_has(self):
        self.assertEqual(YouTube.features, Features(search=True, channels=True, playlists=True, live=True))
        self.assertEqual(Twitch.features, Features(search=True, channels=True, categories=True, live=True))
        self.assertEqual({kind.features.account for kind in PROVIDERS}, {"none"})

    def test_the_hosts_of_the_platforms_are_exactly_the_former_shared_list(self):
        # Проверка хоста переехала с общего списка на площадку — и не потеряла при этом и не
        # приобрела ни одного хоста. Список был общим для YouTube и Twitch; хосты площадок,
        # пришедших позже (Rutube), проверяют их собственные тесты.
        owned = [suffix for kind in (YouTube, Twitch) for suffix in kind.hosts.suffixes]
        self.assertEqual(sorted(owned), sorted(FORMER_ALLOWED_HOSTS))

    def test_a_host_belongs_to_a_platform_by_suffix_not_by_substring(self):
        self.assertTrue(YouTube.hosts.allows("rr5---sn-x.googlevideo.com"))
        self.assertTrue(YouTube.hosts.allows("googlevideo.com"))
        self.assertTrue(YouTube.hosts.allows("I.YTIMG.COM"))
        self.assertFalse(YouTube.hosts.allows("evilgooglevideo.com"))
        self.assertFalse(YouTube.hosts.allows("googlevideo.com.evil.com"))
        self.assertFalse(YouTube.hosts.allows("static-cdn.jtvnw.net"))
        self.assertTrue(Twitch.hosts.allows("static-cdn.jtvnw.net"))
        self.assertFalse(YouTube.hosts.allows(""))
        self.assertTrue(HostPolicy(public_any=True).allows("media.example.org"))
        self.assertFalse(HostPolicy(public_any=True).allows(""))

    def test_every_address_that_opens_today_fits_the_platform_form(self):
        today = [
            "aqz-KE-bpKQ",
            "UCSMOQeBJ2RAnuFungnQOxLg",
            "@Blender.Official",
            "PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf",
            "OLAK5uy_kvw0Ke1R5xDo5lEzjPCp8dScPqAyjQrLE",
            "some_one",
            "2000000001",
            "743",
        ]
        # Адреса, которые открываются сегодня, — адреса YouTube и Twitch; у Rutube своя форма
        # (32 шестнадцатеричных знака), её проверяет `test_cinema_rutube.py`.
        for kind in (YouTube, Twitch):
            for address in today:
                self.assertTrue(CHANNEL_ID.match(address), address)
                self.assertTrue(kind.content_id.fullmatch(address), (kind.id, address))
            for address in ("", "a b", "x" * 81, "a/b", "a\n"):
                self.assertIsNone(kind.content_id.fullmatch(address), (kind.id, address))

    async def test_what_a_platform_does_not_declare_is_refused(self):
        class Bare(Provider):
            id = "bare"
            name = "Bare"
            content_id = re.compile(r"x")

        bare = Bare(kit())
        ctx = Ctx(room=ROOM, net=None)
        self.assertEqual(await bare.availability(), (True, None))
        for call in (
            bare.search(ctx, "q", 0),
            bare.channel(ctx, "c", "videos", 0),
            bare.playlist(ctx, "p", 0),
            bare.categories(ctx, "", 0),
            bare.category(ctx, "1", 0),
            bare.series(ctx, "s", None, 0),
            bare.details(ctx, "video", "x"),
            bare.source(ctx, "video", "x", {}),
        ):
            with self.assertRaises(Unsupported) as refusal:
                await call
            self.assertEqual(refusal.exception.detail, "У площадки Bare такого нет")

    async def test_each_platform_names_its_page_and_whether_dash_is_allowed(self):
        ctx = Ctx(room=ROOM, net=None)
        youtube, twitch = YouTube(kit()), Twitch(kit())
        self.assertEqual(
            await youtube.source(ctx, "video", "aqz-KE-bpKQ", {}),
            ytdlp("https://www.youtube.com/watch?v=aqz-KE-bpKQ", dash=True),
        )
        self.assertEqual(
            await twitch.source(ctx, "video", "2000000001", {}),
            ytdlp("https://www.twitch.tv/videos/2000000001"),
        )
        self.assertEqual(
            await twitch.source(ctx, "channel", "some_one", {}), ytdlp("https://www.twitch.tv/some_one")
        )


class WireTests(unittest.TestCase):
    """Каждый сборщик отдаёт ровно те ключи, что отдавал прод, и в том же порядке."""

    def test_cards_keep_the_keys_of_their_kind(self):
        built = {
            "youtube video": wire.card("youtube", "video", "id", "t"),
            "youtube channel": wire.card("youtube", "channel", "id", "t", followers=None, description=""),
            "youtube playlist": wire.card("youtube", "playlist", "id", "t", count=None),
            "twitch live": wire.card("twitch", "channel", "id", "t", live=True, category=None),
            "twitch record": wire.card("twitch", "video", "id", "t", category=None, published=""),
            "category": wire.category_card("twitch", "1", "t"),
            "channel head": wire.channel_head("youtube", "id", "t"),
            "playlist head": wire.playlist_head("youtube", "id", "t"),
            "details": wire.details("youtube", "video", "id", "t"),
            "channel details": wire.channel_details(
                wire.channel_head("twitch", "id", "t"), title="t", poster=None
            ),
        }
        for kind, value in built.items():
            self.assertEqual(list(value), RECORDED[kind], kind)

    def test_empty_means_what_it_meant(self):
        self.assertEqual(
            wire.card("youtube", "video", "id", "t"),
            {
                "provider": "youtube",
                "kind": "video",
                "id": "id",
                "title": "t",
                "author": "",
                "channelId": None,
                "duration": None,
                "live": False,
                "viewers": None,
                "views": None,
                "poster": None,
            },
        )

    def test_new_keys_appear_only_where_they_are_given(self):
        plain = wire.card("rutube", "video", "id", "t")
        for key in ("badge", "shape", "series"):
            self.assertNotIn(key, plain)
        episode = wire.card("rutube", "video", "id", "t", badge="4K", shape="tall", series="s1", poster="p")
        self.assertEqual(
            {key: episode[key] for key in ("badge", "shape", "series", "poster")},
            {"badge": "4K", "shape": "tall", "series": "s1", "poster": "p"},
        )
        self.assertEqual(list(episode)[-1], "poster")

    def test_a_live_channel_page_is_its_head_with_the_stream_on_top(self):
        head = wire.channel_head("twitch", "someone", "SomeOne", avatar="a", banner="b", live=True)
        page = wire.channel_details(head, title="Live now", poster="p")
        self.assertEqual(
            {key: page[key] for key in ("title", "author", "channelId", "channelAvatar", "poster")},
            {
                "title": "Live now",
                "author": "SomeOne",
                "channelId": "someone",
                "channelAvatar": "a",
                "poster": "p",
            },
        )


class DirectSourceTests(unittest.IsolatedAsyncioTestCase):
    """Площадка, которая знает адрес потока сама: разбирать нечего, остаётся подписать."""

    def setUp(self):
        clock = patch("time.time", return_value=NOW)
        clock.start()
        self.addCleanup(clock.stop)
        self.library = YtDlp()
        self.resolver = Resolver(
            Signer("secret"), self.library, lambda url, provider: url and f"poster:{provider}:{url}"
        )

    async def test_a_direct_stream_is_signed_and_nothing_is_asked_of_yt_dlp(self):
        master = "https://bl.rutube.ru/route/x.m3u8?expire=1800003600"
        caption = "https://rutube.ru/captions/ru.vtt"
        plan = direct(
            "hls",
            master,
            title="Фильм",
            author="Канал",
            duration=60,
            poster="https://pic.rtbcdn.ru/x.jpg",
            language="ru",
            captions=({"lang": "ru", "label": "Русский", "auto": False, "url": caption},),
        )
        with patch.object(self.library, "probe") as probe:
            found = await self.resolver.resolve(plan, None, "rutube", "abc", True)
        probe.assert_not_called()
        signer = Signer("secret")
        self.assertEqual(
            found,
            {
                "provider": "rutube",
                "contentId": "abc",
                "title": "Фильм",
                "author": "Канал",
                "duration": 60,
                "live": False,
                "kind": "hls",
                "url": proxied(signer, master, "playlist", 3600, provider="rutube"),
                "expiresAt": 1800003600000,
                "notice": None,
                "language": "ru",
                "captions": [
                    {
                        "lang": "ru",
                        "label": "Русский",
                        "auto": False,
                        "url": proxied(signer, caption, "subtitles", provider="rutube"),
                    }
                ],
                "poster": "poster:rutube:https://pic.rtbcdn.ru/x.jpg",
            },
        )

    async def test_what_only_some_platforms_know_travels_only_from_them(self):
        choices = ({"id": "720", "label": "720p", "selected": True},)
        plan = direct("file", "https://media.example.org/film.mp4", live=True, duration=5, variants=choices)
        found = await self.resolver.resolve(plan, None, "jellyfin", "abc", False)
        self.assertEqual(found["variants"], [{"id": "720", "label": "720p", "selected": True}])
        self.assertNotIn("audioChoices", found)
        self.assertNotIn("liveDelayMs", found)
        self.assertIsNone(found["duration"])
        self.assertTrue(found["url"].startswith("/api/v1/services/cinema/fetch?"))


class RouteTests(unittest.TestCase):
    """Маршруты кинозала через настоящий FastAPI: участие в комнате подменено, сеть не нужна."""

    def serve(self, platforms=None):
        root = tempfile.TemporaryDirectory()
        self.addCleanup(root.cleanup)
        self.core = Core("http://core.test", "internal-test")
        self.core.member = AsyncMock(return_value=({"id": ROOM}, {"id": "member"}))
        setting = {} if platforms is None else {"CINEMA_PROVIDERS": platforms}
        with patch.dict(os.environ, setting):
            if platforms is None:
                os.environ.pop("CINEMA_PROVIDERS", None)
            app = create_app(Path(root.name), self.core, telegram_enabled=False)
        self.addCleanup(app.state.store.db.close)
        self.app = app
        return TestClient(app, headers={"Authorization": "Bearer member.secret"})

    def ask(self, client, path, **params):
        return client.get(f"/api/v1/services/rooms/{ROOM}/cinema/{path}", params=params)

    def test_the_client_learns_which_platforms_are_on_and_what_they_have(self):
        client = self.serve()
        answer = self.ask(client, "providers")
        self.assertEqual(answer.status_code, 200)
        self.assertEqual(
            answer.json(),
            {
                "providers": [
                    {
                        "id": "youtube",
                        "available": True,
                        "reason": None,
                        "account": "none",
                        "connected": False,
                        "features": {
                            "search": True,
                            "channels": True,
                            "playlists": True,
                            "categories": False,
                            "series": False,
                            "live": True,
                        },
                    },
                    {
                        "id": "twitch",
                        "available": True,
                        "reason": None,
                        "account": "none",
                        "connected": False,
                        "features": {
                            "search": True,
                            "channels": True,
                            "playlists": False,
                            "categories": True,
                            "series": False,
                            "live": True,
                        },
                    },
                    {
                        "id": "rutube",
                        "available": True,
                        "reason": None,
                        "account": "none",
                        "connected": False,
                        "features": {
                            "search": True,
                            "channels": True,
                            "playlists": False,
                            "categories": True,
                            "series": True,
                            "live": True,
                        },
                    },
                ]
            },
        )
        self.core.member.assert_awaited_once_with(ROOM, "Bearer member.secret")

    def test_the_list_is_for_members_of_the_room_only(self):
        client = self.serve()
        self.core.member.side_effect = HTTPException(403, "Сначала войдите во встречу")
        answer = self.ask(client, "providers")
        self.assertEqual((answer.status_code, answer.json()), (403, {"detail": "Сначала войдите во встречу"}))

    def test_a_platform_switched_off_disappears_from_the_list_and_is_refused(self):
        client = self.serve("twitch")
        self.assertEqual(
            [entry["id"] for entry in self.ask(client, "providers").json()["providers"]], ["twitch"]
        )
        off = {"detail": "Эта площадка выключена на этом сервере"}
        answer = self.ask(client, "search", provider="youtube", query="big buck bunny")
        self.assertEqual((answer.status_code, answer.json()), (400, off))
        answer = client.post(
            f"/api/v1/services/rooms/{ROOM}/cinema/resolve", json={"provider": "youtube", "contentId": "abc"}
        )
        self.assertEqual((answer.status_code, answer.json()), (400, off))

    def test_an_unknown_name_in_the_setting_is_logged_once_at_startup(self):
        with self.assertLogs("cord_services.cinema.registry", "WARNING") as log:
            client = self.serve("youtube, vk")
        self.assertEqual(len(log.records), 1)
        self.assertEqual(
            [entry["id"] for entry in self.ask(client, "providers").json()["providers"]], ["youtube"]
        )

    def test_an_unknown_platform_is_a_bad_request_with_a_human_detail(self):
        client = self.serve()
        unknown = {"detail": "Такой площадки в кинозале нет"}
        for path, params in (
            ("search", {"query": "x"}),
            ("channel", {"id": "someone"}),
            ("playlist", {"id": "PLx"}),
            ("categories", {}),
            ("category", {"id": "743"}),
            ("details", {"id": "abc"}),
        ):
            answer = self.ask(client, path, provider="vimeo", **params)
            self.assertEqual((answer.status_code, answer.json()), (400, unknown), path)
        answer = client.post(
            f"/api/v1/services/rooms/{ROOM}/cinema/resolve", json={"provider": "vimeo", "contentId": "abc"}
        )
        self.assertEqual((answer.status_code, answer.json()), (400, unknown))
        # Без площадки вовсе — это по-прежнему ошибка схемы запроса, а не вопрос к реестру.
        self.assertEqual(self.ask(client, "search", query="x").status_code, 422)

    def test_what_a_platform_lacks_is_said_about_that_platform(self):
        # Прежние тексты («есть только у YouTube/Twitch») стали неправдой, когда разделы появились
        # у Rutube, а плейлисты появятся у VK: отказ говорит о той площадке, которую спросили.
        client = self.serve()
        for path, provider, detail in (
            ("playlist", "twitch", "У Twitch плейлистов нет"),
            ("playlist", "rutube", "У Rutube плейлистов нет"),
            ("category", "youtube", "У YouTube разделов нет"),
        ):
            answer = self.ask(client, path, provider=provider, id="743")
            self.assertEqual((answer.status_code, answer.json()), (400, {"detail": detail}), provider)
        answer = self.ask(client, "categories", provider="youtube", cursor="not a cursor")
        self.assertEqual((answer.status_code, answer.json()), (200, {"items": [], "next": None}))

    def test_availability_and_accounts_are_the_platform_own_words(self):
        class Regional(Provider):
            id = "regional"
            name = "Regional"
            features = Features(series=True, account="optional")
            content_id = re.compile(r"[0-9]{1,12}")

            async def availability(self):
                return False, "Бесплатное здесь отдают только в России"

        client = self.serve()
        cinema = self.app.state.cinema
        cinema.registry = Registry([Regional(kit())])
        self.assertEqual(
            self.ask(client, "providers").json(),
            {
                "providers": [
                    {
                        "id": "regional",
                        "available": False,
                        "reason": "Бесплатное здесь отдают только в России",
                        "account": "optional",
                        "connected": False,
                        "features": {
                            "search": True,
                            "channels": False,
                            "playlists": False,
                            "categories": False,
                            "series": True,
                            "live": False,
                        },
                    }
                ]
            },
        )


if __name__ == "__main__":
    unittest.main()
