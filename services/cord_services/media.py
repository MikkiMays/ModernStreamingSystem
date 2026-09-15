from __future__ import annotations

import asyncio
import contextlib
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
    """Ends a decoder and waits for it to be gone — without waiting forever.

    ЗАЧЕМ. Signalling the process is not enough. asyncio completes `wait()` only after
    every pipe transport has disconnected, and the stdout transport is paused whenever
    its reader is full — which here it always is, because ffmpeg decodes far faster than
    a room plays. After a pause, a seek or a skip nobody reads that pipe again, so the
    paused transport never sees the end of the stream, `wait()` never returns, and the
    playback loop stops for good: the room went silent on the first pause and stayed
    silent. Draining the pipe is what closes it.
    """
    if process.returncode is None:
        with contextlib.suppress(ProcessLookupError):
            process.terminate()
    try:
        await asyncio.wait_for(process.communicate(), 2)
    except TimeoutError:
        with contextlib.suppress(ProcessLookupError):
            process.kill()
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(process.communicate(), 2)


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
