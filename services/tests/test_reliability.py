"""
Надёжность служб (W1b, R04/R68): сторож издателя в числах, полосы к площадкам, повтор за сегментом,
автомат у площадок музыки без двойника в кинозале (SoundCloud, Яндекс).

Сети нет: издатель, площадки и yt-dlp подменены, тесты идут и с `--network none`.
"""

import asyncio
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import HTTPException

from test_cinema_reach import Clock, spot
from test_services import BOT, HOST, ROOM, Fixture, track

from cord_services import sources as music_sources
from cord_services.cinema import Cinema, facade, reach
from cord_services.cinema.reach import Reach
from cord_services.metrics import render
from cord_services.music import Music
from cord_services.webapp import Refusal
from cord_services.yandex import Yandex


class LanesTests(unittest.IsolatedAsyncioTestCase):
    """
    Backpressure по образцу Semaphore у Discord: лишним вопросам к площадкам отвечают сразу, а не
    ставят их в очередь без конца.
    """

    def setUp(self):
        self.clock = Clock()
        self.client = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(204)))
        self.reach = Reach(lambda provider: self.client, clock=self.clock)
        self.source = spot()

    async def asyncTearDown(self):
        await self.client.aclose()

    def hold(self, room, gate):
        """Вопрос к площадке, который не кончится, пока не отпустят `gate`."""

        async def work():
            await gate.wait()
            return "ok"

        return asyncio.create_task(self.reach.call(self.source, work, 5.0, room=room))

    async def busy(self, room):
        with self.assertRaises(Refusal) as refusal:
            await self.reach.call(self.source, AsyncMock(return_value="ok"), 5.0, room=room)
        self.assertEqual((refusal.exception.status_code, refusal.exception.code), (429, "PLATFORM_BUSY"))
        self.assertEqual(refusal.exception.headers["Retry-After"], str(reach.BUSY_RETRY_AFTER))
        return refusal.exception

    async def test_a_room_gets_two_lanes_and_the_server_eight(self):
        gate = asyncio.Event()
        held = [self.hold("room-a", gate) for _ in range(reach.ROOM_LANES)]
        await asyncio.sleep(0)
        # Третий вопрос той же комнаты — отказ сразу; другой комнате полосы есть.
        await self.busy("room-a")
        held += [self.hold(f"room-{i}", gate) for i in range(reach.SERVER_LANES - reach.ROOM_LANES)]
        await asyncio.sleep(0)
        self.assertEqual(self.reach.lanes.busy, reach.SERVER_LANES)
        # Восемь на сервер заняты — отказ и свежей комнате; быстрый вопрос без комнаты (каталог) идёт мимо полос.
        await self.busy("room-fresh")
        self.assertEqual(await self.reach.call(self.source, AsyncMock(return_value="ok"), 5.0), "ok")
        lines = self.reach.lane_lines()
        self.assertIn(f"cord_platform_lanes_busy {reach.SERVER_LANES}", lines)
        self.assertIn("cord_platform_busy_refusals_total 2", lines)
        # Отказ не трогает автомат площадки: он по-прежнему закрыт, то есть площадка доступна.
        self.assertEqual(self.reach.gauge(self.source).state, reach.CLOSED)
        gate.set()
        self.assertEqual(await asyncio.gather(*held), ["ok"] * reach.SERVER_LANES)
        self.assertEqual((self.reach.lanes.busy, self.reach.lanes.rooms), (0, {}))
        # Полосы освободились — вопросы идут.
        self.assertEqual(await self.reach.call(self.source, AsyncMock(return_value="ok"), 5.0, room="room-a"), "ok")

    async def test_a_failed_question_frees_its_lane(self):
        async def broken():
            raise httpx.ConnectError("сети нет")

        with self.assertRaises(httpx.ConnectError):
            await self.reach.call(self.source, broken, 5.0, room="room-a")
        self.assertEqual((self.reach.lanes.busy, self.reach.lanes.rooms), (0, {}))


