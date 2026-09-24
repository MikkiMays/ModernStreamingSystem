"""Переписывание HLS-плейлистов на свои проксирующие адреса, включая нумерацию сегментов
досмотренного до конца списка вместо подписи каждой строки."""

from __future__ import annotations

import os
import time
from typing import NamedTuple
from urllib.parse import urljoin

from fastapi import HTTPException

from .signer import SIGNATURE_TTL, Signer, proxied


def master_playlist(body: str) -> bool:
    """Мастер это или уже список сегментов. От ответа зависит, чем считать ссылки внутри."""
    return "#EXT-X-STREAM-INF" in body or "#EXT-X-MEDIA:" in body


def finished_playlist(body: str) -> bool:
    """Целое произведение или край живого эфира: у первого список сегментов больше не меняется."""
    return "#EXT-X-ENDLIST" in body or "#EXT-X-PLAYLIST-TYPE:VOD" in body


class Reel(NamedTuple):
    """Кусочек фильма по номеру: его адрес и площадка, от имени которой он открывается."""

    url: str
    provider: str


class Reels:
    """
    Сегменты досмотренного до конца плейлиста — под номером, а не под подписью.

    ПОЧЕМУ. Плейлист VOD перечисляет **все** сегменты до последнего, а один адрес сегмента у
    YouTube — тысяча двести символов, из которых тысяча сто шестьдесят девять одинаковые.
    Тринадцатичасовой ролик — это 9370 строк и 11 МБ, а после подписи каждой строки 16 МБ, и
    всё это браузер обязан скачать **до первого кадра**. Отсюда и жалоба: короткое открывается
    сразу, фильм — «висит».

    Поэтому в плейлисте стоит `seg/<имя>/<номер>` — сорок байт вместо тысячи с лишним, и те же
    9370 строк весят уже около трёхсот килобайт. Сам список живёт здесь, у нас, и хранится
    общим началом плюс хвосты: различаются адреса только байтовым диапазоном и номером.

    Имя считается от адреса плейлиста тем же ключом, что и подпись: угадать его нельзя, а
    комната, смотрящая одно и то же, получает одно имя на всех — и один разбор вместо пяти.

    Живой эфир сюда не попадает: у него номера сегментов уезжают вперёд каждые несколько
    секунд, а плейлист и без того короткий.

    Список помнит свою площадку: за кусочком прокси идёт её выходом наружу, а в имя списка
    она входит, чтобы один и тот же адрес у двух площадок (у «ссылки» он может совпасть с
    YouTube) не давал один список, отобранный разными политиками хостов.
    """

    def __init__(self, signer: Signer, ttl: float = SIGNATURE_TTL, capacity: int = 24):
        self.signer = signer
        self.ttl = ttl
        self.capacity = capacity
        self._items: dict[str, tuple[float, str, list[str], str]] = {}

    def remember(self, playlist_url: str, targets: list[str], provider: str) -> str:
        key = self.signer.name(f"{provider}|{playlist_url}")
        shared = os.path.commonprefix(targets) if targets else ""
        self._items.pop(key, None)
        self._items[key] = (time.time(), shared, [target[len(shared) :] for target in targets], provider)
        while len(self._items) > self.capacity:
            self._items.pop(next(iter(self._items)))
        return key

    def find(self, key: str, index: int) -> Reel:
        found = self._items.get(key)
        if not found or time.time() - found[0] > self.ttl:
            raise HTTPException(410, "Список кусочков устарел, откройте видео заново")
        _, shared, tails, provider = found
        if index < 0 or index >= len(tails):
            raise HTTPException(404, "Такого кусочка в этом видео нет")
        # Срок считается от последнего обращения, а не от разбора: трёхчасовой фильм иначе
        # разваливался бы на середине. Заодно список переезжает в конец очереди на выселение —
        # то, что смотрят прямо сейчас, не должно уходить ради того, что открыли и бросили.
        self._items.pop(key)
        self._items[key] = (time.time(), shared, tails, provider)
        return Reel(shared + tails[index], provider)


def _attribute(line: str, base: str, signer: Signer, provider: str) -> str:
    """Ссылка внутри тега: дорожка звука в мастере, карта инициализации и ключи в сегментах."""
    if 'URI="' not in line:
        return line
    head, _, rest = line.partition('URI="')
    inner, _, tail = rest.partition('"')
    target = urljoin(base, inner)
    if not signer.allows(target, provider):
        return line
    kind = "playlist" if line.startswith("#EXT-X-MEDIA") else "fetch"
    return f'{head}URI="{proxied(signer, target, kind, provider=provider)}"{tail}'


def rewrite(body: str, base: str, signer: Signer, reels: Reels | None = None, *, provider: str) -> str:
    """
    Переписывает плейлист на свои адреса.

    Внутри мастера все ссылки — плейлисты, внутри списка сегментов — сегменты и ключи. Поэтому
    вид плейлиста определяется один раз для всего тела, а не угадывается по каждой ссылке:
    у YouTube вариант выглядит как `/api/manifest/hls_playlist/...` без всякого `.m3u8`, и любая
    догадка по расширению ошиблась бы на нём первой же строкой.

    Досмотренному до конца списку сегментов достаётся нумерация вместо подписи, если есть куда
    её записать ({@link Reels}); живому эфиру и мастеру — подпись, как и раньше.

    Какие ссылки проксировать, решает политика хостов площадки, чей это плейлист: чужой хост
    остаётся в строке как был, и через наш прокси за ним никто не пойдёт.
    """
    if reels is not None and not master_playlist(body) and finished_playlist(body):
        return _numbered(body, base, signer, reels, provider)
    route = "playlist" if master_playlist(body) else "fetch"
    lines = []
    for line in body.splitlines():
        if not line:
            lines.append(line)
        elif line.startswith("#"):
            lines.append(_attribute(line, base, signer, provider))
        else:
            target = urljoin(base, line.strip())
            if signer.allows(target, provider):
                lines.append(proxied(signer, target, route, provider=provider))
            else:
                lines.append(line)
    return "\n".join(lines) + "\n"


def _numbered(body: str, base: str, signer: Signer, reels: Reels, provider: str) -> str:
    """
    То же самое, но сегменты нумеруются.

    Номер относительный — `seg/<имя>/<номер>`, — и это не экономия ради экономии: плейлист
    лежит по адресу `…/cinema/playlist?u=…`, и относительная ссылка разворачивается браузером
    в `…/cinema/seg/<имя>/<номер>` сама. Абсолютный путь стоил бы двадцати шести лишних байт
    на каждой из десяти тысяч строк.
    """
    targets: list[str] = []
    shape: list[str | None] = []
    for line in body.splitlines():
        if not line:
            shape.append(line)
        elif line.startswith("#"):
            shape.append(_attribute(line, base, signer, provider))
        else:
            target = urljoin(base, line.strip())
            if signer.allows(target, provider):
                shape.append(None)
                targets.append(target)
            else:
                shape.append(line)
    key = reels.remember(base, targets, provider)
    lines = []
    number = 0
    for line in shape:
        if line is None:
            lines.append(f"seg/{key}/{number}")
            number += 1
        else:
            lines.append(line)
    return "\n".join(lines) + "\n"
