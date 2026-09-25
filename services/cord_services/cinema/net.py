"""
Выход кинозала наружу: через что ходит каждая площадка и куда ей ходить нельзя.

ПРОКСИ. `CINEMA_PROXY` — выход для всех площадок, `CINEMA_PROXY_<ID>` — для одной (имя
площадки заглавными: `CINEMA_PROXY_YOUTUBE`), и он важнее общего. Схемы — http, https, socks5 и
socks5h. Прокси площадки один и тот же у httpx (каталог, плейлисты, кусочки) и у yt-dlp
(разбор ссылки): адреса потока у площадок бывают привязаны к адресу, с которого их выдали, и
кусочек, спрошенный не оттуда, где разобран ролик, получает 403.

COOKIES. `CINEMA_COOKIES_<ID>` — путь к cookies.txt в формате Netscape, который yt-dlp получает
для этой площадки и только для неё (httpx их не видит). Это единственный ход против проверки
YouTube «Sign in to confirm you're not a bot» по адресу сервера, кроме другого выхода наружу.
Файл читается и проверяется один раз, при сборке приложения; не читается или не того формата —
одна строка в журнале, и площадка работает без cookies. Содержимое не пишется в журнал никогда.

ТОЛЬКО НАРУЖУ. Соединение идёт только на публичный адрес, и проверка стоит там, где имя уже
разрешено: транспорт сам разрешает имя, проверяет каждый адрес и соединяется ровно с
проверенным. Проверка «по имени» заранее ничего не доказывает — имя, которое на проверке
публичное, на соединении может ответить 127.0.0.1 (DNS rebinding). Частный адрес открывает
только `CINEMA_PRIVATE_HOSTS_<ID>` — одной площадке и, если назван порт, только этот порт:
`127.0.0.1/32:8097` для своей медиатеки, `[fd00::/8]:8096`, `media.lan:8096`. Общей строки на
все площадки нет нарочно: служба живёт в сети хоста, и `127.0.0.1` для всех значил бы, что
ссылка любого участника дотянется до базы, ядра и Redis на той же машине.

БРАУЗЕР. Клиент площадки представляется общим именем кинозала (`USER_AGENT`), если площадка не
назвала своё (`Provider.user_agent`): CDN VK Видео отдаёт поток только браузеру того класса, для
которого выдан адрес, и на имя кинозала отвечает 400.

Настройки читает `NetConfig.from_env` один раз, при сборке приложения; тесты передают
`NetConfig` сами и от окружения процесса не зависят.
"""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import io
import logging
import os
import re
import socket
import ssl
import tempfile
import warnings
from dataclasses import dataclass, field
from ipaddress import IPv4Address, IPv4Network, IPv6Address, IPv6Network, ip_address, ip_network
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Iterable, Iterator, Mapping, Sequence
from urllib.parse import unquote, urlsplit

import httpcore
import httpx

if TYPE_CHECKING:
    from .registry import HostPolicy

logger = logging.getLogger(__name__)

Address = IPv4Address | IPv6Address
Network = IPv4Network | IPv6Network
Resolve = Callable[[str, int], Awaitable[Sequence[str]]]

PROXY_SCHEMES = ("http", "https", "socks5", "socks5h")
# Обычные переменные прокси: httpx кинозала их больше не читает сам — выход задаёт CINEMA_PROXY.
STANDARD_PROXIES = ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")
# Больше этого cookies.txt не бывает; всё, что больше, — не cookies.
COOKIES_LIMIT = 1024 * 1024
NETSCAPE_MAGIC = re.compile(r"#( Netscape)? HTTP Cookie File")
HTTPONLY_PREFIX = "#HttpOnly_"
# Так начинается имя копии cookies на один вызов yt-dlp. По нему текст ошибки yt-dlp, где эта
# копия названа (а рядом с ней бывает и строка файла со значением), узнаётся и заменяется.
COOKIE_COPY = "cord-cookies-"
# Значения cookie короче этого — флажки согласия и настройки, а не сессия; вычёркивать их из
# текста ошибки значило бы портить сам текст.
SECRET_SHORTEST = 8
# Сколько ждать один адрес, если за именем их несколько: остальным тоже нужен срок.
ATTEMPT_TIMEOUT = 4.0

