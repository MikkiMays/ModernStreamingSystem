"""
Прокси кинозала отдаёт чужие байты со своего адреса (`transport/relay.py`): вид ответа — только из белого
списка, и каждый ответ подписанных маршрутов запечатан (`SEALED`).

ДЫРА. «По ссылке» подписывает любой адрес, который назвала вставленная страница, и прокси отдавал тело с тем
видом, какой выбрал чужой сервер: `text/html` открывался вкладкой на адресе Cord, `text/javascript`
исполнялся тегом `<script src>` той же страницы — CSP шлюза (`script-src 'self'`) и `nosniff` пропускали
его как свой. Здесь каждый путь прокси — из памяти, в память, потоком, по диапазону — и каждая площадка.
Сеть — подменённый транспорт httpx, маршруты — настоящий FastAPI.
"""

import asyncio
import unittest
from urllib.parse import urlencode

import httpx
from fastapi import FastAPI
from starlette.requests import ClientDisconnect

from cord_services.cinema import PREFIX, Cinema, routes
from cord_services.cinema.transport.relay import OCTET, SEALED, media_type
from cord_services.cinema.transport.signer import proxied

EVIL = "https://evil.example"
YOUTUBE = "https://rr5---sn-abc.googlevideo.com/videoplayback"
BODY = b"<script>fetch('/api').then(r => r.text()).then(t => parent.postMessage(t, '*'))</script>"
# Что чужой сервер называет видом ответа, а браузер исполнил бы или показал страницей.
FOREIGN = ("text/html; charset=utf-8", "image/svg+xml", "text/javascript", "application/xml")
# Виды, ради которых прокси и существует: они уходят как были.
KEPT = ("video/mp2t", "video/mp4", "image/jpeg", "text/vtt")


class Body(httpx.AsyncByteStream):
    """Тело ответа сайта — непрочитанным потоком, как его отдаёт сеть."""

    def __init__(self, body: bytes):
        self.body = body

    async def __aiter__(self):
        yield self.body


class Upstream:
    """Чужой сервер: на любой адрес — тело с видом `kind` (или без вида); длина объявлена, если `measured`."""

    def __init__(self):
        self.kind: str | None = None
        self.measured = True
        self.body = BODY
        self.asked: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.asked.append(request)
        headers = {"content-type": self.kind} if self.kind is not None else {}
        status = 200
        if "range" in request.headers:
            status = 206
            headers["content-range"] = f"bytes 0-{len(self.body) - 1}/{len(self.body)}"
        # Без объявленной длины тело в общую память не ложится — прокси отдаёт его потоком.
        if self.measured or status == 206:
            headers["content-length"] = str(len(self.body))
        return httpx.Response(status, headers=headers, stream=Body(self.body))


class Member:
    """Ядро теста: всякий, кто спросил, — участник комнаты."""

    async def member(self, room_id, authorization, **_):
        return {"id": room_id}, {"id": "member"}


