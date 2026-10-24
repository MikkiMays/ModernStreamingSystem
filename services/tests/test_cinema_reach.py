"""
Площадка, до которой этот сервер не достаёт (R112): быстрый понятный отказ вместо вечного
«Спрашиваем площадку…».

Московский сервер не достаёт до YouTube: поиск висел больше 90 с, а один разбор yt-dlp через «чёрную
дыру» держит поток пула 160 с. Здесь — автомат защиты площадки (`cinema/reach.py`): срок у каждого
вопроса, счёт сетевых сбоев подряд, дешёвая проба тем же выходом, что и запросы, и отказ сразу, не
трогая yt-dlp, пока площадка признана недоступной. Часы автомата подменены; сеть — транспорт httpx или
настоящий сокет на 127.0.0.1 (прокси-заглушка и «чёрная дыра»): тесты идут и с `--network none`.
"""

import asyncio
import errno
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import HTTPException
from fastapi.testclient import TestClient
from yt_dlp.networking.exceptions import TransportError
from yt_dlp.utils import DownloadError, ExtractorError

from test_cinema_providers import Stage

from cord_services.app import create_app
from cord_services.cinema import Cinema, Resolve
from cord_services.cinema import facade, reach, resolve
from cord_services.cinema.net import NetConfig
from cord_services.cinema.reach import Reach, network
from cord_services.cinema.registry import HostPolicy
from cord_services.cinema.resolve import YtDlp
from cord_services.core import Core
from cord_services.metrics import render
from cord_services.webapp import Refusal

ROOM = "11111111-1111-4111-8111-111111111111"
UNREACHABLE = "Spot недоступен с этого сервера"


class Clock:
    """Часы автомата: стоят, пока тест их не подвинет."""

    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def spot(probe="https://probe.spot.test/ping"):
    """Площадка как её видит автомат: имя, хосты и адрес пробы."""
    return SimpleNamespace(id="spot", name="Spot", hosts=HostPolicy(("spot.test",)), probe=probe)


def broken_network():
    """Отказ площадки так, как его отдают провайдеры: свои слова, а под ними — сбой соединения."""
    try:
        raise httpx.ConnectError("соединение не установлено")
    except httpx.ConnectError:
        raise HTTPException(502, "Spot не ответил на запрос каталога") from None


def ytdlp_timeout(text="Read timed out. (read timeout=20.0)"):
    """Отказ yt-dlp, когда до площадки не дойти: `DownloadError` → `ExtractorError` → `TransportError`."""
    cause = TransportError(text)
    inner = ExtractorError("Unable to download API page: " + text, cause=cause)
    return DownloadError("ERROR: " + str(inner), exc_info=(type(inner), inner, None))


