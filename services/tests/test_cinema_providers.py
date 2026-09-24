"""
Что кинозал отдаёт сегодня — слово в слово, до того как `Cinema` разложен по площадкам.

ЗАЧЕМ. Рефакторинг обещает «ничего не поменялось», а доказать это можно только сравнением с
тем, что было до первой правки. Поэтому каждая дорога, которая строит карточку, прогоняется
здесь на синтетических ответах площадок и сравнивается **целиком**: ключи, значения, подписанные
адреса обложек, ключи памяти и их сроки, адреса и опции, с которыми зовётся yt-dlp, и текст
запросов в GraphQL Twitch.

ГДЕ ПОДМЕНА. На границе с внешним миром, а не на наших методах: yt-dlp подменяется на уровне
самой библиотеки (`yt_dlp.YoutubeDL`), Twitch и чтение индексов DASH — транспортом httpx. Тест
не знает, чья обёртка зовёт yt-dlp и какой класс шлёт запрос, — поэтому переживает перестройку
без единой правки. Часы стоят: подпись адреса зависит от времени, а сравнивать нужно точно.
"""

import copy
import json
import struct
import unittest
from unittest.mock import patch

import httpx
from fastapi import HTTPException

from cord_services.cinema import Cinema, Resolve, Signer
from cord_services.cinema.transport.signer import proxied

NOW = 1_800_000_000.0
SECRET = "secret"
DAY = 24 * 3600
FIVE_HOURS = 5 * 3600

# Опции yt-dlp по местам вызова — такими, какие они сейчас. Каталог листает «плоско», ролик
# открывается целиком и без плейлиста вокруг.
FLAT = {
    "quiet": True,
    "no_warnings": True,
    "skip_download": True,
    "extract_flat": True,
    "cachedir": False,
    "socket_timeout": 20,
}
LISTING = {**FLAT, "extract_flat": "in_playlist"}
PROBE = {
    "quiet": True,
    "no_warnings": True,
    "skip_download": True,
    "noplaylist": True,
    "cachedir": False,
    "socket_timeout": 20,
}

TWITCH_CLIENT = "kimne78kx3ncx6brgo4mv6wki5h1ko"
POPULAR = (
    "{ streams(first: 30) { edges { node { id title viewersCount "
    "previewImageURL(width: 440, height: 248) broadcaster { login displayName } "
    "game { name } } } } }"
)
TOP_GAMES = (
    "{ games(first: 100) { edges { node { id name displayName viewersCount "
    "boxArtURL(width: 285, height: 380) } } } }"
)
USER = """{ user(login: "%s") { id login displayName description
  profileImageURL(width: 300) bannerImageURL
  followers { totalCount }
  stream { id title viewersCount previewImageURL(width: 440, height: 248) game { name } }
  videos(first: %d, sort: TIME) { edges { node { id title lengthSeconds viewCount
    publishedAt previewThumbnailURL(width: 440, height: 248) game { name } } } } } }"""
VIDEO = """{ video(id: "%s") { id title lengthSeconds viewCount publishedAt
  description previewThumbnailURL(width: 440, height: 248) game { name }
  owner { login displayName profileImageURL(width: 300) followers { totalCount } } } }"""
GAME = """{ game(id: "%s") { id name displayName viewersCount
  boxArtURL(width: 285, height: 380)
  streams(first: %d) { edges { node { id title viewersCount
    previewImageURL(width: 440, height: 248) broadcaster { login displayName }
    game { name } } } } } }"""


PROFILE = "https://static-cdn.jtvnw.net/jtv_user_pictures/someone-300x300.png"
BANNER = "https://static-cdn.jtvnw.net/jtv_user_pictures/someone-banner.png"
PREVIEW = "https://static-cdn.jtvnw.net/previews-ttv/live_user_someone-440x248.jpg"
VOD_THUMB = "https://static-cdn.jtvnw.net/cf_vods/x/thumb-440x248.jpg"
BIG_PREVIEW = "https://static-cdn.jtvnw.net/previews-ttv/big-440x248.jpg"
BOX = "https://static-cdn.jtvnw.net/ttv-boxart/%s-285x380.jpg"


def twitch_user(live):
    """Канал Twitch так, как его отдаёт GraphQL: эфир (или его нет) и три записи, одна пустая."""
    return {
        "user": {
            "id": "42",
            "login": "someone",
            "displayName": "SomeOne",
            "description": "About me",
            "profileImageURL": PROFILE,
            "bannerImageURL": BANNER,
            "followers": {"totalCount": 777},
            "stream": {
                "id": "s1",
                "title": "Live now",
                "viewersCount": 321,
                "previewImageURL": PREVIEW,
                "game": {"name": "Chess"},
            }
            if live
            else None,
            "videos": {
                "edges": [
                    {
                        "node": {
                            "id": "2000000001",
                            "title": "Yesterday",
                            "lengthSeconds": 3600,
                            "viewCount": 50,
                            "publishedAt": "2026-09-20T18:00:00Z",
                            "previewThumbnailURL": VOD_THUMB,
                            "game": {"name": "Chess"},
                        }
                    },
                    {
                        "node": {
                            "id": "2000000002",
                            "title": None,
                            "lengthSeconds": 10,
                            "viewCount": 0,
                            "publishedAt": None,
                            "previewThumbnailURL": None,
                            "game": None,
                        }
                    },
                    {"node": {}},
                ]
            },
        }
    }


def channel_search(text):
    return (
        '{ searchFor(userQuery: "%s", platform: "web", target: {index: CHANNEL}) '
        "{ channels { items { id login displayName profileImageURL(width: 300) "
        "stream { viewersCount previewImageURL(width: 440, height: 248) game { name } } "
        "} } } }" % text
    )


def game_search(text):
    return (
        '{ searchFor(userQuery: "%s", platform: "web", target: {index: GAME}) '
        "{ games { items { id name displayName viewersCount "
        "boxArtURL(width: 285, height: 380) } } } }" % text
    )


def img(url):
    """Обложка так, как её подписывает сервер при остановленных часах: сутки жизни."""
    return proxied(Signer(SECRET), url, "image", DAY)


def signed(url, route, ttl=FIVE_HOURS):
    return proxied(Signer(SECRET), url, route, ttl)


def thumb(video_id):
    return img(f"https://i.ytimg.com/vi/{video_id}/mqdefault.jpg")


def box(kind, payload=b""):
    return struct.pack(">I4s", len(payload) + 8, kind) + payload


def indexed_mp4():
    # Один фрагмент, 1000 Гц, десять секунд — ровно то, из чего собирается DASH.
    sidx = struct.pack(">IIIIIHHIII", 0, 1, 1000, 0, 0, 0, 1, 100, 10000, 0)
    return box(b"ftyp", b"isom0000") + box(b"moov", b"meta") + box(b"sidx", sidx)


class FakeYoutubeDL:
    """Вместо `yt_dlp.YoutubeDL`: ответ по адресу и запись того, с чем позвали."""

    def __init__(self):
        self.answers = {}
        self.calls = []

    def __call__(self, options):
        library = self

        class Session:
            def __enter__(self):
                return self

            def __exit__(self, *failure):
                return False

            def extract_info(self, address, download=True):
                library.calls.append((address, dict(options), download))
                if address not in library.answers:
                    raise AssertionError("yt-dlp спросили о неожиданном: " + address)
                answer = library.answers[address]
                if isinstance(answer, BaseException):
                    raise answer
                return copy.deepcopy(answer)

        return Session()