class SegmentRetryTests(unittest.IsolatedAsyncioTestCase):
    """
    Деградация без обрыва (R04): сбой сети или 5xx площадки за сегментом — три повтора через
    200/400/800 мс, и только потом отказ зрителю. Отказ словами (4xx) не повторяется.
    """

    async def asyncSetUp(self):
        self.answers = []
        self.asked = 0

        def upstream(request):
            self.asked += 1
            answer = self.answers.pop(0) if self.answers else 200
            if answer == "down":
                raise httpx.ConnectError("сети нет", request=request)
            return httpx.Response(answer, content=b"ts-bytes", headers={"content-type": "video/mp2t"})

        self.cinema = Cinema("secret", httpx.AsyncClient(transport=httpx.MockTransport(upstream)))
        patcher = patch.object(facade, "RETRY_DELAYS", (0, 0, 0))
        patcher.start()
        self.addCleanup(patcher.stop)

    async def asyncTearDown(self):
        await self.cinema.close()

    async def test_two_failures_then_success_is_a_success(self):
        self.answers = ["down", 503]
        answer = await self.cinema.fetch("https://cdn.films.test/a/1.ts", None, "link")
        self.assertEqual((answer.status_code, bytes(answer.body)), (200, b"ts-bytes"))
        self.assertEqual((self.asked, self.cinema.retries), (3, 2))
        self.assertIn("cord_cinema_upstream_retries_total 2", self.cinema.metric_lines())

    async def test_four_failures_are_a_refusal(self):
        self.answers = ["down", "down", "down", "down"]
        with self.assertRaises(HTTPException) as refusal:
            await self.cinema.fetch("https://cdn.films.test/a/2.ts", None, "link")
        self.assertEqual((refusal.exception.status_code, self.asked), (502, 4))

    async def test_a_platform_refusal_is_not_retried(self):
        self.answers = [404]
        with self.assertRaises(HTTPException) as refusal:
            await self.cinema.fetch("https://cdn.films.test/a/3.ts", None, "link")
        self.assertEqual((refusal.exception.status_code, self.asked, self.cinema.retries), (502, 1, 0))


class MusicWatchdogTests(Fixture):
    """Сторож издателя в числах: голодание, его секунды, перезапуск декодера, пропуск трека."""

    async def test_publisher_events_become_counters(self):
        self.bot_present = True
        one = track(self.store, "One")
        await self.music.enqueue(ROOM, one)
        state = self.store.get(ROOM)
        state.update(
            enabled=True,
            paused=False,
            position=0.0,
            status="playing",
            admission={"roomId": ROOM, "participantId": BOT, "credential": "bot.secret"},
        )
        self.store.save(state)
        commands = []
        events = asyncio.Queue()

        class FakePublisher:
            connected = True

            @classmethod
            async def start(cls, url, token, name="Музыка"):
                return cls()

            async def play(self, path, position, epoch):
                commands.append(("play", Path(path).name, epoch))

            async def pause(self):
                commands.append(("pause",))

            async def event(self, timeout):
                try:
                    return await asyncio.wait_for(events.get(), timeout)
                except TimeoutError:
                    return None

            async def close(self):
                commands.append(("close",))

        async def core_request(method, path, data=None, credential=None, headers=None):
            if path.endswith("/media/token"):
                return {"token": "test"}
            raise AssertionError(path)

        self.core.request = AsyncMock(side_effect=core_request)
        self.core.command = AsyncMock(return_value={})
        player = Music(self.store, self.core, "http://rtc.test")

        async def until(check):
            for _ in range(300):
                if check():
                    return
                await asyncio.sleep(0.01)
            self.fail("издатель или служба не дошли до ожидаемого состояния")

        with patch("cord_services.music.Publisher", FakePublisher):
            task = asyncio.create_task(player.run(ROOM))
            try:
                await until(lambda: any(c[0] == "play" for c in commands))
                epoch = self.store.get(ROOM)["epoch"]
                await events.put({"event": "starved", "epoch": epoch})
                await until(lambda: player.counters.underruns == 1)
                self.assertEqual(self.store.get(ROOM)["status"], "starved")
                # Издатель сам назвал длительность тишины — она и ложится в секунды.
                await events.put({"event": "recovered", "epoch": epoch, "value": 2.5})
                await until(lambda: player.counters.starved_seconds == 2.5)
                self.assertEqual(self.store.get(ROOM)["status"], "playing")
                with self.assertLogs("cord_services.music", "WARNING") as journal:
                    await events.put(
                        {"event": "restart", "epoch": epoch, "value": 7.0, "message": "декодер молчал 5 с"}
                    )
                    await until(lambda: player.counters.decoder_restarts == 1)
                self.assertIn("декодер молчал 5 с", journal.output[0])
                # Перезапуск — не смена трека и не пауза: плеер играет как играл.
                self.assertEqual(self.store.get(ROOM)["status"], "playing")
                self.assertEqual([c for c in commands if c[0] == "play"], [("play", one["file"], epoch)])
                # Источник не отдал звук — трек пропущен, комната знает почему.
                await events.put({"event": "failed", "epoch": epoch, "message": "декодер молчит"})
                await until(lambda: player.counters.skipped == 1)
                self.assertEqual(self.store.get(ROOM)["queue"], [])
                self.assertEqual(self.store.get(ROOM)["error"], "Не удалось воспроизвести трек")
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

        text = render(SimpleNamespace(music=player, store=self.store))
        for line in (
            "cord_music_underrun_total 1",
            "cord_music_starved_seconds_total 2.5",
            "cord_music_decoder_restarts_total 1",
            "cord_music_tracks_skipped_total 1",
            "cord_music_reconnects_total 0",
        ):
            self.assertIn(line + "\n", text)
        self.assertNotIn(ROOM, text)


