"""
Плеер страниц со стороны службы (`cinema/sniffer.py`, `providers/link.py`): когда страницу открывает браузер,
что из его ответа берётся, с какими заголовками прокси спрашивает поток и когда поток вытягивается заново.

Контейнер `sniffer` здесь — подставной (`FakePages`: его ответы записаны формой настоящего,
`services/sniffer`), yt-dlp — `Door` из тестов «По ссылке», сеть потока — свой обработчик httpx, который
отвечает только с «правильными» cookie и Referer, как сайт, привязывающий поток к своему плееру.
"""

import asyncio
import json
import logging
import tempfile
import unittest
import uuid
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from xml.etree import ElementTree as ET

import httpx
from fastapi import HTTPException

from cord_services.cinema import Cinema, Resolve, mpd
from cord_services.cinema.drm import DRM
from cord_services.cinema.providers.link import FORBIDDEN, LOGIN, NOTHING, ROBOT
from cord_services.cinema.resolve import BUSY, DASH_ONLY, INSIDE, LOCKED, Inside, Protected
from cord_services.cinema.sniffer import (
    ANSWER_LIMIT,
    PROFILE_COOKIES,
    Crowded,
    Profile,
    Profiles,
    Sight,
    Sniffer,
    key_for,
)
from cord_services.cinema.transport.signer import proxied
from cord_services.store import Store

from test_cinema_link import MASTER, SAMPLE_AES, Door, LinkCase, media, video

ROOM = str(uuid.uuid4())
OTHER = str(uuid.uuid4())
PAGE = "https://films.example/watch/7"
CDN = "https://cdn.films.example"
AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.8010.12"
COOKIE = "sid=secret-session-7; ab=1"


def sight(*streams, cookies=None, **facts):
    """Ответ контейнера — формой `services/sniffer/sniffer/page.py`."""
    return {
        "page": PAGE,
        "status": 200,
        "title": "Фильм со страницы",
        "poster": "https://films.example/poster.jpg",
        "duration": None,
        "drm": False,
        "systems": [],
        "robot": False,
        "login": False,
        "inside": False,
        "unreachable": False,
        "clicked": False,
        "seconds": 3.1,
        "streams": list(streams),
        "cookies": {"cdn.films.example": COOKIE} if cookies is None else cookies,
        **facts,
    }


def hls(url=f"{CDN}/hls/master.m3u8?token=t1", **extra):
    return {
        "url": url,
        "type": "hls",
        "master": True,
        "heights": [720, 360],
        "headers": {"referer": PAGE, "origin": "https://films.example", "user-agent": AGENT},
        **extra,
    }


def film(url=f"{CDN}/film.mp4"):
    return {"url": url, "type": "file", "ext": "mp4", "headers": {"referer": PAGE, "user-agent": AGENT}}


class FakePages:
    """Подставной контейнер: ответ по адресу страницы (словарь, код, байты или исключение) и его вопросы."""

    def __init__(self, answers=None):
        self.answers = dict(answers or {})
        self.asked = []
        self.keys = []

    def __call__(self, request):
        body = json.loads(request.content)
        self.asked.append(body["url"])
        self.keys.append(request.headers.get("authorization"))
        found = self.answers.get(body["url"], sight(hls()))
        if isinstance(found, BaseException):
            raise found
        if isinstance(found, int):
            return httpx.Response(found)
        if isinstance(found, bytes):
            return httpx.Response(200, content=found)
        return httpx.Response(200, json=found)


class Stream:
    """
    Сеть потока: сайт отдаёт мастер, варианты и кусочки только с cookie сессии и Referer своей страницы; файл
    — только с Referer. Помнит каждый запрос с его заголовками.
    """

    def __init__(self, master=MASTER, variant=None, *, strict=True):
        self.master = master
        self.variant = variant or media()
        self.strict = strict
        self.seen = []
        self.refuse = False

    def __call__(self, request):
        url = str(request.url)
        self.seen.append((url, dict(request.headers)))
        if self.refuse:
            return httpx.Response(403)
        cookie = request.headers.get("cookie", "")
        referer = request.headers.get("referer", "")
        path = request.url.path
        if path.endswith(".mp4"):
            return httpx.Response(206 if referer == PAGE else 403, content=b"x")
        if (
            self.strict
            and (request.url.host == "cdn.films.example")
            and ("sid=secret-session-7" not in cookie)
        ):
            return httpx.Response(403)
        if self.strict and referer != PAGE:
            return httpx.Response(403)
        if path.endswith("master.m3u8"):
            return httpx.Response(200, text=self.master)
        if path.endswith(".m3u8"):
            return httpx.Response(200, text=self.variant)
        return httpx.Response(200, content=b"SEGMENT", headers={"Content-Length": "7"})

    def headers_of(self, fragment):
        return [headers for url, headers in self.seen if fragment in url]


