"""
Укрепление кинозала без видимых изменений (задача 4): то, что раньше проходило молча, а теперь
отказывает, — и то, что раньше путалось, а теперь различается.

Тест здесь называет дыру и доказывает, что она закрыта: на коде до задачи он падал (или не
находил нового API). Те немногие, что проходили и тогда, стерегут прежнее поведение рядом с
новым — например, мелкий кусочек по-прежнему один на комнату. Сцена та же, что у
характеристики (`test_cinema_providers.Stage`): остановленные часы, подменённый yt-dlp и сеть,
которая знает только свои ответы.
"""

import asyncio
import copy
import gzip
import hmac
import json
import re
import time
import unittest
from hashlib import sha256
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from urllib.parse import parse_qsl, urlencode, urlsplit

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse

import test_cinema_providers as characterization
from test_cinema_providers import USER, Stage, indexed_mp4, twitch_user

from cord_services.cinema import PREFIX, Cinema, Memo, Resolve, routes
from cord_services.cinema.limits import Window
from cord_services.cinema.providers.twitch import Twitch
from cord_services.cinema.providers.youtube import YT_FLAT, YouTube
from cord_services.cinema.registry import Kit, Provider, Registry
from cord_services.cinema.resolve import YtDlp
from cord_services.cinema.transport.signer import Signer


def kit():
    return Kit(memo=Memo(), image=lambda url: None, ytdlp=YtDlp())


class MutatingYoutubeDL:
    """
    Как настоящий `yt_dlp.YoutubeDL`: хранит переданный словарь опций как есть и дописывает в
    него своё (`http_headers`, `compat_opts`, …) — в том числе внутрь вложенных словарей.
    """

    def __init__(self, params):
        params["http_headers"] = {"User-Agent": "yt-dlp"}
        params["compat_opts"] = set()
        for value in params.values():
            if isinstance(value, dict):
                value["touched"] = True

    def __enter__(self):
        return self

    def __exit__(self, *failure):
        return False

    def extract_info(self, address, download=True):
        return {"entries": []}


class IdentifierTests(Stage):
    """
    Идентификатор из браузера уходит в чужой адрес — поэтому проверяется целиком.

    Прежние проверки стояли на `re.match(r"^…$")`, а `$` в Python совпадает и перед
    завершающим переводом строки: `UCabc\\n` проходил и уезжал в адрес yt-dlp и в текст запроса
    GraphQL. `contentId` в `resolve` не проверялся вовсе (у pydantic `pattern` — поиск, а не
    совпадение целиком): `aqz-KE-bpKQ&list=…` дописывал параметры в адрес страницы YouTube.
    """

    async def test_a_line_break_after_an_id_is_refused_before_anything_is_asked(self):
        for action, detail in (
            (lambda: self.cinema.channel("youtube", "UCabcdefghij\n", "videos", ""), "Непонятное имя канала"),
            (lambda: self.cinema.channel("twitch", "someone\n", "videos", ""), "Непонятное имя канала"),
            (lambda: self.cinema.playlist("youtube", "PLabcdefghij\n", ""), "Непонятный адрес плейлиста"),
            (lambda: self.cinema.category("twitch", "743\n", ""), "Непонятный раздел"),
            (lambda: self.cinema.details("youtube", "aqz-KE-bpKQ\n", "video"), "Непонятный адрес видео"),
            (lambda: self.cinema.details("twitch", "2000000001\n", "video"), "Непонятный адрес видео"),
        ):
            await self.refused(action(), 400, detail)
        self.assertEqual(self.library.calls, [])
        self.assertEqual(self.seen, [])

    async def test_a_content_id_is_the_whole_platform_form_or_nothing(self):
        for provider, content in (
            ("youtube", "aqz-KE-bpKQ&list=PLabcdefghij"),
            ("youtube", "aqz-KE-bpKQ\n"),
            ("youtube", "../../feed/history"),
            ("twitch", "someone/videos"),
            ("twitch", "some one"),
        ):
            request = Resolve(provider=provider, contentId=content)
            await self.refused(self.cinema.resolve(request), 400, "Непонятный адрес видео")
        self.assertEqual(self.library.calls, [])
        self.assertEqual(self.kept(self.cinema.sources), {})


