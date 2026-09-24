"""Курсор листания и порция уже полученного списка: как ответ каталога режется на страницы."""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException


# Сколько карточек отдаётся за один раз. Столько же YouTube кладёт в одно продолжение своей
# ленты, поэтому страница каталога и порция площадки совпадают — лишних запросов не бывает.
PAGE = 30
# Сколько роликов ищется в глубину: поиск площадка отдаёт целиком, и листание по нему уже
# ничего наружу не стоит. Два-три экрана — ровно столько, сколько долистывают.
SEARCH_DEPTH = 60
# Верхняя граница листания. Не защита от человека, а защита от заблудившегося запроса:
# `playliststart` в десять тысяч заставил бы yt-dlp пройти триста продолжений подряд.
MAX_OFFSET = 600


def offset_of(cursor: str | None) -> int:
    """
    Курсор — это место в ленте, и наружу он уходит строкой.

    Клиент передаёт его обратно, не разбирая: сегодня это номер карточки, и обеим площадкам
    этого хватает. У YouTube листание настоящее (`playliststart` у продолжения ленты), у
    Twitch — по уже полученному списку: их GraphQL отвечает на продолжение отказом
    `failed integrity check`, если спрашивать анонимно, а `first: 100` отдаёт честно.
    """
    if not cursor:
        return 0
    if not cursor.isdigit() or int(cursor) > MAX_OFFSET:
        raise HTTPException(400, "Дальше листать нечего")
    return int(cursor)


def page(items: list[Any], offset: int, limit: int = PAGE) -> dict[str, Any]:
    """Порция уже полученного списка и место, с которого продолжать."""
    chunk = items[offset : offset + limit]
    return {"items": chunk, "next": str(offset + limit) if offset + limit < len(items) else None}


def absolute(url: str | None) -> str:
    """Адреса картинок у YouTube бывают без схемы (`//yt3.ggpht.com/…`) — с ней они в белом списке."""
    if not url:
        return ""
    return "https:" + url if url.startswith("//") else url
