"""Переписывание HLS-плейлистов на свои проксирующие адреса, включая нумерацию сегментов
досмотренного до конца списка вместо подписи каждой строки."""

from __future__ import annotations

import os
import re
import sys
import threading
import time
from typing import Callable, NamedTuple
from urllib.parse import urljoin

from fastapi import HTTPException

from .signer import SIGNATURE_TTL, Signer, proxied


# Чужой плейлист (площадка с любыми хостами — «По ссылке») переписывается строка за строкой: подпись
# или номер на каждый адрес, и адрес после подписи — сотни байт на каждый байт строки. Восемь мегабайт
# однобуквенных строк стоили минут процессора в цикле событий и гигабайтов памяти. Поэтому такой
# плейлист сначала меряется (`unwieldy`), до всякой работы: адресов — не больше `URIS` (у
# тринадцатичасового ролика YouTube их 9 370), каждый — не длиннее `LONGEST_URI`, а строк всех видов —
# не больше `LINES` (у сегмента их до пяти: длительность, время, диапазон, сам адрес).
URIS = 20_000
LONGEST_URI = 2_000
LINES = 5 * URIS
# Сколько байт держат вместе все списки кусочков площадок каталога (`Reels`): тринадцатичасовой ролик
# YouTube — около мегабайта.
REELS_BUDGET = 96 * 1024 * 1024
# Списки чужих страниц («По ссылке») — на своей полке (`Shelves`), со своим счётом и своим бюджетом. Чужой
# плейлист в пределах `unwieldy` весит в памяти до сорока мегабайт — такой не запоминается вовсе (отказ
# словами), настоящий фильм по ссылке — единицы мегабайт. Списков больше, чем у каталога: крошечный список
# ничего не стоит, а выселяет чей-то фильм.
FOREIGN_REELS = 64
FOREIGN_REELS_BUDGET = 32 * 1024 * 1024
# Чем делит строки `str.splitlines` — тем же и считаются строки до деления: иначе `\r` вместо `\n`
# пронёс бы четыре миллиона строк мимо счёта.
BREAKS = re.compile(r"\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]")


def unwieldy(body: str, base: str) -> str | None:
    """
    Почему этот чужой плейлист не переписывать — словами, или `None`. Строки считаются, не деля текст
    (дальше предела счёт не идёт), адреса — ровно те, что подписал бы `rewrite`, и с его `urljoin`.
    """
    for count, _ in enumerate(BREAKS.finditer(body), 1):
        if count > LINES:
            return f"в нём больше {LINES} строк"
    uris = 0
    for line in body.splitlines():
        inner = _uri(line)
        if inner is None:
            continue
        uris += 1
        if uris > URIS:
            return f"в нём больше {URIS} адресов"
        if len(urljoin(base, inner)) > LONGEST_URI:
            return f"адрес в нём длиннее {LONGEST_URI} знаков"
    return None


def _uri(line: str) -> str | None:
    """Адрес в строке плейлиста: сама строка (вариант, сегмент) или `URI="…"` тега; `None` — адреса нет."""
    if not line:
        return None
    if line.startswith("#"):
        if 'URI="' not in line:
            return None
        return line.partition('URI="')[2].partition('"')[0]
    return line.strip()


def master_playlist(body: str) -> bool:
    """Мастер это или уже список сегментов. От ответа зависит, чем считать ссылки внутри."""
    return "#EXT-X-STREAM-INF" in body or "#EXT-X-MEDIA:" in body


def finished_playlist(body: str) -> bool:
    """Целое произведение или край живого эфира: у первого список сегментов больше не меняется."""
    return "#EXT-X-ENDLIST" in body or "#EXT-X-PLAYLIST-TYPE:VOD" in body