TIMEOUT = httpx.Timeout(20.0, read=60.0)
# Соединений в пуле клиента. У площадки каталога хосты известны и адреса свои — как у httpx по умолчанию.
# У площадки с любыми хостами («По ссылке») адрес плейлиста и кусочков ведёт на сервер того, кто вставил
# ссылку, а подписанный адрес открывается без входа: сотня соединений одной такой ссылки — это сотня чужих
# чтений разом. Их и так держит предел чтения в память (`facade.FOREIGN_READS`) и очередь переписывания, но
# пул поменьше — вторая стена и меньше сокетов зря.
POOL = httpx.Limits(max_connections=100, max_keepalive_connections=20)
FOREIGN_POOL = httpx.Limits(max_connections=24, max_keepalive_connections=8)
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Cord/1.0"
# Настольный Chrome — тем же именем VK и Rutube ходят к своим площадкам (`providers/vk.py`,
# `providers/rutube.py`), а yt-dlp и сам ходит под Chrome.
BROWSER = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/140.0.0.0 Safari/537.36"
)

# Порты, на которые браузер не ходит ни за чем (стандарт Fetch, «port blocking»): почта, SSH,
# IRC, SIP и прочие службы, которые не HTTP. Площадке с любыми хостами («По ссылке») туда нельзя
# тоже — иначе страница, которую вставил любой участник, заставляла бы сервер стучаться запросом
# HTTP в чужой почтовый сервер (межпротокольная атака). Список — ровно стандартный.
BAD_PORTS = frozenset(
    {
        0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101,
        102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389,
        427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636,
        989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566,
        6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
    }
)  # fmt: skip


@dataclass(frozen=True)
class Allowance:
    """
    Куда площадке можно, хотя адрес и не публичный: сеть (любой порт или один) или имя с портом.

    Имя разрешает всё, во что оно разрешится, — но только его и только на этом порту: имя своей
    сети назначает администратор, чужому его не переназначить.
    """

    network: Network | None = None
    host: str | None = None
    port: int | None = None

    def covers(self, host: str, address: Address, port: int) -> bool:
        if self.port is not None and self.port != port:
            return False
        if self.host is not None:
            return host.lower().rstrip(".") == self.host
        return self.network is not None and _plain(address) in self.network


