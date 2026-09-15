from __future__ import annotations

import asyncio
import contextlib
import gc
import logging
import random
import uuid
from collections import defaultdict

from fastapi import HTTPException
from livekit import rtc

from .core import Core
from .media import MAX_ROOM, MAX_TOTAL, decoder, stop_process
from .store import Store, now

logger = logging.getLogger(__name__)


class Music:
    def __init__(self, store: Store, core: Core, rtc_url: str):
        self.store = store
        self.core = core
        self.rtc_url = rtc_url.replace("http://", "ws://").replace("https://", "wss://")
        self.locks = defaultdict(asyncio.Lock)
        self.tasks: dict[str, asyncio.Task] = {}
        self.sources: dict[str, rtc.AudioSource] = {}
        self.stopping = False

    def start(self, room_id: str):
        if room_id not in self.tasks or self.tasks[room_id].done():
            self.tasks[room_id] = asyncio.create_task(
                self.run(room_id), name="music-" + room_id
            )

    async def enable(self, room_id: str, command_id: str):
        async with self.locks[room_id]:
            state = self.store.get(room_id)
            if state["enabled"]:
                self.start(room_id)
                return self.store.public(room_id)
            pending_id = state.get("pendingCommandId") or command_id
            state["pendingCommandId"] = pending_id
            self.store.save(state)
            admission = await self.core.add_music(room_id, pending_id)
            state = self.store.get(room_id)
            state.update(
                enabled=True,
                status="connecting",
                error=None,
                admission=admission,
                participantId=admission["participantId"],
                lastHumanAt=now(),
                pendingCommandId=None,
            )
            self.store.save(state)
            self.start(room_id)
            return self.store.public(room_id)

    async def disable(self, room_id: str):
        async with self.locks[room_id]:
            state = self.store.get(room_id)
            state.update(
                enabled=False, status="disabled", paused=True, epoch=state["epoch"] + 1
            )
            self.store.save(state)
            task = self.tasks.pop(room_id, None)
            if task:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
            if state["admission"]:
                with contextlib.suppress(HTTPException):
                    await self.core.command(state["admission"], "leave")
            state = self.store.get(room_id)
            state.update(admission=None, participantId=None, status="disabled")
            self.store.save(state)
            return self.store.public(room_id)

    def check_quota(self, room_id: str, incoming: int, already_stored: bool = False):
        state = self.store.get(room_id)
        if len(state["queue"]) >= 100:
            raise HTTPException(409, "В очереди уже 100 треков")
        room_size = sum(
            (self.store.files / t["file"]).stat().st_size
            for t in state["queue"]
            if (self.store.files / t["file"]).exists()
        )
        total = sum(p.stat().st_size for p in self.store.files.iterdir() if p.is_file())
        if (
            room_size + incoming > MAX_ROOM
            or total + (0 if already_stored else incoming) > MAX_TOTAL
        ):
            raise HTTPException(
                413, "Хранилище музыки заполнено. Удалите треки из очереди"
            )

    async def enqueue(self, room_id: str, track: dict):
        async with self.locks[room_id]:
            self.check_quota(
                room_id,
                (self.store.files / track["file"]).stat().st_size,
                already_stored=True,
            )
            state = self.store.get(room_id)
            if any(t["id"] == track["id"] for t in state["queue"]):
                return self.store.public(room_id)
            was_empty = not state["queue"]
            state["queue"].append(track)
            if was_empty:
                state.update(position=0.0, paused=False, epoch=state["epoch"] + 1)
            self.store.save(state)
            return self.store.public(room_id)

    async def command(self, room_id: str, command: dict):
        async with self.locks[room_id]:
            scope = "music:" + room_id
            prior = self.store.receipt(scope, command["commandId"])
            fingerprint = {k: v for k, v in command.items() if k != "commandId"}
            if prior:
                if prior["request"] != fingerprint:
                    raise HTTPException(409, "Идентификатор команды уже использован")
                return self.store.public(room_id)
            state = self.store.get(room_id)
            previous_files = [track["file"] for track in state["queue"]]
            action = command["action"]
            if action == "pause":
                state["paused"] = True
            elif action == "play":
                state["paused"] = False
            elif action == "skip":
                if state["queue"]:
                    track = state["queue"].pop(0)
                    if state["repeat"]:
                        state["queue"].append(track)
                state["position"] = 0.0
            elif action == "stop":
                state.update(paused=True, position=0.0)
            elif action == "clear":
                state["queue"] = state["queue"][:1]
            elif action == "repeat":
                state["repeat"] = bool(command.get("enabled"))
            elif action == "shuffle":
                tail = state["queue"][1:]
                random.shuffle(tail)
                state["queue"] = state["queue"][:1] + tail
            elif action == "seek":
                if state["queue"]:
                    state["position"] = min(
                        state["queue"][0]["duration"],
                        max(0.0, float(command.get("position") or 0)),
                    )
            elif action in ("remove", "next"):
                target = command.get("trackId")
                index = next(
                    (i for i, t in enumerate(state["queue"]) if t["id"] == target), None
                )
                if index is None:
                    raise HTTPException(404, "Трек уже удалён")
                if action == "next":
                    if index > 0:
                        state["queue"].insert(1, state["queue"].pop(index))
                else:
                    state["queue"].pop(index)
                    if index == 0:
                        state["position"] = 0.0
                        state["epoch"] += 1
            else:
                raise HTTPException(400, "Неизвестная музыкальная команда")
            if action in ("pause", "play", "skip", "stop", "seek"):
                state["epoch"] += 1
            state["error"] = None
            self.store.save(state)
            self.store.remember(scope, command["commandId"], {"request": fingerprint})
            self.store.prune_files(previous_files)
            return self.store.public(room_id)

    async def run(self, room_id: str):
        room = rtc.Room()
        source = rtc.AudioSource(48000, 2, queue_size_ms=100)
        self.sources[room_id] = source
        process = None
        watcher = None
        try:
            state = self.store.get(room_id)
            admission = state["admission"]
            try:
                token = await self.core.request(
                    "POST",
                    f"/api/v1/rooms/{room_id}/media/token",
                    credential=admission["credential"],
                )
            except HTTPException as error:
                if error.status_code != 410:
                    raise
                snapshot = await self.core.request(
                    "GET",
                    f"/api/v1/rooms/{room_id}",
                    credential=admission["credential"],
                )
                if snapshot.get("closedAt"):
                    raise
                await self.core.command(admission, "leave")
                admission = await self.core.add_music(room_id, str(uuid.uuid4()))
                state = self.store.get(room_id)
                state.update(
                    admission=admission, participantId=admission["participantId"]
                )
                self.store.save(state)
                token = await self.core.request(
                    "POST",
                    f"/api/v1/rooms/{room_id}/media/token",
                    credential=admission["credential"],
                )
            await asyncio.wait_for(
                room.connect(
                    self.rtc_url, token["token"], rtc.RoomOptions(auto_subscribe=False)
                ),
                15,
            )
            track = rtc.LocalAudioTrack.create_audio_track("Музыка", source)
            options = rtc.TrackPublishOptions(
                source=rtc.TrackSource.SOURCE_MICROPHONE, dtx=False, red=True
            )
            options.audio_encoding.max_bitrate = 256000
            await room.local_participant.publish_track(track, options)
            state = self.store.get(room_id)
            state.update(status="idle", error=None)
            self.store.save(state)
            watcher = asyncio.create_task(self.watch(room_id, admission, room))
            disconnected_at = None
            while self.store.get(room_id)["enabled"]:
                state = self.store.get(room_id)
                if not room.isconnected():
                    disconnected_at = disconnected_at or now()
                    if now() - disconnected_at > 20000:
                        raise ConnectionError("Media connection lost")
                    await asyncio.sleep(0.2)
                    continue
                disconnected_at = None
                if state["paused"] or not state["queue"]:
                    status = "paused" if state["paused"] and state["queue"] else "idle"
                    if state["status"] != status:
                        state["status"] = status
                        self.store.save(state)
                    await asyncio.sleep(0.2)
                    continue
                current = state["queue"][0]
                epoch = state["epoch"]
                path = self.store.files / current["file"]
                if not path.is_file():
                    await self.failed_track(
                        room_id, current["id"], "Файл трека больше недоступен"
                    )
                    continue
                process = await decoder(path, state["position"])
                latest = self.store.get(room_id)
                if (
                    not latest["enabled"]
                    or latest["epoch"] != epoch
                    or not latest["queue"]
                    or latest["queue"][0]["id"] != current["id"]
                ):
                    await stop_process(process)
                    process = None
                    continue
                latest["status"] = "playing"
                self.store.save(latest)
                completed = False
                decoder_failed = False
                try:
                    while True:
                        state = self.store.get(room_id)
                        if (
                            not state["enabled"]
                            or state["epoch"] != epoch
                            or not state["queue"]
                            or state["queue"][0]["id"] != current["id"]
                        ):
                            break
                        # A finite decoder read keeps commands responsive if a damaged file stalls.
                        try:
                            data = await asyncio.wait_for(
                                process.stdout.readexactly(3840), 5
                            )
                        except asyncio.IncompleteReadError as end:
                            data = end.partial
                            completed = True
                        if data:
                            data = data[: len(data) // 4 * 4]
                            if data:
                                await asyncio.wait_for(
                                    source.capture_frame(
                                        rtc.AudioFrame(data, 48000, 2, len(data) // 4)
                                    ),
                                    5,
                                )
                                state = self.store.get(room_id)
                                if state["epoch"] == epoch:
                                    state["position"] = min(
                                        current["duration"],
                                        state["position"] + len(data) / 192000,
                                    )
                                    # State is durable; avoid a synchronous disk write for every 20ms frame.
                                    self.store.save(state, changed=False)
                        if completed:
                            await source.wait_for_playout()
                            await asyncio.wait_for(process.wait(), 2)
                            decoder_failed = process.returncode != 0
                            break
                except TimeoutError:
                    completed = True
                    decoder_failed = True
                finally:
                    await stop_process(process)
                    process = None
                    # livekit-python 1.1.x can leave this native source unable to
                    # accept more frames after clear_queue(). Let its bounded 100 ms
                    # buffer drain so skip and seek can reuse the published track.
                state = self.store.get(room_id)
                if (
                    completed
                    and state["epoch"] == epoch
                    and state["queue"]
                    and state["queue"][0]["id"] == current["id"]
                ):
                    if decoder_failed:
                        state["error"] = "Не удалось декодировать трек"
                    state["queue"].pop(0)
                    if state["repeat"] and not decoder_failed:
                        state["queue"].append(current)
                    state.update(position=0.0, epoch=state["epoch"] + 1)
                    self.store.save(state)
                    self.store.prune_files([current["file"]])
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Music playback failed")
            state = self.store.get(room_id)
            state.update(
                status="error",
                error="Музыкальный сервис потерял соединение. Организатор может подключить его заново.",
            )
            self.store.save(state)
        finally:
            if watcher:
                watcher.cancel()
                await asyncio.gather(watcher, return_exceptions=True)
            if process:
                await stop_process(process)
            source.clear_queue()
            await source.aclose()
            self.sources.pop(room_id, None)
            with contextlib.suppress(Exception):
                await room.disconnect()
            # rtc.Room exposes no explicit close: the native ICE sockets are released
            # only when the FFI handle is dropped. The room and its event handlers form
            # reference cycles, so refcounting alone leaves them alive and the sockets
            # leak for the lifetime of the process. Drop our references and collect now.
            room = None
            source = None
            gc.collect()
            state = self.store.get(room_id)
            if state["admission"]:
                with contextlib.suppress(HTTPException):
                    await self.core.command(state["admission"], "leave")
            state = self.store.get(room_id)
            resume = self.stopping and state["enabled"]
            state.update(enabled=resume, admission=None, participantId=None)
            if state["status"] != "error":
                state["status"] = "disabled"
            self.store.save(state)

    async def watch(self, room_id: str, admission: dict, room: rtc.Room):
        while True:
            await asyncio.sleep(5)
            try:
                snapshot = await self.core.request(
                    "GET",
                    f"/api/v1/rooms/{room_id}",
                    credential=admission["credential"],
                )
                member = next(
                    (
                        p
                        for p in snapshot["participants"]
                        if p["id"] == admission["participantId"]
                    ),
                    None,
                )
                if snapshot.get("closedAt") or not member:
                    state = self.store.get(room_id)
                    state["enabled"] = False
                    self.store.save(state)
                    return
                humans = [
                    p
                    for p in snapshot["participants"]
                    if p["id"] != admission["participantId"]
                    and not p.get("service")
                    and p["status"] != "WAITING"
                ]
                if member["status"] in ("JOINING", "RECOVERING") and room.isconnected():
                    await self.core.request(
                        "POST",
                        f"/api/v1/rooms/{room_id}/commands",
                        {
                            "commandId": str(uuid.uuid4()),
                            "type": "media.restored",
                            "generation": member["generation"],
                        },
                        admission["credential"],
                    )
                state = self.store.get(room_id)
                if humans:
                    state["lastHumanAt"] = now()
                elif now() - state["lastHumanAt"] >= 60000:
                    state["enabled"] = False
                self.store.save(state, changed=False)
            except HTTPException as error:
                if error.status_code in (403, 404, 410):
                    state = self.store.get(room_id)
                    state["enabled"] = False
                    self.store.save(state)
                    return
                # HTTP recovery must not interrupt an otherwise working audio stream.

    async def failed_track(self, room_id: str, track_id: str, message: str):
        async with self.locks[room_id]:
            state = self.store.get(room_id)
            if state["queue"] and state["queue"][0]["id"] == track_id:
                state["queue"].pop(0)
                state.update(position=0.0, epoch=state["epoch"] + 1, error=message)
                self.store.save(state)

    async def resume(self, room_id: str):
        state = self.store.get(room_id)
        if state["admission"]:
            self.start(room_id)
            return
        state["enabled"] = False
        self.store.save(state)
        try:
            await self.enable(room_id, str(uuid.uuid4()))
        except HTTPException:
            state = self.store.get(room_id)
            state.update(
                enabled=False,
                status="error",
                error="Не удалось восстановить музыкальный сервис. Добавьте его во встречу ещё раз.",
            )
            self.store.save(state)

    async def close(self):
        self.stopping = True
        tasks = list(self.tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
