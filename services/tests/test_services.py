import asyncio
import json
import tempfile
import unittest
import uuid
import wave
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import HTTPException

from cord_services.app import create_app
from cord_services.core import Core
from cord_services.media import probe, stop_process
from cord_services.music import Music
from cord_services.store import Store, now
from cord_services.telegram import COMMANDS, Telegram

ROOM = str(uuid.uuid4())
HOST = str(uuid.uuid4())
GUEST = str(uuid.uuid4())
BOT = str(uuid.uuid4())


def audio(path, seconds=1):
    with wave.open(str(path), "wb") as f:
        f.setparams((1, 2, 48000, 0, "NONE", "not compressed"))
        f.writeframes(b"\x00\x01" * int(48000 * seconds))


def track(store, title, age=0):
    key = str(uuid.uuid4())
    audio(store.files / key)
    return dict(
        id=key,
        file=key,
        title=title,
        artist="",
        duration=1,
        addedBy="Tester",
        source="upload",
        createdAt=now() - age,
    )


class Fixture(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.core = Core("http://core.test", "internal-test")
        await self.core.client.aclose()
        self.calls = []
        self.guest_status = "CONNECTED"
        self.closed = False
        self.integrations_allowed = False
        self.owner_present = False
        # Место музыкального бота в комнате. По умолчанию его нет: снимок спрашивают и те,
        # кто про бота ничего не знает, а лишний участник в нём менял бы их проверки.
        self.bot_present = False
        self.core.client = httpx.AsyncClient(
            transport=httpx.MockTransport(self.respond)
        )
        self.app = create_app(self.root, self.core, telegram_enabled=False)
        self.store = self.app.state.store
        self.music = self.app.state.music
        self.music.start = lambda _: None
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(self.app), base_url="http://services.test"
        )
        self.bot = Telegram(
            "TEST_TOKEN_DO_NOT_USE",
            self.store,
            self.core,
            self.music,
            "https://cord.test",
        )
        self.bot.me_id = 99
        self.sent = []
        self.admin_status = "administrator"
        self.bot.api = AsyncMock(side_effect=self.telegram_api)

    def respond(self, request):
        body = json.loads(request.content) if request.content else None
        self.calls.append(
            (
                request.method,
                request.url.path,
                body,
                request.headers.get("authorization"),
            )
        )
        assert request.headers["x-internal-secret"] == "internal-test"
        path = request.url.path
        if path.endswith("/media/token"):
            return httpx.Response(200, json={"token": "test"})
        if path == "/api/v1/rooms/" + ROOM:
            if request.headers.get("authorization") not in (
                f"Bearer {HOST}.secret",
                f"Bearer {GUEST}.secret",
                # Снимок комнаты спрашивает и сам бот: по нему он понимает, ушли ли все.
                "Bearer bot.secret",
            ):
                return httpx.Response(403, json={"detail": "Forbidden"})
            return httpx.Response(
                200,
                json={
                    "id": ROOM,
                    "title": "Test",
                    "closedAt": 1 if self.closed else None,
                    "integrationsAllowed": self.integrations_allowed,
                    "participants": [
                        {
                            "id": HOST,
                            "name": "Host",
                            "status": "CONNECTED",
                            "owner": True,
                            "service": None,
                        },
                        {
                            "id": GUEST,
                            "name": "Guest",
                            "status": self.guest_status,
                            "owner": False,
                            "service": None,
                        },
                    ]
                    + (
                        [
                            {
                                "id": BOT,
                                "name": "Музыка",
                                "status": "CONNECTED",
                                "owner": False,
                                "service": "music",
                            }
                        ]
                        if self.bot_present
                        else []
                    ),
                },
            )
        if path == "/internal/services/" + ROOM:
            return httpx.Response(
                200,
                json={
                    "id": ROOM,
                    "title": "Test",
                    "code": "123456789",
                    "closedAt": 1 if self.closed else None,
                    "integrationsAllowed": self.integrations_allowed,
                    "ownerPresent": self.owner_present,
                },
            )
        if path.endswith("/invite"):
            return httpx.Response(
                200, json={"url": "https://cord.test/room/" + ROOM + "?invite=test"}
            )
        if path.endswith("/music") or path == "/api/v1/rooms" or path.endswith("/join"):
            return httpx.Response(
                200,
                json={
                    "roomId": ROOM,
                    "participantId": BOT if path.endswith("/music") else HOST,
                    "credential": "bot.secret"
                    if path.endswith("/music")
                    else HOST + ".secret",
                    "snapshot": {"title": "Test"},
                },
            )
        if "/favorites/" in path or path.endswith("/commands"):
            return httpx.Response(200, json={})
        raise AssertionError(path)

    async def telegram_api(self, method, data=None):
        if method == "sendMessage":
            self.sent.append(data)
            return {"message_id": 1}
        if method == "getMe":
            return {"id": 99, "username": "cord_meet_bot"}
        if method == "getChatMember":
            return {"status": self.admin_status}
        if method == "getWebhookInfo":
            return {"url": ""}
        return True

    async def asyncTearDown(self):
        await self.music.close()
        await self.client.aclose()
        await self.core.client.aclose()
        await self.app.state.yandex.http.aclose()
        await self.bot.client.aclose()
        self.store.db.close()
        self.tmp.cleanup()

    def headers(self, member=HOST):
        return {"Authorization": f"Bearer {member}.secret"}

    def message(self, text, number=1, *, thread=7, user=1, private=False):
        return {
            "update_id": number,
            "message": {
                "message_id": number,
                "text": text,
                "message_thread_id": thread,
                "chat": {
                    "id": user if private else -123,
                    "type": "private" if private else "supergroup",
                    "title": "Group",
                },
                "from": {"id": user, "is_bot": False, "first_name": "Tester"},
            },
        }

    def bind(self, thread=7):
        self.store.bind(
            f"-123:{thread}",
            {
                "roomId": ROOM,
                "profile": "x" * 43,
                "title": "Test",
                "ownerId": 1,
                "ownerName": "Host",
            },
        )


