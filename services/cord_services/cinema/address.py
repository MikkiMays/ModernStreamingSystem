"""
Ссылка, вставленная в кинозал, — разбор адреса без единого запроса наружу.

Какой площадке принадлежит ссылка и что она открывает, решает сама площадка (`Provider.match`):
у каждой своя грамматика адресов и своя форма номеров. Общее здесь — только разбор самого адреса,
одинаково строгий для всех. Строгий нарочно: ссылка приходит от человека, а номер из неё уходит в
чужой адрес и в запрос к площадке, поэтому всё, что похоже на ссылку, но ею не является
(`youtube.com.evil.ru`, `youtube.com@evil.ru`, перевод строки внутри адреса), не узнаётся вовсе.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Mapping
from urllib.parse import SplitResult, parse_qs, unquote, urlsplit

# Ссылки длиннее не бывает: адрес ролика с метками — сотня-другая знаков, а две тысячи — предел,
# который держат браузеры и прокси по дороге.
LONGEST = 2000
# Пробел, перевод строки и управляющие знаки — не часть адреса. `urlsplit` табуляцию и переводы
# строки выбрасывает молча (так делает и браузер), и `youtu.be/\nabc` стало бы другой ссылкой —
# поэтому такой адрес не разбирается вовсе.
UNSAFE = re.compile(r"[\x00-\x20\x7f]")
PORTS = {"http": 80, "https": 443}
# В якоре `#__youtubedl_smuggle=…` yt-dlp передаёт сам себе данные для разборщика: чужой Referer,
# заголовки, «разбирай как generic». От человека такой адрес — не ссылка на страницу, а команда yt-dlp,
# и её не берут вовсе (закодированную тоже: знаки процента не делают её ссылкой).
SMUGGLED = "__youtubedl_smuggle"


@dataclass(frozen=True)
class Address:
    """
    Разобранная ссылка: хост строчными (без точки в конце), непустые части пути как есть — без
    раскодирования, чтобы `%2F` не стал разделителем, — и первое значение каждого параметра.
    """

    host: str
    path: tuple[str, ...]
    query: Mapping[str, str]


def _split(url: str) -> tuple[SplitResult, int | None] | None:
    """
    Части ссылки на страницу — `http(s)`, хост, без пробелов, без имени с паролем и без контрабанды
    yt-dlp (`SMUGGLED`) — и её порт.
    """
    if not isinstance(url, str) or not url or len(url) > LONGEST or UNSAFE.search(url):
        return None
    if SMUGGLED in unquote(url).lower():
        return None
    try:
        parts = urlsplit(url)
        # Неверный порт (`:abc`, `:99999`) urlsplit замечает только здесь.
        port = parts.port
    except ValueError:
        return None
    if parts.scheme.lower() not in PORTS or not parts.hostname or "@" in parts.netloc:
        return None
    return parts, port


def web(url: str) -> bool:
    """
    Ссылка ли это на страницу вообще. Проверка маршрута, а не площадки: такую ссылку кинозал
    берёт и отвечает, узнал ли он её. Порт здесь может быть любым — ни одна площадка такую ссылку
    не узнает, но это ответ «не узнал», а не «это не ссылка».
    """
    return _split(url) is not None


def parse(url: str) -> Address | None:
    """
    Адрес для грамматики площадок — или `None`, если ссылку нельзя узнать уверенно.

    Сверх `web`: порт только свой для схемы (у ссылок площадок другого не бывает), хост без
    последней точки (`youtube.com.` — тот же хост).
    """
    split = _split(url)
    if split is None:
        return None
    parts, port = split
    if port is not None and port != PORTS[parts.scheme.lower()]:
        return None
    host = (parts.hostname or "").removesuffix(".")
    if not host:
        return None
    try:
        values = parse_qs(parts.query, keep_blank_values=True)
    except ValueError:
        return None
    return Address(
        host=host,
        path=tuple(part for part in parts.path.split("/") if part),
        query={name: found[0] for name, found in values.items() if found},
    )
