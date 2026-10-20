"""Обложки треков: квадратный JPEG рядом со звуком (T18).

ЗАЧЕМ СВОЙ ФАЙЛ, А НЕ АДРЕС ПЛОЩАДКИ. Браузер Cord картинки с чужих адресов не грузит вовсе (CSP:
`img-src 'self'`), и площадке незачем знать, кто во встрече смотрит на её обложку. Поэтому обложку
приносит служба — из встроенной картинки файла, обложки Яндекса или миниатюры YouTube и SoundCloud —
один раз, при добавлении трека, и дальше отдаёт со своего адреса.

ПОЧЕМУ ЧЕРЕЗ FFMPEG. Картинка чужая: PNG, WebP, JPEG с метаданными, встроенный кадр MP3. Перекодировать
её в один вид — значит отдать браузеру только то, что сделали мы сами: 320×320, JPEG, без метаданных
и без того, что было в исходнике сверх картинки. ffmpeg и так разбирает каждый принесённый трек.
"""

from __future__ import annotations

import asyncio
import uuid
from pathlib import Path

from .media import stop_process

# Сторона квадрата: вдвое больше самой крупной обложки панели (72 px на экране с плотностью 2).
SIDE = 320
# Больше этого исходную картинку не читаем: миниатюра площадки — десятки килобайт, а мегабайты
# «обложки» — это уже не обложка.
SOURCE_LIMIT = 4 * 1024 * 1024
# Имя обложки на диске и в адресе — новый UUID: не выводится ни из трека, ни из комнаты.
NAME = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg"


async def extract(source: Path, files: Path) -> str | None:
    """Обложка из картинки или из встроенного кадра аудиофайла — имя файла в `files` или `None`.

    Нет картинки, битая, ffmpeg не уложился в срок — обложки просто нет: трек без неё остаётся
    треком, и добавление из-за картинки не срывается.
    """
    name = f"{uuid.uuid4()}.jpg"
    target = files / name
    process = await asyncio.create_subprocess_exec(
        "ffmpeg",
        "-nostdin",
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        str(source),
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        "-vf",
        f"scale={SIDE}:{SIDE}:force_original_aspect_ratio=increase,crop={SIDE}:{SIDE}",
        "-q:v",
        "4",
        "-map_metadata",
        "-1",
        "-f",
        "mjpeg",
        "-y",
        str(target),
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        await asyncio.wait_for(process.wait(), 15)
    except TimeoutError:
        pass
    finally:
        await stop_process(process)
    if process.returncode != 0 or not target.is_file() or target.stat().st_size == 0:
        target.unlink(missing_ok=True)
        return None
    return name


async def from_bytes(data: bytes, files: Path) -> str | None:
    """Обложка из скачанной картинки: временный файл рядом, перекодирование, временный — прочь."""
    if not data or len(data) > SOURCE_LIMIT:
        return None
    temporary = files / f"{uuid.uuid4()}.source"
    try:
        temporary.write_bytes(data)
        return await extract(temporary, files)
    finally:
        temporary.unlink(missing_ok=True)


def files_of(track: dict) -> list[str]:
    """Что трек держит на диске: звук и, если есть, обложку."""
    return [track["file"]] + ([track["cover"]] if track.get("cover") else [])