class HttpTests(Fixture):
    async def test_only_admitted_host_can_enable_and_guests_can_control(self):
        base = "/api/v1/services/rooms/" + ROOM + "/music"
        payload = {"commandId": str(uuid.uuid4())}
        self.assertEqual(
            (
                await self.client.post(
                    base + "/enable", headers=self.headers(GUEST), json=payload
                )
            ).status_code,
            403,
        )
        self.assertEqual(
            (
                await self.client.post(
                    base + "/enable", headers=self.headers(), json=payload
                )
            ).status_code,
            200,
        )
        self.assertTrue(self.store.get(ROOM)["enabled"])
        self.integrations_allowed = True
        self.assertEqual(
            (
                await self.client.post(
                    base + "/commands",
                    headers=self.headers(GUEST),
                    json={**payload, "action": "pause"},
                )
            ).status_code,
            200,
        )
        self.assertEqual(
            (await self.client.delete(base, headers=self.headers(GUEST))).status_code,
            403,
        )
        for status in ("WAITING", "LEFT", "REMOVED", "EXPIRED"):
            self.guest_status = status
            self.assertEqual(
                (await self.client.get(base, headers=self.headers(GUEST))).status_code,
                403,
            )
        self.closed = True
        self.assertEqual(
            (await self.client.get(base, headers=self.headers())).status_code, 403
        )

    async def test_api_never_exposes_credentials_or_file_paths(self):
        await self.music.enable(ROOM, str(uuid.uuid4()))
        await self.music.enqueue(ROOM, track(self.store, "One"))
        response = await self.client.get(
            "/api/v1/services/rooms/" + ROOM + "/music", headers=self.headers()
        )
        self.assertEqual(response.status_code, 200)
        for secret in ("bot.secret", "admission", '"file"', str(self.root)):
            self.assertNotIn(secret, response.text)
        response = await self.client.get(
            "/api/v1/services/catalog", headers={"Origin": "https://another.test"}
        )
        self.assertEqual(response.status_code, 403)

    async def test_upload_is_validated_and_concurrent_retry_does_not_duplicate(self):
        path = self.root / "tone.wav"
        audio(path)
        url = f"/api/v1/services/rooms/{ROOM}/music/upload/{uuid.uuid4()}"
        replies = await asyncio.gather(
            *[
                self.client.put(
                    url,
                    headers={**self.headers(), "X-Filename": "tone.wav"},
                    content=path.read_bytes(),
                )
                for _ in range(2)
            ]
        )
        self.assertEqual([r.status_code for r in replies], [200, 200])
        self.assertEqual(len(self.store.get(ROOM)["queue"]), 1)
        bad = await self.client.put(
            f"/api/v1/services/rooms/{ROOM}/music/upload/{uuid.uuid4()}",
            headers=self.headers(),
            content=b"not audio",
        )
        self.assertEqual(bad.status_code, 400)
        self.assertEqual(len(list(self.store.files.iterdir())), 1)

    async def test_claim_one_use_with_retry_and_binding_owner_only(self):
        self.store.set_state("bot_username", "cord_meet_bot")
        url = f"/api/v1/services/rooms/{ROOM}/telegram/link"
        self.assertEqual(
            (await self.client.post(url, headers=self.headers(GUEST))).status_code, 403
        )
        response = await self.client.post(url, headers=self.headers())
        self.assertEqual(response.status_code, 200)
        token = response.json()["command"].split()[1]
        self.assertEqual(self.store.claim(token)["roomId"], ROOM)
        self.store.put_claim(
            "h" * 32,
            {"kind": "web-host", "roomId": ROOM, "title": "Test", "profile": "p" * 43},
        )
        body = dict(token="h" * 32, name="Host", commandId=str(uuid.uuid4()))
        url = "/api/v1/services/claims/redeem"
        first = await self.client.post(url, json=body)
        self.assertEqual(first.status_code, 200)
        self.assertEqual((await self.client.post(url, json=body)).json(), first.json())
        self.assertEqual(
            (
                await self.client.post(
                    url, json={**body, "commandId": str(uuid.uuid4())}
                )
            ).status_code,
            410,
        )
        self.assertEqual(sum(path.endswith("/join") for _, path, _, _ in self.calls), 1)