@dataclass(frozen=True)
class NetConfig:
    """
    Настройки выхода наружу. Прокси и cookies в `repr` не попадают: в них бывают пароли.

    `cookies` — уже прочитанное и проверенное содержимое файла по имени площадки, `private` —
    разрешённые ей частные адреса.
    """

    proxy: str | None = field(default=None, repr=False)
    proxies: Mapping[str, str] = field(default_factory=dict, repr=False)
    cookies: Mapping[str, str] = field(default_factory=dict, repr=False)
    private: Mapping[str, tuple[Allowance, ...]] = field(default_factory=dict)

    def proxy_for(self, provider: str) -> str | None:
        return self.proxies.get(provider) or self.proxy

    def cookies_for(self, provider: str) -> str | None:
        return self.cookies.get(provider)

    def private_for(self, provider: str) -> tuple[Allowance, ...]:
        return tuple(self.private.get(provider, ()))

    def secrets(self) -> list[str]:
        """
        Что нельзя показывать никому: вход в прокси (имя с паролем и сам пароль) и значения cookie.

        Хост прокси остаётся виден — по нему понятно, какой выход отказал, — а вход в него нет.
        Короткое (пароль короче четырёх знаков, флажок cookie) отдельно не ищется: замена по нему
        испортила бы весь текст, а секретом оно не бывает.
        """
        found: list[str] = []
        for value in (self.proxy, *self.proxies.values()):
            userinfo, at, _ = urlsplit(value or "").netloc.rpartition("@")
            if not at:
                continue
            found.append(userinfo + "@")
            password = userinfo.partition(":")[2]
            found.extend(word for word in {password, unquote(password)} if len(word) >= 4)
        for text in self.cookies.values():
            for line in text.splitlines():
                fields = line.removeprefix(HTTPONLY_PREFIX).split("\t")
                if len(fields) == 7 and not fields[0].startswith("#") and len(fields[6]) >= SECRET_SHORTEST:
                    found.append(fields[6])
        # Длинное — раньше: пароль бывает частью строки входа, и заменить нужно её целиком.
        return sorted(set(found), key=len, reverse=True)

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> NetConfig:
        proxy = _proxy("CINEMA_PROXY", env.get("CINEMA_PROXY", ""))
        proxies: dict[str, str] = {}
        cookies: dict[str, str] = {}
        private: dict[str, tuple[Allowance, ...]] = {}
        for name in sorted(env):
            if name.startswith("CINEMA_PROXY_") and len(name) > len("CINEMA_PROXY_"):
                value = _proxy(name, env[name])
                if value:
                    proxies[name.removeprefix("CINEMA_PROXY_").lower()] = value
            elif name.startswith("CINEMA_COOKIES_") and len(name) > len("CINEMA_COOKIES_"):
                text = _cookies(name, env[name])
                if text is not None:
                    cookies[name.removeprefix("CINEMA_COOKIES_").lower()] = text
            elif name.startswith("CINEMA_PRIVATE_HOSTS_") and len(name) > len("CINEMA_PRIVATE_HOSTS_"):
                allowances = _allowances(name, env[name])
                if allowances:
                    private[name.removeprefix("CINEMA_PRIVATE_HOSTS_").lower()] = allowances
        if proxy is None and any(env.get(name) for name in STANDARD_PROXIES):
            logger.warning(
                "кинозал не читает HTTP_PROXY/HTTPS_PROXY/ALL_PROXY: выход наружу задаёт CINEMA_PROXY "
                "(и CINEMA_PROXY_<ПЛОЩАДКА>)"
            )
        if (env.get("CINEMA_PRIVATE_HOSTS") or "").strip():
            logger.warning(
                "CINEMA_PRIVATE_HOSTS не действует: частный адрес открывается одной площадке — "
                "CINEMA_PRIVATE_HOSTS_<ПЛОЩАДКА>, лучше с портом (127.0.0.1/32:8097)"
            )
        return cls(proxy, proxies, cookies, private)


def _proxy(name: str, value: str) -> str | None:
    value = (value or "").strip()
    if not value:
        return None
    try:
        url = httpx.URL(value)
    except httpx.InvalidURL:
        url = None
    if url is None or url.scheme not in PROXY_SCHEMES or not url.host:
        # Значение в журнал не идёт: в адресе прокси бывает пароль.
        logger.warning(
            "%s: прокси не понят — нужны схема http, https, socks5 или socks5h и хост; "
            "площадка ходит без него",
            name,
        )
        return None
    return value


HOSTNAME = re.compile(r"(?=.*[A-Za-z])[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.?")


def _allowances(name: str, text: str) -> tuple[Allowance, ...]:
    """
    Строка `CINEMA_PRIVATE_HOSTS_<ID>`: через запятую `CIDR`, `CIDR:порт`, `[IPv6/CIDR]:порт` или
    `имя:порт`. Всё, что не понято, — одной строкой в журнале; сеть с лишними битами хоста
    (`10.0.0.1/8`) понимается как её сеть (`10.0.0.0/8`) — тоже со строкой в журнале.
    """
    found: list[Allowance] = []
    wrong: list[str] = []
    widened: list[str] = []
    for part in (text or "").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            allowance, exact = _allowance(part)
        except ValueError:
            wrong.append(part)
            continue
        found.append(allowance)
        if not exact:
            widened.append(f"{part} → {allowance.network}")
    if wrong:
        logger.warning("%s: не поняты и пропущены: %s", name, ", ".join(wrong))
    if widened:
        logger.warning("%s: у сети лишние биты хоста, понята как сеть: %s", name, ", ".join(widened))
    return tuple(found)


