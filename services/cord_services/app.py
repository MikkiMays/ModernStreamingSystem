from __future__ import annotations

import asyncio
import logging
import os
import re
import secrets
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal
from urllib.parse import unquote

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from . import covers
from .cinema import Cinema
from .cinema import routes as cinema_routes
from .cinema.net import NetConfig
from .cinema.sniffer import Sniffer, key_for
from .core import Core
from .media import MAX_FILE, probe
from .music import Music
from .sources import PLATFORMS, Sources
from .store import Store, now
from .yandex import Yandex, routes

# Источники музыки по порядку, в котором их видит человек. `MUSIC_SOURCES` — включённые через
# запятую, пусто — все. YouTube и SoundCloud выключаются здесь одной строкой (E06-B, T18).
MUSIC_SOURCES = ("upload", "telegram", "yandex", "youtube", "soundcloud")


def music_sources(value: str | None) -> list[str]:
    wanted = {part.strip().lower() for part in (value or "").split(",") if part.strip()}
    return [source for source in MUSIC_SOURCES if not wanted or source in wanted]


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
        "move",
    ]
    trackId: str | None = Field(default=None, max_length=36)
    position: float | None = Field(default=None, ge=0, le=3600, allow_inf_nan=False)
    enabled: bool | None = None
    # Куда встаёт трек у `move`: первое место — играющий, поэтому не меньше единицы.
    index: int | None = Field(default=None, ge=1, le=99)


class Operation(BaseModel):
    commandId: uuid.UUID


class MusicSearch(BaseModel):
    source: Literal["youtube", "soundcloud"]
    query: str = Field(min_length=1, max_length=300)


