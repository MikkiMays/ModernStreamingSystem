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
публичное, на соединении может ответить 127.0.0.1 (DNS rebinding). Частные сети открывает
только `CINEMA_PRIVATE_HOSTS` (CIDR через запятую) — например, своя медиатека в той же сети.

Настройки читает `NetConfig.from_env` один раз, при сборке приложения; тесты передают
`NetConfig` сами и от окружения процесса не зависят.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import re
import socket
import tempfile
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

TIMEOUT = httpx.Timeout(20.0, read=60.0)
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Cord/1.0"


@dataclass(frozen=True)
class NetConfig:
    """
    Настройки выхода наружу. Прокси и cookies в `repr` не попадают: в них бывают пароли.

    `cookies` — уже прочитанное и проверенное содержимое файла по имени площадки.
    """

    proxy: str | None = field(default=None, repr=False)
    proxies: Mapping[str, str] = field(default_factory=dict, repr=False)
    cookies: Mapping[str, str] = field(default_factory=dict, repr=False)
    private: tuple[Network, ...] = ()

    def proxy_for(self, provider: str) -> str | None:
        return self.proxies.get(provider) or self.proxy

    def cookies_for(self, provider: str) -> str | None:
        return self.cookies.get(provider)

    def secrets(self) -> list[str]:
        """
        Что из адресов прокси нельзя показывать никому: имя с паролем и сам пароль.

        Хост прокси остаётся виден — по нему понятно, какой выход отказал, — а вход в него нет.
        Пароль короче четырёх знаков отдельно не ищется: замена по нему испортила бы весь текст.
        """
        found: list[str] = []
        for value in (self.proxy, *self.proxies.values()):
            userinfo, at, _ = urlsplit(value or "").netloc.rpartition("@")
            if not at:
                continue
            found.append(userinfo + "@")
            password = userinfo.partition(":")[2]
            found.extend(word for word in {password, unquote(password)} if len(word) >= 4)
        return found

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> NetConfig:
        proxy = _proxy("CINEMA_PROXY", env.get("CINEMA_PROXY", ""))
        proxies: dict[str, str] = {}
        cookies: dict[str, str] = {}
        for name in sorted(env):
            if name.startswith("CINEMA_PROXY_") and len(name) > len("CINEMA_PROXY_"):
                value = _proxy(name, env[name])
                if value:
                    proxies[name.removeprefix("CINEMA_PROXY_").lower()] = value
            elif name.startswith("CINEMA_COOKIES_") and len(name) > len("CINEMA_COOKIES_"):
                text = _cookies(name, env[name])
                if text is not None:
                    cookies[name.removeprefix("CINEMA_COOKIES_").lower()] = text
        if proxy is None and any(env.get(name) for name in STANDARD_PROXIES):
            logger.warning(
                "кинозал не читает HTTP_PROXY/HTTPS_PROXY/ALL_PROXY: выход наружу задаёт CINEMA_PROXY "
                "(и CINEMA_PROXY_<ПЛОЩАДКА>)"
            )
        return cls(proxy, proxies, cookies, _networks(env.get("CINEMA_PRIVATE_HOSTS", "")))


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


def _networks(text: str) -> tuple[Network, ...]:
    networks: list[Network] = []
    wrong: list[str] = []
    for part in (text or "").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            networks.append(ip_network(part))
        except ValueError:
            wrong.append(part)
    if wrong:
        logger.warning("CINEMA_PRIVATE_HOSTS: не сети CIDR, пропущены: %s", ", ".join(wrong))
    return tuple(networks)


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
    handle, path = tempfile.mkstemp(prefix="cord-cookies-", suffix=".txt")
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
    """Решает, можно ли соединяться с адресами за именем. Одна на всю сеть кинозала."""

    def __init__(self, private: Iterable[Network] = (), resolve: Resolve = system_resolve):
        self.private = tuple(private)
        self.resolve = resolve

    def permits(self, address: Address) -> bool:
        plain = address.ipv4_mapped if isinstance(address, IPv6Address) and address.ipv4_mapped else address
        return public(address) or any(plain in network for network in self.private)

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
            if not self.permits(ip_address(text)):
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
            return await self.inner.connect_tcp(host, port, timeout, local_address, socket_options)
        try:
            async with asyncio.timeout(timeout):
                addresses = await self.guard.vet(host, port)
        except TimeoutError:
            raise httpcore.ConnectTimeout(f"{host}: имя не разрешилось вовремя") from None
        failure: Exception | None = None
        for address in addresses:
            try:
                return await self.inner.connect_tcp(address, port, timeout, local_address, socket_options)
            except (httpcore.ConnectError, httpcore.ConnectTimeout) as error:
                failure = error
        assert failure is not None
        raise failure

    async def connect_unix_socket(
        self, path: str, timeout: float | None = None, socket_options: Iterable[Any] | None = None
    ) -> httpcore.AsyncNetworkStream:
        raise httpcore.ConnectError("кинозал не ходит через unix-сокеты")

    async def sleep(self, seconds: float) -> None:
        await self.inner.sleep(seconds)


