"""Static DASH from indexed MP4 tracks. Never guess initialization or media ranges."""

from __future__ import annotations

import asyncio
import math
import re
import struct
from collections import defaultdict
from xml.etree import ElementTree as ET

import httpx

MAX_PREFIX = 1024 * 1024
NS = "urn:mpeg:dash:schema:mpd:2011"
ET.register_namespace("", NS)


def mp4_ranges(data: bytes, total_bytes: int | None = None):
    """Return init/index inclusive ranges, None for incomplete prefix, reject invalid MP4."""
    offset = 0
    ftyp = False
    init_end = None
    while offset + 8 <= len(data):
        size, kind = struct.unpack_from(">I4s", data, offset)
        header = 8
        if size == 1:
            if offset + 16 > len(data):
                return None
            size = struct.unpack_from(">Q", data, offset + 8)[0]
            header = 16
        if size < header or size > MAX_PREFIX:
            raise ValueError("Invalid or oversized MP4 box")
        end = offset + size
        if kind in (b"mdat", b"moof"):
            raise ValueError("No index before media")
        if end > len(data):
            return None
        if kind == b"ftyp":
            ftyp = True
        elif kind == b"moov":
            if not ftyp:
                raise ValueError("Missing file type")
            init_end = end - 1
        elif kind == b"sidx":
            if init_end is None:
                raise ValueError("Missing initialization")
            body = data[offset + header : end]
            if len(body) < 24 or body[0] not in (0, 1):
                raise ValueError("Invalid segment index")
            version = body[0]
            count_at = 22 if version == 0 else 30
            if len(body) < count_at + 2 or struct.unpack_from(">I", body, 8)[0] == 0:
                raise ValueError("Invalid segment timescale")
            count = struct.unpack_from(">H", body, count_at)[0]
            if not count or len(body) != count_at + 2 + 12 * count:
                raise ValueError("Invalid segment references")
            referenced_bytes = 0
            for pos in range(count_at + 2, len(body), 12):
                reference, duration = struct.unpack_from(">II", body, pos)
                if reference >> 31 or not reference or not duration:
                    raise ValueError("Unsupported nested or empty index")
                referenced_bytes += reference
            first_offset = struct.unpack_from(
                ">I" if version == 0 else ">Q", body, 16 if version == 0 else 20
            )[0]
            if total_bytes is not None and end + first_offset + referenced_bytes > total_bytes:
                raise ValueError("Segment references exceed resource size")
            return (0, init_end), (offset, end - 1)
        offset = end
    return None


async def read_ranges(client: httpx.AsyncClient, url: str, semaphore: asyncio.Semaphore):
    """Bound every read, reject range-ignoring servers and redirects before following them."""
    async with semaphore:
        size = 64 * 1024
        while size <= MAX_PREFIX:
            async with client.stream(
                "GET",
                url,
                headers={"Range": f"bytes=0-{size - 1}", "Accept-Encoding": "identity"},
                follow_redirects=False,
            ) as response:
                match = re.fullmatch(
                    r"bytes 0-(\d+)/(\d+)", response.headers.get("content-range", "")
                )
                if response.status_code != 206 or not match:
                    raise ValueError("Upstream did not honor bounded range")
                end, total = map(int, match.groups())
                if end >= size or end >= total or end < 0:
                    raise ValueError("Invalid upstream range")
                data = bytearray()
                async for chunk in response.aiter_bytes(16384):
                    data.extend(chunk)
                    if len(data) > size:
                        raise ValueError("Range body exceeded budget")
                if len(data) != end + 1:
                    raise ValueError("Truncated range response")
            found = mp4_ranges(bytes(data), total)
            if found:
                return found
            if len(data) < size:
                break
            size *= 2
    raise ValueError("No MP4 index within bounded prefix")


def number(value, default=0):
    try:
        result = float(value)
        return result if math.isfinite(result) and result >= 0 else default
    except (ValueError, TypeError):
        return default


def codec_group(codec: str) -> str:
    """Keep decoder profiles/depth separate, not resolution-dependent codec levels.

    AVC Baseline/Main/Extended/High are conventional 8-bit 4:2:0; higher-bit-depth
    and chroma profiles stay separate. dash.js checks each full codec string and
    dimensions against the browser before selecting a representation.
    """
    parts = codec.split(".")
    if parts[0] == "avc1" and len(parts) == 2 and re.fullmatch(r"[0-9a-fA-F]{6}", parts[1]):
        profile = parts[1][:2].lower()
        return (
            "avc1.420-8" if profile in ("42", "4d", "58", "64") else f"avc1.{parts[1][:4].lower()}"
        )
    if parts[0] == "av01" and len(parts) >= 4:
        return ".".join([parts[0], parts[1], parts[2][-1], *parts[3:]])
    if parts[0] == "vp09" and len(parts) >= 4:
        return ".".join([parts[0], parts[1], *parts[3:]])
    return codec