def _allowance(part: str) -> tuple[Allowance, bool]:
    """Одна запись и то, записана ли сеть точно (без битов хоста)."""
    if part.startswith("["):
        head, bracket, rest = part[1:].partition("]")
        if not bracket or (rest and not rest.startswith(":")):
            raise ValueError(part)
        port = _port(rest[1:]) if rest else None
    elif part.count(":") == 1:
        head, _, tail = part.partition(":")
        port = _port(tail)
    else:
        # Без двоеточия — сеть без порта; с несколькими — IPv6 без порта (порт — только в скобках).
        head, port = part, None
    try:
        network = ip_network(head)
        exact = True
    except ValueError:
        try:
            network = ip_network(head, strict=False)
            exact = False
        except ValueError:
            # Имя — только с портом: имя своей сети открывает один сервис, а не всю машину.
            if port is None or not HOSTNAME.fullmatch(head):
                raise ValueError(part) from None
            return Allowance(host=head.lower().rstrip("."), port=port), True
    return Allowance(network=_plain_network(network), port=port), exact


def _port(text: str) -> int:
    if not text.isdigit() or not 0 < int(text) < 65536:
        raise ValueError(text)
    return int(text)


MAPPED = IPv6Network("::ffff:0:0/96")


def _plain_network(network: Network) -> Network:
    """IPv4 внутри IPv6 (`::ffff:10.0.0.0/104`) — это та же сеть IPv4 (`10.0.0.0/8`)."""
    if isinstance(network, IPv6Network) and network.prefixlen >= 96 and network.subnet_of(MAPPED):
        inner = network.network_address.ipv4_mapped
        assert inner is not None
        return IPv4Network(f"{inner}/{network.prefixlen - 96}")
    return network


def _plain(address: Address) -> Address:
    if isinstance(address, IPv6Address) and address.ipv4_mapped is not None:
        return address.ipv4_mapped
    return address


def _cookies(name: str, path: str) -> str | None:
    """
    Содержимое cookies.txt, если его можно отдать yt-dlp.

    Проверка — та же, что у yt-dlp при загрузке, и нужна она не только ради понятного отказа:
    строку, которую yt-dlp не понял, он печатает в stderr **целиком**, вместе со значением
    cookie. Поэтому до него доходит только файл, в котором он всё поймёт.
    """
    path = (path or "").strip()
    if not path:
        return None
    try:
        with open(path, encoding="utf-8") as source:
            text = source.read(COOKIES_LIMIT + 1)
    except (OSError, UnicodeDecodeError) as error:
        reason = error.strerror if isinstance(error, OSError) and error.strerror else "не UTF-8"
        logger.warning(
            "%s: файл cookies %s не читается (%s) — площадка ходит без cookies", name, path, reason
        )
        return None
    problem = "файл больше мегабайта" if len(text) > COOKIES_LIMIT else _netscape_problem(text)
    if problem is None:
        problem = cookie_problem(text)
    if problem:
        logger.warning(
            "%s: файл cookies %s не в формате Netscape (%s) — площадка ходит без cookies", name, path, problem
        )
        return None
    return text