class GuardedTransport(httpx.AsyncHTTPTransport):
    """
    Транспорт httpx площадки: её прокси и защита «только наружу».

    Без прокси защита стоит на каждом соединении (`GuardedBackend`). С прокси соединение идёт
    только к нему, а имя площадки разрешает он сам (socks5h — ради обхода подменённого DNS).
    Площадке со своим списком хостов этого хватает: её политика стоит на подписи. Площадке с
    любыми хостами (`strict`: ссылка, своя медиатека) — нет: её цель проверяется здесь, до
    прокси, а SOCKS получает уже проверенный адрес вместо имени (имя остаётся TLS и `Host`).
    HTTP-прокси так не умеет: у него остаётся промежуток между нашей проверкой и его DNS.
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
        # соединения. Имя атрибута — httpcore 1.0 (версия закреплена в requirements.lock);
        # если он переименуется, тесты сети упадут, а не пропустят соединение молча.
        pool = self._pool
        pool._network_backend = GuardedBackend(
            guard, backend or pool._network_backend, proxied.host if proxied else None
        )
        self.guard = guard
        self.vet_targets = strict and proxied is not None
        self.pin = self.vet_targets and proxied is not None and proxied.scheme.startswith("socks")

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if self.vet_targets:
            request = await self._vetted(request)
        return await super().handle_async_request(request)

    async def _vetted(self, request: httpx.Request) -> httpx.Request:
        host = request.url.host
        port = request.url.port or (443 if request.url.scheme == "https" else 80)
        try:
            addresses = await self.guard.vet(host, port)
        except httpcore.ConnectError as error:
            raise httpx.ConnectError(str(error), request=request) from error
        if not self.pin:
            return request
        return httpx.Request(
            request.method,
            request.url.copy_with(host=addresses[0]),
            headers=request.headers,
            stream=request.stream,
            extensions={**request.extensions, "sni_hostname": host},
        )


class Net:
    """
    Клиенты httpx по площадкам: у каждой свой прокси, у всех одна защита.

    Клиент площадки создаётся при первом обращении и живёт до закрытия службы — пул соединений
    у каждой свой. `client` — один клиент на всех вместо своих (так тесты подменяют сеть).
    """

    def __init__(
        self,
        config: NetConfig,
        hosts: Callable[[str], HostPolicy | None],
        *,
        client: httpx.AsyncClient | None = None,
        resolve: Resolve | None = None,
        backend: httpcore.AsyncNetworkBackend | None = None,
    ):
        self.config = config
        self.guard = Guard(config.private, resolve or system_resolve)
        self._hosts = hosts
        self._shared = client
        self._backend = backend
        self._clients: dict[str, httpx.AsyncClient] = {}

    def client_for(self, provider: str) -> httpx.AsyncClient:
        if self._shared is not None:
            return self._shared
        found = self._clients.get(provider)
        if found is None:
            policy = self._hosts(provider)
            transport = GuardedTransport(
                self.guard,
                proxy=self.config.proxy_for(provider),
                # Неизвестная площадка — строже всего: как площадка с любыми хостами.
                strict=policy is None or policy.public_any,
                backend=self._backend,
            )
            found = httpx.AsyncClient(
                transport=transport,
                timeout=TIMEOUT,
                follow_redirects=True,
                headers={"User-Agent": USER_AGENT},
            )
            self._clients[provider] = found
        return found

    async def guard_public(self, host: str, port: int = 443) -> list[str]:
        """
        Проверка имени заранее — для тех, кто соединяется не через наш транспорт (yt-dlp).

        Это только проверка «сейчас»: соединение потом разрешит имя заново. Для своих
        соединений защита стоит на транспорте, и этой проверки им не нужно.
        """
        return await self.guard.vet(host, port)

    async def close(self) -> None:
        clients = [*self._clients.values(), *([self._shared] if self._shared is not None else [])]
        self._clients.clear()
        await asyncio.gather(*(client.aclose() for client in clients), return_exceptions=True)
