"""
Замер R172 «после ivi другая интеграция грузится долго»: что держит служба, когда ivi не отвечает.

Комната открывает два фильма ivi подряд (площадка молчит: плеерное API — «чёрная дыра», у старого кода
yt-dlp висит на чтении, как с `socket_timeout` 20 с и запасным заходом — 40 с), через 2 с человек
переключается на музыку: поиск YouTube той же комнатой — по полосе комнаты и в общем пуле yt-dlp, как
`sources.py`. Меряем: чем ответил поиск и за сколько, сколько потоков пула и полос занято через 2 с и
через 35 с. Код — до (origin/main) или после (R172): какой смонтирован в /app/cord_services.

Из корня репозитория (`до` — `git archive <коммит> services/cord_services | tar -x -C <каталог>`):

    docker run --rm --network none --entrypoint python \
      -v "$PWD/services/cord_services:/app/cord_services:ro" \
      -v "$PWD/services/bench/switch_after_hang.py:/bench.py:ro" -e PYTHONPATH=/app -w /app \
      modern-streaming-services /bench.py после
"""

import asyncio
import json
import sys
import time
from unittest.mock import patch

import httpx

from cord_services.cinema import Cinema, Resolve
from cord_services.cinema.resolve import YtDlp

ROOM = "11111111-1111-4111-8111-111111111111"
HANG = 40.0
INFO = {
    "id": 0,
    "title": "Фильм",
    "object_type": "video",
    "content_paid_types": ["AVOD"],
    "duration": 5400,
    "posters": [],
}


async def serve(request: httpx.Request) -> httpx.Response:
    if request.url.path.endswith("/geocheck/whoami/v6/"):
        return httpx.Response(200, json={"result": {"country_code": "RU"}})
    if request.url.path.endswith("/videoinfo/v7/"):
        return httpx.Response(200, json={"result": {**INFO, "id": int(request.url.params["id"])}})
    if request.url.path.endswith("/categories/v7/"):
        return httpx.Response(200, json={"result": []})
    # Плеерное API ivi (`/light/`) — молчит.
    await asyncio.sleep(3600)
    return httpx.Response(504)


def hanging_extract(*args, **kwargs):
    time.sleep(HANG)
    raise OSError("timed out")


async def main() -> None:
    cinema = Cinema("secret", httpx.AsyncClient(transport=httpx.MockTransport(serve)))
    youtube = cinema.registry.get("youtube")
    started = time.monotonic()

    def at() -> float:
        return round(time.monotonic() - started, 2)

    async def open_film(item: str) -> str:
        try:
            await cinema.resolve(Resolve(provider="ivi", contentId=item, kind="video"), room=ROOM)
            return "открылся"
        except Exception as error:  # noqa: BLE001
            detail = getattr(error, "detail", type(error).__name__)
            return f"{getattr(error, 'status_code', '?')} {detail}"[:80]

    async def music_search() -> tuple[str, float]:
        begun = time.monotonic()

        async def work():
            return await cinema.ytdlp.offload_for("youtube", time.sleep, 1.0)

        try:
            await cinema.reach.call(youtube, work, 25.0, room=ROOM)
            outcome = "ответил"
        except Exception as error:  # noqa: BLE001
            outcome = f"{getattr(error, 'status_code', '?')} {getattr(error, 'code', '')}".strip()
        return outcome, round(time.monotonic() - begun, 2)

    with patch.object(YtDlp, "extract", side_effect=hanging_extract):
        films = [asyncio.ensure_future(open_film("1001"))]
        await asyncio.sleep(0.5)
        films.append(asyncio.ensure_future(open_film("1002")))
        await asyncio.sleep(1.5)
        load_2s = {"pool": sum(cinema.ytdlp.busy.values()), "lanes": cinema.reach.lanes.busy}
        outcome, waited = await music_search()
        films_done = await asyncio.gather(*films)
        await asyncio.sleep(max(0.0, 35.0 - (time.monotonic() - started)))
        load_35s = {"pool": sum(cinema.ytdlp.busy.values()), "lanes": cinema.reach.lanes.busy}
        print(
            json.dumps(
                {
                    "code": sys.argv[1],
                    "load_at_2s": load_2s,
                    "music_search_at_2s": {"outcome": outcome, "seconds": waited},
                    "ivi_films": films_done,
                    "films_answered_at": at(),
                    "load_at_35s": load_35s,
                },
                ensure_ascii=False,
            )
        )
    cinema.ytdlp.pool.shutdown(wait=False, cancel_futures=True)
    await cinema.net.close()


asyncio.run(main())