def _netscape_problem(text: str) -> str | None:
    """Что не так с файлом cookies — номером строки, без её содержимого; `None` — всё так."""
    lines = text.splitlines()
    if not lines or not NETSCAPE_MAGIC.match(lines[0]):
        if text.lstrip()[:1] in ("[", "{"):
            return "это JSON, а нужен cookies.txt"
        return "первая строка — не «# Netscape HTTP Cookie File»"
    for number, line in enumerate(lines[1:], 2):
        line = line.removeprefix(HTTPONLY_PREFIX)
        if line.startswith("#") or not line.strip():
            continue
        fields = line.split("\t")
        if len(fields) != 7 or (fields[4] and not re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", fields[4])):
            return f"строка {number} — не семь полей через табуляцию"
    return None


def cookie_problem(text: str) -> str | None:
    """
    Загружается ли файл тем самым загрузчиком, которым его потом загрузит yt-dlp.

    Проверка по полям не ловит всего: строка с флагом «для поддоменов», который спорит с точкой
    в начале домена, проходит по полям, а загрузчик на ней падает — и yt-dlp повторяет её
    целиком, со значением, в тексте ошибки. Поэтому файл загружается по-настоящему, а если нет —
    по одной строке, чтобы назвать номер той, на которой он падает.
    """
    if _loads(text):
        return None
    lines = text.splitlines()
    for number, line in enumerate(lines[1:], 2):
        bare = line.removeprefix(HTTPONLY_PREFIX)
        if bare.startswith("#") or not bare.strip():
            continue
        if not _loads(f"{lines[0]}\n{line}\n"):
            return f"строка {number} не загружается"
    return "файл не загружается"


def _loads(text: str) -> bool:
    """
    Загружает текст в одноразовую банку cookies yt-dlp — молча.

    Всё, что загрузчик хотел бы сказать (предупреждения Python, строки в stderr — в них бывает
    значение cookie), остаётся здесь и считается отказом: на запросе он сказал бы это в журнал.
    """
    from yt_dlp.cookies import YoutubeDLCookieJar  # тяжёлый модуль: только если cookies заданы

    noise = io.StringIO()
    try:
        with warnings.catch_warnings(), contextlib.redirect_stderr(noise):
            warnings.simplefilter("ignore")
            YoutubeDLCookieJar().load(io.StringIO(text))
    except Exception:
        return False
    return not noise.getvalue()


@contextlib.contextmanager
def cookie_file(text: str | None) -> Iterator[str | None]:
    """
    Свой файл cookies на один вызов yt-dlp.

    yt-dlp при выходе записывает cookies обратно в файл, который получил: файл администратора
    может быть только для чтения (тогда падал бы каждый вызов), а несколько потоков `to_thread`
    писали бы в него разом. Копия живёт один вызов, с правами только для службы.
    """
    if text is None:
        yield None
        return
    handle, path = tempfile.mkstemp(prefix=COOKIE_COPY, suffix=".txt")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as target:
            target.write(text)
        yield path
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(path)


# --- только наружу ---------------------------------------------------------------------

# Непубличные сети IPv4 по реестру IANA special-purpose: своя машина, частные сети, CGNAT,
# link-local (метаданные облака 169.254.169.254), примеры из документации, бенчмарки,
# групповая рассылка, зарезервированное и широковещательное.
BLOCKED_V4 = tuple(
    IPv4Network(network)
    for network in (
        "0.0.0.0/8",
        "10.0.0.0/8",
        "100.64.0.0/10",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "172.16.0.0/12",
        "192.0.0.0/24",
        "192.0.2.0/24",
        "192.88.99.0/24",
        "192.168.0.0/16",
        "198.18.0.0/15",
        "198.51.100.0/24",
        "203.0.113.0/24",
        "224.0.0.0/4",
        "240.0.0.0/4",
    )
)
# У IPv6 публичное — только глобальная одноадресная 2000::/3, и в ней — без служебных сетей
# (Teredo и прочие протокольные 2001::/23, документация). Адреса с IPv4 внутри (::ffff:0:0/96,
# NAT64 64:ff9b::/96, 6to4 2002::/16) проверяются по тому IPv4, который в них вложен.
GLOBAL_V6 = IPv6Network("2000::/3")
BLOCKED_V6 = tuple(IPv6Network(network) for network in ("2001::/23", "2001:db8::/32", "3fff::/20"))
NAT64 = IPv6Network("64:ff9b::/96")


def _embedded(address: IPv6Address) -> IPv4Address | None:
    if address.ipv4_mapped is not None:
        return address.ipv4_mapped
    if address in NAT64:
        return IPv4Address(int(address) & 0xFFFFFFFF)
    return address.sixtofour


def public(address: Address) -> bool:
    """Публичный ли адрес: по таблицам выше, а не по `is_global` (его ответы менялись от версии)."""
    if isinstance(address, IPv6Address):
        inner = _embedded(address)
        if inner is not None:
            return public(inner)
        return address in GLOBAL_V6 and not any(address in network for network in BLOCKED_V6)
    return not any(address in network for network in BLOCKED_V4)


class NotPublic(httpcore.ConnectError):
    """Имя ведёт внутрь: хотя бы один его адрес не публичный и не разрешён настройкой."""


async def system_resolve(host: str, port: int) -> list[str]:
    try:
        found = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError) as error:
        raise httpcore.ConnectError(f"{host}: имя не разрешилось") from error
    return list(dict.fromkeys(str(info[4][0]) for info in found))