class Harness(unittest.IsolatedAsyncioTestCase):
    """Автомат с подменёнными часами; проба отвечает так, как скажет `self.answer`."""

    def setUp(self):
        self.clock = Clock()
        self.answer = "ok"
        self.probes = []

        async def serve(request):
            self.probes.append(str(request.url))
            if self.answer == "down":
                raise httpx.ConnectError("сети нет", request=request)
            if self.answer == "silent":
                await asyncio.sleep(3600)
            return httpx.Response(self.answer if isinstance(self.answer, int) else 204)

        self.client = httpx.AsyncClient(transport=httpx.MockTransport(serve))
        self.asked = []
        self.reach = Reach(self.ask_client, clock=self.clock)
        self.source = spot()

    async def asyncTearDown(self):
        await self.client.aclose()

    def ask_client(self, provider):
        self.asked.append(provider)
        return self.client

    async def call(self, work=None, deadline=5.0):
        calls = []

        async def done():
            calls.append(1)
            if work is not None:
                return await work()
            return {"items": []}

        try:
            return await self.reach.call(self.source, done, deadline), calls
        except BaseException as error:
            error.calls = calls
            raise

    async def fail(self):
        async def work():
            broken_network()

        with self.assertRaises(HTTPException) as refusal:
            await self.call(work)
        self.assertEqual(refusal.exception.status_code, 502)

    async def refused(self):
        with self.assertRaises(Refusal) as refusal:
            await self.call()
        self.assertEqual(refusal.exception.calls, [], "отказ — без работы площадки")
        self.assertEqual(
            (refusal.exception.status_code, refusal.exception.code, refusal.exception.detail),
            (503, "CINEMA_UNREACHABLE", UNREACHABLE),
        )
        self.assertEqual(refusal.exception.extra, {"provider": "spot"})
        return refusal.exception

    async def opened(self):
        with self.assertLogs("cord_services.cinema.reach", "WARNING"):
            for _ in range(reach.FAILURES):
                await self.fail()
        self.assertEqual(self.reach.gauge(self.source).state, reach.OPEN)

    async def closed_by_probe(self):
        """Две пробы подряд без ответа — вторая через `PROBE_AGAIN`: площадка признана недоступной."""
        self.answer = "down"
        with self.assertNoLogs("cord_services.cinema.reach", "WARNING"):
            await self.reach.check([self.source])
        self.assertIsNone(self.reach.down(self.source), "одна проба не решает")
        self.clock.now += reach.PROBE_AGAIN
        with self.assertLogs("cord_services.cinema.reach", "WARNING") as log:
            await self.reach.check([self.source])
        self.assertIn("пробы подряд не дошли", log.output[0])
        self.assertEqual(self.reach.down(self.source), UNREACHABLE)

    async def until(self, condition):
        for _ in range(1000):
            if condition():
                return
            await asyncio.sleep(0.01)
        self.fail("не дождались")


class BreakerTests(Harness):
    async def test_three_network_failures_in_a_row_open_and_the_next_ask_is_refused_at_once(self):
        with self.assertLogs("cord_services.cinema.reach", "WARNING") as log:
            for _ in range(reach.FAILURES):
                await self.fail()
        # Одна строка на смену состояния: какая площадка и почему — без адресов и запросов.
        self.assertEqual(len(log.records), 1)
        self.assertIn("spot", log.output[0])
        self.assertIn("недоступна", log.output[0])
        self.assertNotIn("каталога", log.output[0])
        refusal = await self.refused()
        self.assertEqual(refusal.headers, {"Retry-After": "30"})
        # Пробе ещё не время: открыт он запросами, проверка — через 30 с.
        self.assertEqual(self.probes, [])

    async def test_an_answer_between_failures_starts_the_count_again(self):
        await self.fail()
        await self.fail()
        self.assertEqual((await self.call())[1], [1])
        await self.fail()
        await self.fail()
        self.assertEqual(self.reach.gauge(self.source).state, reach.CLOSED)
        self.assertEqual((await self.call())[1], [1])

    async def test_the_platform_refusing_in_its_own_words_is_not_a_network_failure(self):
        async def missing():
            raise HTTPException(404, "Такого видео на Spot нет")

        for _ in range(reach.FAILURES * 2):
            with self.assertRaises(HTTPException):
                await self.call(missing)
        self.assertEqual(self.reach.gauge(self.source).state, reach.CLOSED)

    async def test_a_deadline_is_a_clear_refusal_not_an_endless_wait_and_counts_as_a_failure(self):
        async def endless():
            await asyncio.sleep(3600)

        started = time.monotonic()
        with self.assertRaises(Refusal) as refusal:
            await self.call(endless, deadline=0.05)
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(
            (refusal.exception.status_code, refusal.exception.code, refusal.exception.detail),
            (504, "CINEMA_TIMEOUT", "Spot не ответил вовремя — попробуйте ещё раз"),
        )
        gauge = self.reach.gauge(self.source)
        self.assertEqual((gauge.deadlines, gauge.failures), (1, 1))
        with self.assertLogs("cord_services.cinema.reach", "WARNING"):
            for _ in range(reach.FAILURES - 1):
                with self.assertRaises(Refusal):
                    await self.call(endless, deadline=0.05)
        await self.refused()

    async def test_after_the_pause_one_trial_goes_through_and_its_answer_closes(self):
        await self.opened()
        self.clock.now += 29
        await self.refused()
        self.clock.now += 1
        gate = asyncio.Event()

        async def trial():
            await gate.wait()
            return {"items": ["ok"]}

        going = asyncio.create_task(self.call(trial))
        await self.until(lambda: self.reach.gauge(self.source).state == reach.HALF_OPEN)
        # Сначала проба — тем же клиентом площадки, — потом сам пробный запрос; остальным пока отказ.
        self.assertEqual(self.asked, ["spot"])
        self.assertEqual(len(self.probes), 1)
        self.assertEqual(self.reach.gauge(self.source).state, reach.HALF_OPEN)
        await self.refused()
        with self.assertLogs("cord_services.cinema.reach", "WARNING") as log:
            gate.set()
            self.assertEqual((await going)[0], {"items": ["ok"]})
        self.assertIn("снова отвечает", log.output[0])
        self.assertEqual(self.reach.gauge(self.source).state, reach.CLOSED)
        self.assertEqual((await self.call())[1], [1])

    async def test_a_failed_trial_opens_again_and_each_next_check_waits_longer(self):
        await self.opened()
        waits = []
        for _ in range(6):
            gauge = self.reach.gauge(self.source)
            waits.append(gauge.retry_at - self.clock.now)
            self.clock.now = gauge.retry_at
            await self.fail()
        self.assertEqual(waits, [30, 60, 120, 240, 300, 300])
        # Ни одной новой строки в журнал: площадка не меняла состояние, она так и лежит.

    async def test_a_trial_that_shows_nothing_leaves_the_next_request_to_be_the_trial(self):
        await self.opened()
        self.clock.now += 30

        async def not_a_network_answer():
            raise HTTPException(400, "Непонятное имя канала")

        with self.assertRaises(HTTPException):
            await self.call(not_a_network_answer)
        self.assertEqual(self.reach.gauge(self.source).state, reach.OPEN)
        with self.assertLogs("cord_services.cinema.reach", "WARNING"):
            self.assertEqual((await self.call())[1], [1])
        self.assertEqual(self.reach.gauge(self.source).state, reach.CLOSED)

    async def test_the_link_platform_has_no_breaker(self):
        self.assertFalse(Reach.tracked(SimpleNamespace(hosts=HostPolicy(public_any=True))))
        self.assertTrue(Reach.tracked(self.source))


