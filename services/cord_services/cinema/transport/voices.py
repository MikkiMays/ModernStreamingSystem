"""
Одна группа звука в мастере HLS: звук не меняет кодек и адрес при каждой смене качества картинки.

ПОЧЕМУ. YouTube кладёт в мастер две группы звука с одинаковым набором дорожек: `233` — HE-AAC
(`mp4a.40.5`, около 48 кбит/с) у ступеней 144p и одной из 240p, `234` — AAC-LC (`mp4a.40.2`, около
130 кбит/с) у остальных. Ступень картинки тянет за собой свою группу, поэтому каждый переход автоматики
через границу 240p/360p — это и смена дорожки звука: hls.js обрывает её загрузку, выбрасывает
незагруженное и спрашивает тот же звук по другому адресу, а декодер перестраивается с HE-AAC на AAC-LC.
Ровно такой переход и случается после перемотки на слабом канале: автоматика уходит вниз, потом вверх. Сам
YouTube звук от картинки не зависит — дорожка одна на весь просмотр.

ЧТО ДЕЛАЕТСЯ. Остаётся одна группа — AAC-LC (её понимает любой браузер и любой телевизор), а при равенстве
— та, на которую ссылается больше ступеней. Ступень другой группы, у которой есть двойник той же высоты,
кадра и кодека картинки в оставшейся, уходит; без двойника — переезжает в оставшуюся группу, и её
`BANDWIDTH` растёт на разницу звука (по парам двойников). Мастер, где группы различаются набором дорожек
(языков), не трогается вовсе: склеивать их — значило бы потерять озвучку.
"""

from __future__ import annotations

import re
from statistics import median

# Пары `КЛЮЧ=значение` списка атрибутов HLS: значение — строка в кавычках (в ней бывают запятые) или токен.
_PAIR = re.compile(r'([A-Z0-9-]+)=("[^"]*"|[^",]*)')
# Кодеки звука в `CODECS` ступени (всё остальное — картинка).
_SOUND = ("mp4a", "ac-3", "ec-3", "opus", "flac", "mp3", "alac", "dtsc", "dtse", "ac-4")
# AAC-LC: его декодирует всё, что вообще играет HLS.
_LC = "mp4a.40.2"


def _attributes(line: str) -> list[tuple[str, str]]:
    return _PAIR.findall(line.partition(":")[2])


def _value(pairs: list[tuple[str, str]], key: str) -> str | None:
    for name, value in pairs:
        if name == key:
            return value.strip('"')
    return None


def _render(tag: str, pairs: list[tuple[str, str]]) -> str:
    return tag + ":" + ",".join(f"{name}={value}" for name, value in pairs)


def _codecs(pairs: list[tuple[str, str]]) -> tuple[list[str], list[str]]:
    """Кодеки ступени: картинка и звук по отдельности."""
    found = [codec.strip() for codec in (_value(pairs, "CODECS") or "").split(",") if codec.strip()]
    sound = [codec for codec in found if codec.lower().startswith(_SOUND)]
    return [codec for codec in found if codec not in sound], sound


def one_audio_group(body: str) -> str:
    """Мастер HLS с одной группой звука — или тот же мастер, если склеивать нечего или нельзя."""
    lines = body.splitlines()
    tracks: dict[str, set[tuple[str, str]]] = {}
    for line in lines:
        if line.startswith("#EXT-X-MEDIA:"):
            pairs = _attributes(line)
            group = _value(pairs, "GROUP-ID")
            if _value(pairs, "TYPE") == "AUDIO" and group is not None:
                identity = (_value(pairs, "NAME") or "", _value(pairs, "LANGUAGE") or "")
                tracks.setdefault(group, set()).add(identity)
    if len(tracks) < 2 or len({frozenset(found) for found in tracks.values()}) != 1:
        return body
    # Ступени: номер строки тега, её атрибуты, группа, кодеки картинки и звука.
    variants = []
    for number, line in enumerate(lines):
        if line.startswith("#EXT-X-STREAM-INF:"):
            pairs = _attributes(line)
            group = _value(pairs, "AUDIO")
            if group is None or group not in tracks:
                return body
            video, sound = _codecs(pairs)
            variants.append((number, pairs, group, video, sound))
    if not variants:
        return body
    sounds = {group: next((v[4] for v in variants if v[2] == group and v[4]), []) for group in tracks}
    uses = {group: sum(1 for v in variants if v[2] == group) for group in tracks}
    kept = max(tracks, key=lambda group: (_LC in sounds[group], uses[group]))

    def shape(pairs: list[tuple[str, str]], video: list[str]) -> tuple:
        return (
            _value(pairs, "RESOLUTION"),
            _value(pairs, "FRAME-RATE"),
            _value(pairs, "VIDEO-RANGE"),
            tuple(codec.split(".")[0] for codec in video),
        )

    bandwidth = {}
    for number, pairs, group, video, _ in variants:
        bandwidth.setdefault((group, shape(pairs, video)), int(_value(pairs, "BANDWIDTH") or 0))
    # Разница звука — по двойникам: та же картинка в двух группах.
    deltas = {
        group: [
            bandwidth[(kept, key)] - value
            for (owner, key), value in bandwidth.items()
            if owner == group and (kept, key) in bandwidth
        ]
        for group in tracks
        if group != kept
    }
    replaced: dict[int, str | None] = {}
    for number, pairs, group, video, sound in variants:
        if group == kept:
            continue
        if (kept, shape(pairs, video)) in bandwidth:
            replaced[number] = None
            continue
        extra = int(median(deltas[group])) if deltas[group] else 0
        moved = []
        for name, value in pairs:
            if name == "AUDIO":
                value = f'"{kept}"'
            elif name in ("BANDWIDTH", "AVERAGE-BANDWIDTH") and value.isdigit():
                value = str(max(1, int(value) + extra))
            elif name == "CODECS" and sound and sounds[kept]:
                value = '"' + ",".join([*video, *sounds[kept]]) + '"'
            moved.append((name, value))
        replaced[number] = _render("#EXT-X-STREAM-INF", moved)
    result = []
    skip = False
    for number, line in enumerate(lines):
        if skip and line and not line.startswith("#"):
            # Адрес ступени, которая ушла, — следующая непустая строка без `#`.
            skip = False
            continue
        if line.startswith("#EXT-X-MEDIA:"):
            pairs = _attributes(line)
            if _value(pairs, "TYPE") == "AUDIO" and _value(pairs, "GROUP-ID") != kept:
                continue
        if number in replaced:
            if replaced[number] is None:
                skip = True
                continue
            line = replaced[number]
        result.append(line)
    return "\n".join(result) + ("\n" if body.endswith("\n") else "")