class TwitchQueryTests(Stage):
    """Строка в GraphQL Twitch — настоящий строковый литерал, а не текст между кавычками."""

    def serve(self, request):
        # Любой поиск отвечает пустым списком: здесь важен сам запрос, а не ответ.
        self.seen.append(request)
        empty = {"searchFor": {"channels": {"items": []}, "games": {"items": []}}}
        return httpx.Response(200, json={"data": empty})

    async def test_quotes_backslashes_and_line_breaks_travel_as_they_were_typed(self):
        # Раньше кавычки и обратные косые черты заменялись пробелами (искался другой текст), а
        # перевод строки уходил в литерал как есть — и Twitch отвечал синтаксической ошибкой.
        typed = 'a"b\\c\nd") { __typename } #'
        await self.cinema.search("twitch", typed, "")
        asked = self.gql_asked()
        self.assertEqual(len(asked), 2)
        for query in asked:
            start = query.index("userQuery: ") + len("userQuery: ")
            # Нестрогий разбор: на старом коде перевод строки стоял в литерале как есть.
            value, end = json.JSONDecoder(strict=False).raw_decode(query, start)
            self.assertEqual(value, typed)
            # После литерала — ровно то, что стояло в шаблоне: ввод из строки не вышел.
            self.assertTrue(query[end:].startswith(', platform: "web", target: {index: '), query)


class SignedLinkTests(Stage):
    """
    Подпись связывает маршрут, площадку и адрес, а хост проверяет политика своей площадки.

    Раньше подписаны были только адрес и срок: ссылка картинки (сутки жизни) открывала и
    `/fetch`, и `/playlist`, а хост сверялся с общим списком двух площадок — Twitch мог отдать
    через наш прокси адрес YouTube и наоборот. Проверяется всё через настоящие маршруты и
    только теми ссылками, которые служба выдала сама.
    """

    WATCH = "https://www.youtube.com/watch?v=aqz-KE-bpKQ"
    TWITCH_MASTER = "https://usher.ttvnw.net/api/channel/hls/someone.m3u8?sig=x"
    TWITCH_BODY = (
        "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n"
        "https://video-weaver.hls.ttvnw.net/v1/playlist/a.m3u8\n"
        "#EXT-X-STREAM-INF:BANDWIDTH=2\n"
        "https://manifest.googlevideo.com/api/manifest/hls_playlist/b\n"
    )

    def serve(self, request):
        if request.url.host == "gql.twitch.tv":
            return super().serve(request)
        self.seen.append(request)
        if request.url.host == "usher.ttvnw.net":
            return httpx.Response(200, text=self.TWITCH_BODY)
        if request.url.path.endswith("videoplayback"):
            payload = indexed_mp4()
            return httpx.Response(
                206,
                headers={"content-range": f"bytes 0-{len(payload) - 1}/{len(payload) + 100}"},
                content=payload,
            )
        return httpx.Response(200, content=b"bytes", headers={"content-type": "image/jpeg"})

    async def get(self, path):
        app = FastAPI()
        app.include_router(routes(self.cinema, None))
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://cord.test") as client:
            return await client.get(path)

    async def refused_link(self, path, detail="Ссылка не подписана этим сервером"):
        answer = await self.get(path)
        self.assertEqual(answer.status_code, 403, path)
        self.assertEqual(answer.json(), {"detail": detail})

    async def youtube_poster(self):
        self.library.answers["ytsearch60:big buck"] = {"entries": [{"id": "aqz-KE-bpKQ"}]}
        found = await self.cinema.search("youtube", "big buck", "")
        return found["items"][0]["poster"]

    async def test_a_picture_link_opens_the_picture_and_nothing_else(self):
        poster = await self.youtube_poster()
        self.assertTrue(poster.startswith(PREFIX + "/image?"), poster)
        self.assertEqual((await self.get(poster)).status_code, 200)
        for route in ("fetch", "playlist"):
            await self.refused_link(poster.replace("/image?", f"/{route}?"))

    async def test_a_stream_link_opens_only_its_own_route(self):
        master = "https://manifest.googlevideo.com/api/manifest/hls_variant/m.m3u8"
        self.library.answers[self.WATCH] = {"formats": [{"protocol": "m3u8", "manifest_url": master}]}
        found = await self.cinema.resolve(Resolve(provider="youtube", contentId="aqz-KE-bpKQ"))
        self.assertTrue(found["url"].startswith(PREFIX + "/playlist?"), found["url"])
        for route in ("fetch", "image"):
            await self.refused_link(found["url"].replace("/playlist?", f"/{route}?"))

    async def test_a_link_signed_for_one_platform_does_not_open_as_another(self):
        poster = await self.youtube_poster()
        query = dict(parse_qsl(urlsplit(poster).query))
        query["p"] = "twitch"
        await self.refused_link(PREFIX + "/image?" + urlencode(query))

    async def test_a_platform_cannot_hand_out_a_host_of_another_platform(self):
        # Запись Twitch, у которой yt-dlp нашёл файл на хосте YouTube: подпись Twitch его не
        # открывает, и наружу за ним никто не ходит.
        self.library.answers["https://www.twitch.tv/videos/2000000001"] = {
            "formats": [
                {
                    "protocol": "https",
                    "url": "https://rr1.googlevideo.com/videoplayback?itag=18",
                    "acodec": "mp4a",
                    "vcodec": "avc1",
                }
            ]
        }
        found = await self.cinema.resolve(Resolve(provider="twitch", contentId="2000000001", kind="video"))
        await self.refused_link(found["url"], "Этот адрес не обслуживается")
        self.assertEqual(self.seen, [])

    async def test_a_playlist_proxies_only_the_hosts_of_its_platform(self):
        self.library.answers["https://www.twitch.tv/someone"] = {
            "is_live": True,
            "formats": [{"protocol": "m3u8_native", "manifest_url": self.TWITCH_MASTER}],
        }
        found = await self.cinema.resolve(Resolve(provider="twitch", contentId="someone", kind="channel"))
        answer = await self.get(found["url"])
        self.assertEqual(answer.status_code, 200)
        self.assertNotIn("video-weaver", answer.text)
        self.assertEqual(answer.text.count(PREFIX + "/playlist?"), 1)
        # Строка на хосте YouTube осталась как была: плеер пойдёт за ней сам, не через нас.
        self.assertIn("\nhttps://manifest.googlevideo.com/api/manifest/hls_playlist/b\n", answer.text)

    async def test_pictures_of_another_platform_are_not_signed(self):
        user = twitch_user(live=False)
        user["user"]["profileImageURL"] = "https://yt3.ggpht.com/avatar"
        self.gql[USER % ("someone", 100)] = user
        found = await self.cinema.channel("twitch", "someone", "about", "")
        self.assertIsNone(found["channel"]["avatar"])
        self.assertTrue(found["channel"]["banner"].startswith(PREFIX + "/image?"))

    async def test_captions_and_dash_tracks_of_another_platform_are_left_out(self):
        tracks = [
            {**track, "url": track["url"].replace("rr1.googlevideo.com", "rr1.ttvnw.net")}
            for track in characterization.ResolveTests.separate_tracks()[:2]
        ]
        self.library.answers[self.WATCH] = {
            "duration": 10,
            "formats": [*tracks, characterization.ResolveTests.separate_tracks()[2]],
            "subtitles": {
                "en": [{"ext": "vtt", "url": "https://www.youtube.com/api/timedtext?lang=en"}],
                "de": [{"ext": "vtt", "url": "https://static-cdn.jtvnw.net/captions/de.vtt"}],
            },
        }
        found = await self.cinema.resolve(Resolve(provider="youtube", contentId="aqz-KE-bpKQ", adaptive=True))
        self.assertEqual(found["kind"], "file")
        self.assertEqual([track["lang"] for track in found["captions"]], ["en"])
        self.assertFalse([request for request in self.seen if request.url.host.endswith("ttvnw.net")])