class Proxy(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.upstream = Upstream()
        self.cinema = Cinema("secret", httpx.AsyncClient(transport=httpx.MockTransport(self.upstream)))
        app = FastAPI()
        app.include_router(routes(self.cinema, Member()))
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://cord.test")
        self.numbered = 0

    async def asyncTearDown(self):
        await self.client.aclose()
        await self.cinema.close()

    def address(self, route: str, url: str, provider: str = "link") -> str:
        """Адрес прокси, который служба выдала бы сама: подписанный, по номеру в списке или обложкой."""
        if route == "seg":
            self.numbered += 1
            key = self.cinema.reels.remember(f"{EVIL}/list-{self.numbered}.m3u8", [url], provider)
            return f"{PREFIX}/seg/{key}/0"
        if route == "image":
            found = self.cinema.image(url, provider)
            assert found is not None
            return found
        return proxied(self.cinema.signer, url, route, provider=provider)

    async def get(self, path: str, **headers: str) -> httpx.Response:
        return await self.client.get(path, headers=headers)

    def assertSealed(self, answer: httpx.Response, kind: str | None = None, note: object = None):
        for name, value in SEALED.items():
            self.assertEqual(answer.headers.get(name), value, (name, note))
        if kind is not None:
            self.assertEqual(answer.headers["content-type"].partition(";")[0], kind, note)


class WhatTheSiteCallsItsBody(Proxy):
    async def test_html_svg_script_and_xml_of_a_pasted_site_leave_as_bytes_on_every_path(self):
        number = 0
        for route in ("fetch", "seg", "image"):
            for kind in FOREIGN:
                self.upstream.kind = kind
                # Первый раз — из сети в общую память, второй — из неё.
                number += 1
                path = self.address(route, f"{EVIL}/{route}/{number}.bin")
                for turn in ("в память", "из памяти"):
                    answer = await self.get(path)
                    self.assertEqual(answer.status_code, 200, (route, kind, turn))
                    self.assertSealed(answer, OCTET, (route, kind, turn))
                    self.assertEqual(answer.content, BODY)
                # Длина не объявлена — тело идёт потоком, мимо памяти.
                self.upstream.measured = False
                number += 1
                answer = await self.get(self.address(route, f"{EVIL}/{route}/{number}.bin"))
                self.upstream.measured = True
                self.assertSealed(answer, OCTET, (route, kind, "потоком"))
                self.assertEqual(answer.content, BODY)
                if route == "image":
                    continue  # у обложки диапазонов нет: маршрут их не передаёт
                number += 1
                answer = await self.get(self.address(route, f"{EVIL}/{route}/{number}.bin"), range="bytes=0-")
                self.assertEqual(answer.status_code, 206, (route, kind))
                self.assertSealed(answer, OCTET, (route, kind, "диапазон"))

    async def test_the_shared_memory_keeps_the_kind_for_the_viewer_not_the_one_the_site_named(self):
        self.upstream.kind = "text/html"
        url = f"{EVIL}/page.html"
        await self.get(self.address("fetch", url))
        self.assertEqual(self.cinema.segments.get(url), (BODY, OCTET))

    async def test_the_facade_answer_is_sealed_before_it_reaches_a_route(self):
        # Так спрашивал прокси зонд финального ревью: `Cinema.fetch` напрямую, мимо маршрутов.
        self.upstream.kind = "image/svg+xml"
        for measured, range_header in ((True, None), (False, None), (True, "bytes=0-")):
            self.upstream.measured = measured
            answer = await self.cinema.fetch(f"{EVIL}/{measured}{range_header}.svg", range_header, "link")
            self.assertEqual(answer.headers["content-type"], OCTET, (measured, range_header))
            for name, value in SEALED.items():
                self.assertEqual(answer.headers[name], value, (measured, range_header))

    async def test_media_pass_as_they_are_and_still_sealed(self):
        number = 0
        for route in ("fetch", "seg"):
            for kind in KEPT:
                self.upstream.kind = kind
                for turn, measured, headers in (
                    ("в память", True, {}),
                    ("потоком", False, {}),
                    ("диапазон", True, {"range": "bytes=0-"}),
                ):
                    number += 1
                    self.upstream.measured = measured
                    answer = await self.get(self.address(route, f"{EVIL}/m/{number}"), **headers)
                    self.assertSealed(answer, kind, (route, kind, turn))
        self.upstream.kind, self.upstream.measured = "image/jpeg", True
        self.assertSealed(await self.get(self.address("image", f"{EVIL}/poster.jpg")), "image/jpeg")

    async def test_a_catalogue_platform_is_sealed_and_filtered_the_same_way(self):
        # Не только «По ссылке»: белый список — у прокси, а не у площадки.
        for number, (kind, expected) in enumerate(
            (("video/mp2t", "video/mp2t"), ("text/html", OCTET), ("text/vtt; charset=UTF-8", "text/vtt"))
        ):
            self.upstream.kind = kind
            path = self.address("fetch", f"{YOUTUBE}?id={number}", provider="youtube")
            answer = await self.get(path)
            self.assertEqual(answer.status_code, 200, kind)
            self.assertSealed(answer, expected, kind)
            path = self.address("seg", f"{YOUTUBE}?seg={number}", provider="youtube")
            self.assertSealed(await self.get(path), expected, kind)

    async def test_a_body_without_a_kind_gets_the_old_default_only_where_it_is_on_the_list(self):
        self.upstream.kind = None
        # Кусочек из памяти и потоком — как было: `video/mp2t`, он в списке.
        self.assertSealed(await self.get(self.address("fetch", f"{EVIL}/a")), "video/mp2t")
        self.upstream.measured = False
        self.assertSealed(await self.get(self.address("fetch", f"{EVIL}/b")), "video/mp2t")
        # У ответа на диапазон вида по умолчанию не было вовсе — теперь он «просто байты», а не догадка.
        self.upstream.measured = True
        answer = await self.get(self.address("fetch", f"{EVIL}/c"), range="bytes=0-")
        self.assertSealed(answer, OCTET)


class EveryAnswerOfTheProxy(Proxy):
    async def test_playlists_subtitles_and_manifests_are_sealed_too(self):
        self.upstream.kind = "application/vnd.apple.mpegurl"
        self.upstream.body = b"#EXTM3U\n#EXTINF:6.0,\nseg0.ts\n#EXT-X-ENDLIST\n"
        for provider, url in (("link", f"{EVIL}/v.m3u8"), ("youtube", f"{YOUTUBE}/index.m3u8")):
            answer = await self.get(proxied(self.cinema.signer, url, "playlist", provider=provider))
            self.assertEqual(answer.status_code, 200, provider)
            self.assertSealed(answer, "application/vnd.apple.mpegurl", provider)
        self.upstream.kind, self.upstream.body = "text/html", b"1\n00:00:01,000 --> 00:00:02,000\n<b>hi</b>\n"
        answer = await self.get(proxied(self.cinema.signer, f"{EVIL}/s.srt", "subtitles", provider="link"))
        self.assertSealed(answer, "text/vtt")
        self.cinema.resolver.dash_manifests["k"] = (2**40, "<MPD/>")
        self.assertSealed(await self.get(f"{PREFIX}/dash/k"), "application/dash+xml")

    async def test_refusals_of_the_proxy_routes_are_sealed_and_the_room_routes_are_not(self):
        signed = self.cinema.signer.sign(f"{EVIL}/x.mp4", 3600, "fetch", "link")
        for path, status in (
            (f"{PREFIX}/fetch?" + urlencode({**signed, "s": "0" * 32}), 403),
            (f"{PREFIX}/image?" + urlencode(signed), 403),
            (f"{PREFIX}/seg/nothing/0", 410),
            (f"{PREFIX}/dash/nothing", 410),
            (f"{PREFIX}/playlist", 422),
            (f"{PREFIX}/subtitles?u=x&e=1&s=x&h=%0A", 422),
        ):
            answer = await self.get(path)
            self.assertEqual(answer.status_code, status, path)
            self.assertSealed(answer, "application/json", path)
        answer = await self.get(self.address("fetch", f"{EVIL}/x.mp4"), range="bytes=9-1")
        self.assertEqual(answer.status_code, 416)
        self.assertSealed(answer)
        # Маршруты комнаты — обычный JSON для приложения: скачивать и запирать там нечего.
        path = "/api/v1/services/rooms/room/cinema/categories?provider=youtube"
        answer = await self.get(path, authorization="Bearer member.secret")
        self.assertEqual(answer.status_code, 200)
        self.assertNotIn("content-disposition", answer.headers)
        self.assertNotIn("content-security-policy", answer.headers)


class Tap(httpx.AsyncByteStream):
    """Тело ответа площадки: помнит, сколько из него прочитали и закрыли ли его (вернули ли соединение)."""

    def __init__(self, chunks: list[bytes]):
        self.chunks = chunks
        self.read = 0
        self.closed = False

    async def __aiter__(self):
        for chunk in self.chunks:
            self.read += len(chunk)
            yield chunk

    async def aclose(self):
        self.closed = True


class ViewerLeaves(unittest.IsolatedAsyncioTestCase):
    """
    Зритель ушёл, а соединение с площадкой — нет (M10). Тело потока закрывал `finally` генератора, а
    генератор, которого не начали (плеер бросил запрос раньше первого байта), `finally` не исполняет: сотня
    таких — и пул площадки занят навсегда. Здесь ответ прокси зовут так, как его зовёт сервер ASGI.
    """

    async def asyncSetUp(self):
        self.taps: list[Tap] = []

        def film(request: httpx.Request) -> httpx.Response:
            self.taps.append(Tap([b"x" * 1024] * 4))
            headers = {
                "content-type": "video/mp4",
                "content-range": "bytes 0-4095/4096",
                "content-length": "4096",
            }
            return httpx.Response(206, headers=headers, stream=self.taps[-1])

        self.cinema = Cinema("secret", httpx.AsyncClient(transport=httpx.MockTransport(film)))

    async def asyncTearDown(self):
        await self.cinema.close()

    async def streamed(self):
        answer = await self.cinema.fetch(f"{EVIL}/film.mp4", "bytes=0-", "link")
        self.assertEqual(answer.status_code, 206)
        return answer

    async def test_a_viewer_gone_before_the_first_byte_still_frees_the_connection(self):
        # ASGI 2.3, как у uvicorn: отключение пришло сразу, а голова ответа ещё не ушла — отдачу отменили.
        answer = await self.streamed()

        async def receive():
            return {"type": "http.disconnect"}

        async def send(message):
            await asyncio.Event().wait()

        await asyncio.wait_for(answer({"type": "http", "asgi": {"spec_version": "2.3"}}, receive, send), 5)
        self.assertEqual(self.taps[0].read, 0)
        self.assertTrue(self.taps[0].closed)

    async def test_a_viewer_whose_socket_is_gone_frees_it_too(self):
        # ASGI 2.4: сервер сообщает об ушедшем зрителе ошибкой на первой же отправке.
        answer = await self.streamed()

        async def receive():
            await asyncio.Event().wait()

        async def send(message):
            raise OSError("зритель ушёл")

        with self.assertRaises(ClientDisconnect):
            await answer({"type": "http", "asgi": {"spec_version": "2.4"}}, receive, send)
        self.assertEqual(self.taps[0].read, 0)
        self.assertTrue(self.taps[0].closed)

    async def test_a_body_sent_to_its_end_frees_it_as_before(self):
        answer = await self.streamed()
        sent = []

        async def receive():
            await asyncio.Event().wait()

        async def send(message):
            sent.append(message)

        await answer({"type": "http", "asgi": {"spec_version": "2.4"}}, receive, send)
        self.assertEqual(b"".join(message.get("body", b"") for message in sent[1:]), b"x" * 4096)
        self.assertTrue(self.taps[0].closed)


class Kinds(unittest.TestCase):
    def test_the_kind_is_one_token_from_the_list_or_plain_bytes(self):
        for value, expected in (
            ("video/mp2t", "video/mp2t"),
            ("VIDEO/MP2T", "video/mp2t"),
            (" audio/mpeg; codecs=mp3 ", "audio/mpeg"),
            ("text/vtt;charset=utf-8", "text/vtt"),
            ("application/mp4", "application/mp4"),
            ("image/webp", "image/webp"),
            # Два заголовка, склеенные запятой: браузер взял бы последний.
            ("video/mp4, text/html", OCTET),
            # Параметры не уходят вовсе — уходит только сам вид.
            ('video/mp4; x=",text/html"', "video/mp4"),
            ("video/x+xml", OCTET),
            ("audio/x-html", OCTET),
            ("video/javascript", OCTET),
            ("image/svg+xml", OCTET),
            ("text/plain", OCTET),
            ("application/javascript", OCTET),
            ("application/json", OCTET),
            ("text/html", OCTET),
            ("image/x-icon", OCTET),
            ("video", OCTET),
            ("video/", OCTET),
            ("", OCTET),
            (None, OCTET),
        ):
            self.assertEqual(media_type(value), expected, value)

    def test_no_kind_is_the_default_only_if_the_default_is_on_the_list(self):
        self.assertEqual(media_type(None, "video/mp2t"), "video/mp2t")
        self.assertEqual(media_type("  ", "video/mp2t"), "video/mp2t")
        self.assertEqual(media_type(None, "text/html"), OCTET)
        self.assertEqual(media_type("text/html", "video/mp2t"), OCTET)


if __name__ == "__main__":
    unittest.main()
