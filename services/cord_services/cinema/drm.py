"""
DRM в потоке чужой страницы: где его видно и почему это отказ, а не попытка.

Кинозал защиту не обходит — это граница, а не недоделка: видео под DRM (Widevine, PlayReady,
FairPlay, SAMPLE-AES) браузер расшифровывает только ключом из лицензии площадки, и показать его
комнате нашим плеером, не взламывая защиту, нельзя. Поэтому такой поток — честный отказ словами
(`DRM`). AES-128 с открытым ключом — не DRM: это обычное шифрование кусочков HLS, ключ лежит рядом
по адресу, и плеер берёт его через наш же прокси, как любой другой кусочек (`playlists._attribute`).

У площадок каталога DRM видно в их API (Rutube — `drm_token`); у чужих страниц — только в самом
потоке: строки `#EXT-X-KEY`/`#EXT-X-SESSION-KEY` в HLS и `ContentProtection` в DASH. DASH помечает
сам yt-dlp (`has_drm` у формата с `ContentProtection`, и такие форматы он отбрасывает — отказ
делает `Resolver.settle` по `_has_drm`), а в HLS он видит не всё: `METHOD=SAMPLE-AES` и Widevine
пропускает, и в мастере ключей обычно нет вовсе — они в списках кусочков. Поэтому списки HLS
читаются здесь — несжатыми и не больше `TEXT_LIMIT`: список чужой, и прислать могут что угодно.
"""

from __future__ import annotations

import asyncio
import re
from typing import Callable
from urllib.parse import urljoin

import httpx
from fastapi import HTTPException

DRM = "Видео защищено DRM — показать комнате нельзя"

# KEYFORMAT систем DRM: идентификаторы систем защиты из реестра DASH-IF и имена Apple и Microsoft.
KEY_SYSTEMS = frozenset(
    {
        "com.apple.streamingkeydelivery",  # FairPlay
        "com.microsoft.playready",  # PlayReady
        "urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed",  # Widevine
        "urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95",  # PlayReady
        "urn:uuid:94ce86fb-07ff-4f43-adb8-93d2fa968ca2",  # FairPlay
    }
)
KEY_LINE = re.compile(r"^#EXT-X-(?:SESSION-)?KEY:(.*)$", re.MULTILINE)
ATTRIBUTE = re.compile(r'([A-Z0-9-]+)=("[^"]*"|[^,]*)')
# Столько читается у одного списка ради проверки: список кусочков фильма — единицы мегабайт.
TEXT_LIMIT = 4 * 1024 * 1024
CHECK_TIMEOUT = 10.0


def hls(text: str) -> bool:
    """Ключ DRM в плейлисте HLS: SAMPLE-AES, CENC, ключ FairPlay (`skd://`) или система DRM в KEYFORMAT."""
    if "#EXT-X-FAXS-CM:" in text:  # Adobe Access — то же, что DRM
        return True
    for line in KEY_LINE.findall(text):
        found = {name: value.strip('"') for name, value in ATTRIBUTE.findall(line)}
        method = found.get("METHOD", "").upper()
        if method.startswith("SAMPLE-AES") or method == "ISO-23001-7":
            return True
        if found.get("KEYFORMAT", "identity").strip().lower() in KEY_SYSTEMS:
            return True
        if found.get("URI", "").strip().lower().startswith("skd://"):
            return True
    return False