class MusicStartRetryTests(Fixture):
    """Первый старт издателя с повторами (R04): одна неудача входа в SFU не гасит музыку."""

    async def test_a_failed_first_start_is_retried(self):
        self.bot_present = True
        one = track(self.store, "One")
        await self.music.enqueue(ROOM, one)
        state = self.store.get(ROOM)
        state.update(
            enabled=True,
            paused=False,
            position=0.0,
            status="playing",
            admission={"roomId": ROOM, "participantId": BOT, "credential": "bot.secret"},
        )
        self.store.save(state)
        starts = []
        commands = []

        class FakePublisher:
            connected = True

            @classmethod
            async def start(cls, url, token, name="Музыка"):
                starts.append(token)
                if len(starts) == 1:
                    raise ConnectionError("Издатель музыки не запустился")
                return cls()

            async def play(self, path, position, epoch):
                commands.append(("play", Path(path).name, epoch))

            async def pause(self):
                commands.append(("pause",))

            async def event(self, timeout):
                await asyncio.sleep(timeout)
                return None

            async def close(self):
                commands.append(("close",))

        async def core_request(method, path, data=None, credential=None, headers=None):
            if path.endswith("/media/token"):
                return {"token": "test"}
            raise AssertionError(path)

        self.core.request = AsyncMock(side_effect=core_request)
        self.core.command = AsyncMock(return_value={})
        player = Music(self.store, self.core, "http://rtc.test")
        with (
            patch("cord_services.music.Publisher", FakePublisher),
            patch("cord_services.music.START_PAUSE", 0.0),
            self.assertLogs("cord_services.music", "WARNING") as journal,
        ):
            task = asyncio.create_task(player.run(ROOM))
            try:
                for _ in range(300):
                    if any(c[0] == "play" for c in commands):
                        break
                    await asyncio.sleep(0.01)
                else:
                    self.fail("после неудачного старта издатель не поднялся второй попыткой")
                # Две попытки, музыка играет — не «потеряла соединение».
                self.assertEqual(len(starts), 2)
                self.assertEqual(self.store.get(ROOM)["status"], "playing")
                self.assertIsNone(self.store.get(ROOM)["error"])
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        self.assertIn("попытка 1 из 3", journal.output[0])

    async def test_three_failed_starts_are_an_error(self):
        self.bot_present = True
        one = track(self.store, "One")
        await self.music.enqueue(ROOM, one)
        state = self.store.get(ROOM)
        state.update(
            enabled=True,
            admission={"roomId": ROOM, "participantId": BOT, "credential": "bot.secret"},
        )
        self.store.save(state)
        starts = []

        class FakePublisher:
            @classmethod
            async def start(cls, url, token, name="Музыка"):
                starts.append(token)
                raise ConnectionError("Издатель музыки не запустился")

        async def core_request(method, path, data=None, credential=None, headers=None):
            if path.endswith("/media/token"):
                return {"token": "test"}
            # Встреча жива, люди на месте: конец не ожидаемый — это поломка, о ней говорится вслух.
            return {
                "closedAt": None,
                "participants": [
                    {"id": HOST, "status": "CONNECTED", "service": None},
                    {"id": BOT, "status": "CONNECTED", "service": "music"},
                ],
            }

        self.core.request = AsyncMock(side_effect=core_request)
        self.core.command = AsyncMock(return_value={})
        player = Music(self.store, self.core, "http://rtc.test")
        with (
            patch("cord_services.music.Publisher", FakePublisher),
            patch("cord_services.music.START_PAUSE", 0.0),
            self.assertLogs("cord_services.music", "WARNING"),
        ):
            await player.run(ROOM)
        self.assertEqual(len(starts), 3)
        self.assertEqual(self.store.get(ROOM)["status"], "error")
        self.assertIn("потерял соединение", self.store.get(ROOM)["error"])


