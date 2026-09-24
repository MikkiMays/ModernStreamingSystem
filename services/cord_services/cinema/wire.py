"""
Провод кинозала: какие ключи уходят клиенту и где они собираются.

Карточка каталога собиралась руками в четырнадцати местах, и у каждого вида был свой набор
ключей — не по замыслу, а по истории. Теперь каждый вид собирается одной функцией, но набор
ключей, их порядок и пустые значения — те же, что были: веб и клиент под Windows читают
именно их, и пропавший ключ заметили бы раньше нас. Имена аргументов — ключи провода как есть.
"""

from __future__ import annotations

from typing import Any, Literal, NotRequired, TypedDict, cast


class Card(TypedDict):
    """Плитка каталога: ролик, эфир, канал или плейлист."""

    provider: str
    kind: str
    id: str
    title: str
    author: str
    channelId: str | None
    duration: float | None
    live: bool
    viewers: int | None
    views: int | None
    # Эти ключи есть не у каждого вида — и появляются только там, где были.
    followers: NotRequired[int | None]
    description: NotRequired[str]
    count: NotRequired[int | None]
    category: NotRequired[str | None]
    published: NotRequired[str | None]
    # Новые и необязательные: значок на плитке, её форма (`wide` 16:9 по умолчанию, `tall` 2:3 у
    # постеров фильмов) и сериал, к которому относится серия.
    badge: NotRequired[str]
    shape: NotRequired[Literal["wide", "tall"]]
    series: NotRequired[str]
    poster: str | None


class CategoryCard(TypedDict):
    """Раздел площадки (у Twitch — игра или рубрика): только имя, обложка и сколько смотрят."""

    provider: str
    kind: Literal["category"]
    id: str
    title: str
    viewers: int | None
    poster: str | None


class ChannelHead(TypedDict):
    """Шапка страницы канала."""

    provider: str
    id: str
    title: str
    handle: str
    description: str
    followers: int | None
    viewers: int | None
    live: bool
    category: str | None
    avatar: str | None
    banner: str | None


class PlaylistHead(TypedDict):
    """Шапка страницы плейлиста."""

    provider: str
    kind: Literal["playlist"]
    id: str
    title: str
    author: str
    channelId: str | None
    description: str
    count: int | None
    views: int | None
    published: str | None
    poster: str | None


class Details(TypedDict):
    """Страница ролика: всё, что показывают до «Смотреть вместе»."""

    provider: str
    kind: str
    id: str
    title: str
    author: str
    channelId: str | None
    channelAvatar: str | None
    duration: float | None
    live: bool
    views: int | None
    viewers: int | None
    followers: int | None
    published: str | None
    category: str | None
    description: str
    poster: str | None
    # Сериал, к которому относится серия, — только у площадок, которые это знают (Rutube).
    series: NotRequired[str]


class ChannelDetails(ChannelHead):
    """Страница идущего эфира: шапка канала и то, что нужно странице ролика."""

    kind: Literal["channel"]
    author: str
    channelId: str
    channelAvatar: str | None
    duration: None
    views: None
    published: None
    poster: str | None


class Page(TypedDict):
    """Порция ленты. `next` — место, с которого продолжать; пусто — дальше ничего нет."""

    items: list[Any]
    next: str | None


class SearchPage(Page):
    channels: list[Card]
    categories: list[CategoryCard]
    # Полка сериалов и шоу над лентой — только у площадок, где сериал есть отдельной страницей.
    series: NotRequired[list[Card]]


class ChannelPage(Page):
    channel: ChannelHead | None


class PlaylistPage(Page):
    playlist: PlaylistHead


class CategoryPage(Page):
    category: CategoryCard


class Season(TypedDict):
    """Сезон сериала: чем его спросить (`id`) и как его назвать на вкладке."""

    id: str
    title: str


class SeriesHead(TypedDict):
    """Шапка страницы сериала: постер, имя, год, описание и сезоны."""

    id: str
    title: str
    poster: str | None
    description: str
    year: int | None
    seasons: list[Season]


class SeriesPage(Page):
    """Страница сериала: шапка и серии открытого сезона (`None` — сезонов у сериала нет)."""

    series: SeriesHead
    season: str | None


class Caption(TypedDict):
    lang: str
    label: str
    auto: bool
    url: str


class Source(TypedDict):
    """Ответ `resolve`: поток у нас, срок его подписи, язык, субтитры, обложка."""

    provider: str
    contentId: str
    title: str
    author: str
    duration: float | None
    live: bool
    kind: Literal["hls", "dash", "file"]
    url: str
    expiresAt: int
    notice: str | None
    language: str
    captions: list[Caption]
    poster: str | None
    # Только у площадок, которые знают это сами: задержка эфира для общей секунды, дорожки
    # звука и варианты качества на выбор.
    liveDelayMs: NotRequired[int]
    audioChoices: NotRequired[list[dict[str, Any]]]
    variants: NotRequired[list[dict[str, Any]]]


