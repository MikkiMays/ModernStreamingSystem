"""
Разбор ссылки площадки в поток, который играет наш плеер: мастер HLS, DASH или готовый файл.

Площадка говорит только, **откуда** брать поток (`SourcePlan`): страницу для yt-dlp или уже
готовый адрес. Остальное — выбрать между HLS и файлом, собрать DASH из отдельных дорожек, найти
язык и субтитры, подписать адреса — общее для всех площадок и о них ничего не знает.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
import copy
import functools
import logging
import re
import time
import warnings
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Literal, Mapping
from urllib.parse import parse_qs, urlsplit

import httpx
from fastapi import HTTPException
from fastapi.responses import Response

from ..dash import candidates, manifest as dash_manifest, number, read_ranges
from . import drm, mpd
from .captions import CAPTIONS_LIMIT, SUBTITLE_FORMATS, _base_language, _pick
from .egress import Busy, Closed, Egress, Lease
from .net import COOKIE_COPY, NetConfig, cookie_file, cookie_problem
from .transport.relay import SEALED
from .transport.signer import PREFIX, SIGNATURE_TTL, Signer, proxied

logger = logging.getLogger(__name__)

# Что сказать вместо ошибки yt-dlp, в которой названа копия файла cookies: рядом с этим именем
# yt-dlp повторяет строку файла целиком, вместе со значением cookie.
COOKIES_REFUSED = "не подошёл файл cookies"

# Что сказать вместо ошибки yt-dlp, когда разбор площадки с охраняемым выходом (`egress.py`) упёрся в
# его пределы: адрес внутри сети, срок разбора, занятые места.
INSIDE = "Ссылка ведёт во внутреннюю сеть или на закрытый порт — такие адреса кинозал не открывает"
EXPIRED = "Сайт не отдал видео вовремя — попробуйте ещё раз или другую ссылку"
BUSY = "Сервер сейчас разбирает много ссылок — попробуйте через минуту"
CLOSED = "Разбор ссылок сейчас недоступен — попробуйте через минуту"
UNREACHABLE = "Сайт не отвечает или такого адреса нет — проверьте ссылку"
TOO_BIG = "Страница слишком большая — такие кинозал не разбирает"
# Сколько распакованных байт yt-dlp может прочесть из одного ответа сайта у площадки с охраняемым
# выходом. Выход считает байты по проводу (`egress.BUDGET`), а распаковывает yt-dlp сам: 64 КБ сжатых
# нулей — это 64 МБ страницы, и «страница» в гигабайт уронила бы службу целиком.
DECODED_LIMIT = 32 * 1024 * 1024
# Видео есть, но только кусочками DASH из манифеста сайта: такой поток наш плеер пока не собирает.
DASH_ONLY = "Сайт отдаёт это видео только потоком DASH — такой кинозал пока не показывает"
# Видео есть, но только файлами, которые браузер не играет (`.mpg`, `.avi`, `.wmv`, …).
UNPLAYABLE = "Сайт отдаёт видео только в виде, который браузер не играет"
# Аудио без картинки — тоже годится: плеер играет его с постером. Виды — те, что играют браузеры.
AUDIO_FILES = ("m4a", "mp3", "aac", "opus", "ogg", "oga", "wav", "flac")
# Кодеки картинки, которые играют браузеры; `mp4v`, Theora, WMV и прочие — нет.
BROWSER_CODECS = ("avc", "h264", "vp8", "vp9", "vp09", "av01", "hev1", "hvc1", "h265")
# Выше этой стороны кадра готовый файл не берётся, если есть ниже (см. `ranked_files`).
FILE_SIDE = 1080
# Ни один из готовых файлов страницы сайт не отдал (404, 403, обрыв).
NO_FILE = "Сайт не отдал файл видео — ссылка на него не открывается"
# Потока у разобранной страницы нет вовсе.
NO_STREAM = "Площадка не отдала поток для этого видео. Попробуйте другое"
# Мастер HLS сайт отдать нам отказался (401/403/410): поток держится на cookies, Referer или адресе своего
# плеера (`drm.Locked`). У ссылки дальше пробует плеер страниц (`providers/link.py`); не вышло и у него —
# этот отказ.
LOCKED = "Сайт отдаёт этот поток только своему плееру — открыть его для комнаты не вышло"

# Пределы на строки, которые приходят из чужого ответа (yt-dlp у страницы «По ссылке») и оседают в общей
# памяти, на диске и в каждом ответе `resolve`. Чужая страница вправе прислать заголовок в мегабайты: без
# обрезки один разбор держал бы десятки мегабайт названия в памяти службы (64 записи по получасу — гигабайт).
# Числа — как у карточки каталога и как их показывает плеер: длиннее их всё равно не видно.
TITLE_LIMIT = 300
AUTHOR_LIMIT = 200
LANGUAGE_LIMIT = 35
CAPTION_LANG_LIMIT = 35
CAPTION_LABEL_LIMIT = 80


def _clip(value: Any, limit: int) -> str:
    """Строка из чужого ответа — не длиннее предела. Не строка — пусто."""
    return value[:limit] if isinstance(value, str) else ""


class Inside(Exception):
    """Разбор упёрся в защиту выхода: сайт повёл yt-dlp внутрь сети или на закрытый порт."""


class Expired(Exception):
    """Срок разбора вышел: выход закрыл его соединения, и yt-dlp остановился на обрыве."""


class Protected(Exception):
    """yt-dlp нашёл только форматы под DRM и отказал сам («This video is DRM protected»)."""


class Unreachable(Exception):
    """Сайта нет: имя не разрешилось или ни один его адрес не ответил выходу."""


class Oversized(Exception):
    """Ответ сайта после распаковки больше `DECODED_LIMIT`: разбор остановлен на пределе."""


# Так yt-dlp отказывает, когда все форматы ролика под DRM (`YoutubeDL.raise_no_formats`).
DRM_REFUSAL = "DRM protected"


# Тем, что площадка отвечает вместо ролика, когда не поверила ни движку без JS, ни клиенту без
# cookies (см. https://github.com/yt-dlp/yt-dlp/wiki/EJS). Текст приходит от самой площадки, в
# её ответе, а не константой из yt-dlp — и апостроф в нём бывает то обычным, то типографским.
BOT_CHECK = re.compile(r"confirm you[’']re not a bot")

# Ролик целиком и без плейлиста вокруг: так его открывают и страница ролика, и сам поток.
PROBE = {
    "quiet": True,
    "no_warnings": True,
    "skip_download": True,
    "noplaylist": True,
    "cachedir": False,
    "socket_timeout": 20,
}

# Общий на процесс: `.info` внутри сам кэширует ответ (`functools.cached_property`), и с ним
# `deno --version` спрашивается только у первого `YtDlp`, а не у каждого — их несколько за один
# прогон тестов, и это тот же самый deno на той же машине.
_deno_runtime: Any = None


def _deno_info() -> Any:
    """
    Версия deno, которую нашёл бы сам yt-dlp (та же проверка, что у него внутри), — или `None`.

    Импорт `yt_dlp.utils._jsruntime` тянет за собой весь пакет yt-dlp: он не входит в число
    вопросов, ради которых модуль держат лёгким (`YtDlp.extract` грузит его так же, отдельно),
    но здесь это одноразовая плата при старте службы — за неё и берётся строка в журнал.
    """
    global _deno_runtime
    if _deno_runtime is None:
        from yt_dlp.utils._jsruntime import DenoJsRuntime

        _deno_runtime = DenoJsRuntime()
    return _deno_runtime.info


class YtDlp:
    """
    Единственная дверь кинозала в yt-dlp.

    Их было две — для каталога и для ролика — с одинаковым телом и разной судьбой ошибок.
    Судьба осталась разной (её решает спросивший: у полки каналов ошибка — это пустая полка,
    у ролика — отказ с текстом), а дверь одна, и всё, что понадобится каждому вызову, ставится
    здесь, а не в двух местах. Опции каждый вызов приносит свои — здесь они не смешиваются.

    Выход наружу — площадки, чей это вызов: её прокси (`CINEMA_PROXY_<ID>` или общий) и её
    cookies (`CINEMA_COOKIES_<ID>`); ни то, ни другое не достаётся чужой площадке. У площадки
    из `cookies_fallback` cookies в первый разбор не идут вовсе — только запасным, вторым
    (см. `extract`).
    """

    def __init__(
        self,
        network: NetConfig | None = None,
        *,
        cookies_fallback: Iterable[str] = (),
        egress: Mapping[str, Egress] | None = None,
    ):
        self.network = network or NetConfig()
        # Площадки, чей yt-dlp ходит наружу только через охраняемый выход (`egress.py`): у них ни
        # прокси администратора, ни прямого соединения — всё через вход разбора, и только через него.
        self.egress = dict(egress or {})
        # Площадки, у которых cookiefile входит в разбор только запасным ходом. Список решает
        # не этот класс, а сами площадки (`Provider.cookies_fallback`); `Cinema.__init__`
        # собирает его у всех включённых разом — здесь ни одного имени площадки по имени нет.
        self.cookies_fallback = frozenset(cookies_fallback)
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
        # Каталог yt-dlp — в своём небольшом пуле, а не в общем пуле `to_thread` цикла событий: тот же общий
        # пул обслуживает `loop.getaddrinfo` каждого исходящего соединения (`net.py`), и лавина запросов
        # каталога стопорила бы разрешение имён всем площадкам разом (M11). Разбор ссылок с охраняемым выходом
        # идёт своим пулом (`egress.py`); здесь — пул площадок каталога.
        self.pool = concurrent.futures.ThreadPoolExecutor(max_workers=4, thread_name_prefix="cinema-catalog")
        self._log_js_runtime()

    async def offload(self, work: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
        """Работа yt-dlp каталога — в выделенном пуле, а не в общем пуле цикла событий (см. `__init__`)."""
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self.pool, functools.partial(work, *args, **kwargs))

    def close(self) -> None:
        self.pool.shutdown(wait=False, cancel_futures=True)

    def extract(
        self, address: str, options: Mapping[str, Any], provider: str, *, lease: Lease | None = None
    ) -> dict[str, Any]:
        """
        Разбор как есть: исключение yt-dlp уходит к спросившему нетронутым.

        yt-dlp получает **копию** опций, и глубокую. `YoutubeDL` хранит переданный словарь как
        есть и дописывает в него своё (`http_headers`, `compat_opts`, `outtmpl`…): с общим
        `YT_FLAT` это значило, что после первого поиска его ключи ехали в каждый следующий
        вызов — одним объектом на все потоки `to_thread`.

        COOKIES ЗАПАСНЫМ ХОДОМ. У площадки из `cookies_fallback` первая попытка идёт совсем
        без cookiefile: у YouTube с cookies приходит SABR и ни одного мастера HLS — без них
        лестница качества жива, пока её же проверку решает движок с JS. Второй, последний раз
        — с тем же cookiefile, что и всегда, — только если yt-dlp отказал именно проверкой на
        человека (`BOT_CHECK`); у отказа бывают и другие причины, и повтор их не лечит.
        """
        cookies = self.cookies.get(provider)
        if cookies and provider in self.cookies_fallback:
            try:
                return self._call(address, options, provider, cookies=None, lease=lease)
            except Exception as error:  # yt_dlp поднимает свои типы — ловим широко, решает текст
                if not BOT_CHECK.search(str(error)):
                    raise
            return self._call(address, options, provider, cookies=cookies, lease=lease)
        return self._call(address, options, provider, cookies=cookies, lease=lease)

    def _call(
        self,
        address: str,
        options: Mapping[str, Any],
        provider: str,
        *,
        cookies: str | None,
        lease: Lease | None = None,
    ) -> dict[str, Any]:
        """Один настоящий вызов yt-dlp — с этим cookiefile или совсем без него."""
        return self.run(
            provider,
            options,
            lambda ydl: ydl.extract_info(address, download=False) or {},
            cookies=cookies,
            lease=lease,
        )

    def run(
        self,
        provider: str,
        options: Mapping[str, Any],
        work: Callable[[Any], Any],
        *,
        cookies: str | None = None,
        lease: Lease | None = None,
    ) -> Any:
        """
        Открытый `YoutubeDL` площадки — со всем, что ей положено снаружи, — и одна работа с ним.

        Через это место идёт любой вызов yt-dlp: и обычный разбор (`_call`), и разбор ссылки по
        шагам, которому мало одного `extract_info` (`providers/link.py`). Поэтому выход наружу
        решается здесь, а не у спросившего: у площадки с охраняемым выходом `proxy` из опций
        заменяется входом разбора (`lease` — его выдаёт `Egress.run`, в чьём потоке и идёт этот
        вызов), что бы в опциях ни стояло; нет входа — нет и выхода наружу.
        """
        import yt_dlp  # тяжёлый модуль: грузится при первом вопросе, а не при старте службы

        params = copy.deepcopy(dict(options))
        if provider in self.egress:
            if lease is None:
                raise Closed("Разбору не дали входа в охраняемый выход")
            # Cookies здесь не идут никогда: страница чужая, и вход администратора на ней не нужен.
            params["proxy"] = lease.url
            # Ни ошибок yt-dlp, ни его предупреждений в журнал: в них адрес страницы, которую
            # вставил участник, а в адресе бывают его ключи и метки.
            params["logger"] = _Quiet(self.explain, silent=True)
            try:
                with yt_dlp.YoutubeDL(params) as ydl:
                    _requests_only(ydl)
                    ydl.urlopen = _capped(ydl.urlopen)
                    return work(ydl)
            except Exception as error:
                raise _egress_error(lease, error) or error
        proxy = self.network.proxy_for(provider)
        if proxy:
            params["proxy"] = proxy
        if proxy or self.cookies.get(provider):
            # Когда у площадки есть что прятать, yt-dlp пишет не в stderr, а сюда: его ошибки
            # идут в журнал службы тем же текстом, что и комнате, — без входа в прокси и cookies.
            # Проверяем, что площадке вообще положены cookies, а не что этот вызов их послал:
            # прятать нужно и на самом первом, ещё бескукийном разборе.
            params["logger"] = _Quiet(self.explain)
        with cookie_file(cookies) as copy_path:
            if copy_path:
                params["cookiefile"] = copy_path
            with yt_dlp.YoutubeDL(params) as ydl:
                return work(ydl)

    def _log_js_runtime(self) -> None:
        """
        Одна строка в журнал при старте: каким движком yt-dlp решит EJS-проверку YouTube.

        24.09.2026 причиной отказа YouTube на проде был именно движок: без него yt-dlp пишет
        `JS runtimes: none`, не решает `n`-задачу и уходит на клиента, которого площадка
        проверяет строже прочих. Эта строка — не `verbose` yt-dlp (его на проде никто не
        включает), а обычный журнал службы, и только при старте: дальше движок не меняется.
        """
        try:
            info = _deno_info()
        except Exception as error:  # своя проверка не должна ронять службу — только предупредить
            logger.warning("кинозал: проверка JS-движка yt-dlp упала: %s", type(error).__name__)
            return
        if info is None:
            logger.warning(
                "кинозал: yt-dlp не нашёл JS-движок (deno) — YouTube без cookies будет чаще "
                "отвечать проверкой на бота"
            )
        elif not info.supported:
            logger.warning(
                "кинозал: yt-dlp нашёл deno %s — версия слишком старая, движок не в счёт", info.version
            )
        else:
            logger.info("кинозал: yt-dlp решает JS-проверки YouTube движком deno %s", info.version)

    def probe(
        self, source: str, provider: str, *, lease: Lease | None = None, **options: Any
    ) -> dict[str, Any]:
        """Один ролик целиком. Отказ площадки превращается в человеческий текст."""
        try:
            if lease is None:
                return self.extract(source, {**PROBE, **options}, provider)
            return self.extract(source, {**PROBE, **options}, provider, lease=lease)
        except HTTPException:
            raise
        except Exception as error:  # yt_dlp поднимает свои типы; наружу идёт человеческий текст
            raise refusal(error) or HTTPException(
                502, f"Не удалось открыть видео: {self.explain(error)}"[:300]
            ) from None

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
        # Пароль входа в охраняемый выход стоит в адресе прокси, а yt-dlp называет прокси в
        # ошибках соединения.
        for gate in self.egress.values():
            text = text.replace(gate.secret, "***")
        return text


class _Capped:
    """
    Ответ сайта для yt-dlp с пределом на распакованные байты (`DECODED_LIMIT`).

    yt-dlp читает страницу целиком (`read()` без размера — у него это кусками по мегабайту до конца) и
    распаковывает gzip, deflate и brotli сам, по заголовку ответа, о чём бы его ни просили. Здесь
    чтение идёт кусками по `CHUNK` распакованных байт, и на пределе разбор останавливается —
    исключением, которое становится отказом словами.
    """

    CHUNK = 64 * 1024

    def __init__(self, response: Any, limit: int):
        self._response = response
        self._left = limit

    def read(self, amt: int | None = None) -> bytes:
        if amt is not None and amt >= 0:
            return self._take(amt)
        parts = []
        while chunk := self._take(self.CHUNK):
            parts.append(chunk)
        return b"".join(parts)

    def _take(self, amt: int) -> bytes:
        if amt == 0:
            return b""
        data = self._response.read(min(amt, self.CHUNK))
        self._left -= len(data)
        if self._left < 0:
            raise Oversized()
        return data

    def __getattr__(self, name: str) -> Any:
        return getattr(self._response, name)

    def __enter__(self) -> _Capped:
        return self

    def __exit__(self, *exc: Any) -> None:
        self._response.close()


def _capped(urlopen: Callable[..., Any]) -> Callable[..., Any]:
    """
    `YoutubeDL.urlopen`, чьи ответы читаются не больше `DECODED_LIMIT` распакованных байт, — и ответы
    с ошибкой тоже: их тело yt-dlp читает так же целиком (`generic` на каждом 403 ищет в нём страницу
    Cloudflare, разборщики с `expected_status` разбирают его как страницу), и оно так же чужое.
    """
    from yt_dlp.networking.exceptions import HTTPError

    def opened(request: Any) -> _Capped:
        try:
            response = urlopen(request)
        except HTTPError as error:
            error.response = _Capped(error.response, DECODED_LIMIT)
            raise
        return _Capped(response, DECODED_LIMIT)

    return opened


def _requests_only(ydl: Any) -> None:
    """
    yt-dlp площадки с выходом ходит только через `requests`, и тела переадресаций не читает.

    Предел `_Capped` держится, только пока тело читают после `urlopen`, кусками: обработчик `urllib` у
    yt-dlp распаковывает тело ещё внутри `urlopen`, а сам `requests` на каждой переадресации читает её
    тело целиком (`Session.resolve_redirects` → `resp.content`) — 95 КБ сжатого по проводу там
    становились двумя сотнями мегабайт памяти. Поэтому прочие обработчики из разбора уходят совсем
    (нет `requests` — нет и разбора, а не разбор без предела), а сессия `requests` получает крючок,
    который закрывает тело переадресации непрочитанным (`_redirect_unread`). Имена внутри yt-dlp
    (`_request_director`, `_create_instance`) проверяет при старте службы `check_reading`.
    """
    director = ydl._request_director
    handler = director.handlers.get("Requests")
    if handler is None:
        raise Closed("У yt-dlp нет обработчика requests — разбор ссылок не пускается")
    for key in [key for key in director.handlers if key != "Requests"]:
        director.handlers.pop(key).close()
    create = handler._create_instance

    def created(*args: Any, **kwargs: Any) -> Any:
        session = create(*args, **kwargs)
        session.hooks["response"].append(_redirect_unread)
        return session

    handler._create_instance = created


def _redirect_unread(response: Any, *args: Any, **kwargs: Any) -> Any:
    """
    Крючок `requests`: тело переадресации не нужно никому — соединение закрывается непрочитанным, и
    `resp.content` у `resolve_redirects` читает из закрытого пустоту. Сам ответ остаётся: из его
    заголовков `requests` ещё берёт cookies (`extract_cookies_to_jar`), а без них Дзен, ставящий cookie
    переадресацией, отдаёт вместо ролика пустую страницу.
    """
    if response.is_redirect:
        with contextlib.suppress(Exception):
            response.raw.close()
    return response


_reading_checked = False


def check_reading() -> None:
    """
    Держится ли предел `_Capped` на этой сборке. urllib3 — 2.6 или новее: раньше `read(n)` распаковывал
    весь пришедший кусок «бомбы», сколько бы ни просили. У yt-dlp — обработчик `requests` и места, куда
    встаёт `_requests_only`. Проверяется при сборке службы с площадкой «По ссылке»: не держится —
    служба не поднимается, а не разбирает чужие страницы без предела. Один раз на процесс.
    """
    global _reading_checked
    if _reading_checked:
        return
    import urllib3
    import yt_dlp

    version = tuple(int(part) for part in re.findall(r"\d+", urllib3.__version__)[:2])
    if version < (2, 6):
        raise RuntimeError(
            f"urllib3 {urllib3.__version__} распаковывает ответ сайта целиком, сколько бы из него ни "
            "читали: разбор ссылок без предела не поднимается — нужен urllib3 2.6 или новее"
        )
    try:
        with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "cachedir": False}) as ydl:
            _requests_only(ydl)
            handlers = list(ydl._request_director.handlers)
            session = ydl._request_director.handlers["Requests"]._create_instance(cookiejar=ydl.cookiejar)
            hooked = _redirect_unread in session.hooks["response"]
            session.close()
    except (Closed, AttributeError, KeyError, TypeError) as error:
        raise RuntimeError(
            f"yt-dlp изменился: предел на тело ответа сайта некуда встроить ({error}) — разбор ссылок "
            "без него не поднимается"
        ) from None
    if handlers != ["Requests"] or not hooked:
        raise RuntimeError("yt-dlp изменился: разбор ссылок ходил бы не через requests с пределом")
    _reading_checked = True


def _egress_error(lease: Lease, error: Exception) -> Exception | None:
    """
    Ошибка yt-dlp, за которой на самом деле стоит выход (отказ проверки, вышедший срок) или DRM:
    у площадки с чужими страницами это отказы словами, а не «не удалось открыть» с текстом yt-dlp.
    """
    if isinstance(error, Oversized):
        return error
    if lease.refused:
        return Inside(lease.refused)
    if lease.expired:
        return Expired()
    if DRM_REFUSAL in str(error):
        return Protected()
    # Выход ответил yt-dlp «502»: сам сайт не нашёлся или молчит. Сбой, а не свойство страницы.
    if lease.failed and ("Bad Gateway" in str(error) or "502" in str(error)):
        return Unreachable(lease.failed)
    return None


def refusal(error: BaseException) -> HTTPException | None:
    """Отказ охраняемого выхода — человеческим текстом и своим кодом; остальное решает спросивший."""
    if isinstance(error, Inside):
        return HTTPException(403, INSIDE)
    if isinstance(error, Expired):
        return HTTPException(504, EXPIRED)
    if isinstance(error, Busy):
        return HTTPException(503, BUSY)
    if isinstance(error, Closed):
        return HTTPException(503, CLOSED)
    if isinstance(error, Protected):
        return HTTPException(403, drm.DRM)
    if isinstance(error, Unreachable):
        return HTTPException(502, UNREACHABLE)
    if isinstance(error, Oversized):
        return HTTPException(502, TOO_BIG)
    return None


def _single(info: dict[str, Any]) -> dict[str, Any]:
    """
    Плейлист из одного видео — это видео. Так приходит одна серия страницы, на которой их несколько
    (`playlist_items`): у площадок каталога разбор отдаёт ролик всегда, и для них здесь ничего нет.
    """
    if info.get("_type") in ("playlist", "multi_video"):
        entries = [entry for entry in info.get("entries") or [] if entry]
        return entries[0] if entries else {}
    return info


class _Quiet:
    """
    Журнал для yt-dlp (`logger`): только ошибки, в журнал службы и сказанные через `explain`.

    Отладка и сведения — шум; предупреждения yt-dlp и без журнала молчат (`no_warnings`), и с
    ним молчат так же. `silent` — не писать и ошибок: у площадки со ссылками откуда угодно в тексте
    ошибки yt-dlp стоит вставленный адрес, а он не наш, чтобы его хранить.
    """

    def __init__(self, explain: Callable[[str], str], *, silent: bool = False):
        self._explain = explain
        self._silent = silent

    def debug(self, message: str) -> None:
        pass

    def info(self, message: str) -> None:
        pass

    def warning(self, message: str) -> None:
        pass

    def error(self, message: str) -> None:
        if not self._silent:
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
    # ytdlp: несёт ли мастер HLS площадки её субтитры сам. У YouTube — да (ручные лежат в
    # мастере), у VK — нет: без флага его субтитры, которые yt-dlp отдаёт отдельным списком,
    # пропадали бы.
    hls_subtitles: bool = True
    # ytdlp: проверять ли поток на DRM до ответа (плейлисты HLS читаются по-настоящему, см.
    # `drm.py`). Нужно площадке, чьи страницы чужие («По ссылке»): у своих площадок DRM узнают по
    # их API, а здесь его видно только в самом плейлисте.
    drm: bool = False
    # ytdlp: какие субтитры брать у yt-dlp. `vtt` — только готовый WebVTT, отдаётся как есть; `any` —
    # и SRT, и TTML: такой файл идёт через маршрут `subtitles`, который переводит его в WebVTT.
    subtitles: Literal["vtt", "any"] = "vtt"
    # ytdlp: готовые файлы каких видов браузер играет — в порядке предпочтения (`None` — прежний выбор
    # по кодекам). Чужие страницы кодеков не называют, зато отдают и `.mpg`, и `.avi`, и `.ogv`, и
    # yt-dlp зовёт «лучшим» исходник, который браузер не откроет (archive.org: `.mpg` против `.mp4`).
    files: tuple[str, ...] | None = None
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
    # page: поток, который спросил плеер страницы (`cinema/sniffer.py`). Страницу разбирать нечего — yt-dlp
    # её не понял; `info` — найденное в форме ответа yt-dlp, дальше всё как у разобранной страницы.
    # `profile` — профиль заголовков потока (`sniffer.Profile`): с ним поток спрашивают проверки и прокси.
    info: Mapping[str, Any] | None = None
    profile: Any = None


def ytdlp(
    url: str,
    *,
    dash: bool = False,
    hls_subtitles: bool = True,
    drm: bool = False,
    subtitles: Literal["vtt", "any"] = "vtt",
    files: tuple[str, ...] | None = None,
    **options: Any,
) -> SourcePlan:
    """
    Страница площадки для yt-dlp.

    `dash` — можно ли собрать DASH из отдельных дорожек, если браузер его играет. Решает
    площадка: это знание о её хранилище, а не о плеере (у YouTube дорожки проиндексированы и
    отдаются по диапазонам, у Twitch — нет). `hls_subtitles` — несёт ли её мастер HLS субтитры
    сам; если нет, субтитры yt-dlp приезжают отдельным списком и при HLS. `drm`, `subtitles` и
    `files` — см. `SourcePlan`.
    """
    return SourcePlan(
        "ytdlp",
        url,
        options=options,
        dash=dash,
        hls_subtitles=hls_subtitles,
        drm=drm,
        subtitles=subtitles,
        files=files,
    )


def page(url: str, info: Mapping[str, Any], profile: Any, *, files: tuple[str, ...]) -> SourcePlan:
    """
    Поток, который спросил плеер страницы: адрес страницы, найденное в форме ответа yt-dlp (`info`) и профиль
    заголовков. Проверки — как у чужой страницы: DRM и эфир по плейлисту, файл — только живой и того вида,
    что играет браузер (`files`).
    """
    return SourcePlan("ytdlp", url, drm=True, subtitles="any", files=files, info=info, profile=profile)


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
        if plan.info is not None:
            # Поток уже нашёл плеер страницы: разбирать её снова незачем, да yt-dlp и не смог бы.
            return await self.settle(plan, dict(plan.info), net, provider, content_id, adaptive)
        gate = self.ytdlp.egress.get(provider)
        if gate is None:
            info = await self.ytdlp.offload(self.ytdlp.probe, plan.url, provider, **plan.options)
        else:
            # Место в выходе ждётся в цикле событий, разбор идёт в пуле выхода (`Egress.run`);
            # отменили разбор — вход закрыт сразу, а место — когда кончится поток.
            try:
                info = await gate.run(
                    lambda lease: self.ytdlp.probe(plan.url, provider, lease=lease, **plan.options)
                )
            except Busy:
                raise HTTPException(503, BUSY) from None
        return await self.settle(plan, info, net, provider, content_id, adaptive)

    async def settle(
        self,
        plan: SourcePlan,
        info: dict[str, Any],
        net: httpx.AsyncClient,
        provider: str,
        content_id: str,
        adaptive: bool,
    ) -> dict[str, Any]:
        """
        Разобранное yt-dlp → ответ `resolve`. Отдельно от разбора: площадка «По ссылке» разбирает
        страницу сама, по шагам, и отдаёт сюда уже готовый ответ yt-dlp — второй раз не спрашивая.
        """
        info = _single(info)
        # Профиль заголовков потока плеера страниц: с ним поток спрашивают и проверки ниже, и прокси.
        extra = plan.profile.headers_for if plan.profile is not None else None
        profile = plan.profile.id if plan.profile is not None else None
        stream, kind = self._stream(info, plan.files)
        dash = None
        if info.get("dash_manifest") and plan.profile is not None:
            # Манифест DASH, который спросил плеер страницы: наш манифест из его дорожек (`mpd.py`).
            dash, length = await self._foreign_dash(
                str(info["dash_manifest"]), net, provider, plan.profile, adaptive
            )
            info = {**info, "duration": info.get("duration") or length}
        elif adaptive and plan.dash and not info.get("is_live") and kind != "hls":
            dash = await self._dash(info, net, provider)
        if dash:
            stream, expires = dash
            kind = "dash"
        else:
            expires = self._expiry([stream] if stream else [])
        if not stream:
            if plan.drm and info.get("_has_drm"):
                raise HTTPException(403, drm.DRM)
            formats = info.get("formats") or []
            if any(str(item.get("protocol", "")).startswith("http_dash") for item in formats):
                raise HTTPException(502, DASH_ONLY)
            if plan.files and formats:
                kinds = sorted({str(item.get("ext")) for item in formats if item.get("ext")})
                raise HTTPException(502, f"{UNPLAYABLE}: {', '.join(kinds)}"[:300])
            raise HTTPException(502, NO_STREAM)
        live = bool(info.get("is_live"))
        if plan.drm and kind == "hls":
            # Эфир виден по самому списку: yt-dlp у чужой страницы его не узнаёт (`drm.inspect_hls`). Мастер,
            # который сайт нам не отдал, — не поток, а отказ: так же его не отдали бы и плееру.
            try:
                found = await drm.inspect_hls(
                    net, stream, lambda url: self.signer.allows(url, provider), extra=extra, locked=True
                )
            except drm.Locked:
                raise HTTPException(502, LOCKED) from None
            live = live or bool(found)
        if plan.files and kind == "file":
            stream = await self._answering(info, plan.files, net, provider, extra)
            if not stream:
                raise HTTPException(502, NO_FILE)
            # Срок подписи — у того файла, что выбран на деле, а не у первого по списку.
            expires = self._expiry([stream])
        poster = info.get("thumbnail") or ""
        # Название, автор и язык — из чужого ответа: обрезаются здесь, на границе, где чужое становится нашим
        # (ключами общей памяти, строкой на диске, полями каждого ответа `resolve`).
        return {
            "provider": provider,
            "contentId": content_id,
            "title": _clip(info.get("title"), TITLE_LIMIT) or content_id,
            "author": _clip(info.get("uploader") or info.get("channel"), AUTHOR_LIMIT),
            "duration": None if live else info.get("duration"),
            "live": live,
            "kind": kind,
            "url": stream
            if kind == "dash"
            else proxied(
                self.signer,
                stream,
                "playlist" if kind == "hls" else "fetch",
                max(1, int(expires - time.time())),
                provider=provider,
                profile=profile,
            ),
            "expiresAt": int(expires * 1000),
            "notice": "Доступен только готовый файл: качество ограничено источником"
            if kind == "file"
            else None,
            # На каком языке ролик говорит сам. Ни одна дорожка в мастере YouTube не помечена
            # как основная (`DEFAULT=NO` у всех), и плеер без подсказки берёт первую по
            # алфавиту — арабскую, французскую, какую придётся. Это и есть «включился чужой
            # язык»: выбора не было, был порядок строк.
            "language": _clip(info.get("language"), LANGUAGE_LIMIT),
            "captions": self._captions(
                info, kind == "hls" and plan.hls_subtitles, provider, converted=plan.subtitles == "any"
            ),
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
            # Файл субтитров площадки бывает не WebVTT (у Rutube это SRT), а `<track>` читает
            # только его: такие файлы идут через маршрут, который переводит их по дороге.
            "captions": [
                {**track, "url": proxied(self.signer, track["url"], "subtitles", provider=provider)}
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
                # Срок адреса — время Unix в секундах (так его пишет YouTube). У чужих сайтов параметр
                # с тем же именем бывает чем угодно, и «expire=1» не должно превращать подпись в
                # секундную: число, которое не похоже на время после 2001 года, не срок.
                if value.isdigit() and int(value) >= 1_000_000_000:
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

    async def _foreign_dash(
        self, url: str, net: httpx.AsyncClient, provider: str, profile: Any, adaptive: bool
    ) -> tuple[tuple[str, float], float]:
        """
        Чужой манифест DASH по требованию — нашим (`mpd.manifest`): каждая дорожка — подписанный адрес `fetch`
        с профилем потока, диапазоны — те же. Манифест читается как чужой список (`drm.text`: несжатым, с
        пределом, переадресация — по политике площадки). Шаблоны и эфир — отказ `DASH_ONLY`, защита — DRM.
        Без MSE (`adaptive` ложно) DASH не играет вовсе — тоже `DASH_ONLY`.
        """
        if not adaptive:
            raise HTTPException(502, DASH_ONLY)

        def allows(target: str) -> bool:
            return self.signer.allows(target, provider)

        try:
            async with asyncio.timeout(drm.CHECK_TIMEOUT):
                found = await drm.text(net, url, allows, profile.headers_for, locked=True)
        except drm.Locked:
            raise HTTPException(502, LOCKED) from None
        except TimeoutError:
            found = None
        if found is None:
            raise HTTPException(502, NO_STREAM)
        try:
            tracks, seconds = mpd.parse(*found)
        except mpd.Protected:
            raise HTTPException(403, drm.DRM) from None
        except mpd.NotOnDemand:
            raise HTTPException(502, DASH_ONLY) from None
        tracks = [track for track in tracks if allows(track.url)]
        if not tracks:
            raise HTTPException(502, DASH_ONLY)
        expires = self._expiry([track.url for track in tracks])
        ttl = max(1, int(expires - time.time()))
        body = mpd.manifest(
            tracks,
            seconds,
            lambda target: proxied(self.signer, target, "fetch", ttl, provider=provider, profile=profile.id),
        )
        key = self.signer.name(body)
        self.dash_manifests[key] = (expires, body)
        while len(self.dash_manifests) > 64:
            self.dash_manifests.pop(next(iter(self.dash_manifests)))
        return (f"{PREFIX}/dash/{key}", expires), seconds

    def dash(self, key: str) -> Response:
        found = self.dash_manifests.get(key)
        if not found or found[0] <= time.time():
            self.dash_manifests.pop(key, None)
            raise HTTPException(410, "Ссылка устарела, откройте видео заново")
        # Манифест собран нами, но он XML с чужими адресами внутри: открыть его вкладкой — скачать (`SEALED`).
        return Response(
            found[1],
            media_type="application/dash+xml",
            headers={"Cache-Control": "no-store", **SEALED},
        )

    def _captions(
        self, info: dict[str, Any], embedded: bool, provider: str, *, converted: bool = False
    ) -> list[dict[str, Any]]:
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

        `converted` — брать и SRT, и TTML, а не только WebVTT: такие файлы идут через маршрут
        `subtitles`, который переводит их по дороге. Туда же идёт и WebVTT — у чужих страниц
        («По ссылке») это ещё и предел по размеру и времени, которого у `fetch` нет.
        """
        manual = info.get("subtitles") or {}
        formats = SUBTITLE_FORMATS if converted else ("vtt",)
        route = "subtitles" if converted else "fetch"
        written = {_base_language(language) for language in manual}
        tracks: list[dict[str, Any]] = []
        seen: set[str] = set()

        def allows(url: str) -> bool:
            return self.signer.allows(url, provider)

        def offer(language: str, entries: list[dict[str, Any]], generated: bool) -> None:
            base = _base_language(language)
            found = _pick(entries, allows, formats)
            if not found or base in seen or (generated and base in written):
                return
            seen.add(base)
            tracks.append(
                {
                    # `ko-orig` — выдумка yt-dlp, а не код языка: так помечена та же
                    # распознанная речь, к которой не приложили перевод. Наружу уходит язык.
                    # Язык и имя — из чужого ответа: обрезаются здесь, как и заголовок.
                    "lang": _clip(language.removesuffix("-orig"), CAPTION_LANG_LIMIT),
                    # Имя от площадки — на английском («Korean»), и оно запасное: плеер
                    # называет язык сам, на языке смотрящего.
                    "label": _clip(found.get("name") or language, CAPTION_LABEL_LIMIT),
                    "auto": generated,
                    "url": proxied(self.signer, found["url"], route, provider=provider),
                }
            )

        if not embedded:
            for language, entries in manual.items():
                offer(language, entries, False)
        for language, entries in (info.get("automatic_captions") or {}).items():
            found = _pick(entries, allows, formats)
            # Все нетронутые переводом дорожки — это одна и та же распознанная речь под
            # разными ключами (`ko` и `ko-orig`); лишние отсеивает общий отбор по языку.
            if found and "tlang=" not in found["url"]:
                offer(language, entries, True)
        return tracks[:CAPTIONS_LIMIT]

    @staticmethod
    def _stream(info: dict[str, Any], files: tuple[str, ...] | None = None) -> tuple[str | None, str]:
        """
        Что отдать плееру: мастер HLS — если площадка его предлагает, иначе готовый файл.

        HLS предпочтительнее не из красоты: в нём лежат **все** уровни качества сразу, и выбор
        между ними делает наш плеер, а не площадка. Обычный файл остаётся запасным ходом для
        тех роликов, которым YouTube плейлиста не даёт; там качество одно. `files` — какие файлы
        браузер играет (`SourcePlan.files`): тогда файл выбирается по виду, а не по кодекам.
        """
        formats = info.get("formats") or []
        for item in formats:
            if str(item.get("protocol", "")).startswith("m3u8") and item.get("manifest_url"):
                return item["manifest_url"], "hls"
        # Адрес манифеста у выбранного формата — HLS, только если сам формат HLS: у формата DASH там
        # манифест DASH, и плеер HLS его не прочтёт.
        if info.get("manifest_url") and str(info.get("protocol", "")).startswith("m3u8"):
            return info["manifest_url"], "hls"
        # Сайт отдал не мастер, а сразу список кусочков одного качества: это тоже HLS, и отдать его
        # «готовым файлом» значило бы дать плееру плейлист вместо видео. У площадок каталога такого
        # не бывает — у них мастер есть всегда, и выбор для них тот же, что был.
        for item in formats:
            if str(item.get("protocol", "")).startswith("m3u8") and item.get("url"):
                return item["url"], "hls"
        if files is not None:
            return Resolver._file(formats, files), "file"
        progressive = [
            item
            for item in formats
            if item.get("acodec") not in (None, "none")
            and item.get("vcodec") not in (None, "none")
            and item.get("url")
            and item.get("protocol") in (None, "http", "https")
        ]
        progressive.sort(key=lambda item: (item.get("height") or 0, item.get("tbr") or 0))
        if progressive:
            return progressive[-1]["url"], "file"
        # Кусочки DASH (`http_dash_segments`) — не файл: адрес у них — сам манифест или первый кусок.
        if info.get("url") and info.get("protocol") in (None, "http", "https"):
            return info["url"], "file"
        return None, "file"

    @staticmethod
    def _file(formats: list[dict[str, Any]], files: tuple[str, ...]) -> str | None:
        found = playable_file(formats, files)
        return found["url"] if found else None

    async def _answering(
        self,
        info: dict[str, Any],
        files: tuple[str, ...],
        net: httpx.AsyncClient,
        provider: str,
        extra: drm.Extra | None = None,
    ) -> str | None:
        """Первый по порядку `ranked_files` файл, который сайт действительно отдаёт (не больше трёх)."""

        def allows(url: str) -> bool:
            return self.signer.allows(url, provider)

        for item in ranked_files(info.get("formats") or [], files)[:3]:
            # Готовый файл — только с видом видеофайла (M4): не HTML, отданная «файлом».
            if await drm.answers(net, item["url"], allows, extra=extra, media_only=True):
                return item["url"]
        return None