class Stage(unittest.IsolatedAsyncioTestCase):
    """Остановленные часы, подменённый yt-dlp и сеть, которая знает только свои ответы."""

    def setUp(self):
        clock = patch("time.time", return_value=NOW)
        clock.start()
        self.addCleanup(clock.stop)
        self.library = FakeYoutubeDL()
        library = patch("yt_dlp.YoutubeDL", self.library)
        library.start()
        self.addCleanup(library.stop)
        self.gql = {}
        self.seen = []
        self.cinema = Cinema(SECRET, httpx.AsyncClient(transport=httpx.MockTransport(self.serve)))

    async def asyncTearDown(self):
        await self.cinema.close()

    def serve(self, request):
        self.seen.append(request)
        if request.url.host == "gql.twitch.tv":
            assert request.method == "POST"
            assert request.headers["client-id"] == TWITCH_CLIENT
            query = json.loads(request.content)["query"]
            if query not in self.gql:
                raise AssertionError("Неожиданный запрос в GraphQL Twitch: " + query)
            answer = self.gql[query]
            return (
                answer if isinstance(answer, httpx.Response) else httpx.Response(200, json={"data": answer})
            )
        if request.url.host.endswith("googlevideo.com"):
            payload = indexed_mp4()
            return httpx.Response(
                206,
                headers={"content-range": f"bytes 0-{len(payload) - 1}/{len(payload) + 100}"},
                content=payload,
            )
        raise AssertionError(f"Неожиданный запрос наружу: {request.url}")

    def kept(self, memo):
        """Что лежит в памяти и сколько ещё проживёт — ключ и срок в секундах."""
        return {key: expiry - NOW for key, (expiry, _) in memo._items.items()}

    def gql_asked(self):
        return [json.loads(r.content)["query"] for r in self.seen if r.url.host == "gql.twitch.tv"]

    async def refused(self, action, status, detail):
        with self.assertRaises(HTTPException) as refusal:
            await action
        self.assertEqual((refusal.exception.status_code, refusal.exception.detail), (status, detail))


class YouTubeSearchTests(Stage):
    SEARCH = "ytsearch60:Big Buck"
    CHANNELS = "https://www.youtube.com/results?search_query=Big+Buck&sp=EgIQAg%3D%3D"

    def setUp(self):
        super().setUp()
        self.library.answers[self.SEARCH] = {
            "entries": [
                {
                    "id": "aqz-KE-bpKQ",
                    "title": "Big Buck Bunny 60fps 4K",
                    "channel": "Blender",
                    "channel_id": "UCSMOQeBJ2RAnuFungnQOxLg",
                    "duration": 635.0,
                    "view_count": 21000000,
                },
                {
                    "id": "live0000001",
                    "title": "Live now",
                    "uploader": "Streamer",
                    "is_live": True,
                    "concurrent_view_count": 1500,
                },
                {"id": "live0000002", "live_status": "is_live", "channel": "Other"},
                {"title": "без адреса"},
                None,
                {"id": ""},
            ]
        }
        self.library.answers[self.CHANNELS] = {
            "entries": [
                {
                    "channel_id": "UCSMOQeBJ2RAnuFungnQOxLg",
                    "channel": "Blender",
                    "uploader_id": "@BlenderOfficial",
                    "channel_follower_count": 1900000,
                    "description": "x" * 400,
                    "thumbnails": [
                        {"url": "//yt3.ggpht.com/a", "width": 88, "height": 88},
                        {"url": "//yt3.ggpht.com/b", "width": 176, "height": 176},
                        {"url": "https://yt3.ggpht.com/banner", "width": 1060, "height": 175},
                    ],
                },
                {"id": "UCxyz", "title": "Only title"},
                {"id": "PLnotachannel", "title": "Плейлист, а не канал"},
                None,
            ]
        }

    def videos(self):
        return [
            {
                "provider": "youtube",
                "kind": "video",
                "id": "aqz-KE-bpKQ",
                "title": "Big Buck Bunny 60fps 4K",
                "author": "Blender",
                "channelId": "UCSMOQeBJ2RAnuFungnQOxLg",
                "duration": 635.0,
                "live": False,
                "viewers": None,
                "views": 21000000,
                "poster": thumb("aqz-KE-bpKQ"),
            },
            {
                "provider": "youtube",
                "kind": "video",
                "id": "live0000001",
                "title": "Live now",
                "author": "Streamer",
                "channelId": None,
                "duration": None,
                "live": True,
                "viewers": 1500,
                "views": None,
                "poster": thumb("live0000001"),
            },
            {
                "provider": "youtube",
                "kind": "video",
                "id": "live0000002",
                "title": "Без названия",
                "author": "Other",
                "channelId": None,
                "duration": None,
                "live": True,
                "viewers": None,
                "views": None,
                "poster": thumb("live0000002"),
            },
        ]

    def channels(self):
        return [
            {
                "provider": "youtube",
                "kind": "channel",
                "id": "UCSMOQeBJ2RAnuFungnQOxLg",
                "title": "Blender",
                "author": "@BlenderOfficial",
                "channelId": "UCSMOQeBJ2RAnuFungnQOxLg",
                "duration": None,
                "live": False,
                "viewers": None,
                "views": None,
                "followers": 1900000,
                "description": "x" * 300,
                "poster": img("https://yt3.ggpht.com/b"),
            },
            {
                "provider": "youtube",
                "kind": "channel",
                "id": "UCxyz",
                "title": "Only title",
                "author": "",
                "channelId": "UCxyz",
                "duration": None,
                "live": False,
                "viewers": None,
                "views": None,
                "followers": None,
                "description": "",
                "poster": None,
            },
        ]

    async def test_first_portion_is_videos_with_a_shelf_of_channels(self):
        found = await self.cinema.search("youtube", "  Big Buck ", "")
        self.assertEqual(
            found,
            {"items": self.videos(), "next": None, "channels": self.channels(), "categories": []},
        )
        self.assertEqual(
            sorted(self.library.calls),
            sorted([(self.SEARCH, FLAT, False), (self.CHANNELS, {**FLAT, "playlistend": 4}, False)]),
        )
        self.assertEqual(
            self.kept(self.cinema.catalog),
            {"search:youtube:big buck": 120, "search:youtube:channels:big buck": 300},
        )

    async def test_the_next_portion_does_not_look_for_channels_again(self):
        entries = [{"id": f"v{number:010d}", "title": str(number)} for number in range(32)]
        self.library.answers[self.SEARCH] = {"entries": entries}
        first = await self.cinema.search("youtube", "Big Buck", "")
        self.assertEqual(len(first["items"]), 30)
        self.assertEqual(first["next"], "30")
        second = await self.cinema.search("youtube", "Big Buck", "30")
        self.assertEqual(
            second,
            {
                "items": [
                    {
                        "provider": "youtube",
                        "kind": "video",
                        "id": f"v{number:010d}",
                        "title": str(number),
                        "author": "",
                        "channelId": None,
                        "duration": None,
                        "live": False,
                        "viewers": None,
                        "views": None,
                        "poster": thumb(f"v{number:010d}"),
                    }
                    for number in (30, 31)
                ],
                "next": None,
                "channels": [],
                "categories": [],
            },
        )
        # Вторая порция взята из памяти: наружу ходили только за первой.
        self.assertEqual(len(self.library.calls), 2)

    async def test_a_later_portion_alone_asks_only_for_videos(self):
        await self.cinema.search("youtube", "Big Buck", "30")
        self.assertEqual(self.library.calls, [(self.SEARCH, FLAT, False)])
        self.assertEqual(self.kept(self.cinema.catalog), {"search:youtube:big buck": 120})

    async def test_a_broken_shelf_of_channels_leaves_the_videos(self):
        self.library.answers[self.CHANNELS] = RuntimeError("HTTP Error 429")
        found = await self.cinema.search("youtube", "Big Buck", "")
        self.assertEqual(found["channels"], [])
        self.assertEqual(found["items"], self.videos())

    async def test_a_broken_search_is_not_swallowed(self):
        self.library.answers[self.SEARCH] = RuntimeError("HTTP Error 429")
        with self.assertRaises(RuntimeError):
            await self.cinema.search("youtube", "Big Buck", "")

    async def test_one_letter_is_not_a_search(self):
        found = await self.cinema.search("youtube", " a ", "")
        self.assertEqual(found, {"items": [], "channels": [], "categories": [], "next": None})
        self.assertEqual(self.library.calls, [])
        self.assertEqual(self.kept(self.cinema.catalog), {})

    async def test_a_cursor_that_is_not_a_place_is_refused_first(self):
        await self.refused(self.cinema.search("youtube", "Big Buck", "x"), 400, "Дальше листать нечего")