class SignerTests(unittest.TestCase):
    """Подпись по отдельности: что именно в неё входит и что она отказывается открыть."""

    URL = "https://rr5.googlevideo.com/videoplayback?id=1"

    def setUp(self):
        clock = patch("time.time", return_value=1_800_000_000.0)
        clock.start()
        self.addCleanup(clock.stop)
        self.signer = Signer("secret", {"youtube": YouTube.hosts, "twitch": Twitch.hosts}.get)

    def refused(self, route, parts, status=403, detail="Ссылка не подписана этим сервером"):
        with self.assertRaises(HTTPException) as refusal:
            self.signer.open(route, parts["u"], parts["e"], parts["s"], parts["p"])
        self.assertEqual((refusal.exception.status_code, refusal.exception.detail), (status, detail))

    def test_a_signature_opens_only_its_route(self):
        for route in ("playlist", "fetch", "image"):
            parts = self.signer.sign(self.URL, 60, route, "youtube")
            self.assertEqual(
                self.signer.open(route, parts["u"], parts["e"], parts["s"], parts["p"]), self.URL
            )
            for other in {"playlist", "fetch", "image"} - {route}:
                self.refused(other, parts)

    def test_a_signature_opens_only_as_its_platform(self):
        parts = self.signer.sign(self.URL, 60, "fetch", "youtube")
        self.refused("fetch", {**parts, "p": "twitch"})
        self.refused("fetch", {**parts, "p": ""})

    def test_a_platform_that_is_not_on_opens_nothing(self):
        # Подписанный адрес выключенной или незнакомой площадки: подпись верна, но политики
        # хостов нет — и прокси за ним не идёт.
        parts = self.signer.sign(self.URL, 60, "fetch", "vimeo")
        self.refused("fetch", parts, detail="Этот адрес не обслуживается")

    def test_a_link_issued_before_the_route_was_signed_is_refused_not_broken(self):
        # Старая форма: подписаны только адрес и срок, площадки в ссылке нет. Плеер получает 403
        # и переоткрывает источник сам.
        packed = self.signer.sign(self.URL, 60, "fetch", "youtube")["u"]
        expires = "1800000060"
        digest = hmac.new(b"secret", f"{packed}|{expires}".encode(), sha256).hexdigest()[:32]
        self.refused("fetch", {"u": packed, "e": expires, "s": digest, "p": ""})

    def test_a_signature_in_another_alphabet_is_a_refusal_not_a_crash(self):
        parts = self.signer.sign(self.URL, 60, "fetch", "youtube")
        self.refused("fetch", {**parts, "s": "щ" * 32})

    def test_there_is_no_signature_for_an_unknown_route(self):
        with self.assertRaises(ValueError):
            self.signer.sign(self.URL, 60, "seg", "youtube")