class Guard:
    """Решает, можно ли соединяться с адресами за именем. У каждой площадки своя."""

    def __init__(self, allowances: Iterable[Allowance] = (), resolve: Resolve = system_resolve):
        self.allowances = tuple(allowances)
        self.resolve = resolve

    def permits(self, host: str, address: Address, port: int) -> bool:
        return public(address) or any(entry.covers(host, address, port) for entry in self.allowances)

    async def vet(self, host: str, port: int) -> list[str]:
        """
        Адреса, в которые разрешилось имя, — если **все** они разрешены; иначе `NotPublic`.

        Все, а не хотя бы один: имя с публичным и внутренним адресом вместе — это приглашение
        соединиться с внутренним. Адрес, записанный в ссылке прямо, проверяется без DNS.
        """
        literal = host.strip("[]")
        try:
            addresses = [str(ip_address(literal))]
        except ValueError:
            addresses = list(await self.resolve(host, port))
        if not addresses:
            raise httpcore.ConnectError(f"{host}: имя не разрешилось")
        for text in addresses:
            if not self.permits(literal, ip_address(text), port):
                raise NotPublic(f"{host}: адрес {text} не публичный")
        return addresses


class GuardedBackend(httpcore.AsyncNetworkBackend):
    """
    Сетевой слой httpcore, который соединяется только с проверенными адресами.

    httpcore отдаёт сюда имя; мы разрешаем его сами, проверяем каждый адрес и соединяемся ровно
    с проверенным — по очереди, пока один не ответит. Второго разрешения имени между проверкой
    и соединением нет. Исключение — сам прокси: его адрес назначил администратор.
    """

    def __init__(self, guard: Guard, inner: httpcore.AsyncNetworkBackend, exempt: str | None = None):
        self.guard = guard
        self.inner = inner
        self.exempt = exempt

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Iterable[Any] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        if self.exempt is not None and host == self.exempt:
            return _Tunnel(await self.inner.connect_tcp(host, port, timeout, local_address, socket_options))
        clock = asyncio.get_running_loop().time
        deadline = None if timeout is None else clock() + timeout
        try:
            async with asyncio.timeout(timeout):
                addresses = await self.guard.vet(host, port)
        except TimeoutError:
            raise httpcore.ConnectTimeout(f"{host}: имя не разрешилось вовремя") from None
        # IPv4 — первым: IPv6 без маршрута молчит до конца срока, а не отказывает сразу. Каждый
        # адрес, кроме последнего, ждём не дольше ATTEMPT_TIMEOUT — иначе до адреса, который
        # ответил бы сразу, очередь доходила бы через минуту. Последнему — весь остаток срока.
        ordered = sorted(addresses, key=lambda text: ip_address(text).version)
        failure: Exception | None = None
        for index, address in enumerate(ordered):
            left = None if deadline is None else deadline - clock()
            if left is not None and left <= 0:
                break
            last = index == len(ordered) - 1
            if last:
                attempt = left
            else:
                attempt = ATTEMPT_TIMEOUT if left is None else min(ATTEMPT_TIMEOUT, left)
            try:
                return await self.inner.connect_tcp(address, port, attempt, local_address, socket_options)
            except (httpcore.ConnectError, httpcore.ConnectTimeout) as error:
                failure = error
        raise failure or httpcore.ConnectTimeout(f"{host}: ни один адрес не ответил вовремя")

    async def connect_unix_socket(
        self, path: str, timeout: float | None = None, socket_options: Iterable[Any] | None = None
    ) -> httpcore.AsyncNetworkStream:
        raise httpcore.ConnectError("кинозал не ходит через unix-сокеты")

    async def sleep(self, seconds: float) -> None:
        await self.inner.sleep(seconds)


# Имя сайта, которое проверяет TLS цели вместо её закреплённого адреса, — у запроса через прокси.
# httpcore (1.0) в туннеле CONNECT отдаёт TLS адрес из URL, а расширение `sni_hostname` не читает; у
# HTTPS-прокси оно к тому же ушло бы в TLS до самого прокси. Поэтому пара «адрес → имя» едет рядом с
# запросом, в его задаче (`GuardedTransport.handle_async_request`), а подставляет имя поток до прокси.
_PINNED: contextvars.ContextVar[tuple[str, str] | None] = contextvars.ContextVar(
    "cinema_pinned", default=None
)