class TwitchSearchTests(Stage):
    def setUp(self):
        super().setUp()
        self.gql[POPULAR] = {
            "streams": {
                "edges": [
                    {
                        "node": {
                            "id": "1",
                            "title": "Speedrun",
                            "viewersCount": 5000,
                            "previewImageURL": "https://static-cdn.jtvnw.net/previews-ttv/a-440x248.jpg",
                            "broadcaster": {"login": "streamer_a", "displayName": "Streamer_A"},
                            "game": {"name": "Celeste"},
                        }
                    },
                    {
                        "node": {
                            "id": "2",
                            "title": "",
                            "viewersCount": 10,
                            "previewImageURL": None,
                            "broadcaster": {"login": "b_login", "displayName": ""},
                            "game": None,
                        }
                    },
                    {"node": {"id": "3", "broadcaster": None}},
                    {"node": None},
                ]
            }
        }
        self.gql[channel_search("Chess")] = {
            "searchFor": {
                "channels": {
                    "items": [
                        {
                            "id": "1",
                            "login": "quiet_one",
                            "displayName": "Quiet_One",
                            "profileImageURL": "https://static-cdn.jtvnw.net/jtv_user_pictures/q-300x300.png",
                            "stream": None,
                        },
                        {
                            "id": "2",
                            "login": "big_live",
                            "displayName": "Big_Live",
                            "profileImageURL": "https://static-cdn.jtvnw.net/jtv_user_pictures/b-300x300.png",
                            "stream": {
                                "viewersCount": 900,
                                "previewImageURL": BIG_PREVIEW,
                                "game": {"name": "Chess"},
                            },
                        },
                        {
                            "id": "3",
                            "login": "small_live",
                            "displayName": "",
                            "profileImageURL": None,
                            "stream": {"viewersCount": 20, "previewImageURL": None, "game": None},
                        },
                    ]
                }
            }
        }
        self.gql[game_search("Chess")] = {
            "searchFor": {
                "games": {
                    "items": [
                        {
                            "id": 743 + number,
                            "name": f"game-{number}",
                            "displayName": f"Game {number}" if number else "",
                            "viewersCount": 1000 - number,
                            "boxArtURL": BOX % (743 + number),
                        }
                        for number in range(10)
                    ]
                    + [{"id": None, "name": "без номера"}]
                }
            }
        }

    def games(self, count):
        return [
            {
                "provider": "twitch",
                "kind": "category",
                "id": str(743 + number),
                "title": f"Game {number}" if number else "game-0",
                "viewers": 1000 - number,
                "poster": img(BOX % (743 + number)),
            }
            for number in range(count)
        ]

    async def test_nothing_typed_is_the_showcase_of_live_streams(self):
        found = await self.cinema.search("twitch", "", "")
        self.assertEqual(
            found,
            {
                "items": [
                    {
                        "provider": "twitch",
                        "kind": "channel",
                        "id": "streamer_a",
                        "title": "Speedrun",
                        "author": "Streamer_A",
                        "channelId": "streamer_a",
                        "duration": None,
                        "live": True,
                        "viewers": 5000,
                        "views": None,
                        "category": "Celeste",
                        "poster": img("https://static-cdn.jtvnw.net/previews-ttv/a-440x248.jpg"),
                    },
                    {
                        "provider": "twitch",
                        "kind": "channel",
                        "id": "b_login",
                        "title": "",
                        "author": "b_login",
                        "channelId": "b_login",
                        "duration": None,
                        "live": True,
                        "viewers": 10,
                        "views": None,
                        "category": None,
                        "poster": None,
                    },
                ],
                "next": None,
                "channels": [],
                "categories": [],
            },
        )
        self.assertEqual(self.gql_asked(), [POPULAR])
        self.assertEqual(self.kept(self.cinema.catalog), {"twitch:live": 60})

    async def test_typed_is_channels_live_first_and_a_shelf_of_categories(self):
        found = await self.cinema.search("twitch", " Chess ", "")
        self.assertEqual(
            found,
            {
                "items": [
                    {
                        "provider": "twitch",
                        "kind": "channel",
                        "id": "big_live",
                        "title": "Big_Live",
                        "author": "Big_Live",
                        "channelId": "big_live",
                        "duration": None,
                        "live": True,
                        "viewers": 900,
                        "views": None,
                        "category": "Chess",
                        "poster": img(BIG_PREVIEW),
                    },
                    {
                        "provider": "twitch",
                        "kind": "channel",
                        "id": "small_live",
                        "title": "small_live",
                        "author": "",
                        "channelId": "small_live",
                        "duration": None,
                        "live": True,
                        "viewers": 20,
                        "views": None,
                        "category": None,
                        "poster": None,
                    },
                    {
                        "provider": "twitch",
                        "kind": "channel",
                        "id": "quiet_one",
                        "title": "Quiet_One",
                        "author": "Quiet_One",
                        "channelId": "quiet_one",
                        "duration": None,
                        "live": False,
                        "viewers": None,
                        "views": None,
                        "category": None,
                        "poster": img("https://static-cdn.jtvnw.net/jtv_user_pictures/q-300x300.png"),
                    },
                ],
                "next": None,
                "channels": [],
                "categories": self.games(8),
            },
        )
        self.assertEqual(sorted(self.gql_asked()), sorted([channel_search("Chess"), game_search("Chess")]))
        self.assertEqual(
            self.kept(self.cinema.catalog), {"twitch:search:chess": 120, "twitch:games:chess": 300}
        )

    async def test_a_later_portion_has_no_shelf_but_asks_for_it_anyway(self):
        found = await self.cinema.search("twitch", "Chess", "30")
        self.assertEqual(found, {"items": [], "next": None, "channels": [], "categories": []})
        self.assertEqual(len(self.gql_asked()), 2)

    async def test_quotes_and_backslashes_do_not_reach_the_query(self):
        typed = 'Che"ss\\' + "x" * 70
        cleaned = "Che ss " + "x" * 53
        self.gql[channel_search(cleaned)] = {"searchFor": {"channels": {"items": []}}}
        self.gql[game_search(cleaned)] = {"searchFor": {"games": {"items": []}}}
        found = await self.cinema.search("twitch", typed, "")
        self.assertEqual(found, {"items": [], "next": None, "channels": [], "categories": []})
        low = typed.lower()
        self.assertEqual(
            self.kept(self.cinema.catalog), {f"twitch:search:{low}": 120, f"twitch:games:{low}": 300}
        )

    async def test_twitch_saying_no_is_a_bad_gateway(self):
        self.gql[POPULAR] = httpx.Response(500)
        await self.refused(self.cinema.search("twitch", "", ""), 502, "Twitch не ответил на запрос каталога")
        self.gql[POPULAR] = httpx.Response(200, json={"errors": [{"message": "integrity"}]})
        await self.refused(self.cinema.search("twitch", "", ""), 502, "Twitch отказал в запросе каталога")