class SniffCase(LinkCase):
    def make_cinema(self, door, stream, pages=None, *, links=None, sniffer=True):
        pages = pages if pages is not None else FakePages()
        client = httpx.AsyncClient(transport=httpx.MockTransport(pages))
        found = Sniffer("http://sniffer.test", key_for("secret"), client=client) if sniffer else None
        cinema = self.make(door, stream, links)
        # Тот же кинозал, но с плеером страниц: `LinkCase.make` строит его без него.
        cinema.sniffer = found
        general = self.general(cinema)
        general.sniffer = found
        return cinema, pages

    @staticmethod
    def signed(url):
        query = parse_qs(urlsplit(url).query)
        return {key: values[0] for key, values in query.items()}

    async def open(self, cinema, url, route="playlist"):
        parts = self.signed(url)
        address = cinema.signer.open(
            route, parts["u"], parts["e"], parts["s"], parts["p"], parts.get("h", "")
        )
        if route == "playlist":
            return await cinema.manifest(address, None, parts["p"], profile_id=parts.get("h", ""))
        return await cinema.fetch(address, None, parts["p"], profile_id=parts.get("h", ""))


class WhenThePagePlayerIsAsked(SniffCase):
    async def test_a_page_yt_dlp_found_nothing_on_opens_with_the_stream_its_own_player_asked_for(self):
        cinema, pages = self.make_cinema(Door(), Stream())
        answer = await cinema.link(PAGE, room=ROOM)
        item = answer["item"]
        self.assertEqual(
            (item["provider"], item["kind"], item["title"]), ("link", "video", "Фильм со страницы")
        )
        self.assertEqual(item["site"], "films.example")
        self.assertEqual(item["qualities"], ["720p", "360p"])
        self.assertEqual(pages.asked, [PAGE])
        self.assertEqual(pages.keys, [f"Bearer {key_for('secret')}"])
        # «Смотреть вместе» — сразу из памяти: поток разобран вместе с карточкой, адрес подписан с профилем.
        source = await cinema.resolve(Resolve(provider="link", contentId=item["id"]), room=ROOM)
        self.assertEqual(self.signed(source["url"])["h"], item["id"])
        self.assertEqual(pages.asked, [PAGE])

    async def test_a_403_a_crashed_extractor_and_an_unknown_refusal_go_to_the_page_player(self):
        from yt_dlp.utils import DownloadError, ExtractorError

        for error in (
            ExtractorError("Unable to download webpage: HTTP Error 403: Forbidden", expected=True),
            TypeError("the JSON object must be str, bytes or bytearray, not NoneType"),
            DownloadError("ERROR: something the site said in its own words"),
        ):
            cinema, pages = self.make_cinema(Door({PAGE: error}), Stream())
            answer = await cinema.link(PAGE, room=str(uuid.uuid4()))
            self.assertIsNotNone(answer["item"], repr(error))
            self.assertEqual(pages.asked, [PAGE], repr(error))

    async def test_what_yt_dlp_understood_stays_a_refusal_and_never_reaches_the_browser(self):
        from yt_dlp.utils import ExtractorError, GeoRestrictedError

        for error, reason in (
            (Protected(), DRM),
            (ExtractorError("Use --cookies, --username and --password"), LOGIN),
            (ExtractorError("Got HTTP Error 403 caused by Cloudflare anti-bot challenge"), ROBOT),
            (GeoRestrictedError("not available"), "Сайт не показывает это видео в стране сервера"),
            (ExtractorError("HTTP Error 404: Not Found"), "Страница не найдена: сайт ответил, что её нет"),
            (Inside("127.0.0.1: адрес 127.0.0.1 не публичный"), INSIDE),
        ):
            cinema, pages = self.make_cinema(Door({PAGE: error}), Stream())
            answer = await cinema.link(PAGE, room=str(uuid.uuid4()))
            self.assertEqual(answer, {"item": None, "reason": reason})
            self.assertEqual(pages.asked, [], reason)

    async def test_a_silent_site_stays_a_failure_and_never_reaches_the_browser(self):
        from yt_dlp.utils import DownloadError

        cinema, pages = self.make_cinema(Door({PAGE: DownloadError("ERROR: Read timed out.")}), Stream())
        with self.assertRaises(HTTPException) as failed:
            await cinema.link(PAGE, room=ROOM)
        self.assertEqual(failed.exception.status_code, 502)
        self.assertEqual(pages.asked, [])

    async def test_a_file_that_answers_only_its_own_page_goes_to_the_page_player(self):
        # yt-dlp нашёл `<video src>`, но файл без Referer страницы отвечает 403: это работа плеера страниц.
        found = video(PAGE, formats=[{"url": f"{CDN}/film.mp4", "ext": "mp4", "protocol": "https"}])
        cinema, pages = self.make_cinema(Door({PAGE: found}), Stream(), FakePages({PAGE: sight(film())}))
        answer = await cinema.link(PAGE, room=ROOM)
        self.assertEqual(answer["item"]["title"], "Фильм со страницы")
        self.assertEqual(pages.asked, [PAGE])
        source = await cinema.resolve(Resolve(provider="link", contentId=answer["item"]["id"]), room=ROOM)
        self.assertEqual(source["kind"], "file")

    async def test_a_master_refused_to_us_goes_to_the_page_player(self):
        master = f"{CDN}/hls/master.m3u8?token=t1"
        found = video(PAGE, formats=[{"url": master, "manifest_url": master, "protocol": "m3u8_native"}])
        cinema, pages = self.make_cinema(Door({PAGE: found}), Stream())
        answer = await cinema.link(PAGE, room=ROOM)
        self.assertIsNotNone(answer["item"])
        self.assertEqual(pages.asked, [PAGE])

    async def test_without_the_page_player_the_answer_of_yt_dlp_stays(self):
        cinema, _ = self.make_cinema(Door(), Stream(), sniffer=False)
        self.assertEqual(await cinema.link(PAGE, room=ROOM), {"item": None, "reason": NOTHING})
        for broken in (httpx.ConnectError("refused"), 401, 500, b"not json", b"x" * (ANSWER_LIMIT + 10)):
            cinema, pages = self.make_cinema(Door(), Stream(), FakePages({PAGE: broken}))
            self.assertEqual(
                await cinema.link(PAGE, room=str(uuid.uuid4())), {"item": None, "reason": NOTHING}
            )
            self.assertEqual(pages.asked, [PAGE])

    async def test_a_busy_page_player_says_so(self):
        cinema, _ = self.make_cinema(Door(), Stream(), FakePages({PAGE: 503}))
        with self.assertRaises(HTTPException) as busy:
            await cinema.link(PAGE, room=ROOM)
        self.assertEqual((busy.exception.status_code, busy.exception.detail), (503, BUSY))