class MemoryKeyTests(Stage):
    """Ключи памяти: у каждой площадки свои, и регистр в них значит то же, что у площадки."""

    async def test_video_ids_that_differ_only_in_case_are_different_videos(self):
        # Идентификаторы YouTube различают регистр: `aqz-KE-bpKQ` и `aqz-ke-bpkq` — два ролика.
        # Память, сложившая их в один ключ, показывала бы у второго страницу первого.
        self.library.answers["https://www.youtube.com/watch?v=aqz-KE-bpKQ"] = {"title": "Первый"}
        self.library.answers["https://www.youtube.com/watch?v=aqz-ke-bpkq"] = {"title": "Второй"}
        first = await self.cinema.details("youtube", "aqz-KE-bpKQ", "video")
        second = await self.cinema.details("youtube", "aqz-ke-bpkq", "video")
        self.assertEqual((first["title"], second["title"]), ("Первый", "Второй"))

    async def test_playlists_that_differ_only_in_case_are_different_playlists(self):
        for playlist in ("PLabcdefghij", "PLABCDEFGHIJ"):
            self.library.answers[f"https://www.youtube.com/playlist?list={playlist}"] = {"title": playlist}
        first = await self.cinema.playlist("youtube", "PLabcdefghij", "")
        second = await self.cinema.playlist("youtube", "PLABCDEFGHIJ", "")
        self.assertEqual(
            (first["playlist"]["title"], second["playlist"]["title"]), ("PLabcdefghij", "PLABCDEFGHIJ")
        )

    async def test_channels_that_differ_only_in_case_are_different_channels(self):
        for channel in ("UCabcdefghij", "UCABCDEFGHIJ"):
            self.library.answers[f"https://www.youtube.com/channel/{channel}/videos"] = {"channel": channel}
        first = await self.cinema.channel("youtube", "UCabcdefghij", "videos", "")
        second = await self.cinema.channel("youtube", "UCABCDEFGHIJ", "videos", "")
        self.assertEqual(
            (first["channel"]["title"], second["channel"]["title"]), ("UCabcdefghij", "UCABCDEFGHIJ")
        )

    async def test_a_query_shaped_like_the_shelf_key_is_still_a_search_for_videos(self):
        # Лента роликов и полка каналов лежали под `search:youtube:<запрос>` и
        # `search:youtube:channels:<запрос>`: набранное «channels:big buck» попадало в полку
        # каналов по «big buck» и показывало каналы вместо роликов.
        shelf = "https://www.youtube.com/results?search_query=big+buck&sp=EgIQAg%3D%3D"
        self.library.answers["ytsearch60:big buck"] = {"entries": []}
        self.library.answers[shelf] = {"entries": [{"channel_id": "UCshelf", "channel": "Полка"}]}
        self.library.answers["ytsearch60:channels:big buck"] = {"entries": [{"id": "vid00000001"}]}
        await self.cinema.search("youtube", "big buck", "")
        found = await self.cinema.search("youtube", "channels:big buck", "")
        self.assertEqual([(item["kind"], item["id"]) for item in found["items"]], [("video", "vid00000001")])

    async def test_every_key_starts_with_the_platform_it_belongs_to(self):
        # Правило одно для фасада и для площадок: чужая площадка не может ни прочитать, ни
        # затереть твой ответ, даже если у неё найдётся ролик с таким же номером.
        self.library.answers["https://www.youtube.com/watch?v=aqz-KE-bpKQ"] = {"title": "t"}
        self.library.answers["https://www.youtube.com/playlist?list=PLabcdefghij"] = {"title": "p"}
        self.library.answers["https://www.youtube.com/channel/UCabcdefghij/videos"] = {"channel": "c"}
        self.library.answers["ytsearch60:x y"] = {"entries": []}
        self.library.answers["https://www.youtube.com/results?search_query=x+y&sp=EgIQAg%3D%3D"] = {}
        await self.cinema.details("youtube", "aqz-KE-bpKQ", "video")
        await self.cinema.playlist("youtube", "PLabcdefghij", "")
        await self.cinema.channel("youtube", "UCabcdefghij", "videos", "")
        await self.cinema.search("youtube", "x y", "")
        self.assertTrue(self.cinema.catalog._items)
        for key in self.cinema.catalog._items:
            self.assertTrue(key.startswith("youtube:"), key)