class YouTubeChannelTests(Stage):
    HANDLE = "https://www.youtube.com/@Blender.Official/videos"
    PAGE = "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv"

    def setUp(self):
        super().setUp()
        self.library.answers[self.HANDLE] = {
            "channel_id": "UCSMOQeBJ2RAnuFungnQOxLg",
            "channel": "Blender",
            "uploader_id": "@BlenderOfficial",
            "description": "d" * 1300,
            "channel_follower_count": 1900000,
            "thumbnails": [
                {"url": "https://yt3.googleusercontent.com/banner=w1060", "width": 1060, "height": 175},
                {"url": "https://yt3.googleusercontent.com/banner=w2120", "width": 2120, "height": 351},
                {"url": "https://yt3.googleusercontent.com/avatar=s900", "width": 900, "height": 900},
                {"url": "https://yt3.googleusercontent.com/no-size"},
            ],
            "entries": [
                {"id": "vid00000001", "title": "One", "duration": 60, "view_count": 5},
                {"id": "vid00000002", "title": "Live", "live_status": "is_live"},
                None,
                {"title": "без адреса"},
            ],
        }

    async def test_videos_tab_carries_the_channel_head_and_its_identity(self):
        found = await self.cinema.channel("youtube", "@Blender.Official", "videos", "")
        self.assertEqual(
            found,
            {
                "channel": {
                    "provider": "youtube",
                    "id": "UCSMOQeBJ2RAnuFungnQOxLg",
                    "title": "Blender",
                    "handle": "@BlenderOfficial",
                    "description": "d" * 1200,
                    "followers": 1900000,
                    "viewers": None,
                    "live": True,
                    "category": None,
                    "avatar": img("https://yt3.googleusercontent.com/avatar=s900"),
                    "banner": img("https://yt3.googleusercontent.com/banner=w2120"),
                },
                "items": [
                    {
                        "provider": "youtube",
                        "kind": "video",
                        "id": "vid00000001",
                        "title": "One",
                        "author": "Blender",
                        "channelId": "UCSMOQeBJ2RAnuFungnQOxLg",
                        "duration": 60,
                        "live": False,
                        "viewers": None,
                        "views": 5,
                        "poster": thumb("vid00000001"),
                    },
                    {
                        "provider": "youtube",
                        "kind": "video",
                        "id": "vid00000002",
                        "title": "Live",
                        "author": "Blender",
                        "channelId": "UCSMOQeBJ2RAnuFungnQOxLg",
                        "duration": None,
                        "live": True,
                        "viewers": None,
                        "views": None,
                        "poster": thumb("vid00000002"),
                    },
                ],
                "next": None,
            },
        )
        self.assertEqual(
            self.library.calls,
            [(self.HANDLE, {**LISTING, "playliststart": 1, "playlistend": 30}, False)],
        )
        self.assertEqual(self.kept(self.cinema.catalog), {"channel:youtube:@blender.official:videos:0": 60})

    async def test_playlists_tab_is_doors_signed_by_the_channel(self):
        entries = [
            {
                "id": f"PL{number:030d}",
                "title": f"List {number}",
                "playlist_count": number,
                "thumbnails": [
                    {"url": f"https://i.ytimg.com/vi/a{number}/default.jpg"},
                    {"url": f"https://i.ytimg.com/vi/a{number}/hqdefault.jpg"},
                ],
            }
            for number in range(29)
        ] + [{"id": "PLbare", "title": None}]
        self.library.answers[self.PAGE + "/playlists"] = {"uploader": "Uploader Name", "entries": entries}
        found = await self.cinema.channel("youtube", "UCabcdefghijklmnopqrstuv", "playlists", "30")
        self.assertEqual(
            found["channel"],
            {
                "provider": "youtube",
                "id": "UCabcdefghijklmnopqrstuv",
                "title": "Uploader Name",
                "handle": "",
                "description": "",
                "followers": None,
                "viewers": None,
                "live": False,
                "category": None,
                "avatar": None,
                "banner": None,
            },
        )
        self.assertEqual(
            found["items"][0],
            {
                "provider": "youtube",
                "kind": "playlist",
                "id": "PL" + "0" * 30,
                "title": "List 0",
                "author": "Uploader Name",
                "channelId": "UCabcdefghijklmnopqrstuv",
                "duration": None,
                "live": False,
                "viewers": None,
                "views": None,
                "count": 0,
                "poster": img("https://i.ytimg.com/vi/a0/hqdefault.jpg"),
            },
        )
        self.assertEqual(
            found["items"][-1],
            {
                "provider": "youtube",
                "kind": "playlist",
                "id": "PLbare",
                "title": "Плейлист",
                "author": "Uploader Name",
                "channelId": "UCabcdefghijklmnopqrstuv",
                "duration": None,
                "live": False,
                "viewers": None,
                "views": None,
                "count": None,
                "poster": None,
            },
        )
        self.assertEqual(len(found["items"]), 30)
        self.assertEqual(found["next"], "60")
        self.assertEqual(
            self.library.calls,
            [(self.PAGE + "/playlists", {**LISTING, "playliststart": 31, "playlistend": 60}, False)],
        )
        self.assertEqual(
            self.kept(self.cinema.catalog), {"channel:youtube:ucabcdefghijklmnopqrstuv:playlists:30": 60}
        )

    async def test_about_tab_is_the_head_of_one_line_of_videos(self):
        self.library.answers[self.PAGE + "/videos"] = {
            "channel_id": "UCabcdefghijklmnopqrstuv",
            "channel": "Chan",
            "entries": [{"id": "vid00000009", "title": "Latest", "live_status": "is_live"}],
        }
        found = await self.cinema.channel("youtube", "UCabcdefghijklmnopqrstuv", "about", "")
        self.assertEqual(found["items"], [])
        self.assertIsNone(found["next"])
        # Шапка без ленты не знает об эфире: признак берётся из карточек, а их здесь нет.
        self.assertFalse(found["channel"]["live"])
        self.assertEqual(found["channel"]["title"], "Chan")
        self.assertEqual(
            self.library.calls,
            [(self.PAGE + "/videos", {**LISTING, "playliststart": 1, "playlistend": 1}, False)],
        )

    async def test_a_tab_the_channel_does_not_have_is_empty_not_broken(self):
        self.library.answers[self.PAGE + "/streams"] = RuntimeError(
            "ERROR: [youtube:tab] This channel does not have a streams tab"
        )
        found = await self.cinema.channel("youtube", "UCabcdefghijklmnopqrstuv", "streams", "")
        self.assertEqual(found, {"channel": None, "items": [], "next": None})
        self.assertEqual(
            self.kept(self.cinema.catalog), {"channel:youtube:ucabcdefghijklmnopqrstuv:streams:0": 60}
        )

    async def test_any_other_failure_is_a_bad_gateway_cut_short(self):
        self.library.answers[self.PAGE + "/shorts"] = RuntimeError("y" * 300)
        await self.refused(
            self.cinema.channel("youtube", "UCabcdefghijklmnopqrstuv", "shorts", ""),
            502,
            ("Канал не открылся: " + "y" * 300)[:200],
        )
        self.assertEqual(self.kept(self.cinema.catalog), {})

    async def test_names_and_cursors_are_checked_before_anything_else(self):
        await self.refused(
            self.cinema.channel("youtube", "bad id!", "videos", "x"), 400, "Непонятное имя канала"
        )
        await self.refused(
            self.cinema.channel("youtube", "UCabc", "videos", "x"), 400, "Дальше листать нечего"
        )
        self.assertEqual(self.library.calls, [])