def playable_file(formats: list[dict[str, Any]], files: tuple[str, ...]) -> dict[str, Any] | None:
    """Лучший из `ranked_files` — или `None`, если браузеру играть нечего."""
    found = ranked_files(formats, files)
    return found[0] if found else None


def ranked_files(formats: list[dict[str, Any]], files: tuple[str, ...]) -> list[dict[str, Any]]:
    """
    Готовые файлы, которые комната может смотреть, лучший первым: из тех, что браузер играет (`files` —
    лучший вид первым), с картинкой и кодеком, который браузер знает (или не названным вовсе — чужие
    страницы кодек называют редко). Выше `FILE_SIDE` — только если ниже нет ничего: у файла нет лестницы
    качества, и каждый зритель тянет его целиком через наш сервер (Wikimedia отдаёт исходник 4K в три
    гигабайта рядом с 1080p). Нет ни одного — звук без картинки, если он есть.
    """

    def plain(item: dict[str, Any]) -> bool:
        return bool(item.get("url")) and item.get("protocol") in ("http", "https")

    def known(item: dict[str, Any]) -> bool:
        codec = str(item.get("vcodec") or "").lower()
        return not codec or codec.startswith(BROWSER_CODECS)

    videos = [
        item
        for item in formats
        if plain(item)
        and item.get("ext") in files
        and item.get("vcodec") != "none"
        and item.get("acodec") != "none"
        and known(item)
    ]

    def rank(item: dict[str, Any]) -> tuple[bool, float, int, float]:
        side = frame_side(item) or 0
        fits = side <= FILE_SIDE
        return (fits, side if fits else -side, -files.index(item["ext"]), item.get("tbr") or 0)

    if videos:
        return sorted(videos, key=rank, reverse=True)
    sounds = [
        item
        for item in formats
        if plain(item)
        and item.get("vcodec") == "none"
        and item.get("acodec") != "none"
        and item.get("ext") in AUDIO_FILES
    ]
    return sorted(sounds, key=lambda item: item.get("abr") or item.get("tbr") or 0, reverse=True)


def frame_side(item: dict[str, Any]) -> float | None:
    """Меньшая сторона кадра: вертикальное видео 1080×1920 — это «1080p», а не «1920p»."""
    height, width = item.get("height"), item.get("width")
    height = height if isinstance(height, (int, float)) and height > 0 else None
    width = width if isinstance(width, (int, float)) and width > 0 else None
    return min(height, width) if height and width else height
