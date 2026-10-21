"""
Рекламные хосты — для «пропустить рекламу» кинозала (E07, T17): разрывы `DISCONTINUITY` с рекламных
доменов в списке сегментов и выбор основного потока вместо преролла у плеера страниц.

ЗАЧЕМ ОТДЕЛЬНО. Правило нужно двоим: прокси HLS службы (`transport/playlists.py`) видит настоящие адреса
сегментов, а браузер — уже нет (после прокси они пронумерованы); плеер страниц (`services/sniffer`) видит,
какой поток спросила страница и из какой рамки. Плеер страниц копирует этот модуль в свой образ, как
`net.py` и `address.py`, поэтому здесь только правила — без зависимостей и без сети.

ЧТО СЧИТАЕТСЯ РЕКЛАМОЙ. Хост из списка рекламных сетей (`AD_HOSTS`: сам домен и его поддомены) — и больше
ничего: ни длина отрезка, ни «другой CDN». Пропустить кусок фильма всей комнате хуже, чем показать рекламу,
а у фильма бывает несколько CDN сразу. Поэтому в списке только домены, с которых отдают рекламу, и ни одного
общего CDN (`akamaized.net`, `cloudfront.net`, `googlevideo.com` — это и фильмы тоже).

КАК ПОМЕЧАЕТСЯ. Отрезок между `#EXT-X-DISCONTINUITY`, все сегменты которого — с рекламных хостов, получает
те же теги, какими поток помечает рекламу сам: `#EXT-X-CUE-OUT:<секунды>` перед первым сегментом и
`#EXT-X-CUE-IN` перед первым сегментом после него. Дальше работает то, что уже есть в браузере
(`theater/ad-breaks.ts`): отрезок пропускается всей комнатой одной командой `watch.seek`. Поток, который
рекламу размечает сам (`CUE-OUT`, `SCTE35`, `DATERANGE` с рекламой), не трогается: его разметке видней.
"""

from __future__ import annotations

import re
from urllib.parse import urljoin, urlsplit

# Домены рекламных сетей, с которых приходят ролики рекламы: Google (DoubleClick, IMA, 2mdn), FreeWheel
# (вставка рекламы в поток на стороне сервера), крупные биржи видеорекламы и российские сети (Яндекс Директ
# и ADFOX, AdRiver, myTarget, Between, Buzzoola, OTM, Videonow, GetIntent, Hybrid, Soloway). Совпадение —
# сам домен или его поддомен (`ad_host`), поэтому `an.yandex.ru` здесь не задевает `yandex.ru`.
AD_HOSTS = frozenset(
    {
        # Google
        "doubleclick.net",
        "googlesyndication.com",
        "googleadservices.com",
        "2mdn.net",
        "imasdk.googleapis.com",
        # Вставка рекламы в поток и биржи
        "fwmrm.net",
        "freewheel.tv",
        "stickyadstv.com",
        "adnxs.com",
        "rubiconproject.com",
        "pubmatic.com",
        "spotxchange.com",
        "spotx.tv",
        "springserve.com",
        "teads.tv",
        "innovid.com",
        "serving-sys.com",
        "flashtalking.com",
        "tremorhub.com",
        "adsrvr.org",
        "amazon-adsystem.com",
        "smartadserver.com",
        "adform.net",
        "vidazoo.com",
        "aniview.com",
        "connatix.com",
        "primis.tech",
        "unrulymedia.com",
        "adtelligent.com",
        # Проверка показов рекламы
        "moatads.com",
        "doubleverify.com",
        "adsafeprotected.com",
        # Россия
        "an.yandex.ru",
        "adfox.yandex.ru",
        "adfox.ru",
        "yandexadexchange.net",
        "adriver.ru",
        "ad.mail.ru",
        "mradx.net",
        "betweendigital.com",
        "buzzoola.com",
        "otm-r.com",
        "videonow.ru",
        "mediasniper.ru",
        "getintent.com",
        "hybrid.ai",
        "adhigh.net",
        "soloway.ru",
    }
)