class TwitchChannelTests(Stage):
    def setUp(self):
        super().setUp()
        self.gql[USER % ("SomeOne", 100)] = twitch_user(live=True)

    def head(self, live=True):
        return {
            "provider": "twitch",
            "id": "someone",
            "title": "SomeOne",
            "handle": "someone",
            "description": "About me",
            "followers": 777,
            "viewers": 321 if live else None,
            "live": live,
            "category": "Chess" if live else None,
            "avatar": img(PROFILE),
            "banner": img(BANNER),
        }

    def live(self):
        return {
            "provider": "twitch",
            "kind": "channel",
            "id": "someone",
            "title": "Live now",
            "author": "SomeOne",
            "channelId": "someone",
            "duration": None,
            "live": True,
            "viewers": 321,
            "views": None,
            "category": "Chess",
            "poster": img(PREVIEW),
        }

    def records(self):
        return [
            {
                "provider": "twitch",
                "kind": "video",
                "id": "2000000001",
                "title": "Yesterday",
                "author": "SomeOne",
                "channelId": "someone",
                "duration": 3600,
                "live": False,
                "viewers": None,
                "views": 50,
                "category": "Chess",
                "published": "2026-09-20",
                "poster": img(VOD_THUMB),
            },
            {
                "provider": "twitch",
                "kind": "video",
                "id": "2000000002",
                "title": "Прошлая трансляция",
                "author": "SomeOne",
                "channelId": "someone",
                "duration": 10,
                "live": False,
                "viewers": None,
                "views": 0,
                "category": None,
                "published": "",
                "poster": None,
            },
        ]

    async def test_videos_tab_is_the_live_stream_then_the_records(self):
        found = await self.cinema.channel("twitch", "SomeOne", "videos", "")
        self.assertEqual(
            found, {"channel": self.head(), "items": [self.live(), *self.records()], "next": None}
        )
        self.assertEqual(self.gql_asked(), [USER % ("SomeOne", 100)])
        self.assertEqual(
            self.kept(self.cinema.catalog),
            {"channel:twitch:someone:videos:0": 60, "twitch:channel:someone": 60},
        )

    async def test_streams_and_about_tabs_come_from_the_same_answer(self):
        streams = await self.cinema.channel("twitch", "SomeOne", "streams", "")
        about = await self.cinema.channel("twitch", "SomeOne", "about", "")
        self.assertEqual(streams, {"channel": self.head(), "items": [self.live()], "next": None})
        self.assertEqual(about, {"channel": self.head(), "items": [], "next": None})
        self.assertEqual(len(self.gql_asked()), 1)

    async def test_a_quiet_channel_has_only_records(self):
        self.gql[USER % ("SomeOne", 100)] = twitch_user(live=False)
        found = await self.cinema.channel("twitch", "SomeOne", "videos", "")
        self.assertEqual(found, {"channel": self.head(live=False), "items": self.records(), "next": None})

    async def test_a_long_login_is_cut_in_the_query(self):
        login = "a" * 50
        self.gql[USER % ("a" * 40, 100)] = {"user": None}
        await self.refused(
            self.cinema.channel("twitch", login, "videos", ""), 404, "Такого канала на Twitch нет"
        )


class YouTubePlaylistTests(Stage):
    LIST = "PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf"
    ADDRESS = "https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf"

    async def test_the_playlist_head_and_its_videos_in_order(self):
        self.library.answers[self.ADDRESS] = {
            "title": "Mix",
            "channel_id": "UCabc",
            "channel": "Chan",
            "description": "p" * 1300,
            "playlist_count": 3,
            "view_count": 999,
            "modified_date": "20260101",
            "thumbnails": [
                {"url": "https://i.ytimg.com/vi/a/hq1.jpg"},
                {"url": "https://i.ytimg.com/vi/a/hq2.jpg"},
            ],
            "entries": [
                {"id": "vid00000001", "title": "One"},
                {"id": "vid00000002", "title": "Two", "channel": "Guest", "channel_id": "UCguest"},
                None,
            ],
        }
        found = await self.cinema.playlist("youtube", self.LIST, "")
        self.assertEqual(
            found,
            {
                "playlist": {
                    "provider": "youtube",
                    "kind": "playlist",
                    "id": self.LIST,
                    "title": "Mix",
                    "author": "Chan",
                    "channelId": "UCabc",
                    "description": "p" * 1200,
                    "count": 3,
                    "views": 999,
                    "published": "20260101",
                    "poster": img("https://i.ytimg.com/vi/a/hq2.jpg"),
                },
                "items": [
                    {
                        "provider": "youtube",
                        "kind": "video",
                        "id": "vid00000001",
                        "title": "One",
                        "author": "Chan",
                        "channelId": "UCabc",
                        "duration": None,
                        "live": False,
                        "viewers": None,
                        "views": None,
                        "poster": thumb("vid00000001"),
                    },
                    {
                        "provider": "youtube",
                        "kind": "video",
                        "id": "vid00000002",
                        "title": "Two",
                        "author": "Guest",
                        "channelId": "UCguest",
                        "duration": None,
                        "live": False,
                        "viewers": None,
                        "views": None,
                        "poster": thumb("vid00000002"),
                    },
                ],
                "next": None,
            },
        )
        self.assertEqual(
            self.library.calls, [(self.ADDRESS, {**LISTING, "playliststart": 1, "playlistend": 30}, False)]
        )
        self.assertEqual(self.kept(self.cinema.catalog), {f"playlist:{self.LIST.lower()}:0": 60})

    async def test_a_playlist_without_an_owner_is_still_a_page(self):
        self.library.answers[self.ADDRESS] = {"entries": [{"id": f"v{n:010d}"} for n in range(30)]}
        found = await self.cinema.playlist("youtube", self.LIST, "60")
        self.assertEqual(
            found["playlist"],
            {
                "provider": "youtube",
                "kind": "playlist",
                "id": self.LIST,
                "title": "Плейлист",
                "author": "",
                "channelId": None,
                "description": "",
                "count": None,
                "views": None,
                "published": None,
                "poster": None,
            },
        )
        self.assertEqual(found["next"], "90")
        self.assertEqual(
            self.library.calls, [(self.ADDRESS, {**LISTING, "playliststart": 61, "playlistend": 90}, False)]
        )

    async def test_a_failure_is_a_bad_gateway_cut_short(self):
        self.library.answers[self.ADDRESS] = RuntimeError("z" * 300)
        await self.refused(
            self.cinema.playlist("youtube", self.LIST, ""), 502, ("Плейлист не открылся: " + "z" * 300)[:200]
        )

    async def test_only_youtube_has_playlists_and_says_so_before_checking_anything(self):
        for playlist, cursor in ((self.LIST, ""), ("bad id!", ""), (self.LIST, "x")):
            await self.refused(
                self.cinema.playlist("twitch", playlist, cursor), 400, "Плейлисты есть только у YouTube"
            )
        await self.refused(self.cinema.playlist("youtube", "bad id!", ""), 400, "Непонятный адрес плейлиста")
        await self.refused(self.cinema.playlist("youtube", self.LIST, "x"), 400, "Дальше листать нечего")
        self.assertEqual(self.library.calls, [])


