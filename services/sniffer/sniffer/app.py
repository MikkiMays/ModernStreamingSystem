"""
Вход в плеер страниц: `POST /sniff {url, room}` от службы кинозала — и больше ни от кого.

КЛЮЧ. Служба и этот контейнер знают один ключ: HMAC от `INTERNAL_SECRET` (`entry.py` считает его при
старте, а самого секрета в контейнере после этого нет). Порт опубликован только на `127.0.0.1` хоста, но его
видит любой процесс машины — поэтому без ключа 401, и ключ проверяется раньше, чем читается тело запроса:
чужой не заставит сервер разбирать что бы то ни было. Тело — не больше `BODY` байт.

ИЗОЛЯЦИЯ. Самопроверка (`isolation.py`) дотянулась туда, куда нельзя, — `/sniff` отвечает 503 «изоляция не
настроена» с заголовком `X-Cord-Isolation: broken`, и страница не открывается; служба тогда отвечает то, что
сказал yt-dlp. `/isolation` — то же состояние для выкатки руками (без ключа: оно никому ничего не открывает).

СКОЛЬКО РАЗОМ. Страница у комнаты одна: новая страница той же комнаты сменяет прежнюю (её разбор
отменяется, запрос получает 409) — как у службы, где новая ссылка сменяет прежнюю. На весь контейнер — не
больше `PAGES` страниц разом (место в выходе), следующая ждёт места не дольше `WAIT`, потом 503. Служба
ушла, не дождавшись ответа, — страница закрывается сразу, а не досматривается до срока.
"""

from __future__ import annotations

import asyncio
import contextlib
import hmac
import logging
from typing import Any, Awaitable, Callable
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, ValidationError

from cord_services.cinema import address
from cord_services.cinema.egress import Busy

from . import capture
from .isolation import BROKEN, Isolation

logger = logging.getLogger(__name__)

# Как часто спрашивать, не ушла ли служба, пока страница открыта.
LISTEN = 0.5
# Больше запрос службы не бывает: адрес до двух тысяч знаков и номер очереди.
BODY = 8 * 1024
# Заголовок, по которому служба отличает «изоляции нет» от «занято».
ISOLATION = "X-Cord-Isolation"

Sniff = Callable[[str], Awaitable[dict[str, Any]]]


class Order(BaseModel):
    url: str = Field(min_length=1, max_length=capture.LONGEST_URL)
    # Номер комнаты в том виде, в каком его знает служба (у нас — только ключ очереди).
    room: str = Field(default="", max_length=64, pattern=r"^[A-Za-z0-9_-]*$")


def create_app(
    key: str,
    sniff: Sniff,
    *,
    isolation: Isolation | None = None,
    close: Callable[[], Awaitable[None]] | None = None,
) -> FastAPI:
    if not key:
        logger.warning("плеер страниц: ключа службы нет (INTERNAL_SECRET не задан) — на /sniff только 401")
    expected = f"Bearer {key}".encode()
    rooms: dict[str, asyncio.Future[dict[str, Any]]] = {}

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI):
        watching = asyncio.ensure_future(isolation.watch()) if isolation is not None else None
        yield
        if watching is not None:
            watching.cancel()
        for task in list(rooms.values()):
            task.cancel()
        if close is not None:
            await close()

    app = FastAPI(
        title="Cord page player", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan
    )

    @app.get("/health")
    async def health() -> dict[str, Any]:
        # Жив ли процесс; изоляция — отдельно (`/isolation`): её отказ не повод перезапускать контейнер.
        return {"status": "UP", "isolated": None if isolation is None else isolation.isolated}

    @app.get("/isolation")
    async def isolated():
        if isolation is None:
            return {"isolated": None}
        if not await isolation.ready():
            return JSONResponse({"detail": BROKEN, **isolation.state()}, 503, headers={ISOLATION: "broken"})
        return isolation.state()

    @app.post("/sniff")
    async def sniffed(request: Request):
        authorization = request.headers.get("authorization", "")
        if not key or not hmac.compare_digest(authorization.encode("utf-8", "replace"), expected):
            raise HTTPException(401, "Нужен ключ службы")
        if isolation is not None and not await isolation.ready():
            raise HTTPException(503, BROKEN, headers={ISOLATION: "broken"})
        order = await _order(request)
        url = order.url.strip()
        # Та же строгость, что у ссылки кинозала: http(s), хост, без входа и без контрабанды yt-dlp.
        if not address.web(url):
            raise HTTPException(400, "Это не ссылка на страницу")
        task = asyncio.ensure_future(sniff(url))
        previous = rooms.get(order.room) if order.room else None
        if previous is not None:
            previous.cancel()
        if order.room:
            rooms[order.room] = task
        try:
            found = await _until_done(task, request)
            _note(url, found)
            return found
        except asyncio.CancelledError:
            current = asyncio.current_task()
            if task.cancelled() and not (current is not None and current.cancelling()):
                raise HTTPException(409, "Эту страницу сменила следующая") from None
            raise
        except Busy:
            raise HTTPException(503, "Плеер страниц занят — попробуйте через минуту") from None
        finally:
            if order.room and rooms.get(order.room) is task:
                del rooms[order.room]
            if not task.done():
                task.cancel()

    return app


async def _order(request: Request) -> Order:
    """Тело запроса — не больше `BODY` байт (по объявленной длине и по прочитанному), разобранное схемой."""
    length = request.headers.get("content-length", "")
    if length and (not length.isdigit() or int(length) > BODY):
        raise HTTPException(413, "Запрос больше предела")
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > BODY:
            raise HTTPException(413, "Запрос больше предела")
    try:
        return Order.model_validate_json(bytes(body))
    except ValidationError:
        raise HTTPException(422, "Непонятный запрос") from None


def _note(url: str, found: dict[str, Any]) -> None:
    """Строка в журнал: сайт (без пути и ключей в адресе), что нашлось и за сколько. Cookies — никогда."""
    kinds = ",".join(str(stream.get("type")) for stream in found.get("streams") or []) or "—"
    flags = [name for name in ("drm", "robot", "login", "inside") if found.get(name)]
    logger.info(
        "плеер страниц: %s — потоки %s%s, %s с",
        (urlsplit(url).hostname or "?"),
        kinds,
        f", {' '.join(flags)}" if flags else "",
        found.get("seconds"),
    )


async def _until_done(task: asyncio.Future[dict[str, Any]], request: Request) -> dict[str, Any]:
    """Ответ страницы — или её отмена, как только служба оборвала запрос."""
    while True:
        done, _ = await asyncio.wait({task}, timeout=LISTEN)
        if done:
            return task.result()
        if await request.is_disconnected():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
            raise asyncio.CancelledError()
