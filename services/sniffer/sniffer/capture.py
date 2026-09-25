"""
Что из запросов страницы — поток для нашего плеера, с какими заголовками его спросили и что ещё видно.

Здесь только правила, без браузера: `page.py` отдаёт сюда то, что увидел Chromium (адрес, тип ответа,
вид запроса, заголовки), и правила же решают, что ответить службе. Поэтому их можно проверить без
браузера, а браузерные тесты проверяют уже весь путь.

ЧТО СЧИТАЕТСЯ ПОТОКОМ. Только то, что видно в самом запросе: тип ответа (`Content-Type`) или вид адреса.
Плейлист HLS и манифест DASH — кто бы их ни спросил (плеер на MSE спрашивает их `fetch`/XHR, тег
`<video>` — сам). Готовый файл — только если его спросил сам тег `<video>`/`<audio>` (вид запроса
`media`): кусочки потока плеер на MSE спрашивает тем же `fetch` и с тем же `video/mp4`, и принять их за
фильм значило бы показать комнате две секунды. Разборщиков под чужие плееры нет — и быть не должно.

ЗАГОЛОВКИ. Служба повторит их, спрашивая поток сама (профиль заголовков): Referer, Origin и имя браузера —
как их послал Chromium; cookies — по хосту, ровно тем хостам, которым браузер их послал сам, и только у
запросов потока (плейлисты, кусочки, ключи). Всё — печатными ASCII и с пределом длины: значения пришли со
страницы, а дальше они станут заголовками запроса службы.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from urllib.parse import urlsplit

HLS_TYPES = frozenset(
    {
        "application/vnd.apple.mpegurl",
        "application/x-mpegurl",
        "application/mpegurl",
        "audio/mpegurl",
        "audio/x-mpegurl",
        "vnd.apple.mpegurl",
    }
)
DASH_TYPES = frozenset({"application/dash+xml"})
# Готовые файлы по виду адреса и по типу ответа — то, что играют браузеры.
FILE_EXTENSIONS = frozenset(
    {"mp4", "m4v", "webm", "mov", "m4a", "mp3", "ogg", "oga", "opus", "aac", "flac", "wav"}
)
FILE_TYPES = {
    "video/mp4": "mp4",
    "video/x-m4v": "m4v",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "audio/webm": "webm",
    "audio/aac": "aac",
    "audio/flac": "flac",
    "audio/wav": "wav",
}
# Кусочки, ключи и дорожки потока: их cookies нужны нашему прокси так же, как у плейлиста.
PIECE_EXTENSIONS = frozenset(
    {"ts", "m2ts", "m4s", "mp4", "m4v", "m4a", "aac", "cmfv", "cmfa", "key", "vtt", "webvtt", "m3u8", "mpd"}
)
PIECE_TYPES = frozenset({"application/octet-stream", "binary/octet-stream", "text/vtt"})
# Какие запросы вообще бывают у плеера: свой `fetch`/XHR, сам тег `<video>` и «прочее» (так Chromium
# называет, например, запросы воркера).
PLAYER_REQUESTS = frozenset({"xhr", "fetch", "media", "other"})

# Пределы того, что уходит службе. Адрес — как у ссылки кинозала; cookie — как у браузера на один хост.
LONGEST_URL = 2000
LONGEST_ORIGIN = 300
LONGEST_AGENT = 512
LONGEST_COOKIE = 4096
LONGEST_TITLE = 300
STREAMS = 16
HOSTS = 16
SYSTEMS = 8
HEIGHTS = 12
PRINTABLE = re.compile(r"[\x20-\x7e]*")
ORIGIN = re.compile(r"https?://[A-Za-z0-9.\-\[\]:]+")
RESOLUTION = re.compile(r"RESOLUTION=(\d{1,5})x(\d{1,5})")

# Ключ ClearKey — шифрование с ключом в открытую, не DRM: сам по себе он отказа не значит.
CLEAR_KEY = "org.w3.clearkey"

# Проверка на человека: сервисы капчи и страницы «проверяем ваш браузер». По ним отказ звучит как
# «сайт просит подтвердить, что вы не робот», а не «видео не нашлось», — но только если потока нет.
CHALLENGE_HOSTS = (
    "challenges.cloudflare.com",
    "hcaptcha.com",
    "recaptcha.net",
    "captcha-delivery.com",
    "smartcaptcha.yandexcloud.net",
    "captcha-api.yandex.ru",
    "arkoselabs.com",
    "funcaptcha.com",
    "geetest.com",
    "check.ddos-guard.net",
)
CHALLENGE_PATH = re.compile(r"/(?:showcaptcha|captcha|cdn-cgi/challenge-platform)(?:[/?#.]|$)", re.IGNORECASE)
CHALLENGE_TITLE = re.compile(
    r"just a moment|attention required|checking your browser|verify you are human|are you a robot|"
    r"вы не робот|проверка браузера|ddos-guard|captcha|капча",
    re.IGNORECASE,
)
# Страница входа: куда ведут сайты, которые показывают видео только своим.
LOGIN_PATH = re.compile(
    r"/(?:login|signin|sign-in|sign_in|auth|oauth|passport|account/login)(?:[/?#.]|$)", re.IGNORECASE
)


def content_type(value: str | None) -> str:
    return (value or "").split(";", 1)[0].strip().lower()


def extension(url: str) -> str:
    path = urlsplit(url).path.lower()
    name = path.rsplit("/", 1)[-1]
    return name.rsplit(".", 1)[-1] if "." in name else ""


def web(url: str) -> bool:
    """Адрес, который можно отдать службе: http(s), с хостом, без входа, без пробелов и не длиннее предела."""
    if not isinstance(url, str) or not url or len(url) > LONGEST_URL or not PRINTABLE.fullmatch(url):
        return False
    if " " in url:
        return False
    try:
        parts = urlsplit(url)
        _ = parts.port
    except ValueError:
        return False
    return parts.scheme in ("http", "https") and bool(parts.hostname) and "@" not in parts.netloc


def kind_of(url: str, kind: str | None, request: str) -> str | None:
    """
    Поток ли это и какой: `hls`, `dash`, `file` — или `None`. `kind` — тип ответа, `request` — вид запроса
    у Chromium (`media` — его спросил сам тег `<video>`/`<audio>`).
    """
    kind = content_type(kind)
    ext = extension(url)
    if kind in HLS_TYPES or ext == "m3u8":
        return "hls"
    if kind in DASH_TYPES or ext == "mpd":
        return "dash"
    if request == "media" and (kind.startswith(("video/", "audio/")) or ext in FILE_EXTENSIONS):
        return "file"
    return None


def streamish(url: str, kind: str | None, request: str) -> bool:
    """Запрос плеера за частью потока — его cookies понадобятся нашему прокси."""
    if request not in PLAYER_REQUESTS:
        return False
    kind = content_type(kind)
    return (
        kind_of(url, kind, request) is not None
        or kind.startswith(("video/", "audio/"))
        or kind in PIECE_TYPES
        or extension(url) in PIECE_EXTENSIONS
    )


def file_extension(url: str, kind: str | None) -> str:
    """Вид файла для службы: по адресу, а если по адресу не видно — по типу ответа."""
    ext = extension(url)
    if ext in FILE_EXTENSIONS:
        return ext
    return FILE_TYPES.get(content_type(kind), "")


def header(value: object, limit: int) -> str:
    """Значение заголовка, которое можно повторить: печатное ASCII и не длиннее предела; иначе пусто."""
    text = str(value or "").strip()
    return text if len(text) <= limit and PRINTABLE.fullmatch(text) else ""


def profile_of(headers: dict[str, str]) -> dict[str, str]:
    """Referer, Origin и имя браузера запроса — как их послал Chromium, если их можно повторить."""
    found: dict[str, str] = {}
    referer = header(headers.get("referer"), LONGEST_URL)
    if referer and web(referer):
        found["referer"] = referer
    origin = header(headers.get("origin"), LONGEST_ORIGIN)
    # `Origin: null` у песочницы и у данных: повторять его незачем, это не чей-то сайт.
    if origin and ORIGIN.fullmatch(origin):
        found["origin"] = origin
    agent = header(headers.get("user-agent"), LONGEST_AGENT)
    if agent:
        found["user-agent"] = agent
    return found


def playlist_facts(text: str) -> tuple[bool | None, tuple[int, ...]]:
    """Мастер ли это (`None` — не понять) и ступени качества мастера по меньшей стороне кадра."""
    if "#EXTM3U" not in text[:1024]:
        return None, ()
    master = "#EXT-X-STREAM-INF" in text or "#EXT-X-MEDIA:" in text
    if not master and "#EXTINF" not in text:
        return None, ()
    sides = {min(int(width), int(height)) for width, height in RESOLUTION.findall(text) if int(height)}
    return master, tuple(sorted((side for side in sides if 0 < side <= 8640), reverse=True))[:HEIGHTS]


@dataclass
class Stream:
    url: str
    kind: str
    # В каком порядке браузер спросил потоки: мастер HLS плеер спрашивает раньше своих вариантов.
    order: int
    headers: dict[str, str]
    frame: str = ""
    master: bool | None = None
    heights: tuple[int, ...] = ()
    ext: str = ""

    def wire(self) -> dict[str, object]:
        found: dict[str, object] = {"url": self.url, "type": self.kind, "headers": dict(self.headers)}
        if self.master is not None:
            found["master"] = self.master
        if self.heights:
            found["heights"] = list(self.heights)
        if self.ext:
            found["ext"] = self.ext
        if self.frame and web(self.frame):
            found["frame"] = self.frame
        return found


@dataclass
class Catch:
    """
    Что поймано за одну страницу: потоки, cookies запросов потока по хостам и признаки EME.

    `closed` — после этого номера новые потоки не принимаются: главная страница ушла на другой документ
    после нашего нажатия (реклама, «откройте в приложении»), и её видео — уже не то, что вставили.
    """

    streams: dict[str, Stream] = field(default_factory=dict)
    cookies: dict[str, str] = field(default_factory=dict)
    systems: list[str] = field(default_factory=list)
    # EME в деле: `encrypted` у элемента, лицензия (`generateRequest`) или ключи на элементе.
    used: bool = False
    counter: int = 0
    closed: bool = False

    def wants(self, url: str, reading: int = 0) -> bool:
        """
        Нужен ли улову этот поток: страница не ушла, адрес новый, и место есть — считая потоки, которые ещё
        читаются (`reading`): ответы приходят разом, и без этого прочитали бы все, прежде чем записать первый.
        """
        return not self.closed and url not in self.streams and len(self.streams) + reading < STREAMS

    def ticket(self) -> int:
        """Номер запроса — в момент, когда браузер о нём сказал, а не когда мы дочитали его заголовки."""
        self.counter += 1
        return self.counter

    def stream(
        self,
        url: str,
        kind: str,
        headers: dict[str, str],
        *,
        order: int = 0,
        frame: str = "",
        master: bool | None = None,
        heights: tuple[int, ...] = (),
        ext: str = "",
    ) -> bool:
        """Запомнить поток (первый раз — с его заголовками); `True` — он новый."""
        if self.closed or not web(url) or url in self.streams or len(self.streams) >= STREAMS:
            return False
        order = order or self.ticket()
        self.streams[url] = Stream(url, kind, order, profile_of(headers), frame, master, heights, ext)
        return True

    def cookie(self, url: str, value: object) -> None:
        """Cookie, которую браузер послал хосту потока, — последняя, как у самого браузера."""
        cookie = header(value, LONGEST_COOKIE)
        host = (urlsplit(url).hostname or "").lower()
        if not cookie or not host or len(host) > 253:
            return
        if host in self.cookies or len(self.cookies) < HOSTS:
            self.cookies[host] = cookie

    def eme(self, signal: str, detail: str = "") -> None:
        """Признак со страницы: `system` — спросили систему ключей, остальное — EME уже в деле."""
        if signal == "system":
            system = header(detail, 64).lower()
            if system and system not in self.systems and len(self.systems) < SYSTEMS:
                self.systems.append(system)
        elif signal in ("encrypted", "keys", "license"):
            self.used = True

    def ranked(self, playing: list[str] | tuple[str, ...] = ()) -> list[Stream]:
        """
        Лучший первым: мастер HLS, другой HLS, DASH, готовый файл. Среди файлов — тот, что играет в самом
        большом `<video>` страницы (реклама перед фильмом — тоже файл, но в другом элементе или раньше).
        """
        order = {"hls": 0, "dash": 1, "file": 2}

        def rank(stream: Stream) -> tuple[int, int, int, int]:
            master = 0 if stream.master else 1 if stream.master is None else 2
            shown = playing.index(stream.url) if stream.url in playing else len(playing)
            return (order[stream.kind], master, shown, stream.order)

        return sorted(self.streams.values(), key=rank)

    def drm(self) -> bool:
        """
        DRM: EME в деле — всегда; система ключей DRM спрошена, а открытого потока (HLS, файл) нет — тоже.

        Одного вопроса о системе ключей мало: плееры спрашивают её и у открытого видео, чтобы знать, что
        умеет браузер. Поток такой страницы потом всё равно проверяет служба — ключи в плейлисте HLS.
        """
        if self.used:
            return True
        asked = any(system != CLEAR_KEY for system in self.systems)
        return asked and not any(stream.kind in ("hls", "file") for stream in self.streams.values())


def challenged(page: str, title: str, frames: list[str] | tuple[str, ...] = ()) -> bool:
    """Страница проверяет, человек ли перед ней: по адресу, имени страницы или рамке сервиса капчи."""
    if CHALLENGE_TITLE.search(title or ""):
        return True
    for url in (page, *frames):
        parts = urlsplit(url or "")
        host = (parts.hostname or "").lower()
        if any(host == known or host.endswith("." + known) for known in CHALLENGE_HOSTS):
            return True
        if host.endswith("google.com") and parts.path.startswith("/recaptcha"):
            return True
        if url == page and CHALLENGE_PATH.search(parts.path or ""):
            return True
    return False


def login_wall(page: str, password: bool) -> bool:
    """Страница просит войти: её адрес — страница входа, или на ней видно поле пароля."""
    return password or bool(LOGIN_PATH.search(urlsplit(page or "").path or ""))


def title_of(text: object) -> str:
    """Имя страницы для карточки: одной строкой, без управляющих знаков и не длиннее предела."""
    cleaned = re.sub(r"\s+", " ", re.sub(r"[\x00-\x1f\x7f]", " ", str(text or ""))).strip()
    return cleaned[:LONGEST_TITLE]
