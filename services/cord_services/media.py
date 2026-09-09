from __future__ import annotations

import asyncio
import json
import math
from pathlib import Path

from fastapi import HTTPException

AUDIO_FORMATS = {
    "mp3",
    "wav",
    "ogg",
    "flac",
    "aac",
    "mov",
    "mp4",
    "m4a",
    "3gp",
    "3g2",
    "mj2",
    "matroska",
    "webm",
}
MAX_FILE = 50 * 1024 * 1024
MAX_ROOM = 512 * 1024 * 1024
MAX_TOTAL = 2 * 1024 * 1024 * 1024


async def stop_process(process: asyncio.subprocess.Process):
    if process.returncode is None:
        try:
            process.terminate()
        except ProcessLookupError:
            pass
        try:
            await asyncio.wait_for(process.wait(), 2)
        except TimeoutError:
            process.kill()
            await process.wait()


async def probe(path: Path) -> dict:
    process = await asyncio.create_subprocess_exec(
        "ffprobe",
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-select_streams",
        "a:0",
        "-show_entries",
        "format=duration,format_name:format_tags=title,artist:stream=codec_type",
        "-of",
        "json",
        str(path),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        output, _ = await asyncio.wait_for(process.communicate(), 12)
        if process.returncode or len(output) > 65536:
            raise ValueError()
        data = json.loads(output)
        duration = float(data.get("format", {}).get("duration", 0))
        formats = set(data.get("format", {}).get("format_name", "").split(","))
        if (
            not data.get("streams")
            or not math.isfinite(duration)
            or not 0 < duration <= 3600
            or not formats.intersection(AUDIO_FORMATS)
        ):
            raise ValueError()
        tags = data.get("format", {}).get("tags", {})
        return {
            "duration": duration,
            "title": str(tags.get("title", ""))[:180],
            "artist": str(tags.get("artist", ""))[:120],
        }
    except (ValueError, TimeoutError):
        raise HTTPException(
            400,
            "Нужен аудиофайл длительностью до 60 минут: MP3, M4A, OGG, WAV, FLAC или WebM",
        ) from None
    finally:
        await stop_process(process)


async def decoder(path: Path, position: float):
    return await asyncio.create_subprocess_exec(
        "ffmpeg",
        "-nostdin",
        "-v",
        "error",
        "-threads",
        "1",
        "-protocol_whitelist",
        "file,pipe",
        "-ss",
        str(max(0, position)),
        "-i",
        str(path),
        "-vn",
        "-map",
        "0:a:0",
        "-ac",
        "2",
        "-ar",
        "48000",
        "-f",
        "s16le",
        "pipe:1",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
        limit=16384,
    )
