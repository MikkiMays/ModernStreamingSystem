"""
Реестр площадок: что кинозал умеет у каждой из них и какие включены на этой установке.

Площадка — модуль, а не развилка. Фасад не спрашивает «YouTube это или Twitch»: он берёт
площадку из реестра и зовёт её метод, а то, чего у площадки нет, отвечает отказом
`Unsupported` с человеческим текстом. Новая площадка — это новый модуль в `providers/` и одна
строка в их списке, а не правка восьми мест по всему кинозалу.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Callable, ClassVar, Iterable, Iterator, Literal, Mapping

import httpx
from fastapi import HTTPException

from .memo import Memo, Scope

if TYPE_CHECKING:
    from .resolve import SourcePlan, YtDlp

logger = logging.getLogger(__name__)

# Имя площадки: короткое слово строчными латинскими буквами.
PROVIDER_ID = re.compile(r"[a-z][a-z0-9_]{0,31}")


class Unsupported(HTTPException):
    """
    Площадка этого не умеет — или её на этой установке нет.

    Это отказ человеку, а не сбой: маршрут отвечает 400 с тем же текстом, что и раньше, когда
    развилка стояла прямо в методе. Поэтому исключение — наследник `HTTPException`: его не
    нужно ловить и переводить на каждом этаже, откуда бы площадка ни отказала.
    """

    def __init__(self, detail: str):
        super().__init__(400, detail)


@dataclass(frozen=True)
class Features:
    """Что у площадки есть. По этому же списку клиент решает, какие двери ей рисовать."""

    search: bool = True
    channels: bool = False
    playlists: bool = False
    categories: bool = False
    series: bool = False
    live: bool = False
    account: Literal["none", "optional", "required"] = "none"


@dataclass(frozen=True)
class HostPolicy:
    """
    Куда площадке можно ходить за картинками и потоком.

    Подписанный адрес открывается только по политике той площадки, чьё имя стоит в подписи:
    YouTube не отдаст через наш прокси адрес Twitch, и наоборот. Вместе политики площадок —
    ровно прежний общий список хостов, ни одного не потеряно и не добавлено.
    """

    suffixes: tuple[str, ...] = ()
    # Любой хост, но только публичный (своя медиатека, ссылка). Публичность проверяется при
    # соединении, по адресу, в который имя разрешилось, — по одному имени её не узнать.
    public_any: bool = False

    def allows(self, host: str) -> bool:
        host = (host or "").lower()
        if not host:
            return False
        if self.public_any:
            return True
        return any(host == suffix or host.endswith("." + suffix) for suffix in self.suffixes)


@dataclass(frozen=True)
class Ctx:
    """
    С чем площадка отвечает на один запрос.

    `room` — чья это комната; `net` — через какой клиент ходить наружу; `accounts` — чьи входы
    у комнаты есть. Сейфа входов пока нет ни у одной площадки, поэтому и поле пустое.
    """

    room: str
    net: httpx.AsyncClient
    accounts: Any = None


@dataclass(frozen=True)
class Kit:
    """Общее хозяйство кинозала, которым площадки пользуются, но не владеют."""

    # Память каталога этой площадки: общая память под её именем (`Memo.scope`). Ключи и сроки
    # площадка выбирает сама, но начинаются они всегда с её `id` — чужого ей не достать.
    memo: Memo | Scope
    # Обложка у нас: подписанный адрес или `None`, если хост чужой.
    image: Callable[[str], str | None]
    ytdlp: YtDlp


class Provider:
    """
    Площадка кинозала. Всё, чего она не умеет, по умолчанию — отказ `Unsupported`.

    Возможности (`features`) и тексты отказов (`refusals`) объявляет сама площадка: фасад
    спрашивает её только о том, что она объявила, а на остальное отвечает её же словами.
    """

    id: ClassVar[str]
    name: ClassVar[str]
    hosts: ClassVar[HostPolicy] = HostPolicy()
    features: ClassVar[Features] = Features()
    # Форма адреса на этой площадке (`fullmatch`): для `contentId` и для id карточек.
    content_id: ClassVar[re.Pattern[str]]
    # Что ответить человеку, если такого у площадки нет, — по имени возможности из `features`.
    refusals: ClassVar[Mapping[str, str]] = {}

    def __init_subclass__(cls, abstract: bool = False, **kwargs: Any):
        """
        Площадка без обязательного объявления падает при импорте — а не отказом 500 на каждом
        запросе, как было с забытым `name` в тексте отказа.

        `abstract=True` — общая основа для нескольких площадок: объявлять себя ей не нужно,
        это сделают наследники.
        """
        super().__init_subclass__(**kwargs)
        if abstract:
            return
        missing = [name for name in ("id", "name", "content_id") if not hasattr(cls, name)]
        if missing:
            raise TypeError(f"Площадка {cls.__name__}: не объявлены {', '.join(missing)}")
        # `id` — префикс ключей памяти, часть подписи адреса и имя в `CINEMA_PROXY_<ID>`:
        # короткое слово строчными буквами, без пробелов и двоеточий.
        if not isinstance(cls.id, str) or not PROVIDER_ID.fullmatch(cls.id):
            raise TypeError(f"Площадка {cls.__name__}: id {cls.id!r} не по форме {PROVIDER_ID.pattern}")
        if not isinstance(cls.name, str) or not cls.name:
            raise TypeError(f"Площадка {cls.__name__}: name должно быть непустой строкой")
        if not isinstance(cls.content_id, re.Pattern):
            raise TypeError(f"Площадка {cls.__name__}: content_id должен быть re.compile(...)")

    def __init__(self, kit: Kit):
        self.memo = kit.memo
        self.image = kit.image
        self.ytdlp = kit.ytdlp

    def refuse(self, feature: str) -> Unsupported:
        return Unsupported(self.refusals.get(feature) or f"У площадки {self.name} такого нет")

    async def availability(self) -> tuple[bool, str | None]:
        """Работает ли площадка отсюда, и если нет — почему. Большинству проверять нечего."""
        return True, None

    async def search(self, ctx: Ctx, query: str, offset: int) -> dict[str, Any]:
        raise self.refuse("search")

    async def channel(self, ctx: Ctx, channel_id: str, tab: str, offset: int) -> dict[str, Any]:
        raise self.refuse("channels")

    async def playlist(self, ctx: Ctx, playlist_id: str, offset: int) -> dict[str, Any]:
        raise self.refuse("playlists")

    async def categories(self, ctx: Ctx, query: str, offset: int) -> dict[str, Any]:
        raise self.refuse("categories")

    async def category(self, ctx: Ctx, category_id: str, offset: int) -> dict[str, Any]:
        raise self.refuse("categories")

    async def series(self, ctx: Ctx, series_id: str, season: str | None, offset: int) -> dict[str, Any]:
        raise self.refuse("series")

    async def details(self, ctx: Ctx, kind: str, item_id: str) -> dict[str, Any]:
        raise self.refuse("details")

    async def source(self, ctx: Ctx, kind: str, item_id: str, options: dict[str, Any]) -> SourcePlan:
        raise self.refuse("source")


class Registry:
    """
    Площадки кинозала и те из них, что включены на этой установке.

    `enabled` — строка как в `CINEMA_PROVIDERS`: имена через запятую, пусто — включены все, кого
    кинозал знает. Незнакомое имя не валит службу, а оставляет одну строку в журнале: опечатка в
    настройке не должна гасить кинозал, но и молча проглатываться тоже не должна. Порядок
    площадок — порядок регистрации, а не строки настройки: так клиент видит их всегда одинаково.
    """

    def __init__(self, providers: Iterable[Provider], enabled: str | None = None):
        self._known = {provider.id: provider for provider in providers}
        names = [name.strip().lower() for name in (enabled or "").split(",") if name.strip()]
        unknown = [name for name in names if name not in self._known]
        if unknown:
            logger.warning(
                "CINEMA_PROVIDERS: незнакомые площадки пропущены: %s (кинозал знает: %s)",
                ", ".join(unknown),
                ", ".join(self._known),
            )
        wanted = set(names) if names else set(self._known)
        self._enabled = {key: provider for key, provider in self._known.items() if key in wanted}

    def get(self, provider_id: str) -> Provider:
        found = self._enabled.get(provider_id)
        if found is None:
            raise Unsupported(
                "Эта площадка выключена на этом сервере"
                if provider_id in self._known
                else "Такой площадки в кинозале нет"
            )
        return found

    def find(self, provider_id: str) -> Provider | None:
        """Включённая площадка по имени или `None` — без отказа, для проверок внутри службы."""
        return self._enabled.get(provider_id)

    def __iter__(self) -> Iterator[Provider]:
        return iter(self._enabled.values())