class ProbeTests(Harness):
    async def test_probes_that_do_not_reach_open_before_anyone_waits_and_a_reaching_one_closes(self):
        self.answer = "silent"
        with patch.object(reach, "PROBE_TIMEOUT", 0.05):
            await self.reach.check([self.source])
            self.assertFalse(self.reach.due(self.source))
            self.clock.now += reach.PROBE_AGAIN
            self.assertTrue(self.reach.due(self.source), "вторая проба — через несколько секунд")
            with self.assertLogs("cord_services.cinema.reach", "WARNING") as log:
                await self.reach.check([self.source])
        self.assertIn("2 пробы подряд не дошли", log.output[0])
        self.assertEqual(self.reach.down(self.source), UNREACHABLE)
        await self.refused()
        # Площадку чинят — следующая проба (через 30 с) закрывает автомат сама, без запросов людей.
        self.answer = "ok"
        self.clock.now += 29
        self.assertFalse(self.reach.due(self.source))
        self.clock.now += 1
        self.assertTrue(self.reach.due(self.source))
        with self.assertLogs("cord_services.cinema.reach", "WARNING") as log:
            await self.reach.check([self.source])
        self.assertIn("снова отвечает", log.output[0])
        self.assertIsNone(self.reach.down(self.source))
        self.assertEqual((await self.call())[1], [1])

    async def test_any_answer_of_the_probe_means_reach_and_one_miss_between_answers_is_forgotten(self):
        for status in (204, 200, 403, 404, 500):
            self.answer = status
            self.assertIs(await self.reach.probe(self.source), True, status)
        self.answer = "down"
        self.assertIs(await self.reach.probe(self.source), False)
        self.answer = "ok"
        await self.reach.probe(self.source)
        self.answer = "down"
        await self.reach.probe(self.source)
        self.assertEqual(self.reach.gauge(self.source).state, reach.CLOSED, "мимо, ответ, мимо — не подряд")

    async def test_retry_asks_the_probe_again_but_not_more_often_than_twice_a_minute(self):
        await self.closed_by_probe()
        self.assertEqual(len(self.probes), 2)
        self.clock.now += 10
        await self.refused()
        self.assertEqual(len(self.probes), 2, "«Повторить» через десять секунд пробу не спрашивает")
        self.answer = "ok"
        self.clock.now += 20
        with self.assertLogs("cord_services.cinema.reach", "WARNING"):
            self.assertEqual((await self.call())[1], [1])
        self.assertEqual(len(self.probes), 3)

    async def test_the_list_of_platforms_rechecks_a_closed_one_on_retry_but_not_more_often(self):
        await self.closed_by_probe()
        await self.reach.refresh(self.source)
        self.assertEqual(len(self.probes), 2, "сразу после пробы — без новой")
        self.answer = "ok"
        self.clock.now += reach.RETRY_PROBE_GAP
        with self.assertLogs("cord_services.cinema.reach", "WARNING"):
            await self.reach.refresh(self.source)
        self.assertEqual(len(self.probes), 3)
        self.assertIsNone(self.reach.down(self.source))
        # Отвечающую площадку список не спрашивает: для неё есть фоновая проба.
        await self.reach.refresh(self.source)
        self.assertEqual(len(self.probes), 3)

    async def test_the_schedule_five_minutes_while_reachable_and_once_per_pause_while_not(self):
        self.assertTrue(self.reach.due(self.source), "первая проба — сразу")
        await self.reach.check([self.source])
        self.clock.now += reach.PROBE_EVERY - 1
        self.assertFalse(self.reach.due(self.source))
        self.clock.now += 1
        self.assertTrue(self.reach.due(self.source))
        # Площадка без адреса пробы — только счёт запросов.
        self.assertFalse(self.reach.due(spot(probe=None)))
        self.assertIsNone(await self.reach.probe(spot(probe=None)))

    async def test_one_probe_at_a_time_however_many_ask(self):
        gate = asyncio.Event()

        async def slow(request):
            self.probes.append(str(request.url))
            await gate.wait()
            return httpx.Response(204)

        await self.client.aclose()
        self.client = httpx.AsyncClient(transport=httpx.MockTransport(slow))
        waiting = [asyncio.create_task(self.reach.probe(self.source)) for _ in range(5)]
        await asyncio.sleep(0.01)
        gate.set()
        self.assertEqual(await asyncio.gather(*waiting), [True] * 5)
        self.assertEqual(len(self.probes), 1)

    async def test_the_watch_probes_at_start_and_then_keeps_watching(self):
        self.answer = "down"
        with patch.object(reach, "WATCH_TICK", 0.01), patch.object(reach, "PROBE_AGAIN", 0.0):
            with self.assertLogs("cord_services.cinema.reach", "WARNING"):
                watching = asyncio.create_task(self.reach.watch(lambda: [self.source]))
                await self.until(lambda: len(self.probes) >= reach.PROBE_MISSES)
                watching.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await watching
        self.assertEqual(self.reach.gauge(self.source).state, reach.OPEN)