class WhatThePagePlayerSaw(SniffCase):
    async def said(self, answer, stream=None):
        cinema, _ = self.make_cinema(Door(), stream or Stream(), FakePages({PAGE: answer}))
        return await cinema.link(PAGE, room=str(uuid.uuid4()))

    async def test_what_is_not_to_be_opened_is_said_in_words(self):
        for answer, reason in (
            (sight(hls(), drm=True, systems=["com.widevine.alpha"]), DRM),
            (sight(inside=True), INSIDE),
            (sight(robot=True), ROBOT),
            (sight(login=True), LOGIN),
            (sight(status=403), FORBIDDEN),
            (sight(), NOTHING),
        ):
            self.assertEqual(await self.said(answer), {"item": None, "reason": reason}, reason)

    async def test_a_stream_is_taken_even_on_a_page_that_also_has_a_captcha_widget(self):
        answer = await self.said(sight(hls(), robot=True))
        self.assertIsNotNone(answer["item"])

    async def test_drm_keys_in_the_playlist_are_still_a_refusal(self):
        answer = await self.said(sight(hls()), Stream(variant=media(SAMPLE_AES)))
        self.assertEqual(answer, {"item": None, "reason": DRM})

    async def test_a_master_the_site_refuses_even_with_the_profile_is_said_so(self):
        stream = Stream()
        stream.refuse = True
        self.assertEqual(await self.said(sight(hls()), stream), {"item": None, "reason": LOCKED})

    def test_nothing_that_could_break_a_request_or_leak_a_cookie_is_taken(self):
        found = Sight.parse(
            sight(
                hls(headers={"referer": PAGE + "\r\nX-Injected: 1", "origin": "null", "user-agent": "Агент"}),
                {"url": "javascript:alert(1)", "type": "hls", "headers": {}},
                {"url": "http://user:pass@cdn.films.example/a.m3u8", "type": "hls", "headers": {}},
                {"url": f"{CDN}/a.m3u8#__youtubedl_smuggle=%7B%7D", "type": "hls", "headers": {}},
                {"url": f"{CDN}/b.m3u8", "type": "rtmp", "headers": {}},
                *[hls(f"{CDN}/{number}.m3u8") for number in range(20)],
                cookies={
                    "cdn.films.example": COOKIE,
                    "bad host!": "a=b",
                    "cdn2.films.example": "a=b\r\nSet-Cookie: x",
                    "cdn3.films.example": "x" * (PROFILE_COOKIES + 1),
                },
                title="  Фильм\nсо страницы\x00 ",
                poster="javascript:alert(1)",
            )
        )
        self.assertEqual(
            (found.streams[0].referer, found.streams[0].origin, found.streams[0].agent), ("", "", "")
        )
        self.assertEqual(len(found.streams), 12)
        self.assertTrue(all(seen.url.startswith(CDN) and "#" not in seen.url for seen in found.streams))
        self.assertEqual(dict(found.cookies), {"cdn.films.example": COOKIE})
        self.assertEqual(found.title, "Фильм со страницы")
        self.assertEqual(found.poster, "")
        self.assertEqual(Sight.parse(["not", "a", "dict"]), Sight())