# Сколько отрезков рекламы в одном списке помечается: разметка на каждом втором сегменте — уже не реклама.
BREAKS = 64
CUE_IN = "#EXT-X-CUE-IN"
EXTINF = re.compile(r"#EXTINF:\s*([0-9]+(?:\.[0-9]+)?)")
# Поток размечает рекламу сам — тогда наша догадка не нужна.
SELF_MARKED = ("#EXT-X-CUE-OUT", "#EXT-X-SCTE35", "SCTE35-OUT", "#EXT-X-CUE-IN")


def ad_host(host: str | None) -> bool:
    """Хост рекламной сети: сам домен из `AD_HOSTS` или его поддомен."""
    name = (host or "").lower().rstrip(".")
    if not name:
        return False
    parts = name.split(".")
    return any(".".join(parts[index:]) in AD_HOSTS for index in range(len(parts) - 1))


def ad_url(url: str | None) -> bool:
    """Адрес на хосте рекламной сети."""
    try:
        return ad_host(urlsplit(url or "").hostname)
    except ValueError:
        return False


def _segments(lines: list[str], base: str) -> list[tuple[int, int, float, bool]]:
    """Сегменты списка: номер отрезка, строка `#EXTINF` (или сам адрес), длительность, рекламный ли хост."""
    found: list[tuple[int, int, float, bool]] = []
    block = 0
    first: int | None = None
    seconds = 0.0
    for number, line in enumerate(lines):
        if line.startswith("#EXT-X-DISCONTINUITY") and not line.startswith("#EXT-X-DISCONTINUITY-"):
            block += 1
            continue
        if line.startswith("#EXTINF"):
            match = EXTINF.match(line)
            seconds = float(match.group(1)) if match else 0.0
            first = number if first is None else first
            continue
        if not line or line.startswith("#"):
            continue
        try:
            host = urlsplit(urljoin(base, line.strip())).hostname
        except ValueError:
            host = None
        found.append((block, number if first is None else first, seconds, ad_host(host)))
        first = None
        seconds = 0.0
    return found


def mark_breaks(body: str, base: str) -> str:
    """
    Помечает в списке сегментов отрезки рекламы — между `DISCONTINUITY`, со всеми сегментами на рекламных
    хостах — тегами `CUE-OUT`/`CUE-IN`. Мастер, список без разрывов, список, который размечает рекламу сам,
    и список, где рекламой оказалось всё, возвращаются как были.
    """
    if "#EXT-X-DISCONTINUITY" not in body or "#EXT-X-STREAM-INF" in body:
        return body
    if any(tag in body for tag in SELF_MARKED):
        return body
    lines = body.splitlines()
    segments = _segments(lines, base)
    blocks: dict[int, list[tuple[int, int, float, bool]]] = {}
    for segment in segments:
        blocks.setdefault(segment[0], []).append(segment)
    advert = {block: all(item[3] for item in items) for block, items in blocks.items()}
    if not any(advert.values()) or all(advert.values()):
        return body
    order = sorted(blocks)
    # Где вставить: CUE-OUT — перед первым тегом первого сегмента отрезка рекламы (это то место, теги
    # которого hls.js кладёт в `tagList` этого сегмента), CUE-IN — так же у первого сегмента после рекламы.
    inserts: dict[int, str] = {}
    marked = 0
    index = 0
    while index < len(order) and marked < BREAKS:
        if not advert[order[index]]:
            index += 1
            continue
        start = index
        while index < len(order) and advert[order[index]]:
            index += 1
        seconds = sum(item[2] for block in order[start:index] for item in blocks[block])
        inserts[blocks[order[start]][0][1]] = f"#EXT-X-CUE-OUT:{seconds:.3f}"
        if index < len(order):
            inserts[blocks[order[index]][0][1]] = CUE_IN
        marked += 1
    out: list[str] = []
    for number, line in enumerate(lines):
        if number in inserts:
            out.append(inserts[number])
        out.append(line)
    return "\n".join(out) + ("\n" if body.endswith(("\n", "\r")) else "")