class UpstreamFailureTests(Stage):
    """Сбой по дороге к площадке — это «площадка не ответила» (502), а не ошибка сервера (500)."""

    URL = "https://rr1.googlevideo.com/videoplayback?id=1"

    def serve(self, request):
        self.seen.append(request)
        if isinstance(self.failure, Exception):
            raise self.failure
        return self.failure

    async def test_twitch_that_cannot_be_reached_or_answers_garbage_is_a_bad_gateway(self):
        for failure in (
            httpx.ConnectError("нет сети"),
            httpx.ReadTimeout("молчит"),
            httpx.Response(200, content=b"<html>not json</html>"),
            httpx.Response(200, json=["not", "an", "object"]),
        ):
            self.failure = failure
            refusal = "Twitch не ответил на запрос каталога"
            await self.refused(self.cinema.search("twitch", "", ""), 502, refusal)
        self.assertEqual(self.kept(self.cinema.catalog), {})

    async def test_a_search_yt_dlp_could_not_do_is_a_bad_gateway_cut_short(self):
        self.library.answers["ytsearch60:big buck"] = RuntimeError("HTTP Error 429: " + "x" * 300)
        await self.refused(
            self.cinema.search("youtube", "big buck", "30"),
            502,
            ("Поиск не удался: HTTP Error 429: " + "x" * 300)[:200],
        )

    async def test_a_playlist_or_a_piece_that_cannot_be_reached_is_a_bad_gateway(self):
        self.failure = httpx.ConnectError("нет сети")
        await self.refused(
            self.cinema.manifest(self.URL, None, "youtube"), 502, "Площадка не отдала плейлист"
        )
        for range_header in (None, "bytes=0-100"):
            await self.refused(
                self.cinema.fetch(self.URL, range_header, "youtube"), 502, "Площадка не отдала данные"
            )


class Tap(httpx.AsyncByteStream):
    """Тело ответа площадки, которое помнит, сколько из него прочитали и закрыли ли его."""

    def __init__(self, chunks):
        self.chunks = chunks
        self.read = 0
        self.closed = False

    async def __aiter__(self):
        for chunk in self.chunks:
            self.read += len(chunk)
            yield chunk

    async def aclose(self):
        self.closed = True


