"""Дорожки субтитров, которых нет в самом потоке: выбор языка и готовый файл вместо
плейлиста из кусочков."""

from __future__ import annotations

import re
from typing import Any, Callable


# Сколько дорожек текста отдавать одному ролику. Двух десятков хватает даже тем, кого
# переводили всем светом: длиннее этого списка бывает только автоперевод, а его площадка
# нам всё равно не отдаёт.
CAPTIONS_LIMIT = 24

# Какие файлы субтитров маршрут `subtitles` умеет отдать браузеру WebVTT — в порядке предпочтения:
# готовый WebVTT, SRT (время через запятую) и TTML/DFXP (XML, его переводит yt-dlp).
SUBTITLE_FORMATS = ("vtt", "srt", "ttml", "dfxp", "xml")

# Строка времени реплики SRT: `00:00:07,120 --> 00:00:17,240`. Часы бывают и в одну цифру, доли
# секунды — короче трёх знаков; всё остальное в строке (положение реплики) остаётся как было.
_TIMING = re.compile(
    r"^\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})(.*)$"
)


def _stamp(hours: str, minutes: str, seconds: str, fraction: str) -> str:
    return f"{int(hours):02d}:{minutes}:{seconds}.{fraction.ljust(3, '0')}"


def webvtt(body: bytes) -> str:
    """
    Субтитры в WebVTT — единственном виде, который браузер читает тегом `<track>`.

    Площадки отдают текст и в SRT (Rutube — только в нём): это те же реплики, но другая первая
    строка и запятая вместо точки в долях секунды. Переводится ровно это, и только в строках
    времени: запятая в самой реплике остаётся запятой. WebVTT проходит как есть. Старые файлы
    бывают в Windows-1251 — такой файл читается ею, а не превращается в знаки вопроса. Чужие
    страницы («По ссылке») отдают и TTML/DFXP — XML с репликами: его yt-dlp переводит в SRT, и
    дальше путь тот же.
    """
    if _xml(body):
        # Файл, который не разбирается, — пустые субтитры, а не ошибка 500 посреди фильма.
        from yt_dlp.utils import dfxp2srt  # тяжёлый модуль: только если пришёл XML

        try:
            body = dfxp2srt(body).encode()
        except Exception:
            return "WEBVTT\n"
    try:
        text = body.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = body.decode("cp1251", errors="replace")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if text.startswith("WEBVTT"):
        return text
    lines = []
    for line in text.split("\n"):
        timing = _TIMING.match(line)
        if timing:
            start, end = _stamp(*timing.group(1, 2, 3, 4)), _stamp(*timing.group(5, 6, 7, 8))
            line = f"{start} --> {end}{timing.group(9)}"
        lines.append(line)
    return "WEBVTT\n\n" + "\n".join(lines).lstrip("\n")


def _xml(body: bytes) -> bool:
    """TTML/DFXP узнаётся по началу: SRT и WebVTT с `<` не начинаются никогда."""
    head = body[:512].lstrip(b"\xef\xbb\xbf \t\r\n")
    return head.startswith(b"<")


def _base_language(language: str) -> str:
    """`ko-orig`, `zh-Hans`, `en-US` — всё это один язык на выбор в меню."""
    return (language or "").split("-")[0].lower()


def _pick(
    entries: list[dict[str, Any]] | None,
    allows: Callable[[str], bool],
    formats: tuple[str, ...] = ("vtt",),
) -> dict[str, Any] | None:
    """
    Готовый файл субтитров, а не плейлист из кусочков.

    yt-dlp перечисляет один и тот же текст в нескольких видах (`json3`, `srv3`, `ttml`,
    `vtt`), а иногда — плейлистом HLS. Браузеру в `<track>` нужен ровно WebVTT одним файлом;
    то, что пришло плейлистом, лежит в мастере и достаётся плеером без нашей помощи.

    `formats` — какие виды годятся, в порядке предпочтения: у площадок каталога только WebVTT, у
    «По ссылке» — и то, что переводит маршрут `subtitles`. `allows` — политика хостов площадки:
    файл с чужого хоста прокси всё равно не откроет.
    """
    usable = [
        entry
        for entry in entries or []
        if entry.get("ext") in formats
        and entry.get("url")
        and not str(entry.get("protocol") or "").startswith("m3u8")
        and allows(entry["url"])
    ]
    usable.sort(key=lambda entry: formats.index(entry["ext"]))
    return usable[0] if usable else None
