"""
Разбор ссылки площадки в поток, который играет наш плеер: мастер HLS, DASH или готовый файл.

Площадка говорит только, **откуда** брать поток (`SourcePlan`): страницу для yt-dlp или уже
готовый адрес. Остальное — выбрать между HLS и файлом, собрать DASH из отдельных дорожек, найти
язык и субтитры, подписать адреса — общее для всех площадок и о них ничего не знает.
"""

from __future__ import annotations

import asyncio
import copy
import logging
import time
import warnings
from dataclasses import dataclass, field
from typing import Any, Callable, Literal, Mapping
from urllib.parse import parse_qs, urlsplit

import httpx
from fastapi import HTTPException
from fastapi.responses import Response

from ..dash import candidates, manifest as dash_manifest, number, read_ranges
from .captions import CAPTIONS_LIMIT, _base_language, _vtt
from .net import COOKIE_COPY, NetConfig, cookie_file, cookie_problem
from .transport.signer import PREFIX, SIGNATURE_TTL, Signer, proxied

logger = logging.getLogger(__name__)

# Что сказать вместо ошибки yt-dlp, в которой названа копия файла cookies: рядом с этим именем
# yt-dlp повторяет строку файла целиком, вместе со значением cookie.
COOKIES_REFUSED = "не подошёл файл cookies"

# Ролик целиком и без плейлиста вокруг: так его открывают и страница ролика, и сам поток.
PROBE = {
    "quiet": True,
    "no_warnings": True,
    "skip_download": True,
    "noplaylist": True,
    "cachedir": False,
    "socket_timeout": 20,
}


class YtDlp:
    """
    Единственная дверь кинозала в yt-dlp.

    Их было две — для каталога и для ролика — с одинаковым телом и разной судьбой ошибок.
    Судьба осталась разной (её решает спросивший: у полки каналов ошибка — это пустая полка,
    у ролика — отказ с текстом), а дверь одна, и всё, что понадобится каждому вызову, ставится
    здесь, а не в двух местах. Опции каждый вызов приносит свои — здесь они не смешиваются.

    Выход наружу — площадки, чей это вызов: её прокси (`CINEMA_PROXY_<ID>` или общий) и её
    cookies (`CINEMA_COOKIES_<ID>`); ни то, ни другое не достаётся чужой площадке.
    """

    def __init__(self, network: NetConfig | None = None):
        self.network = network or NetConfig()
        # До yt-dlp доходят только cookies, которые его загрузчик берёт молча: на строке, где он
        # падает, он повторяет её целиком — со значением — и в ошибке, и в stderr. `from_env`
        # это уже проверил (с именем файла и номером строки); здесь — для любого `NetConfig`.
        self.cookies: dict[str, str] = {}
        for provider, text in self.network.cookies.items():
            if cookie_problem(text) is None:
                self.cookies[provider] = text
            else:
                logger.warning("кинозал: cookies площадки %s не загружаются — она ходит без них", provider)
        if self.cookies:
            # Если загрузчик всё же упадёт, http.cookiejar кладёт трассировку в предупреждение
            # Python — а в трассировке бывает и ошибка yt-dlp со строкой файла. Такое не печатаем.
            warnings.filterwarnings("ignore", message="http.cookiejar bug!", category=UserWarning)

    def extract(self, address: str, options: Mapping[str, Any], provider: str) -> dict[str, Any]:
        """
        Разбор как есть: исключение yt-dlp уходит к спросившему нетронутым.

        yt-dlp получает **копию** опций, и глубокую. `YoutubeDL` хранит переданный словарь как
        есть и дописывает в него своё (`http_headers`, `compat_opts`, `outtmpl`…): с общим
        `YT_FLAT` это значило, что после первого поиска его ключи ехали в каждый следующий
        вызов — одним объектом на все потоки `to_thread`.
        """
        import yt_dlp  # тяжёлый модуль: грузится при первом вопросе, а не при старте службы

        params = copy.deepcopy(dict(options))
        proxy = self.network.proxy_for(provider)
        cookies = self.cookies.get(provider)
        if proxy:
            params["proxy"] = proxy
        if proxy or cookies:
            # Когда у площадки есть что прятать, yt-dlp пишет не в stderr, а сюда: его ошибки
            # идут в журнал службы тем же текстом, что и комнате, — без входа в прокси и cookies.
            params["logger"] = _Quiet(self.explain)
        with cookie_file(cookies) as copy_path:
            if copy_path:
                params["cookiefile"] = copy_path
            with yt_dlp.YoutubeDL(params) as ydl:
                return ydl.extract_info(address, download=False) or {}

    def probe(self, source: str, provider: str, **options: Any) -> dict[str, Any]:
        """Один ролик целиком. Отказ площадки превращается в человеческий текст."""
        try:
            return self.extract(source, {**PROBE, **options}, provider)
        except Exception as error:  # yt_dlp поднимает свои типы; наружу идёт человеческий текст
            raise HTTPException(502, f"Не удалось открыть видео: {self.explain(error)}"[:300]) from None

    def explain(self, error: BaseException | str) -> str:
        """
        Текст отказа yt-dlp для комнаты и журнала — без входа в прокси и без значений cookie.

        Ошибку, где yt-dlp называет копию файла cookies, целиком заменяют свои слова: вместе с
        именем файла он повторяет и его строку, а в ней значение. Значения cookie и вход в
        прокси вычёркиваются из любого текста — на случай, если yt-dlp назовёт их иначе.
        """
        text = str(error)
        if COOKIE_COPY in text:
            return COOKIES_REFUSED
        for secret in self.network.secrets():
            text = text.replace(secret, "***@" if secret.endswith("@") else "***")
        return text