class TwitchCategoryTests(Stage):
    def setUp(self):
        super().setUp()
        self.gql[TOP_GAMES] = {
            "games": {
                "edges": [
                    {
                        "node": {
                            "id": str(100 + number),
                            "name": f"name-{number}",
                            "displayName": f"Game {number}",
                            "viewersCount": 5000 - number,
                            "boxArtURL": BOX % (100 + number),
                        }
                    }
                    for number in range(32)
                ]
                + [{"node": {"id": None}}, {"node": None}]
            }
        }

    def game(self, number):
        return {
            "provider": "twitch",
            "kind": "category",
            "id": str(100 + number),
            "title": f"Game {number}",
            "viewers": 5000 - number,
            "poster": img(BOX % (100 + number)),
        }

    async def test_sections_are_listed_by_popularity_in_portions(self):
        first = await self.cinema.categories("twitch", "", "")
        self.assertEqual(first, {"items": [self.game(n) for n in range(30)], "next": "30"})
        second = await self.cinema.categories("twitch", "", "30")
        self.assertEqual(second, {"items": [self.game(30), self.game(31)], "next": None})
        self.assertEqual(self.gql_asked(), [TOP_GAMES])
        self.assertEqual(self.kept(self.cinema.catalog), {"twitch:games": 120})

    async def test_typed_sections_share_memory_with_the_search_shelf(self):
        self.gql[game_search("Chess")] = {
            "searchFor": {
                "games": {"items": [{"id": 743, "name": "chess", "displayName": None, "viewersCount": None}]}
            }
        }
        found = await self.cinema.categories("twitch", " Chess ", "")
        self.assertEqual(
            found,
            {
                "items": [
                    {
                        "provider": "twitch",
                        "kind": "category",
                        "id": "743",
                        "title": "chess",
                        "viewers": None,
                        "poster": None,
                    }
                ],
                "next": None,
            },
        )
        self.assertEqual(self.kept(self.cinema.catalog), {"twitch:games:chess": 300})

    async def test_youtube_has_no_sections_and_that_is_an_empty_page(self):
        self.assertEqual(
            await self.cinema.categories("youtube", "x", "not a cursor"), {"items": [], "next": None}
        )
        self.assertEqual(self.seen, [])
        await self.refused(self.cinema.categories("twitch", "", "x"), 400, "Дальше листать нечего")

    async def test_one_section_is_its_card_and_its_live_streams(self):
        self.gql[GAME % ("743", 100)] = {
            "game": {
                "id": "743",
                "name": "chess",
                "displayName": "Chess",
                "viewersCount": 12000,
                "boxArtURL": BOX % 743,
                "streams": {
                    "edges": [
                        {
                            "node": {
                                "id": "9",
                                "title": "Blitz",
                                "viewersCount": 700,
                                "previewImageURL": "https://static-cdn.jtvnw.net/previews-ttv/gm-440x248.jpg",
                                "broadcaster": {"login": "gm", "displayName": "GM"},
                                "game": {"name": "Chess"},
                            }
                        },
                        {"node": {"id": "10", "broadcaster": {}}},
                    ]
                },
            }
        }
        found = await self.cinema.category("twitch", "743", "")
        self.assertEqual(
            found,
            {
                "category": {
                    "provider": "twitch",
                    "kind": "category",
                    "id": "743",
                    "title": "Chess",
                    "viewers": 12000,
                    "poster": img(BOX % 743),
                },
                "items": [
                    {
                        "provider": "twitch",
                        "kind": "channel",
                        "id": "gm",
                        "title": "Blitz",
                        "author": "GM",
                        "channelId": "gm",
                        "duration": None,
                        "live": True,
                        "viewers": 700,
                        "views": None,
                        "category": "Chess",
                        "poster": img("https://static-cdn.jtvnw.net/previews-ttv/gm-440x248.jpg"),
                    }
                ],
                "next": None,
            },
        )
        self.assertEqual(self.kept(self.cinema.catalog), {"twitch:category:743": 60})

    async def test_an_unknown_section_is_not_found(self):
        self.gql[GAME % ("999", 100)] = {"game": None}
        await self.refused(self.cinema.category("twitch", "999", ""), 404, "Такого раздела на Twitch нет")

    async def test_only_twitch_has_sections_and_says_so_before_checking_anything(self):
        for category in ("743", "abc"):
            await self.refused(
                self.cinema.category("youtube", category, "x"), 400, "Разделы есть только у Twitch"
            )
        await self.refused(self.cinema.category("twitch", "abc", ""), 400, "Непонятный раздел")
        await self.refused(self.cinema.category("twitch", "743", "x"), 400, "Дальше листать нечего")
        self.assertEqual(self.seen, [])


class DetailsTests(Stage):
    WATCH = "https://www.youtube.com/watch?v=aqz-KE-bpKQ"

    async def test_a_youtube_video_is_probed_whole(self):
        self.library.answers[self.WATCH] = {
            "title": "Big Buck Bunny",
            "channel": "Blender",
            "uploader": "Blender Foundation",
            "channel_id": "UCSMOQeBJ2RAnuFungnQOxLg",
            "duration": 635,
            "is_live": False,
            "view_count": 21000000,
            "channel_follower_count": 1900000,
            "upload_date": "20140519",
            "categories": ["Film & Animation", "Other"],
            "description": "b" * 5000,
            "thumbnail": "https://i.ytimg.com/vi/aqz-KE-bpKQ/maxresdefault.jpg",
        }
        found = await self.cinema.details("youtube", "aqz-KE-bpKQ", "video")
        self.assertEqual(
            found,
            {
                "provider": "youtube",
                "kind": "video",
                "id": "aqz-KE-bpKQ",
                "title": "Big Buck Bunny",
                "author": "Blender",
                "channelId": "UCSMOQeBJ2RAnuFungnQOxLg",
                "channelAvatar": None,
                "duration": 635,
                "live": False,
                "views": 21000000,
                "viewers": None,
                "followers": 1900000,
                "published": "20140519",
                "category": "Film & Animation",
                "description": "b" * 4000,
                "poster": img("https://i.ytimg.com/vi/aqz-KE-bpKQ/maxresdefault.jpg"),
            },
        )
        self.assertEqual(self.library.calls, [(self.WATCH, PROBE, False)])
        self.assertEqual(self.kept(self.cinema.catalog), {"details:youtube:video:aqz-ke-bpkq": 600})

    async def test_a_youtube_live_has_no_length_and_asks_by_the_same_address_for_any_kind(self):
        self.library.answers[self.WATCH] = {
            "is_live": True,
            "duration": 100,
            "uploader": "Up",
            "concurrent_view_count": 50,
        }
        found = await self.cinema.details("youtube", "aqz-KE-bpKQ", "channel")
        self.assertEqual(
            found,
            {
                "provider": "youtube",
                "kind": "video",
                "id": "aqz-KE-bpKQ",
                "title": "aqz-KE-bpKQ",
                "author": "Up",
                "channelId": None,
                "channelAvatar": None,
                "duration": None,
                "live": True,
                "views": None,
                "viewers": 50,
                "followers": None,
                "published": None,
                "category": None,
                "description": "",
                "poster": None,
            },
        )
        self.assertEqual(self.kept(self.cinema.catalog), {"details:youtube:channel:aqz-ke-bpkq": 600})

    async def test_a_youtube_failure_is_a_bad_gateway_cut_short(self):
        self.library.answers[self.WATCH] = RuntimeError("w" * 400)
        await self.refused(
            self.cinema.details("youtube", "aqz-KE-bpKQ", "video"),
            502,
            ("Не удалось открыть видео: " + "w" * 400)[:300],
        )

    async def test_a_twitch_channel_is_its_head_with_the_live_stream_on_top(self):
        self.gql[USER % ("SomeOne", 100)] = twitch_user(live=True)
        found = await self.cinema.details("twitch", "SomeOne", "channel")
        self.assertEqual(
            found,
            {
                "provider": "twitch",
                "id": "someone",
                "title": "Live now",
                "handle": "someone",
                "description": "About me",
                "followers": 777,
                "viewers": 321,
                "live": True,
                "category": "Chess",
                "avatar": img(PROFILE),
                "banner": img(BANNER),
                "kind": "channel",
                "author": "SomeOne",
                "channelId": "someone",
                "channelAvatar": img(PROFILE),
                "duration": None,
                "views": None,
                "published": None,
                "poster": img(PREVIEW),
            },
        )
        # Подробности канала не кладут его страницу в память — только сам ответ.
        self.assertEqual(self.kept(self.cinema.catalog), {"details:twitch:channel:someone": 600})

    async def test_a_quiet_twitch_channel_shows_its_banner(self):
        self.gql[USER % ("SomeOne", 100)] = twitch_user(live=False)
        found = await self.cinema.details("twitch", "SomeOne", "channel")
        self.assertEqual(found["title"], "SomeOne")
        self.assertEqual(found["poster"], img(BANNER))
        self.assertFalse(found["live"])

    async def test_a_twitch_record_is_its_owner_and_its_numbers(self):
        self.gql[VIDEO % "2000000001"] = {
            "video": {
                "id": "2000000001",
                "title": "Yesterday",
                "lengthSeconds": 3600,
                "viewCount": 50,
                "publishedAt": "2026-09-20T18:00:00Z",
                "description": "v" * 5000,
                "previewThumbnailURL": VOD_THUMB,
                "game": {"name": "Chess"},
                "owner": {
                    "login": "someone",
                    "displayName": "SomeOne",
                    "profileImageURL": PROFILE,
                    "followers": {"totalCount": 777},
                },
            }
        }
        found = await self.cinema.details("twitch", "2000000001", "video")
        self.assertEqual(
            found,
            {
                "provider": "twitch",
                "kind": "video",
                "id": "2000000001",
                "title": "Yesterday",
                "author": "SomeOne",
                "channelId": "someone",
                "channelAvatar": img(PROFILE),
                "duration": 3600,
                "live": False,
                "views": 50,
                "viewers": None,
                "followers": 777,
                "published": "2026-09-20",
                "category": "Chess",
                "description": "v" * 4000,
                "poster": img(VOD_THUMB),
            },
        )

    async def test_a_twitch_record_that_is_gone_is_not_found(self):
        self.gql[VIDEO % "2000000009"] = {"video": None}
        await self.refused(
            self.cinema.details("twitch", "2000000009", "video"), 404, "Такой записи на Twitch нет"
        )

    async def test_an_address_that_is_not_an_id_is_refused(self):
        for provider in ("youtube", "twitch"):
            await self.refused(self.cinema.details(provider, "a b", "video"), 400, "Непонятный адрес видео")