class WholePieceTests(Stage):
    """
    Кусочек без `Range` идёт в общую память, только если он в неё помещается.

    Раньше целый ответ читался в память всегда, а в общую память клался только если не больше
    12 МБ: готовый файл на гигабайт (ролик без HLS) держался в памяти службы целиком, пока не
    уйдёт к зрителю, — и так у каждого зрителя. Теперь неизвестный или больший размер идёт
    потоком, как ответ на запрос с `Range`.
    """

    URL = "https://rr1.googlevideo.com/videoplayback?itag=18"

    def serve(self, request):
        self.seen.append(request)
        return self.answer

    async def body(self, response):
        return b"".join([chunk async for chunk in response.body_iterator])

    async def test_a_big_file_goes_through_as_a_stream_not_into_memory(self):
        tap = Tap([b"x" * 1024] * 4)
        declared = str(64 * 1024 * 1024)
        self.answer = httpx.Response(
            200, headers={"content-length": declared, "content-type": "video/mp4"}, stream=tap
        )
        response = await self.cinema.fetch(self.URL, None, "youtube")
        self.assertIsInstance(response, StreamingResponse)
        # Ни байта не прочитано, пока ответ не пошёл к зрителю.
        self.assertEqual(tap.read, 0)
        self.assertEqual(response.headers["content-length"], declared)
        self.assertEqual(response.headers["content-type"], "video/mp4")
        self.assertEqual(response.headers["cache-control"], "private, max-age=600")
        self.assertEqual(await self.body(response), b"x" * 4096)
        self.assertTrue(tap.closed)
        self.assertIsNone(self.cinema.segments.get(self.URL))

    async def test_a_piece_of_unknown_size_goes_through_as_a_stream(self):
        tap = Tap([b"y" * 10])
        self.answer = httpx.Response(200, headers={"content-type": "video/mp2t"}, stream=tap)
        response = await self.cinema.fetch(self.URL, None, "youtube")
        self.assertIsInstance(response, StreamingResponse)
        self.assertEqual(tap.read, 0)
        self.assertEqual(await self.body(response), b"y" * 10)
        self.assertIsNone(self.cinema.segments.get(self.URL))

    async def test_a_compressed_piece_is_passed_on_as_it_came(self):
        # Сжатое тело не распаковывается в память: оно уходит как пришло, вместе со своим
        # `Content-Encoding`, и браузер распакует его сам.
        packed = gzip.compress(b"WEBVTT\n\n" * 100)
        self.answer = httpx.Response(
            200,
            headers={
                "content-length": str(len(packed)),
                "content-encoding": "gzip",
                "content-type": "text/vtt",
            },
            stream=Tap([packed]),
        )
        response = await self.cinema.fetch(self.URL, None, "youtube")
        self.assertIsInstance(response, StreamingResponse)
        self.assertEqual(response.headers["content-encoding"], "gzip")
        self.assertEqual(await self.body(response), packed)
        self.assertIsNone(self.cinema.segments.get(self.URL))

    async def test_a_small_piece_is_still_remembered_for_the_room(self):
        self.answer = httpx.Response(200, headers={"content-type": "video/mp2t"}, content=b"z" * 100)
        first = await self.cinema.fetch(self.URL, None, "youtube")
        second = await self.cinema.fetch(self.URL, None, "youtube")
        self.assertEqual((first.body, second.body), (b"z" * 100, b"z" * 100))
        self.assertEqual(len(self.seen), 1)
        self.assertEqual(self.cinema.segments.get(self.URL), (b"z" * 100, "video/mp2t"))

    async def test_a_piece_longer_than_it_said_is_not_kept(self):
        # Площадка обещала сто байт, а шлёт больше предела памяти: читать дальше предела нельзя.
        big = self.cinema.segments.largest + 1
        self.answer = httpx.Response(200, headers={"content-length": "100"}, stream=Tap([b"w" * big]))
        await self.refused(self.cinema.fetch(self.URL, None, "youtube"), 502, "Площадка не отдала данные")
        self.assertIsNone(self.cinema.segments.get(self.URL))


class YtDlpOptionTests(unittest.TestCase):
    """yt-dlp получает свою копию опций: общий словарь места вызова он испортить не может."""

    def test_the_shared_search_options_stay_as_written(self):
        # Настоящий YoutubeDL дописывал `http_headers` и прочее прямо в модульный `YT_FLAT`, и
        # после первого поиска эти ключи уезжали в каждый следующий вызов — одним объектом на
        # все потоки `to_thread`.
        before = copy.deepcopy(YT_FLAT)
        with patch("yt_dlp.YoutubeDL", MutatingYoutubeDL):
            YouTube(kit())._videos("big buck", 1)
        self.assertEqual(YT_FLAT, before)

    def test_nested_options_are_copied_too(self):
        options = {"quiet": True, "extractor_args": {"youtube": {"player_client": ["web"]}}}
        before = copy.deepcopy(options)
        with patch("yt_dlp.YoutubeDL", MutatingYoutubeDL):
            YtDlp().extract("ytsearch1:x", options, "youtube")
        self.assertEqual(options, before)