class TheProfileOfTheStream(SniffCase):
    async def opened(self, stream=None, answer=None):
        stream = stream or Stream()
        cinema, pages = self.make_cinema(Door(), stream, FakePages({PAGE: answer or sight(hls())}))
        item = (await cinema.link(PAGE, room=ROOM))["item"]
        source = await cinema.resolve(Resolve(provider="link", contentId=item["id"]), room=ROOM)
        return cinema, stream, item, source

    async def test_the_proxy_asks_the_stream_with_the_headers_the_page_player_sent(self):
        cinema, stream, item, source = await self.opened()
        stream.seen.clear()
        answer = await self.open(cinema, source["url"])
        master = stream.headers_of("master.m3u8")[0]
        self.assertEqual(master["referer"], PAGE)
        self.assertEqual(master["origin"], "https://films.example")
        self.assertEqual(master["user-agent"], AGENT)
        self.assertEqual(master["cookie"], COOKIE)
        # Всё внутри мастера — под тем же профилем: номер профиля в подписи каждого адреса.
        inner = [line for line in answer.body.decode().splitlines() if "/cinema/" in line]
        self.assertTrue(inner)
        for line in inner:
            address = line.partition('URI="')[2].partition('"')[0] or line
            self.assertEqual(self.signed(address)["h"], item["id"])

    async def test_segments_of_a_whole_film_go_with_the_profile_and_the_cookie_only_to_its_host(self):
        variant = (
            "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-PLAYLIST-TYPE:VOD\n"
            f'#EXT-X-KEY:METHOD=AES-128,URI="{CDN}/key.bin"\n'
            "#EXTINF:6.0,\nseg0.ts\n#EXTINF:6.0,\nhttps://other-cdn.example/seg1.ts\n#EXT-X-ENDLIST\n"
        )
        cinema, stream, item, source = await self.opened(Stream(variant=variant, strict=False))
        master = (await self.open(cinema, source["url"])).body.decode()
        first = next(
            line for line in master.splitlines() if line.startswith("/api/v1/services/cinema/playlist")
        )
        numbered = (await self.open(cinema, first)).body.decode()
        key_line = next(line for line in numbered.splitlines() if line.startswith("#EXT-X-KEY"))
        segments = [line for line in numbered.splitlines() if line.startswith("seg/")]
        self.assertEqual(len(segments), 2)
        stream.seen.clear()
        for segment in segments:
            _, key, number = segment.split("/")
            reel = cinema.reels.find(key, int(number))
            self.assertEqual(reel.profile, item["id"])
            await cinema.fetch(reel.url, None, reel.provider, profile_id=reel.profile)
        await self.open(cinema, key_line.partition('URI="')[2].partition('"')[0], "fetch")
        own = stream.headers_of("cdn.films.example/hls/seg0.ts")[0]
        other = stream.headers_of("other-cdn.example/seg1.ts")[0]
        key = stream.headers_of("key.bin")[0]
        self.assertEqual((own["cookie"], own["referer"], own["user-agent"]), (COOKIE, PAGE, AGENT))
        self.assertEqual(key["cookie"], COOKIE)
        # Другому хосту — те же Referer и имя браузера, но не cookie: её браузер туда не посылал.
        self.assertNotIn("cookie", other)
        self.assertEqual((other["referer"], other["user-agent"]), (PAGE, AGENT))

    async def test_a_profile_cannot_be_moved_to_another_address(self):
        cinema, _, item, source = await self.opened()
        parts = self.signed(source["url"])
        attempts = (
            {**parts, "h": "A" * 22},
            {key: value for key, value in parts.items() if key != "h"},
        )
        for attempt in attempts:
            with self.assertRaises(HTTPException) as refused:
                cinema.signer.open(
                    "playlist", attempt["u"], attempt["e"], attempt["s"], "link", attempt.get("h", "")
                )
            self.assertEqual(refused.exception.status_code, 403)
        # И чужой адрес под подписью без профиля профиль не получит.
        plain = self.signed(
            proxied(cinema.signer, "https://attacker.example/steal.m3u8", "playlist", provider="link")
        )
        with self.assertRaises(HTTPException) as refused:
            cinema.signer.open("playlist", plain["u"], plain["e"], plain["s"], "link", item["id"])
        self.assertEqual(refused.exception.status_code, 403)

    async def test_a_signature_without_a_profile_is_the_same_as_before(self):
        cinema = Cinema("secret")
        with_nothing = cinema.signer.sign("https://www.youtube.com/x", 60, "fetch", "youtube")
        self.assertEqual(set(with_nothing), {"u", "e", "p", "s"})
        self.assertEqual(
            cinema.signer.open("fetch", with_nothing["u"], with_nothing["e"], with_nothing["s"], "youtube"),
            "https://www.youtube.com/x",
        )
        await cinema.close()

    async def test_a_refused_stream_asks_the_player_of_the_room_to_renew_it(self):
        cinema, stream, _, source = await self.opened()
        stream.refuse = True
        with self.assertRaises(HTTPException) as stale:
            await self.open(cinema, source["url"])
        self.assertEqual(stale.exception.status_code, 410)

    async def test_a_profile_that_is_gone_asks_the_player_of_the_room_to_renew_it(self):
        cinema, stream, item, source = await self.opened()
        cinema.profiles.forget(item["id"])
        stream.seen.clear()
        with self.assertRaises(HTTPException) as stale:
            await self.open(cinema, source["url"])
        self.assertEqual(stale.exception.status_code, 410)
        # Без профиля к сайту не ходили вовсе.
        self.assertEqual(stream.seen, [])

    async def test_cookies_stay_in_memory_and_out_of_the_log(self):
        with self.assertLogs("cord_services", level=logging.DEBUG) as log:
            logging.getLogger("cord_services").debug("начало")
            cinema, _, item, _ = await self.opened()
        record = self.general(cinema).links.get(item["id"])
        self.assertNotIn("secret-session-7", json.dumps(record))
        self.assertTrue(record["cookied"])
        self.assertEqual(
            record["headers"], {"referer": PAGE, "origin": "https://films.example", "agent": AGENT}
        )
        self.assertNotIn("secret-session-7", "\n".join(log.output))
        self.assertNotIn("token=t1", "\n".join(log.output))


