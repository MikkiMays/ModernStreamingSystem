"""
Чужой манифест DASH «по требованию» — нашим манифестом, где у каждой дорожки наш подписанный адрес.

ЗАЧЕМ. Плеер страницы бывает на DASH (у OK.ru — только он): манифест по требованию (on-demand) перечисляет
дорожки, у каждой один файл и одна пара диапазонов — начало файла (`Initialization`) и его индекс кусочков
(`SegmentBase indexRange`). Остальное плеер находит по индексу сам. Ровно такой манифест наш плеер уже играет
у YouTube (`cord_services/dash.py`), и ему нужно одно: адрес каждой дорожки — наш, подписанный, с профилем
потока (`sniffer.Profile`), чтобы диапазоны байт шли к сайту через прокси с заголовками его плеера.

ЧУЖОЕ НЕ ПЕРЕПИСЫВАЕТСЯ, А ПЕРЕСОБИРАЕТСЯ. Манифест прислал сайт, которого вставил любой участник: из него
берутся только проверенные значения (вид, кодеки, размеры, битрейт, язык, диапазоны — формой и числами), и
манифест строится заново (`manifest`). Ни одного чужого элемента или атрибута в ответе нет: ни ссылок наружу,
ни событий, ни шаблонов адресов. Читается не больше `LIMIT` (expat Python держит «миллиард смехов» сам, а
внешних сущностей ElementTree не читает вовсе).

ЧЕГО ЗДЕСЬ НЕТ. Манифест с шаблоном или списком кусочков (`SegmentTemplate`, `SegmentList`), живой
(`dynamic`) и из нескольких периодов — `NotOnDemand`: такие наш плеер пока не собирает, и это честный отказ.
`ContentProtection` где угодно — `Protected`: DRM не обходится.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable
from urllib.parse import urljoin
from xml.etree import ElementTree as ET

from . import address

# Больше манифест по требованию не бывает: дорожек — десятки, строк — сотни.
LIMIT = 1024 * 1024
TRACKS = 32
NS = "urn:mpeg:dash:schema:mpd:2011"
MIMES = frozenset({"video/mp4", "video/webm", "audio/mp4", "audio/webm"})
CODECS = re.compile(r"[A-Za-z0-9.+\-]{1,64}")
LANGUAGE = re.compile(r"[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,2}")
FRAME_RATE = re.compile(r"[0-9]{1,4}(?:/[0-9]{1,5})?")
RANGE = re.compile(r"([0-9]{1,12})-([0-9]{1,12})")
DURATION = re.compile(
    r"P(?:(?P<days>[0-9]+)D)?(?:T(?:(?P<hours>[0-9]+)H)?(?:(?P<minutes>[0-9]+)M)?(?:(?P<seconds>[0-9.]+)S)?)?"
)
ON_DEMAND = "urn:mpeg:dash:profile:isoff-on-demand:2011"
WEBM_ON_DEMAND = "urn:webm:dash:profile:webm-on-demand:2012"
# Уровни VP9 по размеру кадра (яркость, пикселей): уровень → предел. Нужны, чтобы назвать кодек полностью
# (`spelled`).
VP9_LEVELS = ((21, 245_760), (31, 983_040), (41, 2_228_224), (51, 8_912_896), (61, 35_651_584))


class NotOnDemand(Exception):
    """Манифест не «по требованию» (шаблоны, список кусочков, эфир, периоды) или в нём нечего играть."""


class Protected(Exception):
    """В манифесте `ContentProtection`: это DRM."""


@dataclass(frozen=True)
class Track:
    kind: str
    mime: str
    codecs: str
    bandwidth: int
    url: str
    initialization: tuple[int, int]
    index: tuple[int, int]
    group: int
    width: int | None = None
    height: int | None = None
    frame_rate: str | None = None
    language: str | None = None
    timescale: int | None = None


def _name(element: ET.Element) -> str:
    """Имя элемента без пространства имён: у сайтов оно пишется по-разному (`MPD:2011` и `mpd:2011`)."""
    return element.tag.rsplit("}", 1)[-1]


def _children(element: ET.Element, name: str) -> list[ET.Element]:
    return [child for child in element if _name(child) == name]


def _base(element: ET.Element, url: str) -> str:
    found = _children(element, "BaseURL")
    return urljoin(url, (found[0].text or "").strip()) if found else url


def _span(value: str | None) -> tuple[int, int] | None:
    found = RANGE.fullmatch((value or "").strip())
    if not found:
        return None
    start, end = int(found[1]), int(found[2])
    return (start, end) if start <= end else None


def _integer(value: str | None, *, top: int) -> int | None:
    text = (value or "").strip()
    return int(text) if text.isdigit() and 0 < int(text) <= top else None


def duration(value: str | None) -> float | None:
    """`mediaPresentationDuration` (`PT132.655S`, `PT1H2M3S`) — в секундах, или `None`."""
    found = DURATION.fullmatch((value or "").strip())
    if not found or not any(found.groupdict().values()):
        return None
    parts = {key: float(number) for key, number in found.groupdict().items() if number}
    try:
        seconds = (
            parts.get("days", 0) * 86400
            + parts.get("hours", 0) * 3600
            + parts.get("minutes", 0) * 60
            + parts.get("seconds", 0)
        )
    except ValueError:
        return None
    return seconds if 0 < seconds < 7 * 86400 else None


def parse(text: str, url: str) -> tuple[list[Track], float]:
    """Дорожки манифеста по требованию и его длительность — или `NotOnDemand`/`Protected`."""
    if len(text) > LIMIT:
        raise NotOnDemand("манифест больше предела")
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        raise NotOnDemand("манифест не разобрать") from None
    if _name(root) != "MPD":
        raise NotOnDemand("это не манифест DASH")
    if any(_name(element) == "ContentProtection" for element in root.iter()):
        raise Protected()
    listed = ("SegmentTemplate", "SegmentList", "SegmentTimeline")
    if any(_name(element) in listed for element in root.iter()):
        raise NotOnDemand("кусочки по шаблону или списком")
    if (root.get("type") or "static") != "static":
        raise NotOnDemand("живой эфир")
    periods = _children(root, "Period")
    if len(periods) != 1:
        raise NotOnDemand("не один период")
    seconds = duration(root.get("mediaPresentationDuration")) or duration(periods[0].get("duration"))
    if seconds is None:
        raise NotOnDemand("у манифеста нет длительности")
    base = _base(periods[0], _base(root, url))
    tracks: list[Track] = []
    for group, adaptation in enumerate(_children(periods[0], "AdaptationSet")):
        shared = _base(adaptation, base)
        for representation in _children(adaptation, "Representation"):
            track = _track(adaptation, representation, shared, group)
            if track is not None and len(tracks) < TRACKS:
                tracks.append(track)
    if not tracks:
        raise NotOnDemand("в манифесте нет дорожек по требованию")
    return tracks, seconds


def _track(adaptation: ET.Element, representation: ET.Element, base: str, group: int) -> Track | None:
    """Одна дорожка — только если всё в ней проверено; иначе её нет."""

    def attribute(name: str) -> str | None:
        return representation.get(name) or adaptation.get(name)

    mime = (attribute("mimeType") or "").strip().lower()
    codecs = (attribute("codecs") or "").strip()
    if mime not in MIMES or not CODECS.fullmatch(codecs):
        return None
    url = _base(representation, base)
    if not address.web(url):
        return None
    segment = (_children(representation, "SegmentBase") or _children(adaptation, "SegmentBase") or [None])[0]
    if segment is None:
        return None
    index = _span(segment.get("indexRange"))
    initialization = _span(next((item.get("range") for item in _children(segment, "Initialization")), None))
    bandwidth = _integer(representation.get("bandwidth"), top=1_000_000_000)
    if index is None or initialization is None or bandwidth is None:
        return None
    kind = mime.split("/", 1)[0]
    frame_rate = (attribute("frameRate") or "").strip()
    language = (adaptation.get("lang") or "").strip()
    return Track(
        kind=kind,
        mime=mime,
        codecs=codecs,
        bandwidth=bandwidth,
        url=url,
        initialization=initialization,
        index=index,
        group=group,
        width=_integer(attribute("width"), top=16384) if kind == "video" else None,
        height=_integer(attribute("height"), top=16384) if kind == "video" else None,
        frame_rate=frame_rate if kind == "video" and FRAME_RATE.fullmatch(frame_rate) else None,
        language=language if LANGUAGE.fullmatch(language) else None,
        timescale=_integer(segment.get("timescale"), top=10_000_000),
    )


def spelled(track: Track) -> str:
    """
    Кодек дорожки так, как его поймёт проверка браузера. `vp9` без профиля и уровня WebM DASH пишет сплошь и
    рядом (у OK.ru — только так), а Chromium называет такую строку неоднозначной: `MediaCapabilities`
    отвечает «не поддерживается», и dash.js выбрасывает все дорожки с картинкой — остаётся один звук. Полная
    запись — профиль 0 и 8 бит (это и есть `vp9` в WebM без уточнений), уровень — по размеру кадра.
    """
    if track.codecs.lower() != "vp9":
        return track.codecs
    size = (track.width or 1920) * (track.height or 1080)
    level = next((level for level, limit in VP9_LEVELS if size <= limit), 62)
    return f"vp09.00.{level}.08"


def manifest(tracks: list[Track], seconds: float, sign: Callable[[str], str]) -> str:
    """Наш манифест: те же дорожки и диапазоны, у каждой — подписанный адрес (`sign`)."""

    def tag(name: str) -> str:
        return f"{{{NS}}}{name}"

    webm = {track.mime.endswith("/webm") for track in tracks}
    profiles = ",".join(
        profile for flag, profile in ((False, ON_DEMAND), (True, WEBM_ON_DEMAND)) if flag in webm
    )
    root = ET.Element(
        tag("MPD"),
        {
            "type": "static",
            "profiles": profiles,
            "minBufferTime": "PT1.5S",
            "mediaPresentationDuration": f"PT{seconds:g}S",
        },
    )
    period = ET.SubElement(root, tag("Period"), {"start": "PT0S"})
    groups: dict[tuple[int, str], list[Track]] = {}
    for track in tracks:
        groups.setdefault((track.group, track.mime), []).append(track)
    for number, ((_, mime), members) in enumerate(groups.items()):
        attrs = {"id": str(number), "contentType": members[0].kind, "mimeType": mime}
        if members[0].language:
            attrs["lang"] = members[0].language
        adaptation = ET.SubElement(period, tag("AdaptationSet"), attrs)
        for index, track in enumerate(members):
            fields = {"id": f"{number}-{index}", "codecs": spelled(track), "bandwidth": str(track.bandwidth)}
            if track.width and track.height:
                fields.update(width=str(track.width), height=str(track.height))
            if track.frame_rate:
                fields["frameRate"] = track.frame_rate
            representation = ET.SubElement(adaptation, tag("Representation"), fields)
            ET.SubElement(representation, tag("BaseURL")).text = sign(track.url)
            segment = {"indexRange": f"{track.index[0]}-{track.index[1]}", "indexRangeExact": "true"}
            if track.timescale:
                segment["timescale"] = str(track.timescale)
            base = ET.SubElement(representation, tag("SegmentBase"), segment)
            start, end = track.initialization
            ET.SubElement(base, tag("Initialization"), {"range": f"{start}-{end}"})
    return ET.tostring(root, encoding="unicode", xml_declaration=True)