class _Quiet:
    """
    Журнал для yt-dlp (`logger`): только ошибки, в журнал службы и сказанные через `explain`.

    Отладка и сведения — шум; предупреждения yt-dlp и без журнала молчат (`no_warnings`), и с
    ним молчат так же.
    """

    def __init__(self, explain: Callable[[str], str]):
        self._explain = explain

    def debug(self, message: str) -> None:
        pass

    def info(self, message: str) -> None:
        pass

    def warning(self, message: str) -> None:
        pass

    def error(self, message: str) -> None:
        logger.warning("yt-dlp: %s", self._explain(message))


@dataclass(frozen=True)
class SourcePlan:
    """
    Откуда площадка берёт поток.

    `ytdlp` — страница площадки, дальше общий разбор: мастер HLS, DASH или файл, субтитры,
    язык, обложка. `direct` — площадка сама знает адрес потока (её API отдаёт HLS), разбирать
    там нечего: остаётся подписать адреса.
    """

    via: Literal["ytdlp", "direct"]
    url: str
    # ytdlp: опции yt-dlp сверх общих и можно ли собирать DASH из отдельных дорожек.
    options: Mapping[str, Any] = field(default_factory=dict)
    dash: bool = False
    # direct: всё, что площадка знает о потоке сама.
    kind: Literal["hls", "file"] = "hls"
    live: bool = False
    title: str = ""
    author: str = ""
    duration: float | None = None
    poster: str | None = None
    language: str = ""
    captions: tuple[Mapping[str, Any], ...] = ()
    liveDelayMs: int | None = None
    audioChoices: tuple[Mapping[str, Any], ...] | None = None
    variants: tuple[Mapping[str, Any], ...] | None = None


def ytdlp(url: str, *, dash: bool = False, **options: Any) -> SourcePlan:
    """
    Страница площадки для yt-dlp.

    `dash` — можно ли собрать DASH из отдельных дорожек, если браузер его играет. Решает
    площадка: это знание о её хранилище, а не о плеере (у YouTube дорожки проиндексированы и
    отдаются по диапазонам, у Twitch — нет).
    """
    return SourcePlan("ytdlp", url, options=options, dash=dash)


def direct(
    kind: Literal["hls", "file"],
    url: str,
    *,
    live: bool = False,
    title: str = "",
    author: str = "",
    duration: float | None = None,
    poster: str | None = None,
    language: str = "",
    captions: tuple[Mapping[str, Any], ...] = (),
    liveDelayMs: int | None = None,
    audioChoices: tuple[Mapping[str, Any], ...] | None = None,
    variants: tuple[Mapping[str, Any], ...] | None = None,
) -> SourcePlan:
    """Готовый поток площадки. Субтитры — уже в нашем виде (`lang`, `label`, `auto`, `url`)."""
    return SourcePlan(
        "direct",
        url,
        kind=kind,
        live=live,
        title=title,
        author=author,
        duration=duration,
        poster=poster,
        language=language,
        captions=captions,
        liveDelayMs=liveDelayMs,
        audioChoices=audioChoices,
        variants=variants,
    )