def candidates(formats: list[dict]) -> list[dict]:
    groups = {}
    for item in formats:
        if (
            not item.get("url")
            or item.get("protocol") not in ("http", "https")
            or item.get("ext") not in ("mp4", "m4a")
            or item.get("has_drm")
        ):
            continue
        video, audio = item.get("vcodec") or "none", item.get("acodec") or "none"
        if (
            audio == "none"
            and video.startswith(("avc1.", "av01.", "vp09."))
            and number(item.get("height"))
        ):
            key = (
                "video",
                codec_group(video),
                number(item.get("height")),
                number(item.get("fps")),
                item.get("dynamic_range") or "SDR",
            )
        elif video == "none" and audio.startswith("mp4a."):
            key = ("audio", audio, item.get("language") or "und")
        else:
            continue
        bitrate = number(item.get("tbr") or item.get("abr"))
        if key not in groups or bitrate > number(groups[key].get("tbr") or groups[key].get("abr")):
            groups[key] = item
    # Bound work per resolve while reserving room for audio and each video's codec ladder.
    videos = [v for k, v in groups.items() if k[0] == "video"]
    audios = [v for k, v in groups.items() if k[0] == "audio"]
    videos.sort(
        key=lambda item: (
            number(item.get("height")),
            number(item.get("fps")),
            number(item.get("tbr")),
        ),
        reverse=True,
    )
    audios.sort(
        key=lambda item: (
            not (
                str(item.get("language", "")).endswith("-orig")
                or "original" in str(item.get("format_note", "")).lower()
            )
        )
    )
    return videos[:40] + audios[:24]


def manifest(tracks: list[tuple], duration: float) -> str:
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("Invalid duration")

    def tag(name):
        return f"{{{NS}}}{name}"

    root = ET.Element(
        tag("MPD"),
        {
            "type": "static",
            "profiles": "urn:mpeg:dash:profile:isoff-on-demand:2011",
            "minBufferTime": "PT1.5S",
            "mediaPresentationDuration": f"PT{duration:g}S",
        },
    )
    period = ET.SubElement(root, tag("Period"), {"start": "PT0S"})
    groups = defaultdict(list)
    for track in tracks:
        item = track[0]
        audio = item.get("vcodec") in (None, "none")
        codec = item["acodec" if audio else "vcodec"]
        groups[
            (
                "audio" if audio else "video",
                codec if audio else codec_group(codec),
                (item.get("language") or "und") if audio else (item.get("dynamic_range") or "SDR"),
            )
        ].append(track)
    if not any(k[0] == "video" for k in groups) or not any(k[0] == "audio" for k in groups):
        raise ValueError("DASH needs both audio and video")
    for index, ((kind, _, language), group) in enumerate(groups.items()):
        attrs = {
            "id": str(index),
            "contentType": kind,
            "mimeType": f"{kind}/mp4",
            "segmentAlignment": "true",
        }
        if kind == "audio":
            attrs["lang"] = language.removesuffix("-orig")
        adaptation = ET.SubElement(period, tag("AdaptationSet"), attrs)
        if kind == "audio" and any(
            str(item.get("language", "")).endswith("-orig")
            or "original" in str(item.get("format_note", "")).lower()
            for item, _, _ in group
        ):
            ET.SubElement(
                adaptation, tag("Role"), {"schemeIdUri": "urn:mpeg:dash:role:2011", "value": "main"}
            )
            ET.SubElement(adaptation, tag("Label")).text = f"{attrs['lang']} - original"
        for n, (item, (initialization, segment_index), url) in enumerate(group):
            attrs = {
                "id": f"{index}-{n}",
                "codecs": item["acodec" if kind == "audio" else "vcodec"],
                "bandwidth": str(
                    max(1, int(number(item.get("tbr") or item.get("abr"), 128) * 1000))
                ),
            }
            if kind == "video":
                attrs.update(
                    width=str(int(number(item.get("width")))),
                    height=str(int(number(item.get("height")))),
                )
                if number(item.get("fps")):
                    attrs["frameRate"] = f"{number(item['fps']):g}"
            representation = ET.SubElement(adaptation, tag("Representation"), attrs)
            ET.SubElement(representation, tag("BaseURL")).text = url
            base = ET.SubElement(
                representation,
                tag("SegmentBase"),
                {
                    "indexRange": f"{segment_index[0]}-{segment_index[1]}",
                    "indexRangeExact": "true",
                },
            )
            ET.SubElement(
                base,
                tag("Initialization"),
                {"range": f"{initialization[0]}-{initialization[1]}"},
            )
    return ET.tostring(root, encoding="unicode", xml_declaration=True)
