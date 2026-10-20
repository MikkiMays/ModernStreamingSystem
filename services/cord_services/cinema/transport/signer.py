"""Подпись адресов и проверка хоста политикой площадки: то, на чём держится собственный прокси
службы."""

from __future__ import annotations

import base64
import hmac
import json
import os
import re
import time
from contextvars import ContextVar
from hashlib import sha256
from typing import TYPE_CHECKING, Callable
from urllib.parse import urlencode, urlsplit

from fastapi import HTTPException

from ..net import BAD_PORTS

if TYPE_CHECKING:
    from ..registry import HostPolicy


PREFIX = "/api/v1/services/cinema"

_UNITS = {"s": 1, "sec": 1, "second": 1, "m": 60, "min": 60, "minute": 60, "h": 3600, "hour": 3600,
          "d": 86400, "day": 86400}


def seconds(text: str) -> int:
    """Срок словами, как в `application.yml` ядра: `1 hour`, `90 minutes`, `600`."""
    found = re.fullmatch(r"\s*(\d+)\s*([a-z]*?)s?\s*", text.lower())
    if not found or (found.group(2) and found.group(2) not in _UNITS):
        raise ValueError(f"Не понимаю срок «{text}»: ожидается «1 hour», «90 minutes» или число секунд")
    return int(found.group(1)) * _UNITS.get(found.group(2) or "s", 1)


# Сколько живёт выданная подпись (`CINEMA_LINK_TTL`, A8 docs/abuse-model.md). Было пять часов:
# столько же работал любой адрес, унесённый со встречи. Плеер переоткрывает источник сам, получив 410,
# поэтому короткий срок стоит одной незаметной заминки в час.
SIGNATURE_TTL = seconds(os.environ.get("CINEMA_LINK_TTL", "1 hour"))

# Встреча, от имени которой сейчас подписываются адреса. Ставит её маршрут (разбор, плейлист под
# встречей), а не каждая площадка: разбор общий на всех зрителей одного ролика, и номер встречи в
# памяти разбора был бы чужим. Пусто — адрес без встречи (обложки каталога).
ROOM: ContextVar[str] = ContextVar("cinema_room", default="")

# Маршруты, на которые выдаётся подпись. У каждого своя: ссылка картинки живёт сутки, и если бы
# её подпись годилась для `/fetch`, любой участник получал бы суточный пропуск к потоку.
# `subtitles` — файл субтитров, который по дороге становится WebVTT (`captions.webvtt`).
ROUTES = frozenset({"playlist", "fetch", "image", "subtitles"})


def allowed(url: str, hosts: HostPolicy | None) -> bool:
    """
    Адрес, который прокси вправе открыть для площадки с этой политикой хостов.

    Площадкам со списком хостов — только https, как было всегда. Площадке с любыми хостами
    («По ссылке») — и http: у чужих страниц видео бывает и без TLS, а до зрителя оно всё равно
    едет от нас по https; публичность адреса проверяется при соединении (`net.py`). Но не на порт,
    куда не ходит и браузер (`net.BAD_PORTS`): иначе ссылка любого участника стучалась бы нашим
    сервером в чужую почту.
    """
    if hosts is None:
        return False
    parts = urlsplit(url)
    if hosts.public_any:
        try:
            port = parts.port or (443 if parts.scheme == "https" else 80)
        except ValueError:
            return False
        plain = parts.scheme in ("https", "http") and port not in BAD_PORTS
        return plain and hosts.allows(parts.hostname or "")
    return parts.scheme == "https" and hosts.allows(parts.hostname or "")