class Renewal(SniffCase):
    async def opened(self, stream=None, links=None, answer=None, pages=None):
        stream = stream or Stream()
        pages = pages or FakePages({PAGE: answer or sight(hls())})
        cinema, pages = self.make_cinema(Door(), stream, pages, links=links)
        item = (await cinema.link(PAGE, room=ROOM))["item"]
        return cinema, stream, pages, item

    async def test_a_refresh_opens_the_page_again_once_for_the_whole_room(self):
        cinema, _, pages, item = await self.opened()
        # «Смотреть вместе» сразу после карточки — не работа: поток только что вытянут.
        first = await cinema.resolve(Resolve(provider="link", contentId=item["id"], refresh=True), room=ROOM)
        self.assertEqual(pages.asked, [PAGE])
        # Сосед по комнате — тоже с `refresh` в те же секунды: ответ тот же.
        again = await cinema.resolve(Resolve(provider="link", contentId=item["id"], refresh=True), room=ROOM)
        self.assertEqual(again["url"], first["url"])
        self.assertEqual(pages.asked, [PAGE])

    async def test_after_the_grace_a_refresh_opens_the_page_again(self):
        cinema, _, pages, item = await self.opened()
        general = self.general(cinema)
        general.renewed[item["id"]] -= 60
        await cinema.resolve(Resolve(provider="link", contentId=item["id"], refresh=True), room=ROOM)
        self.assertEqual(pages.asked, [PAGE, PAGE])

    async def test_a_number_resolves_from_the_record_while_the_stream_answers(self):
        cinema, stream, pages, item = await self.opened()
        cinema.sources = type(cinema.sources)(capacity=64)
        source = await cinema.resolve(Resolve(provider="link", contentId=item["id"]), room=ROOM)
        self.assertEqual(pages.asked, [PAGE])
        self.assertEqual(self.signed(source["url"])["h"], item["id"])
        # Поток перестал отвечать с профилем — плеер страниц открывает страницу снова.
        cinema.sources = type(cinema.sources)(capacity=64)
        stream.refuse = True
        with self.assertRaises(HTTPException):
            await cinema.resolve(Resolve(provider="link", contentId=item["id"]), room=str(uuid.uuid4()))
        self.assertEqual(pages.asked, [PAGE, PAGE])

    async def test_after_a_restart_a_cookieless_stream_is_restored_and_a_cookied_one_is_sniffed(self):
        with self.subTest("без cookies"):
            store = Store(Path(tempfile.mkdtemp()))
            answer = sight(hls(), cookies={})
            _, _, pages, item = await self.opened(Stream(strict=False), store.links, answer)
            restarted, _ = self.make_cinema(Door(), Stream(strict=False), pages, links=store.links)
            await restarted.resolve(Resolve(provider="link", contentId=item["id"]), room=ROOM)
            self.assertEqual(pages.asked, [PAGE])
        with self.subTest("с cookies"):
            store = Store(Path(tempfile.mkdtemp()))
            _, _, pages, item = await self.opened(Stream(), store.links)
            restarted, _ = self.make_cinema(Door(), Stream(), pages, links=store.links)
            source = await restarted.resolve(Resolve(provider="link", contentId=item["id"]), room=ROOM)
            self.assertEqual(pages.asked, [PAGE, PAGE])
            self.assertEqual(self.signed(source["url"])["h"], item["id"])

    async def test_renewal_is_under_the_room_gate(self):
        cinema, _, pages, item = await self.opened()
        general = self.general(cinema)
        general.renewed[item["id"]] -= 60
        held = general.enter(ROOM)
        with self.assertRaises(HTTPException) as busy:
            await cinema.resolve(Resolve(provider="link", contentId=item["id"], refresh=True), room=ROOM)
        self.assertEqual(busy.exception.status_code, 429)
        general.leave(ROOM, held)
        self.assertEqual(pages.asked, [PAGE])