class NetworkTests(unittest.TestCase):
    """Что считается «до площадки не дошли», а что — её собственным отказом."""

    def test_a_connection_failure_under_the_platform_words_is_network(self):
        with self.assertRaises(HTTPException) as caught:
            broken_network()
        self.assertTrue(network(caught.exception))

    def test_a_yt_dlp_timeout_under_the_platform_words_is_network(self):
        try:
            try:
                raise ytdlp_timeout()
            except DownloadError:
                raise HTTPException(502, "Поиск не удался") from None
        except HTTPException as error:
            self.assertTrue(network(error))

    def test_refusals_and_bot_checks_are_answers_not_network(self):
        self.assertFalse(network(HTTPException(404, "Такого видео нет")))
        bot = DownloadError("ERROR: [youtube] x: Sign in to confirm you’re not a bot")
        try:
            try:
                raise bot
            except DownloadError:
                raise HTTPException(502, "Не удалось открыть видео") from None
        except HTTPException as error:
            self.assertFalse(network(error))
        self.assertFalse(network(httpx.UnsupportedProtocol("ftp://")))
        self.assertFalse(network(ValueError("x")))

    def test_socket_errors_that_mean_no_route_are_network(self):
        self.assertTrue(network(OSError(errno.ENETUNREACH, "Network is unreachable")))
        self.assertTrue(network(ConnectionResetError()))
        self.assertTrue(network(TimeoutError()))
        self.assertFalse(network(OSError(errno.ENOENT, "No such file")))