class Reel(NamedTuple):
    """
    Кусочек фильма по номеру: его адрес, площадка, от имени которой он открывается, и профиль заголовков
    потока, если его спросил плеер страницы (`cinema/sniffer.py`).
    """

    url: str
    provider: str
    profile: str | None = None


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
    YouTube) не давал один список, отобранный разными политиками хостов. Так же — и профиль заголовков
    потока (`Reel.profile`): кусочки спрашиваются с теми же заголовками, что и сам список.

    ПАМЯТЬ. Списков — не больше `capacity`, и весят они вместе не больше `budget` байт: считается то,
    что держится на самом деле, — общее начало, хвосты и сам список (`_weight`). Одного счёта мало:
    чужой плейлист в 253 КБ (двадцать тысяч однобуквенных адресов у длинного адреса списка и один
    адрес другого сайта первым — общее начало тогда `https://`) держал бы 38 МБ хвостов пять часов, и
    двадцать четыре таких — гигабайт, больше, чем есть у службы. Место уходит тем, кого дольше всех не
    смотрели; список тяжелее всего бюджета не запоминается вовсе — отказ словами.
    """

    def __init__(
        self, signer: Signer, ttl: float = SIGNATURE_TTL, capacity: int = 24, budget: int = REELS_BUDGET
    ):
        self.signer = signer
        self.ttl = ttl
        self.capacity = capacity
        self.budget = budget
        # Ключ → (последнее обращение, общее начало, хвосты, площадка, вес в байтах, профиль); порядок — от
        # давно не смотренных к только что смотренным.
        self._items: dict[str, tuple[float, str, list[str], str, int, str | None]] = {}
        # Сколько байт держат все списки вместе.
        self.retained = 0
        # Чужие плейлисты переписываются в потоке (`Cinema.manifest`), а кусочки ищутся в цикле событий.
        self._lock = threading.Lock()

    def remember(
        self, playlist_url: str, targets: list[str], provider: str, profile: str | None = None
    ) -> str:
        # Профиль — в имени, только если он есть: имена прежних списков не меняются.
        named = f"{provider}|{profile}|{playlist_url}" if profile else f"{provider}|{playlist_url}"
        key = self.signer.name(named)
        shared = os.path.commonprefix(targets) if targets else ""
        tails = [target[len(shared) :] for target in targets]
        weight = _weight(shared, tails)
        if weight > self.budget:
            raise HTTPException(
                502,
                f"Плейлист площадки не открыть: его кусочки заняли бы больше {self.budget >> 20} МБ памяти",
            )
        with self._lock:
            self._forget(key)
            self._items[key] = (time.time(), shared, tails, provider, weight, profile)
            self.retained += weight
            while len(self._items) > self.capacity or self.retained > self.budget:
                self._forget(next(iter(self._items)))
        return key

    def find(self, key: str, index: int) -> Reel:
        with self._lock:
            found = self._items.get(key)
            if not found or time.time() - found[0] > self.ttl:
                raise HTTPException(410, "Список кусочков устарел, откройте видео заново")
            _, shared, tails, provider, weight, profile = found
            if index < 0 or index >= len(tails):
                raise HTTPException(404, "Такого кусочка в этом видео нет")
            # Срок считается от последнего обращения, а не от разбора: трёхчасовой фильм иначе
            # разваливался бы на середине. Заодно список переезжает в конец очереди на выселение —
            # то, что смотрят прямо сейчас, не должно уходить ради того, что открыли и бросили.
            self._items.pop(key)
            self._items[key] = (time.time(), shared, tails, provider, weight, profile)
        return Reel(shared + tails[index], provider, profile)

    def __contains__(self, key: str) -> bool:
        with self._lock:
            return key in self._items

    def _forget(self, key: str) -> None:
        found = self._items.pop(key, None)
        if found is not None:
            self.retained -= found[4]


class Shelves:
    """
    Списки кусочков — на двух полках: площадок каталога и площадок с любыми хостами («По ссылке»).

    ПОЧЕМУ ДВЕ. Одна общая полка на двадцать четыре списка отдавала чужим страницам место каталога. Мастер
    чужого сайта перечисляет сколько угодно крошечных готовых вариантов, каждый подписанный GET варианта —
    новый список, и двадцать четыре списка по одной строке выселяли каждый список YouTube на сервере: 410 у
    всех комнат, и каждая переоткрывает поток за счёт своего предела `resolve`. Теперь у чужих страниц своя
    полка со своим счётом и своим бюджетом байт (`FOREIGN_REELS`, `FOREIGN_REELS_BUDGET`): выселить они
    могут только друг друга.

    Полку выбирает площадка списка (`foreign` — её политика хостов `public_any`; площадки нет — тоже чужая).
    Имя списка считается и от площадки (`Reels.remember`), поэтому `find` просто ищет его на обеих.
    """

    def __init__(self, signer: Signer, foreign: Callable[[str], bool]):
        self.catalog = Reels(signer)
        self.foreign = Reels(signer, capacity=FOREIGN_REELS, budget=FOREIGN_REELS_BUDGET)
        self._foreign = foreign

    def remember(
        self, playlist_url: str, targets: list[str], provider: str, profile: str | None = None
    ) -> str:
        shelf = self.foreign if self._foreign(provider) else self.catalog
        return shelf.remember(playlist_url, targets, provider, profile)

    def find(self, key: str, index: int) -> Reel:
        return (self.catalog if key in self.catalog else self.foreign).find(key, index)


def _weight(shared: str, tails: list[str]) -> int:
    """Сколько памяти держит список кусочков: строки с их заголовками и сам список."""
    return sys.getsizeof(shared) + sys.getsizeof(tails) + sum(map(sys.getsizeof, tails))


def _attribute(line: str, base: str, signer: Signer, provider: str, profile: str | None = None) -> str:
    """Ссылка внутри тега: дорожка звука в мастере, карта инициализации и ключи в сегментах."""
    if 'URI="' not in line:
        return line
    head, _, rest = line.partition('URI="')
    inner, _, tail = rest.partition('"')
    target = urljoin(base, inner)
    if not signer.allows(target, provider):
        return line
    kind = "playlist" if line.startswith("#EXT-X-MEDIA") else "fetch"
    return f'{head}URI="{proxied(signer, target, kind, provider=provider, profile=profile)}"{tail}'


def rewrite(
    body: str,
    base: str,
    signer: Signer,
    reels: Reels | Shelves | None = None,
    *,
    provider: str,
    profile: str | None = None,
) -> str:
    """
    Переписывает плейлист на свои адреса.

    Внутри мастера все ссылки — плейлисты, внутри списка сегментов — сегменты и ключи. Поэтому
    вид плейлиста определяется один раз для всего тела, а не угадывается по каждой ссылке:
    у YouTube вариант выглядит как `/api/manifest/hls_playlist/...` без всякого `.m3u8`, и любая
    догадка по расширению ошиблась бы на нём первой же строкой.

    Досмотренному до конца списку сегментов достаётся нумерация вместо подписи, если есть куда
    её записать ({@link Reels}); живому эфиру и мастеру — подпись, как и раньше.

    Какие ссылки проксировать, решает политика хостов площадки, чей это плейлист: чужой хост
    остаётся в строке как был, и через наш прокси за ним никто не пойдёт. `profile` — номер профиля
    заголовков потока: он уходит в подпись каждого адреса внутри, и дальше списка его не потерять.
    """
    if reels is not None and not master_playlist(body) and finished_playlist(body):
        return _numbered(body, base, signer, reels, provider, profile)
    route = "playlist" if master_playlist(body) else "fetch"
    lines = []
    for line in body.splitlines():
        if not line:
            lines.append(line)
        elif line.startswith("#"):
            lines.append(_attribute(line, base, signer, provider, profile))
        else:
            target = urljoin(base, line.strip())
            if signer.allows(target, provider):
                lines.append(proxied(signer, target, route, provider=provider, profile=profile))
            else:
                lines.append(line)
    return "\n".join(lines) + "\n"


def _numbered(
    body: str, base: str, signer: Signer, reels: Reels | Shelves, provider: str, profile: str | None = None
) -> str:
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
            shape.append(_attribute(line, base, signer, provider, profile))
        else:
            target = urljoin(base, line.strip())
            if signer.allows(target, provider):
                shape.append(None)
                targets.append(target)
            else:
                shape.append(line)
    key = reels.remember(base, targets, provider, profile)
    lines = []
    number = 0
    for line in shape:
        if line is None:
            lines.append(f"seg/{key}/{number}")
            number += 1
        else:
            lines.append(line)
    return "\n".join(lines) + "\n"