class ProviderEntry(TypedDict):
    """Строка ответа `providers`: какая площадка включена, доступна ли и что у неё есть."""

    id: str
    available: bool
    reason: str | None
    account: Literal["none", "optional", "required"]
    connected: bool
    features: dict[str, bool]


# «Ключа нет» — не то же самое, что «ключ есть и он пуст»: `followers: null` у карточки канала
# клиент показывает прочерком, а у ролика этого ключа не было никогда.
_ABSENT: Any = object()


def card(
    provider: str,
    kind: str,
    id: str,
    title: str,
    /,
    *,
    author: str = "",
    channelId: str | None = None,
    duration: float | None = None,
    live: bool = False,
    viewers: int | None = None,
    views: int | None = None,
    poster: str | None = None,
    followers: int | None = _ABSENT,
    description: str = _ABSENT,
    count: int | None = _ABSENT,
    category: str | None = _ABSENT,
    published: str | None = _ABSENT,
    badge: str = _ABSENT,
    shape: Literal["wide", "tall"] = _ABSENT,
    series: str = _ABSENT,
) -> Card:
    """Плитка каталога. Необязательные ключи попадают в неё, только если их передали."""
    built: dict[str, Any] = {
        "provider": provider,
        "kind": kind,
        "id": id,
        "title": title,
        "author": author,
        "channelId": channelId,
        "duration": duration,
        "live": live,
        "viewers": viewers,
        "views": views,
    }
    optional = {
        "followers": followers,
        "description": description,
        "count": count,
        "category": category,
        "published": published,
        "badge": badge,
        "shape": shape,
        "series": series,
    }
    built.update((key, value) for key, value in optional.items() if value is not _ABSENT)
    built["poster"] = poster
    return cast(Card, built)


def category_card(
    provider: str, id: str, title: str, /, *, viewers: int | None = None, poster: str | None = None
) -> CategoryCard:
    return {
        "provider": provider,
        "kind": "category",
        "id": id,
        "title": title,
        "viewers": viewers,
        "poster": poster,
    }


def channel_head(
    provider: str,
    id: str,
    title: str,
    /,
    *,
    handle: str = "",
    description: str = "",
    followers: int | None = None,
    viewers: int | None = None,
    live: bool = False,
    category: str | None = None,
    avatar: str | None = None,
    banner: str | None = None,
) -> ChannelHead:
    return {
        "provider": provider,
        "id": id,
        "title": title,
        "handle": handle,
        "description": description,
        "followers": followers,
        "viewers": viewers,
        "live": live,
        "category": category,
        "avatar": avatar,
        "banner": banner,
    }


def playlist_head(
    provider: str,
    id: str,
    title: str,
    /,
    *,
    author: str = "",
    channelId: str | None = None,
    description: str = "",
    count: int | None = None,
    views: int | None = None,
    published: str | None = None,
    poster: str | None = None,
) -> PlaylistHead:
    return {
        "provider": provider,
        "kind": "playlist",
        "id": id,
        "title": title,
        "author": author,
        "channelId": channelId,
        "description": description,
        "count": count,
        "views": views,
        "published": published,
        "poster": poster,
    }


def details(
    provider: str,
    kind: str,
    id: str,
    title: str,
    /,
    *,
    author: str = "",
    channelId: str | None = None,
    channelAvatar: str | None = None,
    duration: float | None = None,
    live: bool = False,
    views: int | None = None,
    viewers: int | None = None,
    followers: int | None = None,
    published: str | None = None,
    category: str | None = None,
    description: str = "",
    poster: str | None = None,
    series: str = _ABSENT,
) -> Details:
    built: dict[str, Any] = {
        "provider": provider,
        "kind": kind,
        "id": id,
        "title": title,
        "author": author,
        "channelId": channelId,
        "channelAvatar": channelAvatar,
        "duration": duration,
        "live": live,
        "views": views,
        "viewers": viewers,
        "followers": followers,
        "published": published,
        "category": category,
        "description": description,
        "poster": poster,
    }
    # Ключ новый и есть не у всех: у YouTube и Twitch страница ролика — прежние шестнадцать.
    if series is not _ABSENT:
        built["series"] = series
    return cast(Details, built)


def series_head(
    id: str,
    title: str,
    /,
    *,
    poster: str | None = None,
    description: str = "",
    year: int | None = None,
    seasons: list[Season] | None = None,
) -> SeriesHead:
    return {
        "id": id,
        "title": title,
        "poster": poster,
        "description": description,
        "year": year,
        "seasons": list(seasons or []),
    }


def channel_details(head: ChannelHead, /, *, title: str, poster: str | None) -> ChannelDetails:
    """
    Страница эфира — это шапка его канала плюс ключи страницы ролика.

    Название и кадр — у эфира, если он идёт, а автор, лицо и адрес — у канала: страница одна и
    та же, идёт эфир или канал молчит.
    """
    return cast(
        ChannelDetails,
        {
            **head,
            "kind": "channel",
            "title": title,
            "author": head["title"],
            "channelId": head["id"],
            "channelAvatar": head["avatar"],
            "duration": None,
            "views": None,
            "published": None,
            "poster": poster,
        },
    )