class _Tunnel(httpcore.AsyncNetworkStream):
    """
    Поток до прокси: TLS цели внутри туннеля проверяет имя сайта (SNI и сертификат), хотя CONNECT
    ушёл на его закреплённый адрес. Остальное — как у потока под ним.
    """

    def __init__(self, inner: httpcore.AsyncNetworkStream):
        self.inner = inner

    async def read(self, max_bytes: int, timeout: float | None = None) -> bytes:
        return await self.inner.read(max_bytes, timeout)

    async def write(self, buffer: bytes, timeout: float | None = None) -> None:
        await self.inner.write(buffer, timeout)

    async def aclose(self) -> None:
        await self.inner.aclose()

    async def start_tls(
        self, ssl_context: ssl.SSLContext, server_hostname: str | None = None, timeout: float | None = None
    ) -> httpcore.AsyncNetworkStream:
        pinned = _PINNED.get()
        if pinned is not None and server_hostname == pinned[0]:
            server_hostname = pinned[1]
        return _Tunnel(await self.inner.start_tls(ssl_context, server_hostname, timeout))

    def get_extra_info(self, info: str) -> Any:
        return self.inner.get_extra_info(info)


_seam_checked = False


def check_seam() -> None:
    """
    Есть ли у httpx и httpcore место, куда встраивается защита «только наружу».

    Проверяется при сборке приложения (сеть кинозала создаётся вместе с ним, а клиенты площадок
    — только к первому запросу): если обновление уберёт это место, служба не поднимется, а не
    будет соединяться без проверки. Один раз на процесс — проверка стоит сборки транспорта.
    """
    global _seam_checked
    if not _seam_checked:
        _seam(httpx.AsyncHTTPTransport())
        _seam_checked = True


def _seam(transport: httpx.AsyncHTTPTransport) -> Any:
    pool = getattr(transport, "_pool", None)
    if pool is None or not hasattr(pool, "_network_backend"):
        raise RuntimeError(
            "httpx/httpcore изменились: у транспорта нет пула с _network_backend, и защиту кинозала "
            "«только наружу» некуда встроить — служба без неё не поднимается"
        )
    return pool


class GuardedTransport(httpx.AsyncHTTPTransport):
    """
    Транспорт httpx площадки: её прокси и защита «только наружу».

    Без прокси защита стоит на каждом соединении (`GuardedBackend`). С прокси соединение идёт
    только к нему, а имя площадки разрешает он сам (socks5h — ради обхода подменённого DNS).
    Площадке со своим списком хостов этого хватает: её политика стоит на подписи. Площадке с
    любыми хостами (`strict`: ссылка, своя медиатека) — нет: её цель проверяется здесь, до
    прокси, и прокси получает уже проверенный адрес вместо имени — SOCKS в CONNECT, HTTP(S)-прокси
    в CONNECT и в адресе запроса. Имя остаётся TLS (SNI и сертификат) и заголовку `Host`, а у прокси
    нет своего разрешения имени, которое успел бы подменить DNS между нашей проверкой и его.
    """

    def __init__(
        self,
        guard: Guard,
        *,
        proxy: str | None = None,
        strict: bool = False,
        backend: httpcore.AsyncNetworkBackend | None = None,
        **options: Any,
    ):
        super().__init__(proxy=proxy, **options)
        proxied = httpx.URL(proxy) if proxy else None
        # Пул httpcore создаёт соединения через свой сетевой слой: подменяем его до первого
        # соединения. Имена атрибутов — httpx 0.28 и httpcore 1.0 (версии закреплены в
        # requirements.lock); пропадут — `_seam` откажет, а не пропустит соединение без проверки.
        pool = _seam(self)
        pool._network_backend = GuardedBackend(
            guard, backend or pool._network_backend, proxied.host if proxied else None
        )
        self.guard = guard
        self.vet_targets = strict and proxied is not None
        # HTTP(S)-прокси, а не SOCKS: адрес цели — в CONNECT и в адресе запроса, а имя для TLS — через
        # поток до прокси (`_Tunnel`): туннель httpcore расширение `sni_hostname` не читает.
        self.tunnel = proxied is not None and not proxied.scheme.startswith("socks")

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if not self.vet_targets:
            return await super().handle_async_request(request)
        host = request.url.host
        request = await self._vetted(request)
        token = _PINNED.set((request.url.host, host))
        try:
            return await super().handle_async_request(request)
        finally:
            _PINNED.reset(token)

    async def _vetted(self, request: httpx.Request) -> httpx.Request:
        host = request.url.host
        port = request.url.port or (443 if request.url.scheme == "https" else 80)
        try:
            addresses = await self.guard.vet(host, port)
        except httpcore.ConnectError as error:
            raise httpx.ConnectError(str(error), request=request) from error
        # IPv4 — первым, как у своих соединений (`GuardedBackend`): IPv6 без маршрута молчит.
        chosen = min(addresses, key=lambda text: ip_address(text).version)
        if self.tunnel and ip_address(chosen).version == 6:
            # Адрес IPv6 httpcore пишет прокси без скобок — и в CONNECT, и в полном адресе запроса http:
            # такого прокси не поймёт, а имя вместо адреса он разрешил бы сам, уже без нашей проверки.
            raise httpx.ConnectError(
                f"{host}: у сайта только IPv6 — через HTTP-прокси его не открыть", request=request
            )
        extensions = dict(request.extensions)
        if not self.tunnel:
            extensions["sni_hostname"] = host
        return httpx.Request(
            request.method,
            request.url.copy_with(host=chosen),
            headers=request.headers,
            stream=request.stream,
            extensions=extensions,
        )