class ResolveTests(Stage):
    WATCH = "https://www.youtube.com/watch?v=aqz-KE-bpKQ"
    MASTER = "https://manifest.googlevideo.com/api/manifest/hls_variant/index.m3u8?expire=1800003600&id=x"

    def youtube(self, **extra):
        return {
            "title": "Big Buck Bunny",
            "uploader": "Blender Foundation",
            "channel": "Blender",
            "duration": 635,
            "is_live": False,
            "language": "en",
            "thumbnail": "https://i.ytimg.com/vi/aqz-KE-bpKQ/maxresdefault.jpg",
            **extra,
        }

    @staticmethod
    def separate_tracks(expire="1800007200"):
        """Дорожки по отдельности — то, из чего собирается DASH, — и один готовый файл."""
        return [
            {
                "format_id": "v",
                "url": f"https://rr1.googlevideo.com/videoplayback?itag=137&expire={expire}",
                "protocol": "https",
                "ext": "mp4",
                "vcodec": "avc1.64002a",
                "acodec": "none",
                "height": 1080,
                "width": 1920,
                "tbr": 3000,
            },
            {
                "format_id": "a",
                "url": f"https://rr1.googlevideo.com/videoplayback?itag=140&expire={expire}",
                "protocol": "https",
                "ext": "m4a",
                "vcodec": "none",
                "acodec": "mp4a.40.2",
                "abr": 128,
            },
            {
                "format_id": "p",
                "url": f"https://rr1.googlevideo.com/videoplayback?itag=18&expire={expire}",
                "protocol": "https",
                "ext": "mp4",
                "vcodec": "avc1.42001E",
                "acodec": "mp4a.40.2",
                "height": 360,
            },
        ]

    def ranges_read(self):
        return [r for r in self.seen if r.url.host.endswith("googlevideo.com")]

    async def test_a_youtube_video_with_a_master_playlist_is_hls(self):
        self.library.answers[self.WATCH] = self.youtube(
            formats=[
                {
                    "protocol": "https",
                    "url": "https://rr1.googlevideo.com/f.mp4",
                    "acodec": "a",
                    "vcodec": "v",
                },
                {"protocol": "m3u8_native", "manifest_url": self.MASTER},
            ],
            subtitles={
                "en": [
                    {"ext": "vtt", "url": "https://www.youtube.com/api/timedtext?lang=en", "name": "English"}
                ]
            },
            automatic_captions={
                "en": [{"ext": "vtt", "url": "https://www.youtube.com/api/timedtext?lang=en&kind=asr"}],
                "fr-orig": [
                    {"ext": "json3", "url": "https://www.youtube.com/api/timedtext?lang=fr&fmt=json3"},
                    {
                        "ext": "vtt",
                        "url": "https://www.youtube.com/api/timedtext?lang=fr&kind=asr&fmt=vtt",
                        "name": "French (Original)",
                    },
                ],
                "de": [
                    {"ext": "vtt", "url": "https://www.youtube.com/api/timedtext?lang=fr&tlang=de&fmt=vtt"}
                ],
            },
        )
        found = await self.cinema.resolve(Resolve(provider="youtube", contentId="aqz-KE-bpKQ"))
        self.assertEqual(
            found,
            {
                "provider": "youtube",
                "contentId": "aqz-KE-bpKQ",
                "title": "Big Buck Bunny",
                "author": "Blender Foundation",
                "duration": 635,
                "live": False,
                "kind": "hls",
                "url": signed(self.MASTER, "playlist", 3600),
                "expiresAt": 1800003600000,
                "notice": None,
                "language": "en",
                "captions": [
                    {
                        "lang": "fr",
                        "label": "French (Original)",
                        "auto": True,
                        "url": signed(
                            "https://www.youtube.com/api/timedtext?lang=fr&kind=asr&fmt=vtt", "fetch"
                        ),
                    }
                ],
                "poster": img("https://i.ytimg.com/vi/aqz-KE-bpKQ/maxresdefault.jpg"),
            },
        )
        self.assertEqual(self.library.calls, [(self.WATCH, PROBE, False)])
        self.assertEqual(self.kept(self.cinema.sources), {"youtube:video:aqz-KE-bpKQ:False": 1800})

    async def test_without_a_playlist_the_best_file_travels_with_its_own_captions(self):
        self.library.answers[self.WATCH] = {
            "formats": [
                {
                    "protocol": "https",
                    "url": "https://rr1.googlevideo.com/videoplayback?itag=18",
                    "acodec": "mp4a",
                    "vcodec": "avc1",
                    "height": 360,
                },
                {
                    "protocol": "https",
                    "url": "https://rr1.googlevideo.com/videoplayback?itag=22",
                    "acodec": "mp4a",
                    "vcodec": "avc1",
                    "height": 720,
                    "tbr": 1000,
                },
            ],
            "subtitles": {
                "ru": [
                    {"ext": "vtt", "url": "https://www.youtube.com/api/timedtext?lang=ru", "name": "Russian"}
                ]
            },
            "automatic_captions": {
                "ru": [{"ext": "vtt", "url": "https://www.youtube.com/api/timedtext?lang=ru&kind=asr"}],
                "ko": [{"ext": "vtt", "url": "https://www.youtube.com/api/timedtext?lang=ko&kind=asr"}],
            },
        }
        found = await self.cinema.resolve(Resolve(provider="youtube", contentId="aqz-KE-bpKQ"))
        self.assertEqual(
            found,
            {
                "provider": "youtube",
                "contentId": "aqz-KE-bpKQ",
                "title": "aqz-KE-bpKQ",
                "author": "",
                "duration": None,
                "live": False,
                "kind": "file",
                "url": signed("https://rr1.googlevideo.com/videoplayback?itag=22", "fetch", FIVE_HOURS),
                "expiresAt": int((NOW + FIVE_HOURS) * 1000),
                "notice": "Доступен только готовый файл: качество ограничено источником",
                "language": "",
                "captions": [
                    {
                        "lang": "ru",
                        "label": "Russian",
                        "auto": False,
                        "url": signed("https://www.youtube.com/api/timedtext?lang=ru", "fetch"),
                    },
                    {
                        "lang": "ko",
                        "label": "ko",
                        "auto": True,
                        "url": signed("https://www.youtube.com/api/timedtext?lang=ko&kind=asr", "fetch"),
                    },
                ],
                "poster": None,
            },
        )

    async def test_a_youtube_video_is_assembled_into_dash_when_the_browser_can_play_it(self):
        self.library.answers[self.WATCH] = self.youtube(formats=self.separate_tracks())
        found = await self.cinema.resolve(Resolve(provider="youtube", contentId="aqz-KE-bpKQ", adaptive=True))
        key = found["url"].rsplit("/", 1)[-1]
        self.assertRegex(found["url"], r"^/api/v1/services/cinema/dash/[0-9a-f]{24}$")
        self.assertEqual(
            {name: value for name, value in found.items() if name != "url"},
            {
                "provider": "youtube",
                "contentId": "aqz-KE-bpKQ",
                "title": "Big Buck Bunny",
                "author": "Blender Foundation",
                "duration": 635,
                "live": False,
                "kind": "dash",
                "expiresAt": 1800007200000,
                "notice": None,
                "language": "en",
                "captions": [],
                "poster": img("https://i.ytimg.com/vi/aqz-KE-bpKQ/maxresdefault.jpg"),
            },
        )
        manifest = self.cinema.dash(key)
        self.assertEqual(manifest.media_type, "application/dash+xml")
        self.assertIn(b'height="1080"', manifest.body)
        # Индекс читается у каждой дорожки из тех, что годятся в DASH, — видео и звук.
        self.assertEqual(len(self.ranges_read()), 2)
        self.assertEqual(self.kept(self.cinema.sources), {"youtube:video:aqz-KE-bpKQ:True": 1800})

    async def test_a_youtube_live_is_never_dash(self):
        self.library.answers[self.WATCH] = self.youtube(
            is_live=True, duration=100, formats=self.separate_tracks()
        )
        found = await self.cinema.resolve(Resolve(provider="youtube", contentId="aqz-KE-bpKQ", adaptive=True))
        self.assertEqual((found["kind"], found["live"], found["duration"]), ("file", True, None))
        self.assertEqual(self.ranges_read(), [])
        self.assertEqual(self.kept(self.cinema.sources), {"youtube:video:aqz-KE-bpKQ:True": 45})

    async def test_a_youtube_live_opened_as_a_channel_is_its_watch_page(self):
        # Эфир YouTube приходит видом `channel`, а смотрится по адресу ролика: вид площадка не
        # различает. Поток — мастер HLS эфира, и DASH не собирается даже там, где браузер его
        # сыграл бы, — отдельных дорожек у эфира нет, есть только край.
        master = "https://manifest.googlevideo.com/api/manifest/hls_variant/live/index.m3u8?id=live"
        self.library.answers[self.WATCH] = self.youtube(
            is_live=True,
            duration=None,
            formats=[{"protocol": "m3u8_native", "manifest_url": master}, *self.separate_tracks()],
        )
        found = await self.cinema.resolve(
            Resolve(provider="youtube", contentId="aqz-KE-bpKQ", kind="channel", adaptive=True)
        )
        self.assertEqual(
            found,
            {
                "provider": "youtube",
                "contentId": "aqz-KE-bpKQ",
                "title": "Big Buck Bunny",
                "author": "Blender Foundation",
                "duration": None,
                "live": True,
                "kind": "hls",
                "url": signed(master, "playlist", FIVE_HOURS),
                "expiresAt": int((NOW + FIVE_HOURS) * 1000),
                "notice": None,
                "language": "en",
                "captions": [],
                "poster": img("https://i.ytimg.com/vi/aqz-KE-bpKQ/maxresdefault.jpg"),
            },
        )
        self.assertEqual(self.library.calls, [(self.WATCH, PROBE, False)])
        self.assertEqual(self.ranges_read(), [])
        self.assertEqual(self.kept(self.cinema.sources), {"youtube:channel:aqz-KE-bpKQ:True": 45})

    async def test_a_twitch_record_is_never_dash_even_when_it_could_be(self):
        address = "https://www.twitch.tv/videos/2000000001"
        self.library.answers[address] = {
            "title": "Yesterday",
            "uploader": "SomeOne",
            "duration": 3600,
            "formats": self.separate_tracks(),
        }
        found = await self.cinema.resolve(
            Resolve(provider="twitch", contentId="2000000001", kind="video", adaptive=True)
        )
        self.assertEqual(
            found,
            {
                "provider": "twitch",
                "contentId": "2000000001",
                "title": "Yesterday",
                "author": "SomeOne",
                "duration": 3600,
                "live": False,
                "kind": "file",
                "url": signed(self.separate_tracks()[2]["url"], "fetch", 7200),
                "expiresAt": 1800007200000,
                "notice": "Доступен только готовый файл: качество ограничено источником",
                "language": "",
                "captions": [],
                "poster": None,
            },
        )
        self.assertEqual(self.ranges_read(), [])
        self.assertEqual(self.library.calls, [(address, PROBE, False)])
        self.assertEqual(self.kept(self.cinema.sources), {"twitch:video:2000000001:True": 1800})

    async def test_a_twitch_channel_is_its_live_playlist(self):
        address = "https://www.twitch.tv/SomeOne"
        master = "https://usher.ttvnw.net/api/channel/hls/someone.m3u8?sig=x"
        self.library.answers[address] = {
            "is_live": True,
            "title": "Live now",
            "uploader": "SomeOne",
            "formats": [{"protocol": "m3u8_native", "manifest_url": master}],
            "thumbnail": "https://static-cdn.jtvnw.net/previews-ttv/live_user_someone-1920x1080.jpg",
        }
        found = await self.cinema.resolve(Resolve(provider="twitch", contentId="SomeOne", kind="channel"))
        self.assertEqual(
            found,
            {
                "provider": "twitch",
                "contentId": "SomeOne",
                "title": "Live now",
                "author": "SomeOne",
                "duration": None,
                "live": True,
                "kind": "hls",
                "url": signed(master, "playlist", FIVE_HOURS),
                "expiresAt": int((NOW + FIVE_HOURS) * 1000),
                "notice": None,
                "language": "",
                "captions": [],
                "poster": img("https://static-cdn.jtvnw.net/previews-ttv/live_user_someone-1920x1080.jpg"),
            },
        )
        self.assertEqual(self.library.calls, [(address, PROBE, False)])
        self.assertEqual(self.kept(self.cinema.sources), {"twitch:channel:SomeOne:False": 45})

    async def test_one_answer_for_the_room_until_someone_asks_to_refresh(self):
        self.library.answers[self.WATCH] = self.youtube(
            formats=[{"protocol": "m3u8", "manifest_url": self.MASTER}]
        )
        request = Resolve(provider="youtube", contentId="aqz-KE-bpKQ")
        first = await self.cinema.resolve(request)
        self.assertEqual(await self.cinema.resolve(request), first)
        self.assertEqual(len(self.library.calls), 1)
        await self.cinema.resolve(Resolve(provider="youtube", contentId="aqz-KE-bpKQ", refresh=True))
        self.assertEqual(len(self.library.calls), 2)

    async def test_a_link_about_to_expire_is_not_kept(self):
        self.library.answers[self.WATCH] = self.youtube(
            formats=[
                {
                    "protocol": "m3u8",
                    "manifest_url": "https://manifest.googlevideo.com/m.m3u8?expire=1800000030",
                }
            ]
        )
        found = await self.cinema.resolve(Resolve(provider="youtube", contentId="aqz-KE-bpKQ"))
        self.assertEqual(found["expiresAt"], 1800000030000)
        self.assertEqual(
            found["url"], signed("https://manifest.googlevideo.com/m.m3u8?expire=1800000030", "playlist", 30)
        )
        # Срок ноль: ответ ляжет в память, но следующий же зритель спросит площадку заново.
        self.assertEqual(self.kept(self.cinema.sources), {"youtube:video:aqz-KE-bpKQ:False": 0})

    async def test_nothing_playable_is_an_honest_refusal(self):
        self.library.answers[self.WATCH] = {"formats": []}
        await self.refused(
            self.cinema.resolve(Resolve(provider="youtube", contentId="aqz-KE-bpKQ")),
            502,
            "Площадка не отдала поток для этого видео. Попробуйте другое",
        )

    async def test_a_platform_failure_is_a_bad_gateway_cut_short(self):
        self.library.answers[self.WATCH] = RuntimeError("Sign in to confirm you're not a bot " + "q" * 400)
        await self.refused(
            self.cinema.resolve(Resolve(provider="youtube", contentId="aqz-KE-bpKQ")),
            502,
            ("Не удалось открыть видео: Sign in to confirm you're not a bot " + "q" * 400)[:300],
        )
        self.assertEqual(self.kept(self.cinema.sources), {})


if __name__ == "__main__":
    unittest.main()