class Resolver:
    """
    План площадки → ответ `resolve`: адрес потока у нас, срок его подписи, язык, субтитры.

    Про площадки он не знает ничего: страницу для yt-dlp и разрешение собирать DASH ему
    приносит план. Подписывает он всё одним ключом и от имени площадки, чей это поток: её
    политика хостов решает, какие дорожки, субтитры и обложки вообще можно отдать.
    """

    def __init__(self, signer: Signer, ytdlp: YtDlp, image: Callable[[str, str], str | None]):
        self.signer = signer
        self.ytdlp = ytdlp
        self.image = image
        self.dash_manifests: dict[str, tuple[float, str]] = {}
        self.index_reads = asyncio.Semaphore(4)

    async def resolve(
        self, plan: SourcePlan, net: httpx.AsyncClient, provider: str, content_id: str, adaptive: bool
    ) -> dict[str, Any]:
        if plan.via == "direct":
            return self._direct(plan, provider, content_id)
        info = await asyncio.to_thread(self.ytdlp.probe, plan.url, provider, **plan.options)
        stream, kind = self._stream(info)
        dash = None
        if adaptive and plan.dash and not info.get("is_live") and kind != "hls":
            dash = await self._dash(info, net, provider)
        if dash:
            stream, expires = dash
            kind = "dash"
        else:
            expires = self._expiry([stream] if stream else [])
        if not stream:
            raise HTTPException(502, "Площадка не отдала поток для этого видео. Попробуйте другое")
        poster = info.get("thumbnail") or ""
        return {
            "provider": provider,
            "contentId": content_id,
            "title": info.get("title") or content_id,
            "author": info.get("uploader") or info.get("channel") or "",
            "duration": None if info.get("is_live") else info.get("duration"),
            "live": bool(info.get("is_live")),
            "kind": kind,
            "url": stream
            if kind == "dash"
            else proxied(
                self.signer,
                stream,
                "playlist" if kind == "hls" else "fetch",
                max(1, int(expires - time.time())),
                provider=provider,
            ),
            "expiresAt": int(expires * 1000),
            "notice": "Доступен только готовый файл: качество ограничено источником"
            if kind == "file"
            else None,
            # На каком языке ролик говорит сам. Ни одна дорожка в мастере YouTube не помечена
            # как основная (`DEFAULT=NO` у всех), и плеер без подсказки берёт первую по
            # алфавиту — арабскую, французскую, какую придётся. Это и есть «включился чужой
            # язык»: выбора не было, был порядок строк.
            "language": info.get("language") or "",
            "captions": self._captions(info, kind == "hls", provider),
            "poster": self.image(poster, provider),
        }

    def _direct(self, plan: SourcePlan, provider: str, content_id: str) -> dict[str, Any]:
        """Поток, адрес которого площадка знает сама: разбирать нечего, остаётся подписать."""
        expires = self._expiry([plan.url])
        source = {
            "provider": provider,
            "contentId": content_id,
            "title": plan.title or content_id,
            "author": plan.author,
            "duration": None if plan.live else plan.duration,
            "live": plan.live,
            "kind": plan.kind,
            "url": proxied(
                self.signer,
                plan.url,
                "playlist" if plan.kind == "hls" else "fetch",
                max(1, int(expires - time.time())),
                provider=provider,
            ),
            "expiresAt": int(expires * 1000),
            "notice": None,
            "language": plan.language,
            "captions": [
                {**track, "url": proxied(self.signer, track["url"], "fetch", provider=provider)}
                for track in plan.captions[:CAPTIONS_LIMIT]
            ],
            "poster": self.image(plan.poster or "", provider),
        }
        # Новые ключи — только у тех, кто их знает: остальным клиентам они не нужны вовсе.
        extra = {
            "liveDelayMs": plan.liveDelayMs,
            "audioChoices": plan.audioChoices,
            "variants": plan.variants,
        }
        source.update(
            (key, list(value) if isinstance(value, tuple) else value)
            for key, value in extra.items()
            if value is not None
        )
        return source

    @staticmethod
    def _expiry(urls: list[str]) -> float:
        expires = time.time() + SIGNATURE_TTL
        for url in urls:
            for value in parse_qs(urlsplit(url).query).get("expire", []):
                if value.isdigit():
                    expires = min(expires, int(value))
        return expires

    async def _dash(
        self, info: dict[str, Any], net: httpx.AsyncClient, provider: str
    ) -> tuple[str, float] | None:
        duration = number(info.get("duration"))
        if not duration:
            return None
        formats = [
            item
            for item in candidates(info.get("formats") or [])
            if self.signer.allows(item["url"], provider)
        ]

        async def inspect(item):
            try:
                ranges = await read_ranges(net, item["url"], self.index_reads)
                return item, ranges
            except (ValueError, httpx.HTTPError):
                return None

        try:
            async with asyncio.timeout(20):
                found = [
                    item
                    for item in await asyncio.gather(*(inspect(item) for item in formats))
                    if item
                ]
        except TimeoutError:
            return None
        expires = self._expiry([item[0]["url"] for item in found])
        if expires - time.time() < 60:
            return None
        ttl = max(1, int(expires - time.time()))
        try:
            body = dash_manifest(
                [
                    (item, ranges, proxied(self.signer, item["url"], "fetch", ttl, provider=provider))
                    for item, ranges in found
                ],
                duration,
            )
        except ValueError:
            return None
        key = self.signer.name(body)
        self.dash_manifests[key] = (expires, body)
        while len(self.dash_manifests) > 64:
            self.dash_manifests.pop(next(iter(self.dash_manifests)))
        return f"{PREFIX}/dash/{key}", expires

    def dash(self, key: str) -> Response:
        found = self.dash_manifests.get(key)
        if not found or found[0] <= time.time():
            self.dash_manifests.pop(key, None)
            raise HTTPException(410, "Ссылка устарела, откройте видео заново")
        return Response(
            found[1],
            media_type="application/dash+xml",
            headers={"Cache-Control": "no-store"},
        )

    def _captions(self, info: dict[str, Any], embedded: bool, provider: str) -> list[dict[str, Any]]:
        """
        Дорожки текста, которых нет в самом потоке.

        В мастере HLS у YouTube лежат **только написанные руками** субтитры — те, что автор
        приложил к ролику. Распознанных речью (`kind=asr`) там нет ни одной, а именно они и
        есть у большинства роликов: у «Gangnam Style» сто пятьдесят семь автоматических и ни
        одной ручной. Поэтому их адрес берётся у yt-dlp и отдаётся отдельным списком.
        Плеер складывает оба списка в одно меню — для человека разницы между ними нет.

        Автоперевод (`tlang=` в адресе) сюда не попадает намеренно: на него площадка отвечает
        нам «429 Too Many Requests» — с адреса сервера переводить она не даёт. Распознанная
        речь на своём языке при этом отдаётся без единой жалобы.

        `embedded` — поток уже несёт субтитры сам (мастер HLS). Тогда ручные не дублируются:
        их покажет плеер из плейлиста, а отсюда приезжает только распознанное. И то, что
        площадка написала руками, автоматическое не вытесняет — как и у самого YouTube.
        """
        manual = info.get("subtitles") or {}
        written = {_base_language(language) for language in manual}
        tracks: list[dict[str, Any]] = []
        seen: set[str] = set()

        def allows(url: str) -> bool:
            return self.signer.allows(url, provider)

        def offer(language: str, entries: list[dict[str, Any]], generated: bool) -> None:
            base = _base_language(language)
            found = _vtt(entries, allows)
            if not found or base in seen or (generated and base in written):
                return
            seen.add(base)
            tracks.append(
                {
                    # `ko-orig` — выдумка yt-dlp, а не код языка: так помечена та же
                    # распознанная речь, к которой не приложили перевод. Наружу уходит язык.
                    "lang": language.removesuffix("-orig"),
                    # Имя от площадки — на английском («Korean»), и оно запасное: плеер
                    # называет язык сам, на языке смотрящего.
                    "label": found.get("name") or language,
                    "auto": generated,
                    "url": proxied(self.signer, found["url"], "fetch", provider=provider),
                }
            )

        if not embedded:
            for language, entries in manual.items():
                offer(language, entries, False)
        for language, entries in (info.get("automatic_captions") or {}).items():
            found = _vtt(entries, allows)
            # Все нетронутые переводом дорожки — это одна и та же распознанная речь под
            # разными ключами (`ko` и `ko-orig`); лишние отсеивает общий отбор по языку.
            if found and "tlang=" not in found["url"]:
                offer(language, entries, True)
        return tracks[:CAPTIONS_LIMIT]

    @staticmethod
    def _stream(info: dict[str, Any]) -> tuple[str | None, str]:
        """
        Что отдать плееру: мастер HLS — если площадка его предлагает, иначе готовый файл.

        HLS предпочтительнее не из красоты: в нём лежат **все** уровни качества сразу, и выбор
        между ними делает наш плеер, а не площадка. Обычный файл остаётся запасным ходом для
        тех роликов, которым YouTube плейлиста не даёт; там качество одно.
        """
        formats = info.get("formats") or []
        for item in formats:
            if str(item.get("protocol", "")).startswith("m3u8") and item.get("manifest_url"):
                return item["manifest_url"], "hls"
        if info.get("manifest_url"):
            return info["manifest_url"], "hls"
        progressive = [
            item
            for item in formats
            if item.get("acodec") not in (None, "none")
            and item.get("vcodec") not in (None, "none")
            and item.get("url")
            and str(item.get("protocol", "")).startswith("http")
        ]
        progressive.sort(key=lambda item: (item.get("height") or 0, item.get("tbr") or 0))
        if progressive:
            return progressive[-1]["url"], "file"
        return (info.get("url"), "file") if info.get("url") else (None, "file")