async def inspect_hls(net: httpx.AsyncClient, url: str, allows: Callable[[str], bool]) -> bool | None:
    """
    Мастер и первые из его списков — вариант качества и дорожка звука. Ключ DRM в них — отказ; кроме
    того, по ним видно, запись это или эфир: у эфира в списке кусочков нет конца (`#EXT-X-ENDLIST`)
    и нет пометки `VOD`. yt-dlp этого у чужой страницы не узнаёт (`generic` эфир не распознаёт), а
    комнате это важно: эфир не ставят на паузу и не перематывают.

    Не прочиталось — не отказ и не ответ (`None`): проверка не должна запирать поток, который играл
    бы; такой список всё равно проверит прокси, когда его спросит плеер (`Cinema.manifest`).
    """
    live: bool | None = None
    try:
        async with asyncio.timeout(CHECK_TIMEOUT):
            master = await _text(net, url, allows)
            if master is None:
                return None
            if hls(master[0]):
                raise HTTPException(403, DRM)
            if "#EXTINF" in master[0]:
                live = _live(master[0])
            for child in _children(*master)[:2]:
                found = await _text(net, child, allows)
                if found is None:
                    continue
                if hls(found[0]):
                    raise HTTPException(403, DRM)
                if live is None and "#EXTINF" in found[0]:
                    live = _live(found[0])
    except TimeoutError:
        pass
    return live


def _live(text: str) -> bool:
    return "#EXT-X-ENDLIST" not in text and "#EXT-X-PLAYLIST-TYPE:VOD" not in text


async def answers(net: httpx.AsyncClient, url: str, allows: Callable[[str], bool]) -> bool:
    """
    Отдаёт ли сайт этот файл вообще: один байт (`Range: bytes=0-0`), переадресация — каждым шагом по
    политике площадки, тело не читается. Страница с `<video>` перечисляет источники на выбор, и
    браузер берёт первый живой — мёртвый первый (у W3C это `www.w3.org/…/trailer.mp4`, 404) не должен
    доставаться комнате, когда рядом живой.
    """
    try:
        # Срок — на весь ответ с переадресацией, а не на каждый шаг: иначе четыре шага по десять
        # секунд и три источника давали бы две минуты ожидания.
        async with asyncio.timeout(CHECK_TIMEOUT):
            for _ in range(4):
                if not allows(url):
                    return False
                async with net.stream(
                    "GET",
                    url,
                    headers={"Range": "bytes=0-0", "Accept-Encoding": "identity"},
                    follow_redirects=False,
                ) as response:
                    if response.is_redirect and response.headers.get("location"):
                        url = urljoin(str(response.url), response.headers["location"])
                        continue
                    return response.status_code in (200, 206)
    except (httpx.HTTPError, TimeoutError):
        return False
    return False


def _children(text: str, base: str) -> list[str]:
    """Первый вариант качества и первая дорожка звука мастера — там, где лежат ключи кусочков."""
    found: list[str] = []
    lines = text.splitlines()
    for index, line in enumerate(lines):
        if line.startswith("#EXT-X-STREAM-INF"):
            following = next(
                (item.strip() for item in lines[index + 1 :] if item.strip() and not item.startswith("#")), ""
            )
            if following:
                found.append(urljoin(base, following))
                break
    for line in lines:
        if line.startswith("#EXT-X-MEDIA:") and "TYPE=AUDIO" in line and 'URI="' in line:
            found.append(urljoin(base, line.partition('URI="')[2].partition('"')[0]))
            break
    return found


async def _text(net: httpx.AsyncClient, url: str, allows: Callable[[str], bool]) -> tuple[str, str] | None:
    """
    Текст списка и его настоящий адрес — переадресацию проходит сам, каждый шаг по политике площадки.

    Список спрашивается несжатым, и сжатый вопреки просьбе не читается вовсе: httpx распаковывает
    тело кусками, и один кусок сжатой «бомбы» — это десятки мегабайт ещё до проверки предела. Поэтому
    прочитанные байты — ровно те, что пришли по сети, и их не больше `TEXT_LIMIT`.
    """
    for _ in range(4):
        if not allows(url):
            return None
        try:
            async with net.stream(
                "GET", url, headers={"Accept-Encoding": "identity"}, follow_redirects=False
            ) as response:
                if response.is_redirect and response.headers.get("location"):
                    url = urljoin(str(response.url), response.headers["location"])
                    continue
                encoding = response.headers.get("content-encoding", "identity").strip().lower()
                if response.status_code != 200 or encoding not in ("", "identity"):
                    return None
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > TEXT_LIMIT:
                        return None
                return body.decode("utf-8", errors="replace"), str(response.url)
        except httpx.HTTPError:
            return None
    return None