class Parts(SniffCase):
    def test_the_key_is_the_same_formula_as_the_container(self):
        # Тот же образец, что у контейнера (`services/sniffer/tests/test_capture.py`).
        self.assertEqual(
            key_for("local-development-internal-secret-32bytes"),
            "de15ca6b425f4cfddf100152f4835ca2de15a2fb6278e7a779a0ba4c98842f05",
        )

    def test_a_cookie_goes_only_to_the_host_the_browser_sent_it_to(self):
        profile = Profile("x", referer=PAGE, agent=AGENT, cookies={"cdn.films.example": COOKIE})
        self.assertEqual(profile.headers_for(f"{CDN}/a.ts")["Cookie"], COOKIE)
        self.assertNotIn("Cookie", profile.headers_for("https://films.example.evil.example/a.ts"))
        self.assertNotIn("Cookie", profile.headers_for("https://evil.example/cdn.films.example/a.ts"))
        self.assertEqual(profile.public(), {"referer": PAGE, "origin": "", "agent": AGENT})
        self.assertNotIn(COOKIE, repr(profile))

    def test_profiles_are_bounded_and_expire(self):
        profiles = Profiles(capacity=2, ttl=60)
        for name in "abc":
            profiles.put(Profile(name))
        self.assertIsNone(profiles.get("a"))
        self.assertIsNotNone(profiles.get("c"))
        stale = Profiles(ttl=-1)
        stale.put(Profile("x"))
        self.assertIsNone(stale.get("x"))

    async def test_the_page_player_is_asked_at_most_two_pages_at_once(self):
        release = asyncio.Event()
        started = []

        async def slow(request):
            started.append(request)
            await release.wait()
            return httpx.Response(200, json=sight())

        sniffer = Sniffer(
            "http://sniffer.test",
            "k",
            client=httpx.AsyncClient(transport=httpx.MockTransport(slow)),
            wait=0.2,
        )
        first = asyncio.ensure_future(sniffer.look(PAGE, "a"))
        second = asyncio.ensure_future(sniffer.look(PAGE, "b"))
        await asyncio.sleep(0.05)
        with self.assertRaises(Crowded):
            await sniffer.look(PAGE, "c")
        release.set()
        await asyncio.gather(first, second)
        self.assertEqual(len(started), 2)
        await sniffer.close()


FIXTURES = Path(__file__).parent / "fixtures" / "sniff"
MPD = "https://vd503.okcdn.example/?expires=1790393199610&srcIp=203.0.113.7&type=4&id=1"


def dash(url=MPD):
    return {"url": url, "type": "dash", "headers": {"referer": PAGE, "user-agent": AGENT}}


class Dash:
    """Сеть потока DASH: манифест и дорожки отдаются только с Referer страницы; дорожки — диапазонами."""

    def __init__(self, body):
        self.body = body
        self.seen = []

    def __call__(self, request):
        self.seen.append((str(request.url), dict(request.headers)))
        if request.headers.get("referer") != PAGE:
            return httpx.Response(403)
        if request.url.path.endswith(".mp4"):
            return httpx.Response(206, content=b"x")
        if "ct=" not in str(request.url):
            return httpx.Response(200, text=self.body, headers={"Content-Type": "application/dash+xml"})
        return httpx.Response(206, content=b"x", headers={"Content-Range": "bytes 0-0/100"})


TEMPLATE = (
    '<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" '
    'mediaPresentationDuration="PT10S"><Period><AdaptationSet mimeType="video/mp4" codecs="avc1.64001f">'
    '<SegmentTemplate media="chunk-$Number$.m4s" initialization="init.mp4" duration="2" />'
    '<Representation id="1" bandwidth="1000" width="640" height="360" /></AdaptationSet></Period></MPD>'
)
PROTECTED = (
    '<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" '
    'mediaPresentationDuration="PT10S"><Period><AdaptationSet mimeType="video/mp4" codecs="avc1.64001f">'
    '<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed" />'
    '<Representation id="1" bandwidth="1000"><BaseURL>v.mp4</BaseURL>'
    '<SegmentBase indexRange="100-200"><Initialization range="0-99" /></SegmentBase></Representation>'
    "</AdaptationSet></Period></MPD>"
)