class Signer:
    """
    Подпись маршрута, площадки, адреса и срока. Ключ тот же, которым служба доказывает ядру,
    что она своя.

    Подписано всё, что определяет ответ прокси: какой маршрут откроет ссылку, от имени какой
    площадки (её политика хостов и её выход наружу) и что именно. Раньше подписаны были только
    адрес и срок: ссылка картинки открывала `/fetch` и `/playlist`, а адрес годился для любой
    площадки. Выданные до этого ссылки после выкатки не откроются (403), и плеер переоткроет
    источник сам — одна заминка.

    `hosts` — политика площадки по её имени (`None` — площадки нет или она выключена).

    ПРОФИЛЬ ПОТОКА (`h`). У потока, который спросил плеер страницы (`cinema/sniffer.py`), в подписи есть и
    номер его профиля заголовков: по нему прокси подставляет Referer, Origin, имя браузера и cookies.
    Номер — часть подписи: приписать чужой профиль к своему адресу (и увести его cookies) нельзя. Подписи
    без профиля — прежние, байт в байт: выданные раньше ссылки открываются как открывались.
    """

    def __init__(self, secret: str, hosts: Callable[[str], HostPolicy | None] | None = None):
        self._secret = (secret or "cord-cinema").encode()
        self._hosts = hosts or (lambda provider: None)

    def allows(self, url: str, provider: str) -> bool:
        """Вправе ли прокси открыть этот адрес от имени площадки."""
        return allowed(url, self._hosts(provider))

    def sign(
        self,
        url: str,
        ttl: int,
        route: str,
        provider: str,
        profile: str | None = None,
        room: str | None = None,
    ) -> dict[str, str]:
        if route not in ROUTES:
            raise ValueError(f"Подпись для незнакомого маршрута: {route}")
        expires = str(int(time.time()) + ttl)
        packed = base64.urlsafe_b64encode(url.encode()).decode().rstrip("=")
        return self.seal(route, provider, packed, expires, profile, ROOM.get() if room is None else room)

    def seal(
        self, route: str, provider: str, packed: str, expires: str, profile: str | None, room: str = ""
    ) -> dict[str, str]:
        """Параметры подписанного адреса; встреча (`room`) — в подписи, а в адресе — частью пути."""
        seal = self._seal(route, provider, packed, expires, profile, room)
        signed = {"u": packed, "e": expires, "p": provider, "s": seal}
        if profile:
            signed["h"] = profile
        return signed

    def open(
        self,
        route: str,
        packed: str,
        expires: str,
        signature: str,
        provider: str,
        profile: str = "",
        room: str = "",
    ) -> str:
        # Сравнение байтами: у `compare_digest` строки с не-ASCII вызывают TypeError, и чужая
        # подпись кириллицей отвечала бы 500 вместо отказа.
        expected = self._seal(route, provider, packed, expires, profile, room)
        if not hmac.compare_digest(signature.encode(), expected.encode()):
            raise HTTPException(403, "Ссылка не подписана этим сервером")
        if not expires.isdigit() or int(expires) < time.time():
            raise HTTPException(410, "Ссылка устарела, откройте видео заново")
        try:
            url = base64.urlsafe_b64decode(packed + "=" * (-len(packed) % 4)).decode()
        except Exception:
            raise HTTPException(400, "Неразборчивая ссылка") from None
        # Хост — по политике той площадки, чьё имя стоит в подписи, а не по общему списку.
        if not self.allows(url, provider):
            raise HTTPException(403, "Этот адрес не обслуживается")
        return url

    def name(self, value: str) -> str:
        """Короткое имя: то же самое доказательство, что и подпись, но без адреса внутри."""
        return self._mac(f"{value}|reel")[:24]

    def _seal(
        self, route: str, provider: str, packed: str, expires: str, profile: str | None = None, room: str = ""
    ) -> str:
        # Поля — списком JSON, а не через разделитель: имя площадки приходит из запроса, и
        # никакая его строка не должна склеиться с соседним полем в чужую подпись. Профиль — после срока и
        # только если он есть: подпись без него та же, что была всегда. Встреча — объектом в конце: её не
        # спутать ни с профилем, ни с чем-то ещё.
        fields: list = ["sign", route, provider, packed, expires, *([profile] if profile else [])]
        if room:
            fields.append({"room": room})
        return self._mac(json.dumps(fields, separators=(",", ":")))[:32]

    def _mac(self, message: str) -> str:
        return hmac.new(self._secret, message.encode(), sha256).hexdigest()


def proxied(
    signer: Signer,
    url: str,
    route: str,
    ttl: int = SIGNATURE_TTL,
    *,
    provider: str,
    profile: str | None = None,
) -> str:
    return located(route, ROOM.get()) + "?" + urlencode(signer.sign(url, ttl, route, provider, profile))


def located(route: str, room: str = "") -> str:
    """Путь маршрута прокси: под встречей — `…/cinema/r/<встреча>/<маршрут>`, без неё — как раньше.

    Встреча — в пути, а не в параметрах: относительные адреса сегментов в плейлисте (`seg/<имя>/<номер>`)
    браузер разворачивает от пути плейлиста, и они остаются под той же встречей сами, без лишнего байта
    в каждой из тысяч строк."""
    return f"{PREFIX}/r/{room}/{route}" if room else f"{PREFIX}/{route}"