class QueueTests(Fixture):
    async def test_queue_controls_are_durable_and_idempotent(self):
        a, b, c = [track(self.store, title) for title in ("One", "Two", "Three")]
        for t in (a, b, c):
            await self.music.enqueue(ROOM, t)
        next_command = dict(commandId=str(uuid.uuid4()), action="next", trackId=c["id"])
        await self.music.command(ROOM, next_command)
        self.assertEqual(
            [t["title"] for t in self.store.get(ROOM)["queue"]], ["One", "Three", "Two"]
        )
        skip = dict(commandId=str(uuid.uuid4()), action="skip")
        await self.music.command(ROOM, skip)
        await self.music.command(ROOM, skip)
        self.assertEqual(
            [t["title"] for t in self.store.get(ROOM)["queue"]], ["Three", "Two"]
        )
        self.assertFalse((self.store.files / a["file"]).exists())
        with self.assertRaises(HTTPException):
            await self.music.command(ROOM, {**skip, "action": "clear"})
        for action, extra in [
            ("seek", {"position": 5000}),
            ("pause", {}),
            ("play", {}),
            ("repeat", {"enabled": True}),
            ("skip", {}),
        ]:
            await self.music.command(
                ROOM, dict(commandId=str(uuid.uuid4()), action=action, **extra)
            )
        restored = Store(self.root)
        self.assertTrue(restored.get(ROOM)["repeat"])
        self.assertEqual(
            [t["title"] for t in restored.get(ROOM)["queue"]], ["Two", "Three"]
        )
        restored.db.close()

    async def test_adding_the_service_again_plays_instead_of_staying_paused(self):
        """ЗАЧЕМ. Это и есть «добавил музыку, а она молчит».

        Снятие сервиса со встречи ставило `paused`, очередь при этом оставалась. Добавление
        сервиса заново `paused` не снимало, поэтому бот заходил в комнату, очередь была видна,
        статус был честный — «на паузе», — а звука не появлялось, пока кто-нибудь не догадался
        нажать «продолжить». Со стороны это выглядело как «зависит от того, что добавлять
        раньше: треки или плеер».
        """
        await self.music.enable(ROOM, str(uuid.uuid4()))
        await self.music.enqueue(ROOM, track(self.store, "One"))
        await self.music.command(
            ROOM, {"commandId": str(uuid.uuid4()), "action": "pause"}
        )
        self.assertTrue(self.store.get(ROOM)["paused"])
        await self.music.disable(ROOM)
        # Очередь переживает снятие сервиса, и треки можно добавлять, пока его нет.
        await self.music.enqueue(ROOM, track(self.store, "Two"))
        self.assertEqual(len(self.store.get(ROOM)["queue"]), 2)

        state = await self.music.enable(ROOM, str(uuid.uuid4()))
        self.assertFalse(state["paused"])
        self.assertTrue(state["enabled"])

        # А перезапуск самого сервиса — не просьба человека: пауза его переживает.
        await self.music.command(
            ROOM, {"commandId": str(uuid.uuid4()), "action": "pause"}
        )
        self.store.cache[ROOM]["admission"] = None
        await self.music.resume(ROOM)
        self.assertTrue(self.store.get(ROOM)["paused"])

    async def test_cleanup_drops_old_audio_and_invalidates_current_decoder(self):
        old = track(self.store, "Old", 86400001)
        recent = track(self.store, "New")
        for t in (old, recent):
            await self.music.enqueue(ROOM, t)
        epoch = self.store.get(ROOM)["epoch"]
        self.store.cleanup()
        self.assertEqual(self.store.get(ROOM)["epoch"], epoch + 1)
        self.assertEqual([t["title"] for t in self.store.get(ROOM)["queue"]], ["New"])
        self.assertFalse((self.store.files / old["file"]).exists())
        with patch("cord_services.music.MAX_TOTAL", 1):
            with self.assertRaises(HTTPException):
                self.music.check_quota(ROOM, 1)

    async def test_cleanup_forgets_rooms_that_stopped_using_music(self):
        # Запись о комнате, где музыку выключили сутки назад, не хранит ничего: очередь
        # пуста, а комнаты к этому времени уже нет и в ядре. Раньше такие записи копились
        # без предела — и не только на диске: ledger целиком поднимается в память при старте.
        old = track(self.store, "Old", 86400001)
        await self.music.enqueue(ROOM, old)
        state = self.store.get(ROOM)
        state["enabled"] = False
        state["lastHumanAt"] = 0
        self.store.save(state, changed=False)
        self.store.cleanup()
        self.assertNotIn(ROOM, self.store.cache)
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM music").fetchone()[0], 0)
        self.assertFalse((self.store.files / old["file"]).exists())
        # Забытая комната — это чистый лист, а не отказ: включат музыку снова, и запись
        # заведётся заново.
        self.assertEqual(self.store.get(ROOM)["queue"], [])

    async def test_cleanup_keeps_a_room_that_is_still_playing(self):
        await self.music.enqueue(ROOM, track(self.store, "New"))
        state = self.store.get(ROOM)
        state["enabled"] = True
        state["lastHumanAt"] = 0
        self.store.save(state, changed=False)
        self.store.cleanup()
        self.assertIn(ROOM, self.store.cache)
        self.assertEqual([t["title"] for t in self.store.get(ROOM)["queue"]], ["New"])

    async def test_probe_rejects_external_playlist_and_accepts_audio(self):
        path = self.root / "source"
        path.write_text("#EXTM3U\nhttps://example.test/audio.mp3\n")
        with self.assertRaises(HTTPException):
            await probe(path)
        audio(path)
        self.assertAlmostEqual((await probe(path))["duration"], 1, places=2)

    async def test_stopping_a_process_nobody_is_reading_does_not_hang(self):
        """ЗАЧЕМ. Это ровно та поломка, из-за которой музыка замолкала навсегда.

        ffmpeg отдаёт данные быстрее, чем комната играет, поэтому к паузе, перемотке или
        переключению труба всегда полна: процесс стоит в записи, а её транспорт — на паузе,
        потому что читать перестали. asyncio завершает `wait()` только после того, как все
        трубы отсоединились, и прежняя остановка ждала этого вечно — даже убив процесс.
        Цикл воспроизведения оставался в `finally`, и на экране всё выглядело живым: статус
        «играет», очередь на месте, ошибок нет. Только звука больше не было никогда.

        Сейчас звук отдаёт отдельный процесс, но `stop_process` по-прежнему останавливает
        ffprobe в разборе файла, и обещание у него то же: она возвращает управление.
        """
        path = self.root / "long"
        audio(path, 5)
        process = await asyncio.create_subprocess_exec(
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-i",
            str(path),
            "-f",
            "s16le",
            "pipe:1",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            limit=16384,
        )
        try:
            for _ in range(5):
                await asyncio.wait_for(process.stdout.readexactly(3840), 5)
            await asyncio.sleep(0.3)
            await asyncio.wait_for(stop_process(process), 10)
            self.assertIsNotNone(process.returncode)
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()

    async def test_pause_skip_and_seek_reach_the_publisher(self):
        """Очередь живёт здесь, звук — в отдельном процессе; связывает их эпоха.

        Раньше в этом месте проверялось, что источник LiveKit продолжает принимать кадры.
        Теперь кадров нет: воспроизведением занимается издатель, и проверять нужно ровно
        то, что до него доходит — какой трек, с какой позиции и когда замолчать.
        """
        first, second = track(self.store, "One"), track(self.store, "Two")
        await self.music.enqueue(ROOM, first)
        await self.music.enqueue(ROOM, second)
        state = self.store.get(ROOM)
        state.update(
            enabled=True,
            admission={
                "roomId": ROOM,
                "participantId": BOT,
                "credential": "bot.secret",
            },
        )
        self.store.save(state)
        commands = []
        events = asyncio.Queue()

        class FakePublisher:
            connected = True

            @classmethod
            async def start(cls, url, token, name="Музыка"):
                commands.append(("connect", url, token))
                return cls()

            async def play(self, path, position, epoch):
                commands.append(("play", Path(path).name, round(position, 3), epoch))

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

        async def sent(kind, count=1):
            for _ in range(200):
                if len([c for c in commands if c[0] == kind]) >= count:
                    return
                await asyncio.sleep(0.01)
            self.fail(f"Издателю так и не отправили {kind}: {commands}")

        with patch("cord_services.music.Publisher", FakePublisher):
            task = asyncio.create_task(player.run(ROOM))
            try:
                await sent("play")
                self.assertEqual(commands[0][1], "ws://rtc.test")
                epoch = self.store.get(ROOM)["epoch"]
                self.assertEqual(commands[1], ("play", first["file"], 0.0, epoch))
                # Позиция приходит от издателя и переживает перезапуск сервиса.
                await events.put({"event": "position", "epoch": epoch, "value": 0.4})
                await asyncio.sleep(0.05)
                self.assertAlmostEqual(self.store.get(ROOM)["position"], 0.4, places=3)

                await player.command(
                    ROOM, {"commandId": str(uuid.uuid4()), "action": "skip"}
                )
                await sent("play", 2)
                epoch = self.store.get(ROOM)["epoch"]
                self.assertEqual(commands[-1], ("play", second["file"], 0.0, epoch))

                await player.command(
                    ROOM,
                    {
                        "commandId": str(uuid.uuid4()),
                        "action": "seek",
                        "position": 0.5,
                    },
                )
                await sent("play", 3)
                epoch = self.store.get(ROOM)["epoch"]
                self.assertEqual(commands[-1], ("play", second["file"], 0.5, epoch))

                await player.command(
                    ROOM, {"commandId": str(uuid.uuid4()), "action": "pause"}
                )
                await sent("pause")
                self.assertEqual(self.store.get(ROOM)["status"], "paused")

                await player.command(
                    ROOM, {"commandId": str(uuid.uuid4()), "action": "play"}
                )
                await sent("play", 4)
                epoch = self.store.get(ROOM)["epoch"]
                # Трек кончился сам: очередь двигается, эпоха меняется, файл убирается.
                await events.put({"event": "finished", "epoch": epoch, "value": 1.0})
                for _ in range(200):
                    if not self.store.get(ROOM)["queue"]:
                        break
                    await asyncio.sleep(0.01)
                self.assertEqual(self.store.get(ROOM)["queue"], [])
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        self.assertIn(("close",), commands)

    async def test_room_ending_is_not_reported_as_a_broken_connection(self):
        """Все разошлись — это конец работы, а не поломка.

        ЗАЧЕМ ТЕСТ. Обрыв у издателя одинаковый в обоих случаях, и раньше он одинаково же и
        объяснялся: «Музыкальный сервис потерял соединение». Надпись переживала саму встречу
        и встречала следующего, кто открывал панель, — при том что добавление сервиса
        работало с первого нажатия. Проверяем обе половины: у закрытой комнаты ошибки нет, у
        живой с людьми — есть.
        """
        for closed, expected_error in ((True, False), (False, True)):
            with self.subTest(closed=closed):
                self.closed = closed
                self.bot_present = True
                state = self.store.get(ROOM)
                state.update(
                    enabled=True,
                    status="playing",
                    error=None,
                    admission={
                        "roomId": ROOM,
                        "participantId": BOT,
                        "credential": "bot.secret",
                    },
                )
                self.store.save(state)
                events = asyncio.Queue()
                events.put_nowait({"event": "closed", "message": "room closed"})

                class FakePublisher:
                    connected = True

                    @classmethod
                    async def start(cls, url, token, name="Музыка"):
                        return cls()

                    async def play(self, path, position, epoch):
                        pass

                    async def pause(self):
                        pass

                    async def event(self, timeout):
                        try:
                            return await asyncio.wait_for(events.get(), timeout)
                        except TimeoutError:
                            return None

                    async def close(self):
                        pass

                player = Music(self.store, self.core, "http://rtc.test")
                with patch("cord_services.music.Publisher", FakePublisher):
                    await player.run(ROOM)
                state = self.store.get(ROOM)
                self.assertEqual(bool(state["error"]), expected_error)
                self.assertEqual(
                    state["status"], "error" if expected_error else "disabled"
                )


