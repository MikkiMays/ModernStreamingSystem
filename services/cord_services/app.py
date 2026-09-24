from __future__ import annotations

import asyncio
import logging
import os
import secrets
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal
from urllib.parse import unquote

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .cinema import Cinema
from .cinema import routes as cinema_routes
from .cinema.net import NetConfig
from .core import Core
from .media import MAX_FILE, probe
from .music import Music
from .store import Store, now
from .yandex import Yandex, routes


class Command(BaseModel):
    commandId: uuid.UUID
    action: Literal[
        "pause",
        "play",
        "skip",
        "stop",
        "clear",
        "repeat",
        "shuffle",
        "seek",
        "remove",
        "next",
    ]
    trackId: str | None = Field(default=None, max_length=36)
    position: float | None = Field(default=None, ge=0, le=3600, allow_inf_nan=False)
    enabled: bool | None = None


class Operation(BaseModel):
    commandId: uuid.UUID


class Claim(BaseModel):
    token: str = Field(min_length=20, max_length=100)
    name: str = Field(default="", max_length=40)
    commandId: uuid.UUID | None = None


def create_app(
    root: Path | None = None, core: Core | None = None, *, telegram_enabled: bool = True
):
    store = Store(root or Path(os.environ.get("CORD_SERVICES_ROOT", "/data")))
    core = core or Core(
        os.environ.get("CORD_CORE_URL", "http://127.0.0.1:8080"),
        os.environ.get("INTERNAL_SECRET", ""),
    )
    music = Music(
        store, core, os.environ.get("LIVEKIT_INTERNAL_URL", "http://127.0.0.1:7880")
    )
    public_url = os.environ.get("PUBLIC_URL", "https://meet.nikg.tech").rstrip("/")
    yandex = Yandex(store, music, core.secret)
    # Какие площадки кинозала включены на этой установке: имена через запятую, пусто — все.
    # Выход наружу — CINEMA_PROXY, CINEMA_PROXY_<ID>, CINEMA_COOKIES_<ID> и
    # CINEMA_PRIVATE_HOSTS — читается здесь же и один раз (`cinema/net.py`).
    cinema = Cinema(
        core.secret,
        enabled=os.environ.get("CINEMA_PROVIDERS"),
        net=NetConfig.from_env(os.environ),
        # Номера ссылок «По ссылке» переживают перезапуск: комната, открывшая фильм по ссылке,
        # досматривает его и после выкатки.
        links=store.links,
    )
    telegram = None
    background = []

    @asynccontextmanager
    async def lifespan(app):
        nonlocal telegram
        logging.getLogger("httpx").setLevel(logging.WARNING)
        logging.getLogger("httpcore").setLevel(logging.WARNING)
        for room in store.rooms():
            if room["enabled"]:
                background.append(asyncio.create_task(music.resume(room["roomId"])))
        if telegram_enabled and os.environ.get("CORD_MEET_TELEGRAM_BOT_TOKEN"):
            from .telegram import Telegram

            telegram = Telegram(
                os.environ["CORD_MEET_TELEGRAM_BOT_TOKEN"],
                store,
                core,
                music,
                public_url,
                yandex=yandex,
            )
            background.append(asyncio.create_task(telegram.run(), name="telegram"))

        async def clean():
            while True:
                await asyncio.sleep(300)
                store.cleanup()

        background.append(asyncio.create_task(clean(), name="cleanup"))
        yield
        for task in background:
            task.cancel()
        await asyncio.gather(*background, return_exceptions=True)
        await music.close()
        if telegram:
            await telegram.client.aclose()
        await yandex.http.aclose()
        await cinema.close()
        await core.client.aclose()
        store.db.close()

    app = FastAPI(
        title="Cord services",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    app.state.store, app.state.core, app.state.music = store, core, music
    app.state.yandex = yandex
    app.state.cinema = cinema
    app.include_router(routes(yandex, core))
    app.include_router(cinema_routes(cinema, core))

    @app.middleware("http")
    async def boundary(request: Request, call_next):
        origin = request.headers.get("origin")
        if origin and origin != public_url:
            return JSONResponse(
                {"detail": "Источник запроса не разрешён"}, status_code=403
            )
        length = request.headers.get("content-length", "0")
        if not length.isdigit() or int(length) > MAX_FILE:
            return JSONResponse(
                {"detail": "Максимальный размер аудиофайла — 50 МБ"}, status_code=413
            )
        response = await call_next(request)
        # Кинозал отвечает за свои заголовки сам: сегменты видео должны лежать в кэше
        # браузера, иначе отмотка назад скачивает уже скачанное — и с нашего же канала.
        if not request.url.path.startswith("/api/v1/services/cinema/"):
            response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.get("/health")
    async def health():
        return {"status": "UP"}

    @app.get("/api/v1/services/catalog")
    async def catalog():
        return {
            "services": [
                {
                    "id": "music",
                    "name": "Музыка",
                    "description": "Общая очередь и музыка во встрече",
                }
            ],
            "telegram": {
                "username": store.state("bot_username") or None,
                "connected": bool(
                    telegram
                    and telegram.ready
                    and store.state("bot_status") == "polling"
                ),
            },
            "sources": ["upload", "telegram", "yandex"],
            "maxFileBytes": MAX_FILE,
        }

    @app.get("/api/v1/services/rooms/{room_id}/music")
    async def state(room_id: str, authorization: str = Header()):
        await core.member(room_id, authorization)
        return store.public(room_id)

    @app.post("/api/v1/services/rooms/{room_id}/music/enable")
    async def enable(room_id: str, operation: Operation, authorization: str = Header()):
        room, _ = await core.member(room_id, authorization, integration=True)
        # Активная интеграция в комнате одна. Ядро скажет то же самое при создании места для
        # бота, но здесь отказ приходит раньше — до того, как человек дождётся подключения.
        if room.get("watch"):
            raise HTTPException(409, "Во встрече открыт кинозал. Сначала закройте его")
        return await music.enable(room_id, str(operation.commandId))

    @app.delete("/api/v1/services/rooms/{room_id}/music")
    async def disable(room_id: str, authorization: str = Header()):
        await core.member(room_id, authorization, owner=True)
        return await music.disable(room_id)

    @app.post("/api/v1/services/rooms/{room_id}/music/commands")
    async def command(room_id: str, command: Command, authorization: str = Header()):
        await core.member(room_id, authorization, integration=True)
        return await music.command(room_id, command.model_dump(mode="json"))

    @app.put("/api/v1/services/rooms/{room_id}/music/upload/{command_id}")
    async def upload(
        room_id: str,
        command_id: uuid.UUID,
        request: Request,
        authorization: str = Header(),
        x_filename: str = Header(default="Аудиофайл"),
    ):
        _, member = await core.member(room_id, authorization, integration=True)
        scope = "upload:" + room_id + ":" + member["id"]
        async with music.locks[scope + ":" + str(command_id)]:
            if store.receipt(scope, str(command_id)):
                return store.public(room_id)
            music.check_quota(room_id, int(request.headers.get("content-length", 0)))
            track_id = str(uuid.uuid4())
            path = store.files / track_id
            total = 0
            try:
                with path.open("xb") as output:
                    async for chunk in request.stream():
                        total += len(chunk)
                        if total > MAX_FILE:
                            raise HTTPException(
                                413, "Максимальный размер аудиофайла — 50 МБ"
                            )
                        output.write(chunk)
                if total == 0:
                    raise HTTPException(400, "Файл пуст")
                metadata = await probe(path)
                track = {
                    "id": track_id,
                    "file": track_id,
                    **metadata,
                    "title": metadata["title"] or Path(unquote(x_filename)).name[:180],
                    "addedBy": member["name"],
                    "source": "upload",
                    "createdAt": now(),
                }
                result = await music.enqueue(room_id, track)
                store.remember(scope, str(command_id), {"trackId": track_id})
                return result
            except BaseException:
                path.unlink(missing_ok=True)
                raise

    @app.post("/api/v1/services/rooms/{room_id}/telegram/link")
    async def link(room_id: str, authorization: str = Header()):
        room, member = await core.member(room_id, authorization, owner=True)
        if not store.state("bot_username"):
            raise HTTPException(503, "Telegram-бот ещё не подключён")
        profile = store.state("room-profile:" + room_id)
        if not profile:
            profile = secrets.token_urlsafe(32)
            store.set_state("room-profile:" + room_id, profile)
        await core.request(
            "PUT",
            f"/api/v1/favorites/{room_id}",
            {"roomCredential": authorization.removeprefix("Bearer ")},
            profile,
        )
        token = secrets.token_urlsafe(18)
        store.put_claim(
            token,
            {
                "kind": "bind",
                "roomId": room_id,
                "profile": profile,
                "title": room["title"],
                "ownerName": member["name"],
            },
        )
        return {
            "command": "/bind@" + store.state("bot_username") + " " + token,
            "expiresAt": now() + 900000,
        }

    @app.post("/api/v1/services/claims/preview")
    async def preview(claim: Claim):
        value = store.claim(claim.token)
        if not value or value["kind"] != "web-host":
            raise HTTPException(
                410, "Ссылка организатора истекла. Запросите новую у бота"
            )
        return {
            "roomId": value["roomId"],
            "title": value["title"],
            "name": value.get("ownerName", ""),
        }

    @app.post("/api/v1/services/claims/redeem")
    async def redeem(claim: Claim):
        if not claim.commandId or not claim.name.strip():
            raise HTTPException(400, "Укажите имя")
        async with music.locks["claim:" + claim.token]:
            scope = "claim:" + claim.token
            prior = store.receipt(scope, str(claim.commandId))
            if prior:
                return prior
            value = store.claim(claim.token)
            if not value or value["kind"] != "web-host":
                raise HTTPException(
                    410, "Ссылка организатора уже использована или истекла"
                )
            admission = await core.request(
                "POST",
                f"/api/v1/favorites/{value['roomId']}/join",
                {"name": claim.name.strip(), "commandId": str(claim.commandId)},
                value["profile"],
            )
            invite = await core.request(
                "POST", f"/internal/services/{value['roomId']}/invite"
            )
            admission["inviteUrl"] = invite["url"]
            store.remember(scope, str(claim.commandId), admission)
            store.delete_claim(claim.token)
            return admission

    return app
