"""Мост к издателю музыки: отдельный процесс на комнату, один общий стереотрек.

ЗАЧЕМ. Клиент LiveKit для Python не умеет объявлять стереодорожку — в его
`TrackPublishOptions` такого поля нет, и сервер договаривается об одном канале, каким бы
ни был источник. Комната слышала сведённую в моно музыку. Поле есть только в Go-SDK,
поэтому звук отдаёт отдельная маленькая программа (`services/publisher`), а очередь,
права, места в комнате и сроки хранения остаются здесь.

Протокол простой и построчный: команды JSON в stdin, события JSON из stdout. Токен уходит
первой строкой, а не аргументом командной строки: аргументы видны всей машине в `ps`.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os

BINARY = os.environ.get("CORD_PUBLISHER", "/usr/local/bin/cord-publisher")


class Publisher:
    def __init__(self, process: asyncio.subprocess.Process):
        self.process = process
        self.connected = True

    @classmethod
    async def start(cls, url: str, token: str, name: str = "Музыка") -> Publisher:
        process = await asyncio.create_subprocess_exec(
            BINARY,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            limit=65536,
        )
        publisher = cls(process)
        try:
            await publisher.send(
                {"cmd": "connect", "url": url, "token": token, "name": name}
            )
            event = await publisher.event(20)
        except Exception:
            await publisher.close()
            raise
        if not event or event.get("event") != "ready":
            message = (event or {}).get("message") or "Издатель музыки не запустился"
            await publisher.close()
            raise ConnectionError(message)
        return publisher

    async def send(self, command: dict):
        stdin = self.process.stdin
        if stdin is None or stdin.is_closing():
            self.connected = False
            raise ConnectionError("Издатель музыки больше не принимает команды")
        stdin.write((json.dumps(command, ensure_ascii=False) + "\n").encode())
        await stdin.drain()

    async def play(self, path: str, position: float, epoch: int):
        await self.send(
            {
                "cmd": "play",
                "path": path,
                "position": max(0.0, position),
                "epoch": epoch,
            }
        )

    async def pause(self):
        await self.send({"cmd": "pause"})

    async def event(self, timeout: float) -> dict | None:
        """Следующее событие, либо None, если за это время ничего не произошло."""
        assert self.process.stdout is not None
        try:
            line = await asyncio.wait_for(self.process.stdout.readline(), timeout)
        except TimeoutError:
            return None
        except (asyncio.LimitOverrunError, ValueError):
            return None
        if not line:
            self.connected = False
            return {"event": "closed", "message": "Издатель музыки завершился"}
        try:
            value = json.loads(line)
        except ValueError:
            return None
        if not isinstance(value, dict):
            return None
        if value.get("event") == "closed":
            self.connected = False
        return value

    async def close(self):
        self.connected = False
        if self.process.returncode is None:
            with contextlib.suppress(Exception):
                self.process.stdin.write(b'{"cmd":"quit"}\n')
                await self.process.stdin.drain()
                self.process.stdin.close()
            try:
                await asyncio.wait_for(self.process.wait(), 3)
            except TimeoutError:
                with contextlib.suppress(ProcessLookupError):
                    self.process.kill()
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(self.process.wait(), 3)
