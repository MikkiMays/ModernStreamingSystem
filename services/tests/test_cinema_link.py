"""
«По ссылке» (`providers/link.py`): что нашлось на чужой странице, чем это отдаётся комнате и где отказ.

Ответы yt-dlp — записи настоящих разборов 24.09.2026 (`fixtures/link/`, обрезаны до нужного): Дзен
(HLS и DASH, субтитры), archive.org (файлы `.ogv`/`.mp4` и коллекция роликов плейлистом), страница
w3schools с двумя `<video>` и тестовый поток Mux (мастер HLS). yt-dlp здесь — `Door`: он отвечает
записью по адресу и помнит, о чём его спросили. Там, где проверяется весь путь — страница, выход,
yt-dlp, поток, — yt-dlp настоящий и ходит через настоящий охраняемый выход к сайтам теста
(`test_cinema_egress.py`), без единого запроса наружу.
"""

import asyncio
import copy
import json
import re
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import httpx
from fastapi import HTTPException

from cord_services.cinema import Cinema, Resolve
from cord_services.cinema import drm as drmmodule
from cord_services.cinema.captions import webvtt
from cord_services.cinema.net import Guard
from cord_services.cinema.providers.link import LINK_ID, LOGIN, Link, MemoryLinks
from cord_services.cinema.resolve import INSIDE, Expired, Inside, Protected, Resolver
from cord_services.cinema.transport.signer import allowed
from cord_services.cinema.registry import HostPolicy
from cord_services.store import Store

from test_cinema_egress import CDN, PUBLIC, Directory, Site, Wires

ROOM = str(uuid.uuid4())
OTHER = str(uuid.uuid4())
FIXTURES = Path(__file__).parent / "fixtures" / "link"

DZEN = "https://dzen.ru/video/watch/6002240ff8b1af50bb2da5e3"
COPS = "https://archive.org/details/Cops1922"
ELECTION = "https://archive.org/details/Election_Ads"
W3 = "https://www.w3schools.com/html/html5_video.asp"
MUX = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8"