class MusicLink(BaseModel):
    url: str = Field(min_length=1, max_length=2000)
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
    # Плеер страниц — контейнер `sniffer` (`CINEMA_SNIFFER_URL`, у compose — 127.0.0.1:18103); ключ входа в
    # него — из внутреннего секрета, сам секрет туда не уходит (`cinema/sniffer.py`).
    sniffer_url = os.environ.get("CINEMA_SNIFFER_URL", "").strip()
    cinema = Cinema(
        core.secret,
        enabled=os.environ.get("CINEMA_PROVIDERS"),
        net=NetConfig.from_env(os.environ),
        # Номера ссылок «По ссылке» переживают перезапуск: комната, открывшая фильм по ссылке,
        # досматривает его и после выкатки.
        links=store.links,
        sniffer=Sniffer(sniffer_url, key_for(core.secret)) if sniffer_url and core.secret else None,
    )
    sources_on = music_sources(os.environ.get("MUSIC_SOURCES"))
    sources = Sources(
        cinema.ytdlp,
        store,
        music,
        [source for source in sources_on if source in PLATFORMS],
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
                # Одна неудачная уборка не должна останавливать все следующие: без них не
                # истекают сроки треков и не уходят осиротевшие файлы до перезапуска службы.
                try:
                    store.cleanup()
                except Exception:
                    logging.getLogger(__name__).exception("Уборка хранилища музыки не удалась")

        background.append(asyncio.create_task(clean(), name="cleanup"))
        yield
        for task in background:
            task.cancel()
        await asyncio.gather(*background, return_exceptions=True)
        await music.close()
        sources.close()
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
    app.state.sources = sources
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
        # браузера, иначе отмотка назад скачивает уже скачанное — и с нашего же канала. Обложка
        # трека под своим именем не меняется никогда — её кэш задаёт маршрут обложек.
        if not request.url.path.startswith(
            ("/api/v1/services/cinema/", "/api/v1/services/music/covers/")
        ):
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
            "sources": sources_on,
            "maxFileBytes": MAX_FILE,
        }

    @app.get("/api/v1/services/rooms/{room_id}/music")
    async def state(room_id: str, authorization: str = Header()):
        await core.member(room_id, authorization, action="music.view")
        return store.public(room_id)

    @app.post("/api/v1/services/rooms/{room_id}/music/enable")
    async def enable(room_id: str, operation: Operation, authorization: str = Header()):
        room, _ = await core.member(room_id, authorization, action="music.enable")
        # Активная интеграция в комнате одна. Ядро скажет то же самое при создании места для
        # бота, но здесь отказ приходит раньше — до того, как человек дождётся подключения.
        if room.get("watch"):
            raise HTTPException(409, "Во встрече открыт кинозал. Сначала закройте его")
        return await music.enable(room_id, str(operation.commandId))

    @app.delete("/api/v1/services/rooms/{room_id}/music")
    async def disable(room_id: str, authorization: str = Header()):
        # Убрать — то же право, что добавить (T14): раньше сюда пускали только создателя, и бота,
        # которого включил гость, до прихода создателя не мог убрать никто.
        await core.member(room_id, authorization, action="music.remove")
        return await music.disable(room_id)

    @app.post("/api/v1/services/rooms/{room_id}/music/commands")
    async def command(room_id: str, command: Command, authorization: str = Header()):
        await core.member(room_id, authorization, action="music.control")
        return await music.command(room_id, command.model_dump(mode="json"))

    @app.put("/api/v1/services/rooms/{room_id}/music/upload/{command_id}")
    async def upload(
        room_id: str,
        command_id: uuid.UUID,
        request: Request,
        authorization: str = Header(),
        x_filename: str = Header(default="Аудиофайл"),
    ):
        _, member = await core.member(room_id, authorization, action="music.upload")
        scope = "upload:" + room_id + ":" + member["id"]
        async with music.locks[scope + ":" + str(command_id)]:
            if store.receipt(scope, str(command_id)):
                return store.public(room_id)
            music.check_quota(room_id, int(request.headers.get("content-length", 0)))
            track_id = str(uuid.uuid4())
            path = store.files / track_id
            cover = None
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
                cover = await covers.extract(path, store.files)
                track = {
                    "id": track_id,
                    "file": track_id,
                    **metadata,
                    "title": metadata["title"] or Path(unquote(x_filename)).name[:180],
                    "addedBy": member["name"],
                    "source": "upload",
                    "createdAt": now(),
                    "cover": cover,
                }
                result = await music.enqueue(room_id, track)
                store.remember(scope, str(command_id), {"trackId": track_id})
                return result
            except BaseException:
                path.unlink(missing_ok=True)
                if cover:
                    (store.files / cover).unlink(missing_ok=True)
                raise

    @app.post("/api/v1/services/rooms/{room_id}/music/search")
    async def search(room_id: str, value: MusicSearch, authorization: str = Header()):
        await core.member(room_id, authorization, action="music.search")
        return await sources.search(room_id, value.source, value.query)

    @app.post("/api/v1/services/rooms/{room_id}/music/link")
    async def add_link(room_id: str, value: MusicLink, authorization: str = Header()):
        _, member = await core.member(room_id, authorization, action="music.link")
        return await sources.enqueue(
            room_id, value.url, str(value.commandId), member["name"]
        )

    @app.get("/api/v1/services/music/covers/{name}")
    async def cover(name: str):
        # Без заголовка входа: `<img>` его не пошлёт, а CSP пускает картинки только со своего
        # адреса. Имя — новый UUID, не выводится из трека; отдаётся только обложка, которую держит
        # чья-то очередь, — звук и прочие файлы хранилища этим путём не достать.
        if not re.fullmatch(covers.NAME, name) or name not in store.referenced():
            raise HTTPException(404, "Обложки нет")
        path = store.files / name
        if not path.is_file():
            raise HTTPException(404, "Обложки нет")
        return FileResponse(
            path,
            media_type="image/jpeg",
            headers={"Cache-Control": "private, max-age=86400, immutable"},
        )

    @app.post("/api/v1/services/rooms/{room_id}/telegram/link")
    async def link(room_id: str, authorization: str = Header()):
        # Привязка открывает беседе встречу — решение создателя, флаг здесь не участвует (T30).
        room, member = await core.member(room_id, authorization, action="telegram.link")
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