class DeclarationTests(unittest.TestCase):
    """Площадка без обязательного объявления падает при импорте, а не отказом 500 на запросе."""

    def test_a_platform_without_a_name_id_or_form_does_not_load(self):
        form = re.compile(r"[0-9]{1,12}")
        for missing, body in (
            ("name", {"id": "nameless", "content_id": form}),
            ("id", {"name": "Без id", "content_id": form}),
            ("content_id", {"id": "formless", "name": "Без формы"}),
        ):
            with self.assertRaises(TypeError) as failure:
                type("Broken", (Provider,), body)
            self.assertIn(missing, str(failure.exception))

    def test_an_id_must_be_a_short_lowercase_word(self):
        # Имя площадки становится префиксом ключей памяти, частью подписи и именем переменной
        # `CINEMA_PROXY_<ID>` — в нём не место пробелам, двоеточиям и заглавным.
        for bad in ("You Tube", "YouTube", "you:tube", "", "x" * 33, 7):
            with self.assertRaises(TypeError):
                type("Broken", (Provider,), {"id": bad, "name": "X", "content_id": re.compile(r"x")})

    def test_a_form_must_be_a_compiled_pattern(self):
        with self.assertRaises(TypeError):
            type("Broken", (Provider,), {"id": "stringy", "name": "X", "content_id": r"[0-9]+"})

    def test_a_shared_base_may_leave_the_declaration_to_its_heirs(self):
        class Base(Provider, abstract=True):
            pass

        class Heir(Base):
            id = "heir"
            name = "Наследник"
            content_id = re.compile(r"[0-9]+")

        self.assertEqual(Heir(kit()).refuse("search").detail, "У площадки Наследник такого нет")
        with self.assertRaises(TypeError):
            type("Orphan", (Base,), {"id": "orphan"})


class AvailabilityTests(unittest.IsolatedAsyncioTestCase):
    """
    Одна площадка, чья проверка упала или замолчала, не роняет весь список.

    Раньше `providers` собирал ответы `asyncio.gather` без защиты: исключение одной площадки
    превращало ответ в 500 для всех, а зависшая проверка держала список, пока не ответит.
    """

    async def test_a_broken_or_silent_check_marks_only_its_platform_unavailable(self):
        def platform(key, check=None):
            body = {"id": key, "name": key.title(), "content_id": re.compile(r"x")}
            if check:
                body["availability"] = check
            return type(key.title(), (Provider,), body)(kit())

        async def broken(self, net):
            raise RuntimeError("ключ в логе не нужен")

        async def silent(self, net):
            await asyncio.sleep(3600)

        cinema = Cinema("secret")
        self.addAsyncCleanup(cinema.close)
        cinema.registry = Registry(
            [
                platform("broken", broken),
                platform("silent", silent),
                platform("quiet", silent),
                platform("fine"),
            ]
        )
        started = time.monotonic()
        with patch.object(Cinema, "AVAILABILITY_TIMEOUT", 0.05, create=True):
            with self.assertLogs("cord_services.cinema.facade", "WARNING") as log:
                answer = await asyncio.wait_for(cinema.providers(), 1)
        self.assertLess(time.monotonic() - started, 0.5)
        self.assertEqual(
            [(entry["id"], entry["available"], entry["reason"]) for entry in answer["providers"]],
            [
                ("broken", False, "Не удалось проверить площадку"),
                ("silent", False, "Площадка не ответила вовремя"),
                ("quiet", False, "Площадка не ответила вовремя"),
                ("fine", True, None),
            ],
        )
        # В журнал — чья проверка и чем упала, но не текст исключения: в нём бывают адреса с ключами.
        self.assertEqual(len(log.records), 1)
        self.assertIn("broken", log.output[0])
        self.assertNotIn("ключ в логе", log.output[0])


