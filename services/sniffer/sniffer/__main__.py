"""
Сервер плеера страниц: охраняемый выход, браузер, самопроверка изоляции и вход для службы — на порту 8080
контейнера.

Порт опубликован в compose только на `127.0.0.1:18103` хоста (у стенда разработчика — `18113`). Выход
наружу — площадки «По ссылке»: её прокси администратора (`CINEMA_PROXY_LINK` или общий `CINEMA_PROXY` —
чтобы страница и поток выходили в сеть с одного адреса: адрес потока у CDN бывает привязан к адресу, с
которого его выдали) и её частные адреса (`CINEMA_PRIVATE_HOSTS_LINK`; в этом контейнере `127.0.0.1` — он
сам, а не машина). Цели самопроверки — `CINEMA_SNIFFER_CANARIES`, метки стены хоста — `/run/cord-sniffer`
(`isolation.py`).
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

import uvicorn

from cord_services.cinema.egress import Egress
from cord_services.cinema.net import Guard, NetConfig

from .app import create_app
from .isolation import CANARIES, WALLS, Isolation, gateway, targets
from .page import SECONDS, TEARDOWN, Pages

# Страниц разом на контейнер — и мест в выходе. Каждая — вкладка Chromium, сотни мегабайт.
PAGES = 2
# Сколько ждать места для страницы; дольше служба ждать не станет.
WAIT = 10.0
# Соединений у одной страницы и всего: браузер держит по шесть на хост, а хостов у страницы десятки.
PER_PAGE = 96
TUNNELS = PAGES * PER_PAGE
PENDING = 64
# Байт от сайтов на одну страницу: страница с плеером — мегабайты, и ещё столько же первых кусочков.
BUDGET = 96 * 1024 * 1024
PORT = 8080


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    # Ключ — в память процесса, а из `os.environ` — вон: его наследовали бы драйвер Playwright и браузер. В
    # `/proc/<pid>/environ` этого процесса и tini он остаётся — их окружение при запуске, — и там его прочтёт
    # любой процесс того же пользователя, браузер тоже. Этим ключом открывается только сам плеер страниц.
    key = os.environ.pop("CINEMA_SNIFFER_KEY", "")
    config = NetConfig.from_env(os.environ)
    egress = Egress(
        Guard(config.private_for("link")),
        upstream=config.proxy_for("link"),
        sessions=PAGES,
        wait=WAIT,
        tunnels=TUNNELS,
        per_lease=PER_PAGE,
        pending=PENDING,
        budget=BUDGET,
    )
    egress.seconds = SECONDS + TEARDOWN
    pages = Pages(egress)

    async def close() -> None:
        await pages.close()
        await egress.close()

    isolation = Isolation(
        targets(os.environ.get("CINEMA_SNIFFER_CANARIES") or CANARIES, gateway()), walls=Path(WALLS)
    )
    app = create_app(key, pages.sniff, isolation=isolation, close=close)
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="warning", access_log=False)


if __name__ == "__main__":
    main()