def recorded(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


MASTER = "\n".join(
    [
        "#EXTM3U",
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Русский",LANGUAGE="ru",DEFAULT=YES,AUTOSELECT=YES,'
        'URI="audio-ru.m3u8"',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,'
        'URI="audio-en.m3u8"',
        '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Русские",LANGUAGE="ru",URI="subs-ru.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",'
        'AUDIO="aud",SUBTITLES="subs"',
        "720.m3u8",
        '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",'
        'AUDIO="aud",SUBTITLES="subs"',
        "360.m3u8",
        "",
    ]
)


def media(key=""):
    return (
        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-PLAYLIST-TYPE:VOD\n"
        + (key + "\n" if key else "")
        + "#EXTINF:6.0,\nseg0.ts\n#EXTINF:6.0,\nseg1.ts\n#EXT-X-ENDLIST\n"
    )


SAMPLE_AES = '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key-id",KEYFORMAT="com.apple.streamingkeydelivery"'
WIDEVINE = (
    '#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="data:text/plain;base64,AAAA",'
    'KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed",KEYFORMATVERSIONS="1"'
)
AES128 = '#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example/key.bin",IV=0x00000000000000000000000000000001'


class Door:
    """
    yt-dlp теста: `extract_info(process=False)` — сырая запись по адресу, `process_ie_result` —
    обработанная (или та же); `extract_info` с разбором (поток `resolve`) — обработанная.
    """

    def __init__(self, pages=None, processed=None):
        self.pages = pages or {}
        self.processed = processed or {}
        self.asked = []
        self.options = []

    def answer(self, url):
        self.asked.append(url)
        found = self.pages.get(url)
        if isinstance(found, BaseException):
            raise found
        if found is None:
            from yt_dlp.utils import DownloadError, UnsupportedError

            original = UnsupportedError(url)
            raise DownloadError(f"ERROR: Unsupported URL: {url}", (type(original), original, None))
        return copy.deepcopy(found)

    def extract_info(self, url, download=False, process=True, ie_key=None, **_):
        found = self.answer(url)
        if process:
            return copy.deepcopy(self.processed.get(url, found))
        return found

    def process_ie_result(self, result, download=False):
        page = result.get("webpage_url") or result.get("url")
        return copy.deepcopy(self.processed.get(page, result))


def cinema_with(door, handler=None, links=None):
    """Кинозал, у которого yt-dlp — `door`, а сеть потока — `handler` (httpx MockTransport)."""
    # Без своей сети потока «интернет» отдаёт на любой адрес один байт: файл видео жив.
    transport = httpx.MockTransport(handler or (lambda request: httpx.Response(206, content=b"x")))
    cinema = Cinema("secret", httpx.AsyncClient(transport=transport), links=links)

    def run(provider, options, work, *, cookies=None):
        door.options.append((provider, dict(options)))
        return work(door)

    cinema.ytdlp.run = run
    cinema.ytdlp.extract = lambda address, options, provider: (
        door.options.append((provider, dict(options))) or door.extract_info(address, process=True)
    )
    return cinema


def playlists(routes):
    """Сеть потока: адрес → (код, тело); чего нет — 404. Помнит, что спросили."""
    asked = []

    def handler(request):
        asked.append(str(request.url))
        found = routes.get(str(request.url))
        if found is None:
            return httpx.Response(404)
        status, body, *headers = found
        return httpx.Response(status, text=body, headers=headers[0] if headers else {})

    handler.asked = asked
    return handler


def video(url, title="Фильм", **extra):
    """Сырой ответ yt-dlp про одно видео на странице."""
    return {"id": "film", "title": title, "webpage_url": url, "extractor": "generic", **extra}


class LinkCase(unittest.IsolatedAsyncioTestCase):
    async def asyncTearDown(self):
        for cinema in getattr(self, "cinemas", []):
            await cinema.close()

    def make(self, door, handler=None, links=None):
        cinema = cinema_with(door, handler, links)
        self.cinemas = [*getattr(self, "cinemas", []), cinema]
        return cinema

    @staticmethod
    def general(cinema) -> Link:
        return cinema.registry.get("link")


class WhatALinkOpens(LinkCase):
    async def test_a_page_with_one_video_is_a_card_with_what_decides_whether_to_watch_it(self):
        dzen = recorded("dzen.json")
        door = Door({DZEN: dzen}, {DZEN: dzen})
        master = next(item["manifest_url"] for item in dzen["formats"] if item["protocol"] == "m3u8_native")
        cinema = self.make(door, playlists({master: (200, MASTER.replace("audio-", "a-"))}))
        answer = await cinema.link(DZEN, room=ROOM)
        item = answer["item"]
        self.assertTrue(LINK_ID.fullmatch(item["id"]))
        self.assertEqual(
            {key: item[key] for key in ("provider", "kind", "title", "author", "duration", "live", "site")},
            {
                "provider": "link",
                "kind": "video",
                "title": "Извержение вулкана из спичек: зрелищный опыт",
                "author": "TechInsider",
                "duration": 243,
                "live": False,
                "site": "dzen.ru",
            },
        )
        # Ступени — только те, что плеер покажет: варианты HLS; отдельные дорожки DASH — нет.
        self.assertEqual(item["qualities"], ["720p", "144p"])
        self.assertEqual(item["audio"], [])
        self.assertEqual(item["captions"], [{"lang": "ru", "label": "", "auto": False}])
        self.assertEqual(item["views"], 13561876)
        self.assertEqual(item["published"], "20210123")
        self.assertTrue(item["poster"].startswith("/api/v1/services/cinema/image?"))
        self.assertEqual(parse_qs(urlsplit(item["poster"]).query)["p"], ["link"])
        # Разбор — одним вопросом, и никаких запросов наружу, кроме списков HLS на DRM.
        self.assertEqual(door.asked, [DZEN])

    async def test_the_stream_is_ready_before_watch_together_and_is_asked_by_number_only(self):
        dzen = recorded("dzen.json")
        door = Door({DZEN: dzen}, {DZEN: dzen})
        master = next(item["manifest_url"] for item in dzen["formats"] if item["protocol"] == "m3u8_native")
        cinema = self.make(door, playlists({master: (200, "#EXTM3U\n#EXT-X-TARGETDURATION:6\n")}))
        item = (await cinema.link(DZEN, room=ROOM))["item"]
        # «Смотреть вместе» — ответ уже в общей памяти: второго разбора страницы нет.
        cinema.ytdlp.probe = lambda *args, **kwargs: self.fail("страница разобрана второй раз")
        source = await cinema.resolve(
            Resolve(provider="link", contentId=item["id"], kind="video", adaptive=True), room=ROOM
        )
        self.assertEqual(source["kind"], "hls")
        opened = cinema.signer.open(
            "playlist", *(parse_qs(urlsplit(source["url"]).query)[key][0] for key in ("u", "e", "s", "p"))
        )
        self.assertEqual(opened, master)
        self.assertEqual(source["title"], item["title"])
        # Субтитры страницы (WebVTT Дзена) — через маршрут, который переводит и ограничивает.
        self.assertEqual([track["lang"] for track in source["captions"]], ["ru"])
        self.assertTrue(source["captions"][0]["url"].startswith("/api/v1/services/cinema/subtitles?"))

    async def test_a_film_file_is_the_one_the_browser_plays_not_the_one_yt_dlp_calls_best(self):
        cops = recorded("archive-cops.json")
        door = Door({COPS: cops}, {COPS: cops})
        cinema = self.make(door)
        item = (await cinema.link(COPS, room=ROOM))["item"]
        self.assertEqual((item["site"], item["qualities"]), ("archive.org", ["480p"]))
        source = await cinema.resolve(Resolve(provider="link", contentId=item["id"]), room=ROOM)
        self.assertEqual(source["kind"], "file")
        packed = parse_qs(urlsplit(source["url"]).query)
        url = cinema.signer.open("fetch", *(packed[key][0] for key in ("u", "e", "s", "p")))
        self.assertEqual(url, "https://archive.org/download/Cops1922/Cops-v2.mp4")

    async def test_a_bare_hls_link_is_its_master_with_every_quality(self):
        mux = recorded("mux.json")
        door = Door({MUX: mux}, {MUX: mux})
        cinema = self.make(door, playlists({MUX: (200, "#EXTM3U\n")}))
        item = (await cinema.link(MUX, room=ROOM))["item"]
        self.assertEqual(item["qualities"], ["1080p", "720p", "480p", "288p", "184p"])
        self.assertEqual(item["site"], "test-streams.mux.dev")
        # Имя голой ссылки на поток — кусок адреса (`x36xhzz.m3u8`): карточка называет сайт.
        self.assertEqual(item["title"], "Видео с test-streams.mux.dev")

    async def test_voice_tracks_are_the_hls_audio_renditions(self):
        page = "https://kino.example/film"
        info = video(
            page,
            # Как у yt-dlp после разбора: от худшего к лучшему, дорожка по умолчанию — позже.
            formats=[
                {
                    "format_id": "hls-aud-English",
                    "format_note": "English",
                    "language": "en",
                    "vcodec": "none",
                    "protocol": "m3u8_native",
                    "url": "https://cdn.example/audio-en.m3u8",
                    "manifest_url": "https://cdn.example/master.m3u8",
                },
                {
                    "format_id": "hls-aud-Русский",
                    "format_note": "Русский",
                    "language": "ru",
                    "vcodec": "none",
                    "protocol": "m3u8_native",
                    "url": "https://cdn.example/audio-ru.m3u8",
                    "manifest_url": "https://cdn.example/master.m3u8",
                },
                {
                    "format_id": "hls-720",
                    "protocol": "m3u8_native",
                    "height": 720,
                    "width": 1280,
                    "url": "https://cdn.example/720.m3u8",
                    "manifest_url": "https://cdn.example/master.m3u8",
                },
                # Звук DASH — не дорожка на выбор: его плеер не играет.
                {
                    "format_id": "dash-a",
                    "vcodec": "none",
                    "acodec": "mp4a.40.2",
                    "protocol": "https",
                    "format_note": "DASH audio",
                    "url": "https://cdn.example/a.m4a",
                    "ext": "m4a",
                },
            ],
            subtitles={"en": [{"ext": "srt", "url": "https://cdn.example/en.srt", "name": "English"}]},
        )
        door = Door({page: info})
        cinema = self.make(door, playlists({"https://cdn.example/master.m3u8": (200, MASTER)}))
        item = (await cinema.link(page, room=ROOM))["item"]
        self.assertEqual(
            item["audio"], [{"lang": "ru", "label": "Русский"}, {"lang": "en", "label": "English"}]
        )
        self.assertEqual(item["captions"], [{"lang": "en", "label": "English", "auto": False}])
        source = await cinema.resolve(Resolve(provider="link", contentId=item["id"]), room=ROOM)
        # SRT со страницы едет маршрутом `subtitles`: `<track>` читает только WebVTT.
        self.assertTrue(source["captions"][0]["url"].startswith("/api/v1/services/cinema/subtitles?"))

    async def test_a_live_stream_is_a_channel_and_one_not_started_is_not_shown(self):
        page = "https://tv.example/live"
        stream = {
            "protocol": "m3u8_native",
            "url": "https://tv.example/live/720.m3u8",
            "manifest_url": "https://tv.example/live/master.m3u8",
            "height": 720,
        }
        door = Door(
            {
                page: video(
                    page, "Эфир", is_live=True, live_status="is_live", duration=3600, formats=[stream]
                ),
                page + "?soon": video(page, "Скоро", live_status="is_upcoming", formats=[stream]),
            }
        )
        cinema = self.make(door, playlists({"https://tv.example/live/master.m3u8": (200, "#EXTM3U\n")}))
        item = (await cinema.link(page, room=ROOM))["item"]
        self.assertEqual((item["kind"], item["live"], item["duration"]), ("channel", True, None))
        source = await cinema.resolve(
            Resolve(provider="link", contentId=item["id"], kind="channel"), room=ROOM
        )
        self.assertTrue(source["live"])
        answer = await cinema.link(page + "?soon", room=ROOM)
        self.assertEqual(
            answer, {"item": None, "reason": "Эфир ещё не начался — откройте ссылку, когда он пойдёт"}
        )

    async def test_a_dead_first_source_gives_way_to_the_next_that_answers(self):
        # Так у W3C: `<video>` перечисляет `www.w3.org/…/trailer.mp4` (404) и `media.w3.org/…` (живой).
        page = "https://www.w3.org/2010/05/video/mediaevents.html"
        sources = [
            {"url": "https://www.w3.org/2010/05/sintel/trailer.mp4", "ext": "mp4", "protocol": "https"},
            {"url": "https://www.w3.org/2010/05/sintel/trailer.webm", "ext": "webm", "protocol": "https"},
            {"url": "https://media.w3.org/2010/05/sintel/trailer.mp4", "ext": "mp4", "protocol": "https"},
        ]
        routes = {"https://media.w3.org/2010/05/sintel/trailer.mp4": (206, "x")}
        cinema = self.make(Door({page: video(page, formats=sources)}), playlists(routes))
        item = (await cinema.link(page, room=ROOM))["item"]
        source = await cinema.resolve(Resolve(provider="link", contentId=item["id"]), room=ROOM)
        packed = parse_qs(urlsplit(source["url"]).query)
        self.assertEqual(
            cinema.signer.open("fetch", *(packed[key][0] for key in ("u", "e", "s", "p"))),
            "https://media.w3.org/2010/05/sintel/trailer.mp4",
        )
        # Ни один источник не отвечает — это отказ словами, а не плеер, которому нечего играть.
        dead = self.make(Door({page: video(page, formats=sources[:2])}), playlists({}))
        self.assertEqual(
            await dead.link(page, room=ROOM),
            {"item": None, "reason": "Сайт не отдал файл видео — ссылка на него не открывается"},
        )

    async def test_a_hls_without_an_end_is_a_live_stream_even_if_yt_dlp_did_not_say_so(self):
        page = "https://tv.example/stream.m3u8"
        master = "https://tv.example/master.m3u8"
        # К имени эфира yt-dlp дописывает дату разбора — это не название, его комната не видит.
        info = video(
            page,
            "Прямой эфир 2026-09-25 00:31",
            formats=[
                {"protocol": "m3u8_native", "url": "https://tv.example/720.m3u8", "manifest_url": master}
            ],
        )
        live_media = (
            "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:9001\n#EXTINF:6.0,\nseg9001.ts\n"
        )
        routes = {
            master: (200, "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720\n720.m3u8\n"),
            "https://tv.example/720.m3u8": (200, live_media),
        }
        cinema = self.make(Door({page: info}), playlists(routes))
        item = (await cinema.link(page, room=ROOM))["item"]
        self.assertEqual((item["kind"], item["live"], item["duration"]), ("channel", True, None))
        self.assertEqual(item["title"], "Прямой эфир")
        # Поток уже в памяти — под видом эфира, каким его и откроет комната.
        cinema.ytdlp.probe = lambda *args, **kwargs: self.fail("страница разобрана второй раз")
        source = await cinema.resolve(
            Resolve(provider="link", contentId=item["id"], kind="channel"), room=ROOM
        )
        self.assertTrue(source["live"])

    async def test_one_video_of_a_page_is_named_after_the_page_not_numbered(self):
        page = "https://example.org/clip"
        door = Door(
            {
                page: video(
                    page,
                    "Клип (1)",
                    id="clip-1",
                    formats=[{"url": "https://example.org/c.mp4", "ext": "mp4", "protocol": "https"}],
                )
            }
        )
        cinema = self.make(door)
        self.assertEqual((await cinema.link(page, room=ROOM))["item"]["title"], "Клип")


class EmbeddedPlayers(LinkCase):
    async def test_a_player_of_a_known_platform_opens_in_its_own_scene(self):
        blog = "https://blog.example/post"
        for target, route in (
            (
                "https://www.youtube.com/embed/dQw4w9WgXcQ",
                {"provider": "youtube", "kind": "video", "id": "dQw4w9WgXcQ", "page": "item"},
            ),
            (
                "https://rutube.ru/play/embed/d8061eab5d7ed2bad058162bc5762842",
                {
                    "provider": "rutube",
                    "kind": "video",
                    "id": "d8061eab5d7ed2bad058162bc5762842",
                    "page": "item",
                },
            ),
            (
                "//vk.com/video_ext.php?oid=-22277933&id=456242381&hash=87b046504ccd8bfa",
                {"provider": "vk", "kind": "video", "id": "-22277933_456242381", "page": "item"},
            ),
        ):
            door = Door({blog: {"_type": "url_transparent", "url": target, "title": "Пост", "ie_key": "X"}})
            cinema = self.make(door)
            self.assertEqual(await cinema.link(blog, room=str(uuid.uuid4())), {"route": route}, target)
            # Площадку по ссылке разбирает её сцена, а не общий путь: спросили только страницу блога.
            self.assertEqual(door.asked, [blog])

    async def test_a_player_of_a_platform_switched_off_is_known_but_not_opened(self):
        blog = "https://blog.example/post"
        door = Door({blog: {"_type": "url", "url": "https://youtu.be/dQw4w9WgXcQ"}})
        cinema = Cinema("secret", enabled="twitch,link")
        self.cinemas = [cinema]
        cinema.ytdlp.run = lambda provider, options, work, cookies=None: work(door)
        self.assertEqual(
            await cinema.link(blog, room=ROOM),
            {"item": None, "reason": "Это ссылка на YouTube, а эта площадка выключена на этом сервере"},
        )

    async def test_a_player_of_another_site_is_followed_with_the_page_name_on_top(self):
        blog = "https://blog.example/post"
        player = "https://player.example/v/42"
        inner = video(
            player,
            "player 42",
            formats=[{"url": "https://cdn.example/42.mp4", "ext": "mp4", "protocol": "https", "height": 720}],
        )
        door = Door(
            {
                blog: {
                    "_type": "url_transparent",
                    "url": player,
                    "title": "Пост про кино",
                    "thumbnail": "https://blog.example/p.jpg",
                },
                player: inner,
            }
        )
        cinema = self.make(door)
        item = (await cinema.link(blog, room=ROOM))["item"]
        # Как у самого yt-dlp (`url_transparent`): имя и постер — страницы, поток — плеера.
        self.assertEqual(item["title"], "Пост про кино")
        self.assertEqual(item["site"], "blog.example")
        self.assertEqual(door.asked, [blog, player])
        source = await cinema.resolve(Resolve(provider="link", contentId=item["id"]), room=ROOM)
        packed = parse_qs(urlsplit(source["url"]).query)
        self.assertEqual(
            cinema.signer.open("fetch", *(packed[key][0] for key in ("u", "e", "s", "p"))),
            "https://cdn.example/42.mp4",
        )


class Playlists(LinkCase):
    async def test_a_collection_is_a_series_whose_episodes_get_their_numbers_when_asked(self):
        election = recorded("election.raw.json")
        door = Door({ELECTION: election})
        links = MemoryLinks()
        cinema = self.make(door, links=links)
        item = (await cinema.link(ELECTION, room=ROOM))["item"]
        self.assertEqual(
            {key: item[key] for key in ("provider", "kind", "title", "count", "site", "author")},
            {
                "provider": "link",
                "kind": "series",
                "title": "1960 Presidential Campaign Election Commercials",
                "count": 3,
                "site": "archive.org",
                # Автор у archive.org — почта загрузившего: на карточку она не идёт.
                "author": "",
            },
        )
        self.assertNotIn("qualities", item)
        stored = len(links._items)
        page = await cinema.series("link", item["id"], room=ROOM)
        self.assertEqual(page["series"]["title"], item["title"])
        self.assertEqual((page["season"], page["next"]), (None, None))
        self.assertEqual(
            [(card["provider"], card["kind"], card["badge"], card["series"]) for card in page["items"]],
            [("link", "video", f"{number} серия", item["id"]) for number in (1, 2, 3)],
        )
        self.assertEqual(page["items"][1]["title"], "Commercial-JFK1960ElectionAdIkeknocksNixon.mpg")
        self.assertEqual(page["items"][1]["duration"], 60.09)
        # Номера серий заведены порцией, которую спросили, — и только ею.
        self.assertEqual(len(links._items), stored + 3)
        second = page["items"][1]["id"]
        self.assertEqual(links.get(second)["item"], 2)
        details = await cinema.details("link", second, "video", room=ROOM)
        self.assertEqual((details["title"], details["series"]), (page["items"][1]["title"], item["id"]))

        # Серия без своей страницы — второе видео той же страницы: yt-dlp спрашивается о ней одной,
        # и играет файл, который браузер откроет (`.mp4`), а не исходник `.mpg`.
        processed = copy.deepcopy(election)
        entry = processed["entries"][1]
        for number, found in enumerate(entry["formats"]):
            found.update(format_id=str(number), ext=found["url"].rsplit(".", 1)[1])
        door.processed[ELECTION] = {"_type": "playlist", "entries": [entry]}
        source = await cinema.resolve(Resolve(provider="link", contentId=second), room=ROOM)
        provider, options = door.options[-1]
        self.assertEqual((provider, options["playlist_items"]), ("link", "2"))
        packed = parse_qs(urlsplit(source["url"]).query)
        self.assertTrue(
            cinema.signer.open("fetch", *(packed[key][0] for key in ("u", "e", "s", "p"))).endswith(
                "IkeknocksNixon_512kb.mp4"
            )
        )

    async def test_several_videos_on_one_page_are_its_episodes(self):
        door = Door({W3: recorded("w3.raw.json")})
        cinema = self.make(door)
        item = (await cinema.link(W3, room=ROOM))["item"]
        self.assertEqual((item["kind"], item["count"], item["title"]), ("series", 2, "HTML Video"))
        page = await cinema.series("link", item["id"], room=ROOM)
        self.assertEqual([card["title"] for card in page["items"]], ["HTML Video (1)", "HTML Video (2)"])
        self.assertEqual(len({card["id"] for card in page["items"]}), 2)

    async def test_episodes_of_known_platforms_are_their_cards_and_the_series_pages_through(self):
        page_url = "https://blog.example/list"
        entries = [
            {"_type": "url", "url": f"https://youtu.be/{'abcdefghij' + str(n)}", "title": f"Ролик {n}"}
            for n in range(9)
        ]
        entries += [
            {"_type": "url", "url": f"https://videos.example/{n}", "title": f"Видео {n}"} for n in range(31)
        ]
        door = Door({page_url: {"_type": "playlist", "title": "Подборка", "entries": entries}})
        cinema = self.make(door)
        item = (await cinema.link(page_url, room=ROOM))["item"]
        self.assertEqual(item["count"], 40)
        first = await cinema.series("link", item["id"], room=ROOM)
        self.assertEqual(first["next"], "30")
        self.assertEqual((first["items"][0]["provider"], first["items"][0]["id"]), ("youtube", "abcdefghij0"))
        self.assertEqual(first["items"][9]["provider"], "link")
        rest = await cinema.series("link", item["id"], cursor="30", room=ROOM)
        self.assertEqual((len(rest["items"]), rest["next"]), (10, None))

    async def test_a_series_that_is_gone_says_so(self):
        cinema = self.make(Door())
        with self.assertRaises(HTTPException) as gone:
            await cinema.series("link", "A" * 22, room=ROOM)
        self.assertEqual(
            (gone.exception.status_code, gone.exception.detail),
            (410, "Ссылка устарела — вставьте её в кинозал ещё раз"),
        )


class Refusals(LinkCase):
    async def refused(self, error, url="https://site.example/v"):
        door = Door({url: error})
        cinema = self.make(door)
        return await cinema.link(url, room=str(uuid.uuid4()))

    @staticmethod
    def download_error(error):
        from yt_dlp.utils import DownloadError

        return DownloadError(f"ERROR: {error}", (type(error), error, None))

    async def test_what_the_page_is_is_said_in_words(self):
        from yt_dlp.utils import ExtractorError, GeoRestrictedError, UnsupportedError

        for error, reason in (
            (
                UnsupportedError("https://site.example/v"),
                "На этой странице не нашлось видео, которое можно показать комнате",
            ),
            (
                GeoRestrictedError("This video is not available from your location"),
                "Сайт не показывает это видео в стране сервера",
            ),
            (
                ExtractorError(
                    "The web client only works when logged-in. Use --cookies, --username and --password"
                ),
                LOGIN,
            ),
            (
                ExtractorError("Got HTTP Error 403 caused by Cloudflare anti-bot challenge"),
                "Сайт просит подтвердить, что вы не робот, — откройте видео на самом сайте",
            ),
            (
                ExtractorError("Unable to download webpage: HTTP Error 404: Not Found"),
                "Страница не найдена: сайт ответил, что её нет",
            ),
            (
                # Так 25.09.2026 отвечала w3schools.com на честное имя кинозала.
                ExtractorError("Unable to download webpage: HTTP Error 403: Forbidden", expected=True),
                "Сайт не пустил кинозал к этой странице (403) — откройте видео на самом сайте",
            ),
            (
                ExtractorError("No video formats found!"),
                "На этой странице не нашлось видео, которое можно показать комнате",
            ),
        ):
            answer = await self.refused(self.download_error(error))
            self.assertEqual(answer, {"item": None, "reason": reason}, str(error))

    async def test_the_guarded_way_out_speaks_for_itself(self):
        self.assertEqual(
            await self.refused(Inside("10.0.0.5: адрес не публичный")),
            {
                "item": None,
                "reason": INSIDE,
            },
        )
        self.assertEqual(
            await self.refused(Protected()),
            {"item": None, "reason": "Видео защищено DRM — показать комнате нельзя"},
        )
        with self.assertRaises(HTTPException) as late:
            await self.refused(Expired())
        self.assertEqual(
            (late.exception.status_code, late.exception.detail),
            (504, "Сайт не отдал видео за 30 секунд — попробуйте ещё раз или другую ссылку"),
        )

    async def test_a_crash_of_the_extractor_is_not_its_traceback(self):
        from yt_dlp.utils import ExtractorError

        # Так 25.09.2026 отвечал разборщик OK.ru: падение кода и «Unable to extract player».
        for error in (
            TypeError("the JSON object must be str, bytes or bytearray, not dict"),
            self.download_error(
                ExtractorError(
                    "[Odnoklassniki] 4249587550747: Unable to extract player; please report this issue on "
                    "https://github.com/yt-dlp/yt-dlp/issues?q= , filling out the appropriate issue template."
                )
            ),
        ):
            with self.assertRaises(HTTPException) as broken:
                await self.refused(error)
            self.assertEqual(
                (broken.exception.status_code, broken.exception.detail),
                (502, "Разборщик этого сайта не справился со страницей — попробуйте позже или другую ссылку"),
            )

    async def test_an_answer_that_is_not_a_video_is_not_cached_as_a_failure_to_retry(self):
        from yt_dlp.utils import ExtractorError

        url = "https://site.example/v"
        # Так 25.09.2026 отвечал ok.ru: сетевой отказ yt-dlp помечен ожидаемым (`expected`).
        timed_out = ExtractorError(
            "Unable to download webpage: HTTPSConnectionPool(host='ok.ru', port=443): Read timed out. "
            "(read timeout=15.0)",
            expected=True,
        )
        door = Door({url: self.download_error(timed_out)})
        cinema = self.make(door)
        for _ in range(2):
            with self.assertRaises(HTTPException) as failed:
                await cinema.link(url, room=ROOM)
            self.assertEqual(
                (failed.exception.status_code, failed.exception.detail),
                (502, "Сайт не ответил вовремя или оборвал связь — попробуйте ещё раз"),
            )
        # Сбой не запомнен: второй раз страницу спросили снова.
        self.assertEqual(door.asked, [url, url])


class Drm(LinkCase):
    def test_what_is_drm_in_hls_and_dash(self):
        for line in (
            SAMPLE_AES,
            WIDEVINE,
            '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="https://k.example/1"',
            '#EXT-X-SESSION-KEY:METHOD=AES-128,URI="https://k/1",KEYFORMAT="com.microsoft.playready"',
            '#EXT-X-KEY:METHOD=AES-128,URI="skd://abc"',
            '#EXT-X-KEY:METHOD=ISO-23001-7,URI="data:,x"',
            "#EXT-X-FAXS-CM:abc",
        ):
            self.assertTrue(drmmodule.hls(media(line)), line)
        for line in (
            AES128,
            "#EXT-X-KEY:METHOD=NONE",
            "",
            '#EXT-X-KEY:METHOD=AES-128,URI="k.bin",KEYFORMAT="identity"',
        ):
            self.assertFalse(drmmodule.hls(media(line)), line)
        self.assertTrue(
            drmmodule.dash(
                "<MPD><Period><AdaptationSet>"
                '<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011"/>'
            )
        )
        self.assertTrue(drmmodule.dash('<mpd:ContentProtection xmlns:mpd="urn:mpeg:dash:schema:mpd:2011"/>'))
        self.assertFalse(
            drmmodule.dash("<MPD><Period><AdaptationSet><Representation/></AdaptationSet></Period></MPD>")
        )

    def page(self, master_url):
        return video(
            "https://kino.example/film",
            formats=[
                {
                    "protocol": "m3u8_native",
                    "url": master_url.replace("master", "720"),
                    "manifest_url": master_url,
                    "height": 720,
                }
            ],
        )

    async def test_a_key_of_a_drm_system_in_a_media_playlist_is_a_refusal_in_words(self):
        master = "https://cdn.example/master.m3u8"
        for key in (SAMPLE_AES, WIDEVINE):
            routes = {
                master: (200, MASTER),
                "https://cdn.example/720.m3u8": (200, media(key)),
                "https://cdn.example/audio-ru.m3u8": (200, media()),
            }
            cinema = self.make(Door({"https://kino.example/film": self.page(master)}), playlists(routes))
            answer = await cinema.link("https://kino.example/film", room=ROOM)
            self.assertEqual(answer, {"item": None, "reason": "Видео защищено DRM — показать комнате нельзя"})
        # Ключ на дорожке звука — тоже DRM.
        routes = {
            master: (200, MASTER),
            "https://cdn.example/720.m3u8": (200, media()),
            "https://cdn.example/audio-ru.m3u8": (200, media(SAMPLE_AES)),
        }
        cinema = self.make(Door({"https://kino.example/film": self.page(master)}), playlists(routes))
        self.assertEqual(
            (await cinema.link("https://kino.example/film", room=ROOM))["reason"],
            "Видео защищено DRM — показать комнате нельзя",
        )

    async def test_aes_128_with_an_open_key_is_ordinary_hls_and_its_key_goes_through_our_proxy(self):
        master = "https://cdn.example/master.m3u8"
        routes = {
            master: (200, MASTER),
            "https://cdn.example/720.m3u8": (200, media(AES128)),
            "https://cdn.example/audio-ru.m3u8": (200, media()),
        }
        cinema = self.make(Door({"https://kino.example/film": self.page(master)}), playlists(routes))
        item = (await cinema.link("https://kino.example/film", room=ROOM))["item"]
        self.assertEqual(item["kind"], "video")
        response = await cinema.manifest("https://cdn.example/720.m3u8", None, "link")
        body = response.body.decode()
        self.assertIn('#EXT-X-KEY:METHOD=AES-128,URI="/api/v1/services/cinema/fetch?', body)
        self.assertNotIn("https://cdn.example/key.bin", body)

    async def test_the_proxy_refuses_a_drm_playlist_of_a_link_but_not_of_a_catalogue_platform(self):
        youtube = "https://manifest.googlevideo.com/api/manifest/hls_playlist/x/index.m3u8"
        routes = {"https://cdn.example/720.m3u8": (200, media(SAMPLE_AES)), youtube: (200, media(SAMPLE_AES))}
        cinema = self.make(Door(), playlists(routes))
        with self.assertRaises(HTTPException) as refused:
            await cinema.manifest("https://cdn.example/720.m3u8", None, "link")
        self.assertEqual(
            (refused.exception.status_code, refused.exception.detail),
            (403, "Видео защищено DRM — показать комнате нельзя"),
        )
        # У YouTube DRM узнаётся иначе, и его плейлисты прокси проходит, как и раньше.
        self.assertEqual((await cinema.manifest(youtube, None, "youtube")).status_code, 200)

    async def test_yt_dlp_seeing_only_drm_formats_is_the_same_refusal(self):
        page = "https://kino.example/film"
        cinema = self.make(Door({page: video(page, formats=[])}))
        cinema.registry.get("link")  # площадка включена
        door = Door(
            {
                page: video(
                    page,
                    _has_drm=True,
                    formats=[{"protocol": "http_dash_segments", "url": "https://c/x.mpd", "has_drm": True}],
                )
            }
        )
        cinema = self.make(door)
        self.assertEqual(
            await cinema.link(page, room=ROOM),
            {"item": None, "reason": "Видео защищено DRM — показать комнате нельзя"},
        )


class StreamChoice(unittest.TestCase):
    PLAYABLE = ("mp4", "m4v", "webm", "mov")

    def test_a_file_the_browser_plays_wins_over_a_bigger_one_it_does_not(self):
        formats = [
            {"url": "https://a/o.mpg", "ext": "mpg", "protocol": "https", "height": 480},
            {"url": "https://a/o.ogv", "ext": "ogv", "protocol": "https", "height": 480},
            {"url": "https://a/m.mp4", "ext": "mp4", "protocol": "https", "height": 240},
            # MPEG-4 Part 2 в `.mov` браузер не играет, как бы ни был велик кадр.
            {"url": "https://a/v.mov", "ext": "mov", "protocol": "https", "height": 720, "vcodec": "mp4v"},
            {"url": "https://a/b.mp4", "ext": "mp4", "protocol": "https", "height": 360},
        ]
        self.assertEqual(Resolver._stream({"formats": formats}, self.PLAYABLE), ("https://a/b.mp4", "file"))
        self.assertEqual(Resolver._stream({"formats": formats[:2]}, self.PLAYABLE), (None, "file"))

    def test_a_file_is_the_biggest_up_to_1080p_and_mp4_among_equals(self):
        # Так у Wikimedia: исходник 4K в три гигабайта рядом с 1080p — комнате едет 1080p.
        wikimedia = [
            {"url": "https://w/240.webm", "ext": "webm", "protocol": "https", "height": 240, "width": 426},
            {"url": "https://w/1080.webm", "ext": "webm", "protocol": "https", "height": 1080, "width": 1920},
            {"url": "https://w/4k.webm", "ext": "webm", "protocol": "https", "height": 2250, "width": 4000},
        ]
        self.assertEqual(Resolver._stream({"formats": wikimedia}, self.PLAYABLE)[0], "https://w/1080.webm")
        self.assertEqual(Resolver._stream({"formats": wikimedia[2:]}, self.PLAYABLE)[0], "https://w/4k.webm")
        # Вертикальное 1080×1920 — это 1080p, не выше предела.
        tall = [
            {"url": "https://w/tall.mp4", "ext": "mp4", "protocol": "https", "height": 1920, "width": 1080}
        ]
        self.assertEqual(
            Resolver._stream({"formats": tall + wikimedia[:1]}, self.PLAYABLE)[0], "https://w/tall.mp4"
        )
        # Кадр одинаковый — `mp4` раньше `webm`: его играют и старые телефоны.
        same = [
            {"url": "https://a/720.webm", "ext": "webm", "protocol": "https", "height": 720},
            {"url": "https://a/720.mp4", "ext": "mp4", "protocol": "https", "height": 720},
        ]
        self.assertEqual(Resolver._stream({"formats": same}, self.PLAYABLE)[0], "https://a/720.mp4")

    def test_sound_without_picture_is_the_last_resort(self):
        formats = [
            {"url": "https://a/o.wma", "ext": "wma", "protocol": "https", "vcodec": "none"},
            {"url": "https://a/o.mp3", "ext": "mp3", "protocol": "https", "vcodec": "none", "abr": 128},
        ]
        self.assertEqual(Resolver._stream({"formats": formats}, self.PLAYABLE), ("https://a/o.mp3", "file"))

    def test_a_single_quality_playlist_is_hls_not_a_file(self):
        formats = [{"url": "https://a/only.m3u8", "protocol": "m3u8_native", "ext": "mp4"}]
        self.assertEqual(Resolver._stream({"formats": formats}), ("https://a/only.m3u8", "hls"))

    def test_a_dash_manifest_is_never_mistaken_for_hls_or_a_file(self):
        info = {
            "manifest_url": "https://a/x.mpd",
            "protocol": "http_dash_segments",
            "url": "https://a/x.mpd",
            "formats": [
                {
                    "url": "https://a/x.mpd",
                    "protocol": "http_dash_segments",
                    "vcodec": "avc1",
                    "acodec": "mp4a",
                }
            ],
        }
        self.assertEqual(Resolver._stream(info), (None, "file"))


class Limits(LinkCase):
    async def test_a_room_opens_one_link_at_a_time(self):
        started, release = threading.Event(), threading.Event()
        slow = "https://slow.example/v"

        class Slow(Door):
            def extract_info(self, url, download=False, process=True, ie_key=None, **_):
                if url == slow:
                    started.set()
                    release.wait(5)
                return super().extract_info(url, download, process, ie_key)

        page = video(slow, formats=[{"url": "https://slow.example/v.mp4", "ext": "mp4", "protocol": "https"}])
        other = "https://fast.example/v"
        door = Slow({slow: page, other: video(other, formats=page["formats"])})
        cinema = self.make(door)
        first = asyncio.ensure_future(cinema.link(slow, room=ROOM))
        await asyncio.to_thread(started.wait, 5)
        with self.assertRaises(HTTPException) as busy:
            await cinema.link(other, room=ROOM)
        self.assertEqual(
            (busy.exception.status_code, busy.exception.detail),
            (429, "Комната уже разбирает ссылку — дождитесь ответа"),
        )
        # Другая комната ждёт не за этой; и ту же ссылку соседи получают даром, из того же разбора.
        self.assertEqual((await cinema.link(other, room=OTHER))["item"]["kind"], "video")
        joined = asyncio.ensure_future(cinema.link(slow, room=OTHER))
        release.set()
        self.assertEqual((await first)["item"]["id"], (await joined)["item"]["id"])
        self.assertEqual(door.asked.count(slow), 1)
        # Разбор кончился — место у комнаты снова есть.
        self.assertEqual((await cinema.link(other, room=ROOM))["item"]["kind"], "video")

    async def test_ten_new_links_a_minute_and_what_is_known_is_free(self):
        pages = {
            f"https://site.example/{n}": video(
                f"https://site.example/{n}",
                formats=[{"url": f"https://site.example/{n}.mp4", "ext": "mp4", "protocol": "https"}],
            )
            for n in range(12)
        }
        cinema = self.make(Door(pages))
        general = self.general(cinema)
        now = [1000.0]
        general.window.clock = lambda: now[0]
        for n in range(10):
            await cinema.link(f"https://site.example/{n}", room=ROOM)
        # Уже разобранная — из памяти, в счёт не идёт.
        await cinema.link("https://site.example/3#t=10", room=ROOM)
        with self.assertRaises(HTTPException) as often:
            await cinema.link("https://site.example/10", room=ROOM)
        self.assertEqual(
            (often.exception.status_code, often.exception.detail, often.exception.headers["Retry-After"]),
            (429, "Комната слишком часто разбирает ссылки, подождите минуту", "60"),
        )
        now[0] += 60
        await cinema.link("https://site.example/10", room=ROOM)


class Numbers(unittest.TestCase):
    def test_a_link_number_is_22_signed_characters_of_the_address(self):
        general = Link.__new__(Link)
        general.key = b"secret"
        number = general.identify("https://Site.Example:443/film?x=1#t=30")
        self.assertTrue(LINK_ID.fullmatch(number))
        self.assertEqual(number, general.identify("https://site.example/film?x=1"))
        self.assertNotEqual(number, general.identify("https://site.example/film?x=2"))
        self.assertNotEqual(number, general.identify("https://site.example/film?x=1", 2))
        other = Link.__new__(Link)
        other.key = b"another"
        self.assertNotEqual(number, other.identify("https://site.example/film?x=1"))

    def test_a_client_sent_address_is_never_a_number(self):
        cinema = Cinema("secret")
        for bad in ("https://evil.example/", "A" * 21, "A" * 23, "A" * 21 + "="):
            with self.assertRaises(HTTPException) as refused:
                asyncio.run(
                    cinema.resolve(
                        Resolve.model_construct(provider="link", contentId=bad, kind="video"), room=ROOM
                    )
                )
            self.assertEqual(refused.exception.status_code, 400, bad)

    def test_the_numbers_survive_a_restart_of_the_service(self):
        with tempfile.TemporaryDirectory() as root:
            store = Store(Path(root))
            store.links.put("A" * 22, {"kind": "video", "url": "https://site.example/film"}, 3600)
            store.links.put_many(
                {
                    "B" * 22: {"kind": "video", "url": "https://b"},
                    "C" * 22: {"kind": "video", "url": "https://c"},
                },
                3600,
            )
            store.links.put("D" * 22, {"kind": "video", "url": "https://d"}, -1)
            store.db.close()
            again = Store(Path(root))
            self.assertEqual(again.links.get("A" * 22)["url"], "https://site.example/film")
            self.assertEqual(again.links.get("C" * 22)["url"], "https://c")
            self.assertIsNone(again.links.get("D" * 22))
            again.cleanup()
            self.assertEqual(again.db.execute("SELECT count(*) FROM cinema_links").fetchone()[0], 3)
            again.db.close()


class Resolving(LinkCase):
    async def test_a_number_that_is_gone_says_so_and_a_series_is_not_a_stream(self):
        cinema = self.make(Door())
        with self.assertRaises(HTTPException) as gone:
            await cinema.resolve(Resolve(provider="link", contentId="Z" * 22), room=ROOM)
        self.assertEqual(
            (gone.exception.status_code, gone.exception.detail),
            (410, "Ссылка устарела — вставьте её в кинозал ещё раз"),
        )

    async def test_a_watched_link_is_parsed_again_by_its_stored_address_and_lives_another_day(self):
        page = "https://site.example/film"
        info = video(page, formats=[{"url": "https://site.example/f.mp4", "ext": "mp4", "protocol": "https"}])
        links = MemoryLinks()
        door = Door({page: info})
        cinema = self.make(door, links=links)
        item = (await cinema.link(page, room=ROOM))["item"]
        cinema.sources._items.clear()
        before = links._items[item["id"]][0]
        time.sleep(0.01)
        source = await cinema.resolve(Resolve(provider="link", contentId=item["id"], refresh=True), room=ROOM)
        self.assertEqual(source["kind"], "file")
        provider, options = door.options[-1]
        self.assertEqual(provider, "link")
        self.assertFalse(options.get("playlist_items"))
        self.assertEqual(door.asked[-1], page)
        self.assertGreater(links._items[item["id"]][0], before)


class Proxy(LinkCase):
    def test_a_link_may_play_plain_http_but_never_a_port_no_browser_opens(self):
        link, youtube = HostPolicy(public_any=True), HostPolicy(("youtube.com",))
        self.assertTrue(allowed("http://video.example/film.mp4", link))
        self.assertTrue(allowed("https://video.example:8443/film.mp4", link))
        for url in (
            "http://video.example:25/x",
            "https://video.example:22/x",
            "ftp://video.example/x",
            "http://video.example:99999/x",
        ):
            self.assertFalse(allowed(url, link), url)
        # У площадок каталога — как было: только https.
        self.assertFalse(allowed("http://www.youtube.com/x", youtube))
        self.assertTrue(allowed("https://www.youtube.com:25/x", youtube))

    async def test_a_redirect_of_a_link_is_followed_step_by_step_by_its_policy(self):
        routes = {
            "https://archive.example/download/film.mp4": (
                302,
                "",
                {"Location": "https://ia801.archive.example/0/film.mp4"},
            ),
            "https://ia801.archive.example/0/film.mp4": (200, "FILM", {"Content-Length": "4"}),
            "https://archive.example/download/bad.mp4": (
                302,
                "",
                {"Location": "http://ia801.archive.example:25/bad"},
            ),
        }
        handler = playlists(routes)
        cinema = self.make(Door(), handler)
        answer = await cinema.fetch("https://archive.example/download/film.mp4", None, "link")
        self.assertEqual(answer.body, b"FILM")
        with self.assertRaises(HTTPException) as refused:
            await cinema.fetch("https://archive.example/download/bad.mp4", None, "link")
        self.assertEqual(refused.exception.status_code, 502)
        self.assertNotIn("http://ia801.archive.example:25/bad", handler.asked)

    async def test_a_catalogue_platform_still_never_follows_a_redirect(self):
        routes = {
            "https://r1.googlevideo.com/x": (302, "", {"Location": "https://r2.googlevideo.com/x"}),
            # Шаг вёл бы на разрешённый хост — и всё равно не делается: у YouTube переадресация — отказ.
            "https://r2.googlevideo.com/x": (200, "SEG", {"Content-Length": "3"}),
        }
        handler = playlists(routes)
        cinema = self.make(Door(), handler)
        with self.assertRaises(HTTPException) as refused:
            await cinema.fetch("https://r1.googlevideo.com/x", None, "youtube")
        self.assertEqual(refused.exception.status_code, 502)
        self.assertEqual(handler.asked, ["https://r1.googlevideo.com/x"])

    def test_the_password_of_the_way_out_never_reaches_a_refusal_text(self):
        # yt-dlp называет прокси в ошибках соединения — вместе с входом в него.
        cinema = Cinema("secret")
        secret = cinema.egress["link"].secret
        text = cinema.ytdlp.explain(f"Unable to connect to proxy http://lease:{secret}@127.0.0.1:1")
        self.assertNotIn(secret, text)
        self.assertIn("***", text)

    def test_ttml_subtitles_become_webvtt(self):
        ttml = (
            b'<?xml version="1.0" encoding="utf-8"?><tt xmlns="http://www.w3.org/ns/ttml"><body><div>'
            b'<p begin="00:00:01.500" end="00:00:03.000">\xd0\x9f\xd1\x80\xd0\xb8\xd0\xb2\xd0\xb5\xd1\x82</p>'
            b"</div></body></tt>"
        )
        text = webvtt(ttml)
        self.assertTrue(text.startswith("WEBVTT"))
        self.assertIn("00:00:01.500 --> 00:00:03.000", text)
        self.assertIn("Привет", text)
        self.assertEqual(webvtt(b"<not really xml"), "WEBVTT\n")


class ThroughTheRealWay(LinkCase):
    """
    Весь путь без подмен yt-dlp: страница на сайте теста → охраняемый выход → настоящий yt-dlp →
    карточка → поток в общей памяти → плейлист нашим прокси. Сеть — `Wires` и сайты на 127.0.0.1.
    """

    async def asyncSetUp(self):
        self.names = Directory({"films.test": [PUBLIC], "cdn.test": [CDN], "inside.test": ["10.0.0.9"]})
        self.wires = Wires()

    async def site(self, routes, address):
        found = await Site(routes).start()
        self.addAsyncCleanup(found.stop)
        self.wires.connect(address, 80, found)
        return found

    def real(self, handler):
        transport = httpx.MockTransport(handler)
        cinema = Cinema("secret", httpx.AsyncClient(transport=transport))
        gate = cinema.egress["link"]
        gate.guard = Guard((), self.names)
        gate._dial = self.wires
        self.cinemas = [*getattr(self, "cinemas", []), cinema]
        return cinema

    async def test_a_page_with_a_video_tag_becomes_a_card_and_a_stream_of_our_own(self):
        page = (
            b"<html><head><title>Film night</title>"
            b'<meta property="og:image" content="http://cdn.test/poster.jpg"></head><body>'
            b'<video controls><source src="http://cdn.test/film/master.m3u8" type="application/x-mpegURL">'
            b"</video></body></html>"
        )
        await self.site({"/film": (200, {"Content-Type": "text/html; charset=utf-8"}, page)}, PUBLIC)
        master = MASTER.encode()
        cdn = await self.site(
            {"/film/master.m3u8": (200, {"Content-Type": "application/vnd.apple.mpegurl"}, master)}, CDN
        )
        stream = {
            "http://cdn.test/film/master.m3u8": (200, MASTER),
            "http://cdn.test/film/720.m3u8": (200, media(AES128)),
            "http://cdn.test/film/audio-ru.m3u8": (200, media()),
        }
        cinema = self.real(playlists(stream))
        answer = await cinema.link("http://films.test/film", room=ROOM)
        item = answer["item"]
        self.assertEqual((item["title"], item["site"], item["kind"]), ("Film night", "films.test", "video"))
        self.assertEqual(item["qualities"], ["720p", "360p"])
        self.assertEqual(
            item["audio"], [{"lang": "ru", "label": "Русский"}, {"lang": "en", "label": "English"}]
        )
        # Субтитры внутри мастера HLS yt-dlp у `<video>` не перечисляет (`_extract_m3u8_formats` без
        # них) — их покажет сам плеер из мастера; карточка говорит только о том, что знает разбор.
        self.assertEqual(item["captions"], [])
        self.assertEqual(self.wires.dialed, [(PUBLIC, 80), (CDN, 80)])
        self.assertEqual(cdn.requests[0][1], "/film/master.m3u8")

        source = await cinema.resolve(
            Resolve(provider="link", contentId=item["id"], adaptive=True), room=ROOM
        )
        self.assertEqual(source["kind"], "hls")
        packed = parse_qs(urlsplit(source["url"]).query)
        self.assertEqual(
            cinema.signer.open("playlist", *(packed[key][0] for key in ("u", "e", "s", "p"))),
            "http://cdn.test/film/master.m3u8",
        )
        rewritten = (await cinema.manifest("http://cdn.test/film/master.m3u8", None, "link")).body.decode()
        self.assertNotIn("http://cdn.test", rewritten)
        self.assertEqual(rewritten.count("/api/v1/services/cinema/playlist?"), 5)
        self.assertTrue(
            all(
                value == ["link"]
                for value in (
                    parse_qs(line.split("?", 1)[1])["p"]
                    for line in re.findall(r"/api/v1/services/cinema/playlist\?[^\"\s]+", rewritten)
                )
            )
        )

    async def test_a_page_that_embeds_youtube_opens_youtube_without_asking_it(self):
        page = (
            b"<html><head><title>Blog</title></head><body>"
            b'<iframe width="560" height="315" src="https://www.youtube.com/embed/dQw4w9WgXcQ" '
            b'frameborder="0"></iframe>'
            b"</body></html>"
        )
        await self.site({"/post": (200, {"Content-Type": "text/html"}, page)}, PUBLIC)
        cinema = self.real(playlists({}))
        self.assertEqual(
            await cinema.link("http://films.test/post", room=ROOM),
            {"route": {"provider": "youtube", "kind": "video", "id": "dQw4w9WgXcQ", "page": "item"}},
        )
        self.assertEqual(self.wires.dialed, [(PUBLIC, 80)])

    async def test_a_page_that_leads_inside_is_refused_in_words_and_nothing_inside_is_dialled(self):
        await self.site({"/go": (302, {"Location": "http://inside.test/admin"}, b"")}, PUBLIC)
        cinema = self.real(playlists({}))
        answer = await cinema.link("http://films.test/go", room=ROOM)
        self.assertEqual(
            answer,
            {
                "item": None,
                "reason": INSIDE,
            },
        )
        self.assertEqual(self.wires.dialed, [(PUBLIC, 80)])

    async def test_a_site_that_does_not_exist_is_said_so_and_can_be_asked_again(self):
        cinema = self.real(playlists({}))
        with self.assertRaises(HTTPException) as missing:
            await cinema.link("http://nowhere.test/film", room=ROOM)
        self.assertEqual(
            (missing.exception.status_code, missing.exception.detail),
            (502, "Сайт не отвечает или такого адреса нет — проверьте ссылку"),
        )
        self.assertEqual(self.wires.dialed, [])

    async def test_a_site_that_takes_too_long_is_cut_at_the_deadline_with_words(self):
        async def never():
            await asyncio.sleep(30)
            return 200, {}, b""

        await self.site({"/slow": never}, PUBLIC)
        cinema = self.real(playlists({}))
        cinema.egress["link"].seconds = 1.0
        started = time.monotonic()
        with self.assertRaises(HTTPException) as late:
            await cinema.link("http://films.test/slow", room=ROOM)
        self.assertEqual(
            (late.exception.status_code, late.exception.detail),
            (504, "Сайт не отдал видео за 30 секунд — попробуйте ещё раз или другую ссылку"),
        )
        self.assertLess(time.monotonic() - started, 5)


if __name__ == "__main__":
    unittest.main()