class ResolveLimitTests(Stage):
    """
    Комната не может заставить сервер разбирать ссылки без конца: 30 разборов в минуту.

    Считается только работа наружу — новый разбор или `refresh`. Зритель, который получил
    ответ из общей памяти или присоединился к уже идущему разбору, площадке ничего не стоит и
    лимит не тратит: иначе комната из десяти человек упиралась бы в него за три ролика.
    """

    def setUp(self):
        super().setUp()
        self.now = 1000.0
        self.cinema.resolves.clock = lambda: self.now
        for number in range(40):
            self.library.answers[f"https://www.youtube.com/watch?v=video{number:06d}"] = {
                "formats": [{"protocol": "m3u8", "manifest_url": "https://manifest.googlevideo.com/m.m3u8"}]
            }

    def ask(self, number, room="room-a", refresh=False):
        request = Resolve(provider="youtube", contentId=f"video{number:06d}", refresh=refresh)
        return self.cinema.resolve(request, room=room)

    async def test_the_thirty_first_new_video_in_a_minute_is_refused(self):
        for number in range(30):
            await self.ask(number)
        with self.assertRaises(HTTPException) as refusal:
            await self.ask(30)
        self.assertEqual(
            (refusal.exception.status_code, refusal.exception.detail),
            (429, "Комната слишком часто открывает видео, подождите минуту"),
        )
        self.assertEqual(refusal.exception.headers, {"Retry-After": "60"})
        self.assertEqual(len(self.library.calls), 30)
        # Другая комната живёт своим счётом.
        await self.ask(30, room="room-b")

    async def test_the_window_slides_rather_than_resets(self):
        for number in range(30):
            self.now = 1000.0 + number
            await self.ask(number)
        self.now = 1059.5
        with self.assertRaises(HTTPException) as refusal:
            await self.ask(30)
        self.assertEqual(refusal.exception.headers, {"Retry-After": "1"})
        # Через минуту после первого разбора освобождается ровно одно место.
        self.now = 1060.0
        await self.ask(30)
        with self.assertRaises(HTTPException):
            await self.ask(31)

    async def test_answers_from_shared_memory_cost_nothing(self):
        for _ in range(45):
            await self.ask(0)
        self.assertEqual(len(self.library.calls), 1)
        for number in range(1, 30):
            await self.ask(number)

    async def test_viewers_joining_a_running_resolve_cost_nothing(self):
        await asyncio.gather(*(self.ask(0) for _ in range(10)))
        self.assertEqual(len(self.library.calls), 1)
        for number in range(1, 30):
            await self.ask(number)

    async def test_spellings_of_one_room_share_one_window(self):
        # Ядро принимает номер комнаты в любом регистре, а окно считалось по строке из адреса:
        # каждое новое написание одной и той же комнаты получало свои тридцать разборов.
        room = "8f3cab1e-dead-beef-cafe-0123456789ab"
        core = SimpleNamespace(member=AsyncMock(return_value=({"id": room}, {"id": "member"})))
        app = FastAPI()
        app.include_router(routes(self.cinema, core))
        transport = httpx.ASGITransport(app=app)
        letters = [index for index, char in enumerate(room) if char.isalpha()]

        def spelling(number):
            flip = {letters[bit] for bit in range(len(letters)) if number >> bit & 1}
            return "".join(char.upper() if index in flip else char for index, char in enumerate(room))

        async with httpx.AsyncClient(transport=transport, base_url="http://cord.test") as client:
            answers = []
            for number in range(31):
                answer = await client.post(
                    f"/api/v1/services/rooms/{spelling(number)}/cinema/resolve",
                    json={"provider": "youtube", "contentId": f"video{number:06d}"},
                    headers={"Authorization": "Bearer member.secret"},
                )
                answers.append(answer.status_code)
        self.assertEqual(len({spelling(number) for number in range(31)}), 31)
        self.assertEqual(answers, [200] * 30 + [429])

    async def test_a_refused_refresh_leaves_the_answer_for_the_room(self):
        # Отказ 429 не должен стоить комнате готового ответа: раньше `refresh` сначала забывал
        # его, а уже потом упирался в предел — и следующий зритель тоже получал отказ.
        for number in range(30):
            await self.ask(number)
        with self.assertRaises(HTTPException) as refusal:
            await self.ask(0, refresh=True)
        self.assertEqual(refusal.exception.status_code, 429)
        self.assertTrue(
            "youtube:video:video000000:False" in self.cinema.sources._items, "готовый ответ забыт"
        )
        await self.ask(0)
        self.assertEqual(len(self.library.calls), 30)

    async def test_a_refresh_is_real_work_and_counts(self):
        for _ in range(30):
            await self.ask(0, refresh=True)
        with self.assertRaises(HTTPException) as refusal:
            await self.ask(0, refresh=True)
        self.assertEqual(refusal.exception.status_code, 429)


class WindowTests(unittest.TestCase):
    def test_rooms_that_went_quiet_leave_the_memory(self):
        # Комнат за день — тысячи; счёт каждой не должен жить вечно после того, как она затихла.
        now = 0.0
        window = Window(30, 60.0, "подождите", clock=lambda: now)
        for room in range(1100):
            window.take(f"room-{room}")
        now = 61.0
        window.take("fresh")
        self.assertEqual(list(window._events), ["fresh"])


if __name__ == "__main__":
    unittest.main()