class ProxyTests(unittest.IsolatedAsyncioTestCase):
    """
    Проба идёт тем же выходом, что и запросы площадки: через её прокси (`CINEMA_PROXY_YOUTUBE`), а не мимо.

    Прокси здесь — сокет на 127.0.0.1: заглушка, которая запоминает, куда её просят открыть туннель, и
    «чёрная дыра», которая принимает соединение и молчит (так выглядит дата-центр, где площадка закрыта).
    """

    async def proxy(self, answer: bytes | None):
        seen, writers = [], []

        async def handle(reader, writer):
            writers.append(writer)
            seen.append((await reader.readline()).decode().strip())
            if answer is None:
                return  # «чёрная дыра»: соединение принято, ответа не будет
            writer.write(answer)
            await writer.drain()
            writer.close()

        server = await asyncio.start_server(handle, "127.0.0.1", 0)

        async def stop():
            server.close()
            for writer in writers:
                writer.close()

        self.addAsyncCleanup(stop)
        return f"http://127.0.0.1:{server.sockets[0].getsockname()[1]}", seen

    async def cinema(self, net):
        # Только площадки теста: остальные спрашивали бы настоящую сеть.
        cinema = Cinema("secret", net=net, enabled="youtube,rutube,link")
        self.addAsyncCleanup(cinema.close)
        return cinema

    async def test_the_probe_asks_through_the_platforms_own_proxy(self):
        address, seen = await self.proxy(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
        cinema = await self.cinema(NetConfig(proxies={"youtube": address}))
        youtube = cinema.registry.get("youtube")
        self.assertIs(await cinema.reach.probe(youtube), False)
        self.assertEqual(seen, ["CONNECT www.youtube.com:443 HTTP/1.1"])
        # Тем же прокси ходит и yt-dlp этой площадки (`YtDlp.run`) — проба не врёт о пути запросов.
        self.assertEqual(cinema.ytdlp.network.proxy_for("youtube"), address)
        with self.assertLogs("cord_services.cinema.reach", "WARNING"):
            self.assertIs(await cinema.reach.probe(youtube), False)
        self.assertEqual(cinema.reach.gauge(youtube).state, reach.OPEN)

    async def test_the_common_proxy_carries_the_probe_too(self):
        address, seen = await self.proxy(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
        cinema = await self.cinema(NetConfig(proxy=address))
        self.assertIs(await cinema.reach.probe(cinema.registry.get("rutube")), False)
        self.assertEqual(seen, ["CONNECT rutube.ru:443 HTTP/1.1"])

    async def test_a_black_hole_makes_youtube_unreachable_and_search_is_refused_without_yt_dlp(self):
        address, seen = await self.proxy(None)
        cinema = await self.cinema(NetConfig(proxies={"youtube": address}))
        youtube = cinema.registry.get("youtube")
        started = time.monotonic()
        with patch.object(reach, "PROBE_TIMEOUT", 0.3), patch.object(reach, "PROBE_AGAIN", 0.0):
            with self.assertLogs("cord_services.cinema.reach", "WARNING"):
                await cinema.reach.check([youtube])
                await cinema.reach.check([youtube])
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(seen, ["CONNECT www.youtube.com:443 HTTP/1.1"] * 2)
        # Rutube — та же служба, но без пробы до сих пор: о нём автомат ничего плохого не знает.
        entries = {entry["id"]: entry for entry in (await cinema.providers())["providers"]}
        self.assertEqual((entries["rutube"]["available"], "code" in entries["rutube"]), (True, False))
        self.assertEqual(
            (entries["youtube"]["available"], entries["youtube"]["reason"], entries["youtube"]["code"]),
            (False, "YouTube недоступен с этого сервера", "CINEMA_UNREACHABLE"),
        )
        self.assertNotIn("code", entries["link"])
        with patch("yt_dlp.YoutubeDL", side_effect=AssertionError("yt-dlp при закрытом автомате не зовут")):
            with self.assertRaises(Refusal) as refusal:
                await cinema.search("youtube", "кино", room=ROOM)
        self.assertEqual(refusal.exception.detail, "YouTube недоступен с этого сервера")
        self.assertEqual(cinema.ytdlp.busy.get("youtube", 0), 0)


class FacadeTests(Stage):
    """Кинозал целиком: YouTube недоступен — отказ сразу везде, где к нему ходят, остальные площадки живы."""

    def setUp(self):
        # Проверка встраивания предела (`check_reading`) требует настоящего yt-dlp, а он здесь подменён,
        # как во всех тестах каталога (`CatalogExecutorTests`): считаем её пройденной.
        checked = patch("cord_services.cinema.resolve._reading_checked", True)
        checked.start()
        self.addCleanup(checked.stop)
        super().setUp()
        self.youtube = self.cinema.registry.get("youtube")

    def close_youtube(self):
        gauge = self.cinema.reach.gauge(self.youtube)
        with self.assertLogs("cord_services.cinema.reach", "WARNING"):
            self.cinema.reach._open(gauge, reach.BY_PROBE)
        # Проба только что была: «Повторить» в эти полминуты её снова не спрашивает.
        gauge.probed_at = self.cinema.reach.clock()

    async def test_three_hanging_searches_open_the_breaker_and_the_fourth_does_not_touch_yt_dlp(self):
        for number in range(reach.FAILURES):
            self.library.answers[f"ytsearch60:запрос {number}"] = ytdlp_timeout()
        with self.assertLogs("cord_services.cinema.reach", "WARNING"):
            for number in range(reach.FAILURES):
                with self.assertRaises(HTTPException) as refusal:
                    await self.cinema.search("youtube", f"запрос {number}", room=ROOM)
                self.assertEqual(refusal.exception.status_code, 502)
        asked = len(self.library.calls)
        with self.assertRaises(Refusal) as refusal:
            await self.cinema.search("youtube", "запрос 4", room=ROOM)
        self.assertEqual((refusal.exception.status_code, refusal.exception.code), (503, "CINEMA_UNREACHABLE"))
        self.assertEqual(len(self.library.calls), asked, "yt-dlp при открытом автомате не зовут")

    async def test_every_way_to_youtube_is_refused_at_once_while_it_is_unreachable(self):
        self.close_youtube()
        with patch.object(self.cinema.ytdlp.pool, "submit", side_effect=AssertionError("пул не трогают")):
            for action in (
                self.cinema.search("youtube", "кино", room=ROOM),
                self.cinema.channel("youtube", "@someone", room=ROOM),
                self.cinema.playlist("youtube", "PLabcdefghijkl", room=ROOM),
                self.cinema.details("youtube", "aqz-KE-bpKQ", "video", room=ROOM),
                self.cinema.resolve(Resolve(provider="youtube", contentId="aqz-KE-bpKQ"), room=ROOM),
                self.cinema.link("https://youtu.be/aqz-KE-bpKQ", room=ROOM),
            ):
                with self.assertRaises(Refusal) as refusal:
                    await action
                self.assertEqual(refusal.exception.detail, "YouTube недоступен с этого сервера")
        self.assertEqual(self.library.calls, [])
        self.assertEqual(self.cinema.reach.gauge(self.youtube).refused, 6)

    async def test_other_platforms_keep_working_and_their_links_still_route(self):
        self.close_youtube()
        answer = await self.cinema.link("https://www.twitch.tv/someone", room=ROOM)
        self.assertEqual(answer["route"]["provider"], "twitch")
        self.assertIsNone(self.cinema.reach.down(self.cinema.registry.get("twitch")))

    async def test_a_search_that_hangs_ends_with_words_at_the_deadline(self):
        release = threading.Event()
        self.addCleanup(release.set)

        def hanging(query, limit):
            # Поток yt-dlp, до площадки которого нет сети: держит место, пока его не отпустят. Наружу
            # он не ходит и после теста — подмена yt-dlp к тому времени уже снята.
            release.wait(10)
            return []

        self.youtube._videos = hanging
        self.library.answers[
            "https://www.youtube.com/results?search_query=%D0%BA%D0%B8%D0%BD%D0%BE&sp=EgIQAg%3D%3D"
        ] = {"entries": []}
        started = time.monotonic()
        with patch.object(facade, "CATALOG_DEADLINE", 0.2):
            with self.assertRaises(Refusal) as refusal:
                await self.cinema.search("youtube", "кино", room=ROOM)
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(
            (refusal.exception.status_code, refusal.exception.code, refusal.exception.detail),
            (504, "CINEMA_TIMEOUT", "YouTube не ответил вовремя — попробуйте ещё раз"),
        )
        self.assertEqual(self.cinema.reach.gauge(self.youtube).deadlines, 1)
        release.set()

    async def test_the_list_marks_only_the_unreachable_platform_with_a_code(self):
        self.close_youtube()
        with self.assertLogs("cord_services.cinema.facade", "WARNING"):
            # ivi спрашивает страну через сеть теста, а та её не знает: «Не удалось проверить площадку».
            listed = {entry["id"]: entry for entry in (await self.cinema.providers())["providers"]}
        self.assertEqual(
            {key: listed["youtube"][key] for key in ("available", "reason", "code")},
            {
                "available": False,
                "reason": "YouTube недоступен с этого сервера",
                "code": "CINEMA_UNREACHABLE",
            },
        )
        self.assertEqual((listed["twitch"]["available"], listed["twitch"]["reason"]), (True, None))
        self.assertNotIn("code", listed["twitch"])

    async def test_metrics_name_the_platform_and_its_state_and_nothing_about_people(self):
        before = render(SimpleNamespace(cinema=self.cinema))
        self.assertIn('cord_cinema_reachable{provider="youtube"} 1\n', before)
        self.assertIn('cord_cinema_ytdlp_threads{provider="youtube"} 0\n', before)
        self.assertNotIn('provider="link"', before)
        self.close_youtube()
        with self.assertRaises(Refusal):
            await self.cinema.search("youtube", "кино", room=ROOM)
        after = render(SimpleNamespace(cinema=self.cinema))
        self.assertIn('cord_cinema_reachable{provider="youtube"} 0\n', after)
        self.assertIn('cord_cinema_reach_changes_total{provider="youtube",state="open"} 1\n', after)
        self.assertIn('cord_cinema_unreachable_refusals_total{provider="youtube"} 1\n', after)
        self.assertIn('cord_cinema_reachable{provider="twitch"} 1\n', after)
        self.assertNotIn(ROOM, after)
        self.assertNotIn("кино", after)


class LaneTests(unittest.IsolatedAsyncioTestCase):
    """Зависшие потоки одной площадки не съедают пул: у неё не больше `LANE_THREADS` мест."""

    async def test_a_platform_takes_at_most_its_lane_and_frees_a_place_only_when_the_thread_ends(self):
        ytdlp = YtDlp()
        self.addCleanup(ytdlp.close)
        release = {index: threading.Event() for index in range(4)}
        started = []

        def work(index):
            started.append(index)
            release[index].wait(10)
            return index

        self.addCleanup(lambda: [event.set() for event in release.values()])
        with patch.object(resolve, "LANE_THREADS", 2):
            tasks = [asyncio.create_task(ytdlp.offload_for("youtube", work, index)) for index in range(3)]
            await self._until(lambda: len(started) == 2)
            await asyncio.sleep(0.05)
            self.assertEqual(sorted(started), [0, 1])
            self.assertEqual(ytdlp.busy["youtube"], 2)
            # Соседняя площадка идёт своим местом, пока YouTube висит.
            other = asyncio.create_task(ytdlp.offload_for("rutube", work, 3))
            await self._until(lambda: 3 in started)
            release[3].set()
            self.assertEqual(await other, 3)
            # Ушёл ждавший запрос (срок) — поток живёт, и место не освободилось.
            tasks[0].cancel()
            await asyncio.sleep(0.05)
            self.assertNotIn(2, started)
            # Кончился сам поток — место отдано третьему.
            release[0].set()
            await self._until(lambda: 2 in started)
            release[1].set()
            release[2].set()
            self.assertEqual(await tasks[1], 1)
            self.assertEqual(await tasks[2], 2)
        await self._until(lambda: ytdlp.busy["youtube"] == 0)

    async def _until(self, condition):
        for _ in range(1000):
            if condition():
                return
            await asyncio.sleep(0.01)
        self.fail("не дождались")


class RouteTests(unittest.TestCase):
    """Отказ через настоящий FastAPI: код, слова, площадка и `Retry-After` — то, по чему клиент говорит."""

    def serve(self):
        root = tempfile.TemporaryDirectory()
        self.addCleanup(root.cleanup)
        core = Core("http://core.test", "internal-test")
        core.member = AsyncMock(return_value=({"id": ROOM}, {"id": "member"}))
        # Только площадки без своей проверки по сети: список площадок не должен ходить наружу.
        with patch.dict(os.environ, {"CINEMA_PROVIDERS": "youtube,rutube"}):
            app = create_app(Path(root.name), core, telegram_enabled=False)
        self.addCleanup(app.state.store.db.close)
        return app, TestClient(app, headers={"Authorization": "Bearer member.secret"})

    def test_the_refusal_carries_its_code_the_platform_and_when_to_ask_again(self):
        app, client = self.serve()
        cinema = app.state.cinema
        youtube = cinema.registry.get("youtube")
        with self.assertLogs("cord_services.cinema.reach", "WARNING"):
            cinema.reach._open(cinema.reach.gauge(youtube), reach.BY_TRAFFIC)
        answer = client.get(
            f"/api/v1/services/rooms/{ROOM}/cinema/search", params={"provider": "youtube", "query": "кино"}
        )
        self.assertEqual(answer.status_code, 503)
        self.assertEqual(
            answer.json(),
            {
                "code": "CINEMA_UNREACHABLE",
                "detail": "YouTube недоступен с этого сервера",
                "provider": "youtube",
            },
        )
        self.assertEqual(answer.headers["retry-after"], "30")
        answer = client.post(
            f"/api/v1/services/rooms/{ROOM}/cinema/link", json={"url": "https://youtu.be/aqz-KE-bpKQ"}
        )
        self.assertEqual((answer.status_code, answer.json()["code"]), (503, "CINEMA_UNREACHABLE"))
        listed = client.get(f"/api/v1/services/rooms/{ROOM}/cinema/providers").json()["providers"]
        self.assertEqual(
            [(entry["id"], entry["available"], entry.get("code")) for entry in listed],
            [("youtube", False, "CINEMA_UNREACHABLE"), ("rutube", True, None)],
        )

    def test_without_the_running_service_nothing_is_probed(self):
        # Тесты и сборка приложения без `lifespan` в сеть не ходят: проба — только у запущенной службы.
        app, client = self.serve()
        listed = client.get(f"/api/v1/services/rooms/{ROOM}/cinema/providers").json()["providers"]
        self.assertEqual([entry["available"] for entry in listed], [True, True])
        gauges = app.state.cinema.reach._gauges
        self.assertEqual(sorted(gauges), ["rutube", "youtube"])
        self.assertTrue(all(gauge.probed_at is None for gauge in gauges.values()))


if __name__ == "__main__":
    unittest.main()