class ForeignDash(SniffCase):
    def on_demand(self):
        return (FIXTURES / "ok-on-demand.mpd").read_text(encoding="utf-8")

    async def test_an_on_demand_manifest_plays_as_ours_with_every_track_signed_with_the_profile(self):
        network = Dash(self.on_demand())
        cinema, _ = self.make_cinema(Door(), network, FakePages({PAGE: sight(dash())}))
        item = (await cinema.link(PAGE, room=ROOM))["item"]
        self.assertEqual((item["kind"], item["title"]), ("video", "Фильм со страницы"))
        source = await cinema.resolve(
            Resolve(provider="link", contentId=item["id"], adaptive=True), room=ROOM
        )
        self.assertEqual(source["kind"], "dash")
        self.assertAlmostEqual(source["duration"], 132.655)
        body = cinema.dash(source["url"].rsplit("/", 1)[1]).body.decode()
        root = ET.fromstring(body)
        bases = [element.text for element in root.iter() if element.tag.endswith("BaseURL")]
        self.assertEqual(len(bases), 7)
        for base in bases:
            self.assertTrue(base.startswith("/api/v1/services/cinema/fetch?"))
            self.assertEqual(self.signed(base)["h"], item["id"])
        # Из чужого манифеста — только проверенное: ни его атрибутов, ни его элементов в нашем нет.
        self.assertNotIn("quality=", body)
        self.assertNotIn("AudioChannelConfiguration", body)
        self.assertNotIn("okcdn", body)
        self.assertIn('mimeType="video/webm"', body)
        self.assertIn('indexRange="433-2564"', body)
        # Диапазон дорожки идёт к сайту с заголовками профиля.
        network.seen.clear()
        parts = self.signed(bases[0])
        address = cinema.signer.open("fetch", parts["u"], parts["e"], parts["s"], parts["p"], parts["h"])
        await cinema.fetch(address, "bytes=0-432", "link", profile_id=parts["h"])
        headers = network.seen[-1][1]
        self.assertEqual(
            (headers["referer"], headers["user-agent"], headers["range"]), (PAGE, AGENT, "bytes=0-432")
        )

    async def test_a_browser_without_media_source_is_not_given_dash(self):
        cinema, _ = self.make_cinema(Door(), Dash(self.on_demand()), FakePages({PAGE: sight(dash())}))
        item = (await cinema.link(PAGE, room=ROOM))["item"]
        with self.assertRaises(HTTPException) as refused:
            await cinema.resolve(Resolve(provider="link", contentId=item["id"], adaptive=False), room=OTHER)
        self.assertEqual((refused.exception.status_code, refused.exception.detail), (502, DASH_ONLY))

    async def test_a_template_manifest_falls_back_to_the_file_of_the_page(self):
        cinema, _ = self.make_cinema(Door(), Dash(TEMPLATE), FakePages({PAGE: sight(dash(), film())}))
        item = (await cinema.link(PAGE, room=ROOM))["item"]
        source = await cinema.resolve(
            Resolve(provider="link", contentId=item["id"], adaptive=True), room=ROOM
        )
        self.assertEqual(source["kind"], "file")

    async def test_a_template_manifest_alone_or_a_protected_one_is_said_in_words(self):
        for body, reason in ((TEMPLATE, DASH_ONLY), (PROTECTED, DRM)):
            cinema, _ = self.make_cinema(Door(), Dash(body), FakePages({PAGE: sight(dash())}))
            answer = await cinema.link(PAGE, room=str(uuid.uuid4()))
            self.assertEqual(answer, {"item": None, "reason": reason})