class TelegramTests(Fixture):
    async def test_metadata_registers_every_supported_command(self):
        await self.bot.configure()
        calls = self.bot.api.call_args_list
        commands = next(
            c.args[1]["commands"] for c in calls if c.args[0] == "setMyCommands"
        )
        self.assertEqual(len(commands), 20)
        self.assertEqual({c["command"] for c in commands}, {c for c, _ in COMMANDS})
        self.assertTrue(self.bot.ready)
        self.assertEqual(self.store.state("bot_username"), "cord_meet_bot")

    async def test_bot_answers_even_when_telegram_refuses_to_rename_it(self):
        """ЗАЧЕМ. Из-за этого бот однажды замолчал на полдня — и ничего не ломалось.

        Telegram ограничивает смену имени часами. Оформление применялось при каждом
        запуске процесса и в одной попытке с `getMe`, поэтому несколько перезапусков
        сервиса подряд — обычное дело при выкатке — оставляли бота в вечном повторе
        настройки: до получения обновлений он не доходил ни разу.
        """
        await self.bot.configure()
        applied = [c.args[0] for c in self.bot.api.call_args_list]
        self.assertIn("setMyName", applied)

        # Второй запуск: оформление уже такое, какое нужно, и повторять его незачем.
        self.bot.api.reset_mock()
        self.bot.ready = False
        await self.bot.configure()
        self.assertNotIn("setMyName", [c.args[0] for c in self.bot.api.call_args_list])
        self.assertTrue(self.bot.ready)

        # А если Telegram всё же отказал — бот всё равно работает, а отметка не ставится.
        self.store.set_state("bot_profile", "")
        refused = {"setMyName"}

        async def api(method, payload=None):
            if method in refused:
                raise HTTPException(429, "Too Many Requests")
            return await self.telegram_api(method, payload)

        self.bot.api = AsyncMock(side_effect=api)
        self.bot.ready = False
        await self.bot.configure()
        self.assertTrue(self.bot.ready)
        self.assertEqual(self.store.state("bot_status"), "polling")
        self.assertEqual(self.store.state("bot_profile"), "")

    async def test_binding_requires_chat_admin_and_is_scoped_to_topic(self):
        token = "b" * 24
        self.store.put_claim(
            token,
            {
                "kind": "bind",
                "roomId": ROOM,
                "profile": "p" * 43,
                "title": "Test",
                "ownerName": "Owner",
            },
        )
        self.admin_status = "member"
        await self.bot.handle(self.message("/bind " + token))
        self.assertIsNone(self.store.binding("-123:7"))
        self.assertIsNotNone(self.store.claim(token))
        self.admin_status = "administrator"
        await self.bot.handle(self.message("/bind@cord_meet_bot " + token, 2))
        self.assertEqual(self.store.binding("-123:7")["roomId"], ROOM)
        self.assertIsNone(self.store.binding("-123:8"))
        self.assertIsNone(self.store.claim(token))
        self.assertEqual(self.sent[-1]["message_thread_id"], 7)
        await self.bot.handle(self.message("/unbind", 3))
        self.assertIsNone(self.store.binding("-123:7"))

    async def test_host_link_is_private_creator_only_and_one_use(self):
        token = "h" * 24
        self.store.put_claim(
            token,
            {
                "kind": "telegram-host",
                "roomId": ROOM,
                "profile": "p" * 43,
                "title": "Test",
                "ownerId": 1,
            },
        )
        await self.bot.handle(
            self.message("/start host_" + token, user=2, private=True)
        )
        self.assertIsNotNone(self.store.claim(token))
        self.assertNotIn("reply_markup", self.sent[-1])
        await self.bot.handle(self.message("/start host_" + token, 2, private=True))
        self.assertIsNone(self.store.claim(token))
        url = self.sent[-1]["reply_markup"]["inline_keyboard"][0][0]["url"]
        self.assertTrue(url.startswith("https://cord.test/host#token="))
        self.assertEqual(self.store.claim(url.split("token=")[1])["kind"], "web-host")

    async def test_failed_reply_retries_outbox_without_repeating_skip(self):
        self.bind()
        for title in ("One", "Two", "Three"):
            await self.music.enqueue(ROOM, track(self.store, title))
        update = self.message("/skip")
        self.bot.api.side_effect = HTTPException(503, "Temporary")
        with self.assertRaises(HTTPException):
            await self.bot.handle(update)
        self.assertEqual(
            [t["title"] for t in self.store.get(ROOM)["queue"]], ["Two", "Three"]
        )
        self.bot.api.side_effect = self.telegram_api
        await self.bot.handle(update)
        await self.bot.handle(update)
        self.assertEqual(
            [t["title"] for t in self.store.get(ROOM)["queue"]], ["Two", "Three"]
        )
        self.assertEqual(len(self.sent), 1)

    async def test_create_meet_exposes_regular_invite_and_creator_private_button(self):
        await self.bot.handle(self.message("/new Team music"))
        binding = self.store.binding("-123:7")
        self.assertEqual(binding["ownerId"], 1)
        buttons = self.sent[-1]["reply_markup"]["inline_keyboard"]
        self.assertIn("?invite=", buttons[0][0]["url"])
        self.assertIn("t.me/cord_meet_bot?start=host_", buttons[1][0]["url"])
        before = len([c for c in self.calls if c[1] == "/api/v1/rooms"])
        await self.bot.handle(self.message("/meet", 2, user=2))
        self.assertEqual(len(self.sent[-1]["reply_markup"]["inline_keyboard"]), 1)
        self.assertEqual(
            len([c for c in self.calls if c[1] == "/api/v1/rooms"]), before
        )

    async def test_forwarded_audio_downloads_and_replay_does_not_duplicate(self):
        self.bind()
        wav = self.root / "telegram.wav"
        audio(wav)
        await self.bot.client.aclose()
        self.bot.client = httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda _: httpx.Response(200, content=wav.read_bytes())
            )
        )

        async def api(method, data=None):
            if method == "getFile":
                return {"file_path": "music/test.wav"}
            return await self.telegram_api(method, data)

        self.bot.api.side_effect = api
        update = self.message("/play@cord_meet_bot")
        update["message"]["reply_to_message"] = {
            "audio": {
                "file_id": "test",
                "title": "From song",
                "file_size": wav.stat().st_size,
            },
            "via_bot": {"username": "song"},
        }
        await self.bot.handle(update)
        await self.bot.handle(update)
        self.assertEqual(
            [t["title"] for t in self.store.get(ROOM)["queue"]], ["From song"]
        )
        self.assertTrue(self.store.get(ROOM)["enabled"])
        self.assertEqual(len(self.sent), 1)

    async def configure_audio(self):
        self.bind()
        wav = self.root / "forwarded.wav"
        audio(wav)
        await self.bot.client.aclose()
        self.bot.client = httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda _: httpx.Response(200, content=wav.read_bytes())
            )
        )

        async def api(method, data=None):
            if method == "getFile":
                return {"file_path": "music/test.wav"}
            return await self.telegram_api(method, data)

        self.bot.api.side_effect = api
        return {
            "file_id": "forwarded",
            "title": "Forwarded track",
            "file_size": wav.stat().st_size,
        }

    async def test_caption_and_external_reply_both_enqueue_audio(self):
        media = await self.configure_audio()
        caption = self.message("", 101)
        caption["message"].update(
            caption="/play@cord_meet_bot",
            audio=media,
            reply_to_message={"text": "unrelated text"},
        )
        await self.bot.handle(caption)
        quote = self.message("/play@cord_meet_bot", 102)
        quote["message"]["external_reply"] = {"audio": media}
        await self.bot.handle(quote)
        self.assertEqual(len(self.store.get(ROOM)["queue"]), 2)
        self.assertTrue(
            all(t["source"] == "telegram" for t in self.store.get(ROOM)["queue"])
        )

    async def test_forward_then_separate_play_is_scoped_and_used_once(self):
        media = await self.configure_audio()
        self.integrations_allowed = True
        forwarded = self.message("", 201)
        forwarded["message"].update(audio=media, forward_origin={"type": "channel"})
        await self.bot.handle(forwarded)
        self.assertEqual(self.store.get(ROOM)["queue"], [])
        await self.bot.handle(self.message("/play", 202, user=2))
        self.assertEqual(self.store.get(ROOM)["queue"], [])
        self.bind(thread=8)
        await self.bot.handle(self.message("/play", 203, thread=8))
        self.assertEqual(self.store.get(ROOM)["queue"], [])
        await self.bot.handle(self.message("/play", 204))
        await self.bot.handle(forwarded)
        await self.bot.handle(self.message("/play", 205))
        self.assertEqual(len(self.store.get(ROOM)["queue"]), 1)
        self.assertFalse(self.store.get(ROOM)["paused"])

    async def test_stale_forward_does_not_play_and_empty_queue_is_explained(self):
        media = await self.configure_audio()
        forwarded = self.message("", 301)
        forwarded["message"]["audio"] = media
        await self.bot.handle(forwarded)
        key = self.bot.recent_audio_key(forwarded["message"])
        recent = self.store.receipt("tg-recent-audio", key)
        recent["at"] = now() - 300001
        self.store.remember("tg-recent-audio", key, recent)
        await self.bot.handle(self.message("/play", 302))
        self.assertIn("Очередь пуста", self.sent[-1]["text"])
        self.assertNotIn("Продолжаем", self.sent[-1]["text"])
        self.assertFalse(self.store.get(ROOM)["enabled"])

    async def test_controls_help_and_foreign_bot_filter(self):
        self.bind()
        for title in ("One", "Two", "Three"):
            await self.music.enqueue(ROOM, track(self.store, title))
        commands = [
            "/help",
            "/start",
            "/room",
            "/queue",
            "/now",
            "/pause",
            "/resume",
            "/next 3",
            "/remove 3",
            "/shuffle",
            "/repeat on",
            "/stop",
            "/clear",
            "/play missing song",
        ]
        for number, command in enumerate(commands, 10):
            await self.bot.handle(self.message(command, number))
        self.assertEqual(len(self.sent), len(commands))
        before = len(self.sent)
        await self.bot.handle(self.message("/play@another_bot", 100))
        update = self.message("/meet", 101)
        update["message"]["from"]["is_bot"] = True
        await self.bot.handle(update)
        self.assertEqual(len(self.sent), before)
        self.assertIn("Яндекс", self.sent[-1]["text"])


if __name__ == "__main__":
    unittest.main()