class MusicGatesTests(Fixture):
    """SoundCloud и Яндекс — тем же автоматом площадок, что YouTube и кинозал, своими именами."""

    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.sources = self.app.state.sources
        self.reach = self.app.state.cinema.reach

    async def test_soundcloud_has_its_own_gate_in_the_shared_breaker(self):
        gate = self.sources.gate("soundcloud")
        self.assertIs(gate, music_sources.GATES["soundcloud"])
        self.assertTrue(self.reach.tracked(gate))
        self.assertEqual(
            [found.id for found in self.sources.gates()], ["soundcloud", "yandex"]
        )
        # YouTube — автомат кинозала под тем же именем, не свой.
        self.assertIs(self.sources.gate("youtube"), self.app.state.cinema.registry.get("youtube"))
        lines = self.sources.metric_lines()
        self.assertIn('cord_music_reachable{provider="soundcloud"} 1', lines)
        self.assertIn('cord_music_reachable{provider="yandex"} 1', lines)
        self.assertFalse(any(line.startswith("cord_cinema_") for line in lines))
        # Площадка признана недоступной — поиск получает отказ сразу, словами музыки.
        with self.assertLogs("cord_services.cinema.reach", "WARNING"):
            self.reach._open(self.reach.gauge(gate), reach.BY_TRAFFIC)
        with self.assertRaises(Refusal) as refusal:
            await self.sources.search(ROOM, "soundcloud", "something")
        self.assertEqual(refusal.exception.code, "MUSIC_UNREACHABLE")
        self.assertEqual(refusal.exception.extra, {"source": "soundcloud"})
        self.assertEqual(await self.sources.unreachable(), ["soundcloud"])
        self.assertIn('cord_music_reachable{provider="soundcloud"} 0', self.sources.metric_lines())

    async def test_yandex_questions_go_through_the_breaker(self):
        yandex = Yandex(self.store, self.music, "yandex-test-secret", reach=self.reach)

        async def broken():
            raise httpx.ConnectError("сети нет")

        for _ in range(reach.FAILURES - 1):
            with self.assertRaises(HTTPException) as refusal:
                await yandex.request(broken(), room=ROOM)
            self.assertEqual(refusal.exception.status_code, 502)
        with self.assertLogs("cord_services.cinema.reach", "WARNING"):
            with self.assertRaises(HTTPException):
                await yandex.request(broken(), room=ROOM)
        # Автомат открыт: следующий вопрос — отказ сразу, не трогая Яндекс.
        asked = []

        async def answer():
            asked.append(1)
            return {"ok": True}

        pending = answer()
        try:
            with self.assertRaises(Refusal) as refusal:
                await yandex.request(pending, room=ROOM)
        finally:
            pending.close()
        self.assertEqual(
            (refusal.exception.code, refusal.exception.extra), ("MUSIC_UNREACHABLE", {"source": "yandex"})
        )
        self.assertEqual(asked, [])
        self.assertIn('cord_music_reachable{provider="yandex"} 0', self.sources.metric_lines())
        # Вопрос без автомата (старый путь) — как раньше: сбой сети словами 502.
        plain = Yandex(self.store, self.music, "yandex-test-secret")
        with self.assertRaises(HTTPException):
            await plain.request(broken())


if __name__ == "__main__":
    unittest.main()
