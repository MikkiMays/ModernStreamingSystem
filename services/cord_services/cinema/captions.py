"""Дорожки субтитров, которых нет в самом потоке: выбор языка и готовый файл вместо
плейлиста из кусочков."""

from __future__ import annotations

from typing import Any

from .transport.signer import allowed


# Сколько дорожек текста отдавать одному ролику. Двух десятков хватает даже тем, кого
# переводили всем светом: длиннее этого списка бывает только автоперевод, а его площадка
# нам всё равно не отдаёт.
CAPTIONS_LIMIT = 24


def _base_language(language: str) -> str:
    """`ko-orig`, `zh-Hans`, `en-US` — всё это один язык на выбор в меню."""
    return (language or "").split("-")[0].lower()


def _vtt(entries: list[dict[str, Any]] | None) -> dict[str, Any] | None:
    """
    Готовый файл субтитров, а не плейлист из кусочков.

    yt-dlp перечисляет один и тот же текст в нескольких видах (`json3`, `srv3`, `ttml`,
    `vtt`), а иногда — плейлистом HLS. Браузеру в `<track>` нужен ровно WebVTT одним файлом;
    то, что пришло плейлистом, лежит в мастере и достаётся плеером без нашей помощи.
    """
    for entry in entries or []:
        if (
            entry.get("ext") == "vtt"
            and entry.get("url")
            and not str(entry.get("protocol") or "").startswith("m3u8")
            and allowed(entry["url"])
        ):
            return entry
    return None