class Net:
    """
    Клиенты httpx по площадкам: у каждой свой прокси, у всех одна защита.

    Клиент площадки создаётся при первом обращении и живёт до закрытия службы — пул соединений
    у каждой свой. `client` — один клиент на всех вместо своих (так тесты подменяют сеть).
    `agents` — имя браузера площадки (`Provider.user_agent`) или `None`, если ей годится общее.
    """

    def __init__(
        self,
        config: NetConfig,
        hosts: Callable[[str], HostPolicy | None],
        *,
        client: httpx.AsyncClient | None = None,
        resolve: Resolve | None = None,
        backend: httpcore.AsyncNetworkBackend | None = None,
        agents: Callable[[str], str | None] | None = None,
    ):
        check_seam()
        self.config = config
        self._resolve = resolve or system_resolve
        self._hosts = hosts
        self._agents = agents or (lambda provider: None)
        self._shared = client
        self._backend = backend
        self._guards: dict[str, Guard] = {}
        self._clients: dict[str, httpx.AsyncClient] = {}

    def guard_for(self, provider: str) -> Guard:
        """Защита площадки: публичные адреса и то, что открыто только ей."""
        found = self._guards.get(provider)
        if found is None:
            found = self._guards[provider] = Guard(self.config.private_for(provider), self._resolve)
        return found

    def client_for(self, provider: str) -> httpx.AsyncClient:
        if self._shared is not None:
            return self._shared
        found = self._clients.get(provider)
        if found is None:
            policy = self._hosts(provider)
            # Неизвестная площадка — строже всего: как площадка с любыми хостами.
            strict = policy is None or policy.public_any
            transport = GuardedTransport(
                self.guard_for(provider),
                proxy=self.config.proxy_for(provider),
                strict=strict,
                backend=self._backend,
                limits=FOREIGN_POOL if strict else POOL,
            )
            found = httpx.AsyncClient(
                transport=transport,
                timeout=TIMEOUT,
                follow_redirects=True,
                headers={"User-Agent": self._agents(provider) or USER_AGENT},
            )
            self._clients[provider] = found
        return found

    async def guard_public(self, provider: str, host: str, port: int = 443) -> list[str]:
        """
        Проверка имени заранее — для тех, кто соединяется не через наш транспорт (yt-dlp).

        Это только проверка «сейчас»: соединение потом разрешит имя заново. Для своих
        соединений защита стоит на транспорте, и этой проверки им не нужно.
        """
        return await self.guard_for(provider).vet(host, port)

    async def close(self) -> None:
        clients = [*self._clients.values(), *([self._shared] if self._shared is not None else [])]
        self._clients.clear()
        await asyncio.gather(*(client.aclose() for client in clients), return_exceptions=True)