class ManifestRules(unittest.TestCase):
    def test_the_real_on_demand_manifest_gives_its_tracks_and_length(self):
        tracks, seconds = mpd.parse((FIXTURES / "ok-on-demand.mpd").read_text(encoding="utf-8"), MPD)
        self.assertEqual(seconds, 132.655)
        self.assertEqual([track.kind for track in tracks], ["video"] * 4 + ["audio"] * 3)
        first = tracks[0]
        self.assertEqual(
            (first.mime, first.codecs, first.width, first.height), ("video/webm", "vp9", 240, 426)
        )
        self.assertEqual((first.initialization, first.index), ((0, 432), (433, 2564)))
        # Адрес дорожки — относительно манифеста: у OK.ru это одна строка запроса.
        self.assertTrue(first.url.startswith("https://vd503.okcdn.example/?expires=1790393199610&srcIp="))

    def test_base_addresses_chain_from_the_manifest_down_to_the_track(self):
        text = (
            '<MPD xmlns="urn:mpeg:DASH:schema:MPD:2011" type="static" mediaPresentationDuration="PT1M2.5S">'
            "<BaseURL>https://cdn.example/root/</BaseURL><Period><BaseURL>film/</BaseURL>"
            '<AdaptationSet mimeType="audio/mp4" codecs="mp4a.40.2" lang="ru"><BaseURL>audio/</BaseURL>'
            '<Representation bandwidth="128000"><BaseURL>ru.m4a</BaseURL>'
            '<SegmentBase indexRange="700-900"><Initialization range="0-699"/></SegmentBase>'
            "</Representation></AdaptationSet></Period></MPD>"
        )
        (track,), seconds = mpd.parse(text, "https://site.example/manifest.mpd")
        self.assertEqual(track.url, "https://cdn.example/root/film/audio/ru.m4a")
        self.assertEqual((track.language, seconds), ("ru", 62.5))

    def test_what_is_not_on_demand_or_not_safe_is_refused(self):
        head = '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT10S"'
        track = (
            '<AdaptationSet mimeType="video/mp4" codecs="avc1.64001f"><Representation bandwidth="1">'
            '<BaseURL>v.mp4</BaseURL><SegmentBase indexRange="10-20"><Initialization range="0-9"/>'
            "</SegmentBase></Representation></AdaptationSet>"
        )
        for text in (
            TEMPLATE,
            f'{head} type="dynamic"><Period>{track}</Period></MPD>',
            f"{head}><Period>{track}</Period><Period>{track}</Period></MPD>",
            f"{head.replace(' mediaPresentationDuration="PT10S"', '')}><Period>{track}</Period></MPD>",
            f"{head}><Period>{track.replace('avc1.64001f', 'avc1"onload=x')}</Period></MPD>",
            f"{head}><Period>{track.replace('v.mp4', 'javascript:alert(1)')}</Period></MPD>",
            f"{head}><Period>{track.replace('10-20', '20-10')}</Period></MPD>",
            "<html>not a manifest</html>",
            "<MPD",
            "x" * (mpd.LIMIT + 1),
        ):
            with self.assertRaises(mpd.NotOnDemand, msg=text[:120]):
                mpd.parse(text, "https://site.example/manifest.mpd")
        with self.assertRaises(mpd.Protected):
            mpd.parse(PROTECTED, "https://site.example/manifest.mpd")

    def test_an_entity_bomb_is_not_expanded(self):
        bomb = (
            '<?xml version="1.0"?><!DOCTYPE MPD [<!ENTITY a "aaaaaaaaaa">'
            + "".join(
                f'<!ENTITY {chr(98 + n)} "&{chr(97 + n)};&{chr(97 + n)};&{chr(97 + n)};&{chr(97 + n)};">'
                for n in range(12)
            )
            + ']><MPD type="static" mediaPresentationDuration="PT1S"><Period>&m;</Period></MPD>'
        )
        with self.assertRaises(mpd.NotOnDemand):
            mpd.parse(bomb, "https://site.example/manifest.mpd")

    def test_an_ambiguous_vp9_is_spelled_out_for_the_browser(self):
        tracks, _ = mpd.parse((FIXTURES / "ok-on-demand.mpd").read_text(encoding="utf-8"), MPD)
        # 240×426 — уровень 2.1; звук не трогается.
        self.assertEqual(mpd.spelled(tracks[0]), "vp09.00.21.08")
        self.assertEqual(mpd.spelled(tracks[-1]), "opus")
        full = mpd.Track(
            "video", "video/webm", "vp9", 1, "https://a.example/v", (0, 1), (2, 3), 0, 3840, 2160
        )
        self.assertEqual(mpd.spelled(full), "vp09.00.51.08")
        other = mpd.Track("video", "video/mp4", "avc1.64001f", 1, "https://a.example/v", (0, 1), (2, 3), 0)
        self.assertEqual(mpd.spelled(other), "avc1.64001f")

    def test_our_manifest_carries_only_checked_values(self):
        tracks, seconds = mpd.parse((FIXTURES / "ok-on-demand.mpd").read_text(encoding="utf-8"), MPD)
        body = mpd.manifest(tracks, seconds, lambda url: "/signed?" + str(len(url)))
        root = ET.fromstring(body)
        allowed = {
            "MPD": {"type", "profiles", "minBufferTime", "mediaPresentationDuration"},
            "Period": {"start"},
            "AdaptationSet": {"id", "contentType", "mimeType", "lang"},
            "Representation": {"id", "codecs", "bandwidth", "width", "height", "frameRate"},
            "BaseURL": set(),
            "SegmentBase": {"indexRange", "indexRangeExact", "timescale"},
            "Initialization": {"range"},
        }
        for element in root.iter():
            name = element.tag.rsplit("}", 1)[-1]
            self.assertIn(name, allowed)
            self.assertLessEqual(set(element.attrib), allowed[name], name)
        self.assertIn("urn:webm:dash:profile:webm-on-demand:2012", root.get("profiles"))
