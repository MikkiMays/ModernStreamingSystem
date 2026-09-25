"""
Первый процесс контейнера: ключ службы — из `INTERNAL_SECRET`, а сам секрет из контейнера уходит.

ЗАЧЕМ. `INTERNAL_SECRET` — ключ всей установки: им подписаны адреса прокси кинозала, им ядро узнаёт шлюз,
от него ключ сейфа Яндекс Музыки. Здесь же исполняется код чужих страниц, и браузер в контейнере без своей
песочницы (`page.py`): секрету здесь не место. Поэтому этот процесс считает из секрета ключ только для
входа в плеер страниц (`key_for` — та же формула, что у службы в `cord_services/cinema/sniffer.py`) и
заменяет себя (`execve`) на tini с коротким окружением, где секрета нет: после `execve` его нет ни в
памяти процессов контейнера, ни в `/proc/1/environ`. Поэтому в compose у контейнера нет `init: true` —
tini запускается отсюда.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import sys

# Что переживает замену: пути и язык, настройки Python и Playwright, выход наружу площадки «По ссылке».
KEEP = frozenset(
    {
        "PATH",
        "LANG",
        "LC_ALL",
        "TZ",
        "HOME",
        "XDG_CACHE_HOME",
        "XDG_CONFIG_HOME",
        "PYTHONDONTWRITEBYTECODE",
        "PYTHONUNBUFFERED",
        "PLAYWRIGHT_BROWSERS_PATH",
        "CINEMA_PROXY",
        "CINEMA_PROXY_LINK",
        "CINEMA_PRIVATE_HOSTS_LINK",
    }
)
TINI = "/usr/bin/tini"


def key_for(secret: str) -> str:
    """Ключ входа службы в плеер страниц: HMAC-SHA256 от секрета установки с меткой назначения."""
    return hmac.new(secret.encode(), b"cord-cinema-sniffer", hashlib.sha256).hexdigest()


def environment(source: dict[str, str]) -> dict[str, str]:
    """Окружение сервера: только нужное — и ключ вместо секрета."""
    secret = source.get("INTERNAL_SECRET", "")
    kept = {name: value for name, value in source.items() if name in KEEP}
    kept["CINEMA_SNIFFER_KEY"] = key_for(secret) if secret else ""
    return kept


def main() -> None:
    os.execve(TINI, [TINI, "--", sys.executable, "-m", "sniffer"], environment(dict(os.environ)))


if __name__ == "__main__":
    main()
