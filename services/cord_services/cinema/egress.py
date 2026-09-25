"""
Охраняемый выход yt-dlp наружу: свой прокси, который соединяется только с проверенным адресом.

ЗАЧЕМ. Площадка «По ссылке» разбирает страницу, которую вставил любой участник комнаты, и
разбирает её yt-dlp. Соединения httpx кинозала защищены там, где соединяются (`net.GuardedBackend`),
а yt-dlp разрешает имена и соединяется сам, внутри urllib3: ссылка на `http://127.0.0.1:18100/`,
страница с `<video src="http://169.254.169.254/…">` или имя, которое на втором вопросе отвечает
внутренним адресом, увели бы его внутрь сети службы — к ядру, базе и метаданным облака. Поэтому у
этой площадки вся сеть yt-dlp идёт сюда: CONNECT (https) и запрос с полным адресом (http). Прокси
разрешает имя сам, проверяет **все** адреса той же защитой (`net.Guard`: публичные, частные — только
по `CINEMA_PRIVATE_HOSTS_LINK`) и соединяется ровно с проверенным — второго разрешения имени между
проверкой и соединением нет. Переадресацию yt-dlp выполняет сам, и каждый её шаг приходит сюда
новым запросом — и проверяется заново.

ВХОД. Прокси слушает 127.0.0.1 на случайном порту. Служба живёт в сети хоста, и этот порт видит
любой процесс машины, поэтому вход — по паролю, придуманному при старте процесса; в журнал он не
пишется. Имя входа — номер разбора (`Lease`): соединения одного разбора закрываются разом, когда
разбор кончился, отменён или вышел его срок, — и поток yt-dlp, которого снаружи не прервать,
кончается сам, на обрыве.

ПРЕДЕЛЫ. Разбор — не дольше `LEASE_SECONDS` и не больше `BUDGET` байт от сайтов; разом — не больше
`SESSIONS` разборов на процесс (`Egress.run`): место ждут в цикле событий, yt-dlp работает в своём
пуле из стольких же потоков — не в общем, где и разрешение имён, — а место отдаётся, когда кончился
сам поток, а не ожидание его ответа. `TUNNELS` пропущенных соединений всего и `PER_LEASE` у одного
разбора. Соединение без головы запроса — ещё не вход: таких держится не больше `PENDING`, и новое
вытесняет самое старое — чужой процесс машины, открывший их сотню и молчащий, не запрёт выход
настоящему разбору. Порты, на которые не ходит и браузер (почта, SSH, …), закрыты (`net.BAD_PORTS`).

ПРОКСИ АДМИНИСТРАТОРА. Если у площадки есть выход `CINEMA_PROXY_LINK` (или общий `CINEMA_PROXY`),
соединение идёт через него — но к уже проверенному адресу, а не к имени: имя прокси
администратора переразрешить по-своему не может. Так поток и разбор выходят наружу одним путём,
как у остальных площадок (`net.py`), и адрес потока, привязанный к адресу разбора, не получает 403.
"""

from __future__ import annotations

import asyncio
import base64
import concurrent.futures
import contextlib
import hmac
import logging
import re
import secrets
import ssl
import struct
import time
from dataclasses import dataclass, field
from ipaddress import ip_address
from typing import AsyncIterator, Awaitable, Callable, TypeVar
from urllib.parse import urlsplit

import httpx

from .net import ATTEMPT_TIMEOUT, BAD_PORTS, Guard, NotPublic

logger = logging.getLogger(__name__)

T = TypeVar("T")
Streams = tuple[asyncio.StreamReader, asyncio.StreamWriter]
# Как соединиться с уже проверенным адресом: `(адрес, порт, срок) -> (чтение, запись)`. Тесты
# подставляют свою сеть — и видят, куда прокси звонил.
Dial = Callable[[str, int, float], Awaitable[Streams]]

# Сколько живёт один разбор: столько же, сколько человек ждёт ответа о ссылке.
LEASE_SECONDS = 30.0
# Разборов разом на процесс — и потоков в пуле разборов (`Egress.run`): страница в 30 МБ — это ещё
# десятки секунд регулярок yt-dlp после последнего байта, и каждый такой поток — ядро процессора.
SESSIONS = 3
# Сколько ждать места для разбора, если все заняты, — дольше этого человек ждать не станет.
WAIT = 10.0
TUNNELS = 32
PER_LEASE = 8
# Соединений, которые ещё не прислали голову запроса. yt-dlp присылает её сразу, так что это почти
# всегда ноль; больше — вытесняется самое старое.
PENDING = 16
# Столько байт разбор может получить от сайтов. Страница видео — сотни килобайт, плейлист
# фильма — единицы мегабайт; гигабайтная «страница» — это уже не страница, а способ занять память.
BUDGET = 64 * 1024 * 1024
HEAD_LIMIT = 16 * 1024
RESPONSE_HEAD_LIMIT = 64 * 1024
BODY_LIMIT = 1024 * 1024
HEAD_TIMEOUT = 10.0
CONNECT_TIMEOUT = 10.0
IDLE_TIMEOUT = 20.0
CHUNK = 64 * 1024

# Заголовки одного перегона, а не всего пути: дальше прокси они не идут (RFC 9110 §7.6.1).
# `Expect` — тоже: ответ «100 Continue» прокси без памяти о запросе не перешлёт.
HOP_BY_HOP = frozenset(
    {
        "connection",
        "expect",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "proxy-connection",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    }
)
# Чем yt-dlp ходит за страницами и API сайтов. Остальное (TRACE, PUT, DELETE…) разбору не нужно.
METHODS = frozenset({"GET", "HEAD", "POST", "OPTIONS"})
TOKEN = re.compile(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+")
# `хост:порт` у CONNECT: имя, IPv4 или IPv6 в скобках.
AUTHORITY = re.compile(r"(?:\[([0-9A-Fa-f:.]+)\]|([A-Za-z0-9._-]+)):([0-9]{1,5})")
REASONS = {
    400: "Bad Request",
    403: "Forbidden",
    407: "Proxy Authentication Required",
    413: "Content Too Large",
    431: "Request Header Fields Too Large",
    501: "Not Implemented",
    502: "Bad Gateway",
    503: "Service Unavailable",
}


class EgressError(Exception):
    """Разбор не вышел наружу — по причине, которую можно сказать человеку."""


class Busy(EgressError):
    """Все места для разборов заняты дольше, чем стоит ждать."""


class Closed(EgressError):
    """Разбору не дали входа в выход: без него yt-dlp этой площадки наружу не ходит вовсе."""


class _Refusal(Exception):
    def __init__(self, status: int):
        super().__init__(status)
        self.status = status


class _Exhausted(Exception):
    """Разбор получил от сайтов больше `BUDGET`."""


@dataclass(eq=False)
class Lease:
    """
    Один разбор: его вход в прокси (`url`), срок и что прокси ему отказал.

    `refused` — первая причина отказа проверкой (адрес внутри сети, закрытый порт): по ней ошибка
    yt-dlp («HTTP Error 403») становится человеческим «ссылка ведёт внутрь сети», а не «сайт не
    отдал». `streams` — открытые соединения разбора; трогает их только цикл событий. Кончился
    разбор — вход убран из таблицы прокси (`Egress.run`), и по нему больше не пускают.
    """

    id: str
    url: str = field(repr=False)
    deadline: float
    refused: str | None = None
    # Первый сбой сети: имя не разрешилось или ни один адрес не ответил. По нему «502 Bad Gateway»
    # прокси становится «сайт не отвечает или такого адреса нет».
    failed: str | None = None
    received: int = 0
    # Соединений от yt-dlp сейчас — для предела `PER_LEASE`; `streams` — они же и их пары к сайтам.
    active: int = 0
    streams: set[asyncio.StreamWriter] = field(default_factory=set, repr=False)

    @property
    def expired(self) -> bool:
        return time.monotonic() >= self.deadline

    def refuse(self, reason: str) -> None:
        if self.refused is None:
            self.refused = reason

    def fail(self, reason: str) -> None:
        if self.failed is None:
            self.failed = reason


@dataclass
class _Request:
    method: str
    target: str
    headers: list[tuple[str, str]]


class Egress:
    """
    Выход наружу одной площадки для yt-dlp (у площадки «По ссылке» — её `Guard`).

    Всё здесь живёт в цикле событий: сервер (`start` — лениво, на первом разборе), места разборов
    (`asyncio.Semaphore`), таблица входов и соединения. yt-dlp работает в своём пуле потоков
    (`run`) и получает только готовый вход (`Lease.url`) — ни ожиданием места, ни замками не занят.
    """

    def __init__(
        self,
        guard: Guard,
        *,
        upstream: str | None = None,
        dial: Dial | None = None,
        sessions: int = SESSIONS,
        wait: float = WAIT,
        tunnels: int = TUNNELS,
        per_lease: int = PER_LEASE,
        pending: int = PENDING,
        budget: int = BUDGET,
        idle: float = IDLE_TIMEOUT,
    ):
        self.guard = guard
        self._upstream = httpx.URL(upstream) if upstream else None
        self._dial = dial or (self._via if self._upstream is not None else _direct)
        self.sessions = sessions
        self.wait = wait
        # Срок разбора по умолчанию: тесты укорачивают его, не трогая остальное.
        self.seconds = LEASE_SECONDS
        self.tunnels = tunnels
        self.per_lease = per_lease
        self.pending = pending
        self.budget = budget
        self.idle = idle
        # Пароль входа — на процесс: только буквы и цифры, чтобы в адресе прокси его не пришлось
        # экранировать (urllib и requests раскодируют вход по-разному).
        self.secret = secrets.token_hex(24)
        self._leases: dict[str, Lease] = {}
        self._server: asyncio.Server | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._starting: asyncio.Lock | None = None
        self._slots: asyncio.Semaphore | None = None
        # Пропущенные соединения (для `TUNNELS`) и те, что ещё не прислали голову (для `PENDING`,
        # в порядке прихода: вытесняется самое старое).
        self._open = 0
        self._heads: dict[asyncio.StreamWriter, None] = {}
        # Потоки разборов — свои: общий пул цикла событий нужен разрешению имён (`loop.getaddrinfo`)
        # и остальным `to_thread`, и разбор, который считает после отмены, его не займёт.
        self._pool: concurrent.futures.ThreadPoolExecutor | None = None
        self.port: int | None = None

    # --- жизнь сервера -----------------------------------------------------------------

    async def start(self) -> None:
        """
        Поднять прокси, если в этом цикле событий он ещё не поднят. Зовётся на каждом разборе —
        дёшево. Цикл сменился (тестовый клиент заводит свой на запрос) — прокси поднимается в новом:
        прежний закрыт вместе со своим циклом.
        """
        loop = asyncio.get_running_loop()
        if self._server is not None and self._loop is loop:
            return
        if self._starting is None or self._loop is not loop:
            self._starting = asyncio.Lock()
            self._slots = asyncio.Semaphore(self.sessions)
            self._loop, self._server, self.port = loop, None, None
        async with self._starting:
            if self._server is None:
                server = await asyncio.start_server(self._serve, "127.0.0.1", 0, limit=HEAD_LIMIT)
                self.port = server.sockets[0].getsockname()[1]
                self._server = server

    async def close(self) -> None:
        pool, self._pool = self._pool, None
        if pool is not None:
            pool.shutdown(wait=False, cancel_futures=True)
        server, self._server = self._server, None
        if server is None:
            return
        server.close()
        for lease in list(self._leases.values()):
            self._hang_up(lease)
        for writer in list(self._heads):
            writer.close()
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(server.wait_closed(), 2)

    # --- входы разборов --------------------------------------------------------------------

    async def run(self, work: Callable[[Lease], T], seconds: float | None = None) -> T:
        """
        Разбор целиком: место, вход и поток yt-dlp из своего пула (`work(lease)` — в нём).

        Место ждётся в цикле событий, до потока: не дольше `wait`, потом `Busy`. Отменили разбор
        (новая ссылка комнаты, общий срок) — вход закрывается сразу, и yt-dlp дальше получает только
        обрывы и 407. Место же отдаётся, только когда кончился сам поток: страница в 30 МБ — это ещё
        десятки секунд регулярок после последнего байта, и отменённые разборы иначе копились бы
        потоками сверх `sessions`.
        """
        release = await self._place()
        loop = asyncio.get_running_loop()
        try:
            lease = self._enter(seconds)
        except BaseException:
            release()
            raise
        try:
            future = self._threads().submit(work, lease)
        except BaseException:
            self._leave(lease)
            release()
            raise
        future.add_done_callback(lambda _: _soon(loop, release))
        try:
            return await asyncio.wrap_future(future, loop=loop)
        finally:
            self._leave(lease)

    @contextlib.asynccontextmanager
    async def session(self, seconds: float | None = None) -> AsyncIterator[Lease]:
        """
        Место и вход на время `async with`, без потока, — для проверок самого выхода. Разбор идёт через
        `run`: с `to_thread` место отдавалось бы раньше, чем кончится поток.
        """
        release = await self._place()
        try:
            lease = self._enter(seconds)
            try:
                yield lease
            finally:
                self._leave(lease)
        finally:
            release()

    async def _place(self) -> Callable[[], None]:
        """Место разбора: ждётся в цикле событий не дольше `wait`. Возвращает, как его отдать (раз)."""
        await self.start()
        slots = self._slots
        assert slots is not None
        try:
            async with asyncio.timeout(self.wait):
                await slots.acquire()
        except TimeoutError:
            raise Busy("Сервер сейчас разбирает много ссылок") from None
        given = False

        def release() -> None:
            nonlocal given
            if not given:
                given = True
                slots.release()

        return release

    def _enter(self, seconds: float | None) -> Lease:
        assert self.port is not None
        name = secrets.token_hex(12)
        deadline = time.monotonic() + (seconds or self.seconds)
        lease = Lease(name, f"http://{name}:{self.secret}@127.0.0.1:{self.port}", deadline)
        self._leases[name] = lease
        return lease

    def _leave(self, lease: Lease) -> None:
        """Вход убран из таблицы, соединения разбора закрыты: по нему больше не пускают."""
        self._leases.pop(lease.id, None)
        self._hang_up(lease)

    def _threads(self) -> concurrent.futures.ThreadPoolExecutor:
        if self._pool is None:
            self._pool = concurrent.futures.ThreadPoolExecutor(
                max_workers=self.sessions, thread_name_prefix="cinema-link"
            )
        return self._pool

    @staticmethod
    def _hang_up(lease: Lease) -> None:
        for stream in list(lease.streams):
            stream.close()

    # --- одно соединение от yt-dlp ------------------------------------------------------

    async def _serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        lease: Lease | None = None
        admitted = False
        # Молчащее соединение без головы запроса — ещё не вход; места ему столько, сколько `pending`,
        # и новое вытесняет самое старое: держать их, чтобы запереть выход, бесполезно.
        while len(self._heads) >= self.pending:
            oldest = next(iter(self._heads))
            self._heads.pop(oldest)
            oldest.close()
        self._heads[writer] = None
        try:
            try:
                request = await _read_request(reader)
            finally:
                self._heads.pop(writer, None)
            found = self._admit(request.headers)
            if self._open >= self.tunnels or found.active >= self.per_lease:
                raise _Refusal(503)
            lease = found
            admitted = True
            self._open += 1
            lease.active += 1
            lease.streams.add(writer)
            left = lease.deadline - time.monotonic()
            if left <= 0:
                raise _Refusal(503)
            # Срок разбора — на каждое его соединение: вышел срок — соединение закрывается, и
            # yt-dlp получает обрыв, а не ждёт ответа, который уже никому не нужен.
            async with asyncio.timeout(left):
                if request.method == "CONNECT":
                    await self._tunnel(lease, request, reader, writer)
                else:
                    await self._forward(lease, request, reader, writer)
        except _Refusal as refusal:
            with contextlib.suppress(OSError, RuntimeError):
                writer.write(_status(refusal.status))
                await writer.drain()
        except (TimeoutError, OSError, EOFError, _Exhausted, asyncio.IncompleteReadError):
            pass
        finally:
            if admitted:
                self._open -= 1
            if lease is not None:
                lease.active -= 1
                lease.streams.discard(writer)
            writer.close()

    def _admit(self, headers: list[tuple[str, str]]) -> Lease:
        """Вход по имени разбора и паролю процесса — или 407, не говоря, что именно не так."""
        found = _basic(_header(headers, "proxy-authorization"))
        if found is None:
            raise _Refusal(407)
        name, password = found
        if not hmac.compare_digest(password.encode(), self.secret.encode()):
            raise _Refusal(407)
        lease = self._leases.get(name)
        if lease is None:
            raise _Refusal(407)
        return lease

    async def _tunnel(
        self, lease: Lease, request: _Request, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        """CONNECT: туннель к проверенному адресу; дальше TLS между yt-dlp и сайтом, мы его не видим."""
        host, port = _authority(request.target)
        up_reader, up_writer = await self._reach(lease, host, port)
        lease.streams.add(up_writer)
        try:
            writer.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
            await writer.drain()
            await self._splice(lease, reader, writer, up_reader, up_writer)
        finally:
            lease.streams.discard(up_writer)
            up_writer.close()

    async def _forward(
        self, lease: Lease, request: _Request, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        """
        Запрос с полным адресом (`GET http://…`): один запрос — одно соединение.

        urllib3 шлёт все запросы http через одно соединение с прокси, к каким бы хостам они ни шли.
        Поэтому соединение здесь не переиспользуется вовсе: запрос уходит к проверенному адресу с
        `Connection: close`, ответ приходит к yt-dlp с `Connection: close` — и следующий запрос, куда
        бы он ни шёл, придёт новым соединением и будет проверен заново.
        """
        if request.method not in METHODS:
            raise _Refusal(501)
        parts = urlsplit(request.target)
        if parts.scheme.lower() != "http" or not parts.hostname or "@" in parts.netloc:
            raise _Refusal(400)
        try:
            port = parts.port or 80
        except ValueError:
            raise _Refusal(400) from None
        names = {name.lower() for name, _ in request.headers}
        # Тело кусками прокси не пересылает: yt-dlp шлёт тело целиком, с длиной.
        if "transfer-encoding" in names:
            raise _Refusal(501)
        length = _header(request.headers, "content-length")
        if length and (not length.isdigit() or int(length) > BODY_LIMIT):
            raise _Refusal(413)
        body = await reader.readexactly(int(length)) if length else b""
        host = parts.hostname
        authority = (f"[{host}]" if ":" in host else host) + (f":{port}" if port != 80 else "")
        listed = {
            token.strip().lower()
            for name, value in request.headers
            if name.lower() == "connection"
            for token in value.split(",")
        }
        kept = [
            (name, value)
            for name, value in request.headers
            if name.lower() not in HOP_BY_HOP and name.lower() != "host" and name.lower() not in listed
        ]
        origin = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
        head = (
            f"{request.method} {origin} HTTP/1.1\r\nHost: {authority}\r\n"
            + "".join(f"{name}: {value}\r\n" for name, value in kept)
            + "Connection: close\r\n\r\n"
        )
        up_reader, up_writer = await self._reach(lease, host, port)
        lease.streams.add(up_writer)
        try:
            up_writer.write(head.encode("latin-1") + body)
            await up_writer.drain()
            async with asyncio.timeout(self.idle):
                answer = await up_reader.readuntil(b"\r\n\r\n")
            lease.received += len(answer)
            writer.write(_closing(answer))
            await writer.drain()
            await self._pump(up_reader, writer, lease)
        except (asyncio.LimitOverrunError, ValueError):
            # Заголовки ответа длиннее предела — это не ответ сайта, а попытка занять память.
            raise _Refusal(502) from None
        finally:
            lease.streams.discard(up_writer)
            up_writer.close()

    async def _reach(self, lease: Lease, host: str, port: int) -> Streams:
        """
        Соединение с тем адресом, который проверен: имя разрешается один раз, все его адреса должны
        быть разрешены, и звонок идёт по проверенному — IPv4 первым, как у `GuardedBackend`.
        """
        if port in BAD_PORTS:
            lease.refuse(f"{host}:{port} — этот порт закрыт для кинозала")
            raise _Refusal(403)
        try:
            async with asyncio.timeout(CONNECT_TIMEOUT):
                addresses = await self.guard.vet(host, port)
        except NotPublic as error:
            lease.refuse(str(error))
            raise _Refusal(403) from None
        except Exception:  # имя не разрешилось (или разрешитель упал) — адреса нет, соединять не с чем
            lease.fail(f"{host}: имя не разрешилось")
            raise _Refusal(502) from None
        ordered = sorted(addresses, key=lambda text: ip_address(text).version)
        clock = time.monotonic
        deadline = clock() + CONNECT_TIMEOUT
        for index, address in enumerate(ordered):
            left = deadline - clock()
            if left <= 0:
                break
            attempt = left if index == len(ordered) - 1 else min(ATTEMPT_TIMEOUT, left)
            try:
                return await self._dial(address, port, attempt)
            except (OSError, TimeoutError, EOFError, ValueError, asyncio.IncompleteReadError):
                continue
        lease.fail(f"{host}:{port} не ответил")
        raise _Refusal(502)

    async def _splice(
        self,
        lease: Lease,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        up_reader: asyncio.StreamReader,
        up_writer: asyncio.StreamWriter,
    ) -> None:
        """Туннель в обе стороны; счёт байт — только от сайта (`BUDGET`)."""
        tasks = [
            asyncio.ensure_future(self._pump(reader, up_writer, None)),
            asyncio.ensure_future(self._pump(up_reader, writer, lease)),
        ]
        try:
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
            for task in done:
                task.result()
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _pump(
        self, source: asyncio.StreamReader, target: asyncio.StreamWriter, counted: Lease | None
    ) -> None:
        while True:
            async with asyncio.timeout(self.idle):
                chunk = await source.read(CHUNK)
            if not chunk:
                # Половина соединения закрыта — сообщаем другой стороне и ждём, пока закроет она.
                with contextlib.suppress(OSError, RuntimeError):
                    if target.can_write_eof():
                        target.write_eof()
                return
            if counted is not None:
                counted.received += len(chunk)
                if counted.received > self.budget:
                    raise _Exhausted()
            target.write(chunk)
            await target.drain()

    async def _via(self, address: str, port: int, timeout: float) -> Streams:
        """Через прокси администратора — к уже проверенному адресу (SOCKS5 или HTTP CONNECT)."""
        proxy = self._upstream
        assert proxy is not None
        async with asyncio.timeout(timeout):
            if proxy.scheme in ("socks5", "socks5h"):
                reader, writer = await asyncio.open_connection(proxy.host, proxy.port or 1080)
                try:
                    await _socks5(reader, writer, address, port, proxy.username, proxy.password)
                except BaseException:
                    writer.close()
                    raise
                return reader, writer
            tls = ssl.create_default_context() if proxy.scheme == "https" else None
            reader, writer = await asyncio.open_connection(
                proxy.host,
                proxy.port or (443 if tls else 80),
                ssl=tls,
                server_hostname=proxy.host if tls else None,
                limit=RESPONSE_HEAD_LIMIT,
            )
            try:
                await _connect_through(reader, writer, address, port, proxy.username, proxy.password)
            except BaseException:
                writer.close()
                raise
            return reader, writer


def _soon(loop: asyncio.AbstractEventLoop, callback: Callable[[], None]) -> None:
    """Сделать в цикле событий из любого потока; цикл уже закрыт — делать нечего."""
    with contextlib.suppress(RuntimeError):
        loop.call_soon_threadsafe(callback)


async def _direct(address: str, port: int, timeout: float) -> Streams:
    async with asyncio.timeout(timeout):
        return await asyncio.open_connection(address, port, limit=RESPONSE_HEAD_LIMIT)


async def _read_request(reader: asyncio.StreamReader) -> _Request:
    """Строка запроса и заголовки — строго: без переводов строки внутри значений и без мусора."""
    try:
        async with asyncio.timeout(HEAD_TIMEOUT):
            head = await reader.readuntil(b"\r\n\r\n")
    except (asyncio.LimitOverrunError, ValueError):
        raise _Refusal(431) from None
    lines = head[:-4].decode("latin-1").split("\r\n")
    parts = lines[0].split(" ")
    if len(parts) != 3 or not TOKEN.fullmatch(parts[0]) or parts[2] not in ("HTTP/1.0", "HTTP/1.1"):
        raise _Refusal(400)
    headers: list[tuple[str, str]] = []
    for line in lines[1:]:
        name, colon, value = line.partition(":")
        # Одинокий `\n` или `\r` внутри значения прокси дальше не пустит: сервер за ним мог бы
        # прочесть его как конец строки — и получить заголовок, которого yt-dlp не посылал.
        if not colon or not TOKEN.fullmatch(name) or any(mark in value for mark in "\r\n\x00"):
            raise _Refusal(400)
        headers.append((name, value.strip()))
    return _Request(parts[0].upper(), parts[1], headers)


def _header(headers: list[tuple[str, str]], name: str) -> str:
    for key, value in headers:
        if key.lower() == name:
            return value
    return ""


def _basic(value: str) -> tuple[str, str] | None:
    scheme, _, token = value.partition(" ")
    if scheme.lower() != "basic" or not token:
        return None
    try:
        name, colon, password = base64.b64decode(token.strip(), validate=True).decode().partition(":")
    except (ValueError, UnicodeDecodeError):
        return None
    return (name, password) if colon else None


def _authority(target: str) -> tuple[str, int]:
    found = AUTHORITY.fullmatch(target)
    if found is None:
        raise _Refusal(400)
    port = int(found[3])
    if not 0 < port < 65536:
        raise _Refusal(400)
    return (found[1] or found[2]).lower(), port


def _status(status: int) -> bytes:
    extra = 'Proxy-Authenticate: Basic realm="cord"\r\n' if status == 407 else ""
    return (
        f"HTTP/1.1 {status} {REASONS[status]}\r\n{extra}Content-Length: 0\r\nConnection: close\r\n\r\n"
    ).encode()


def _closing(head: bytes) -> bytes:
    """Ответ сайта с `Connection: close`: соединение с прокси после него не переиспользуется."""
    lines = head[:-4].decode("latin-1").split("\r\n")
    kept = [
        line
        for line in lines[1:]
        if line.partition(":")[0].strip().lower() not in ("connection", "keep-alive", "proxy-connection")
    ]
    return ("\r\n".join([lines[0], *kept, "Connection: close"]) + "\r\n\r\n").encode("latin-1")


async def _socks5(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    address: str,
    port: int,
    username: str,
    password: str,
) -> None:
    """SOCKS5 (RFC 1928/1929) к адресу, а не к имени: имя уже проверено здесь."""
    methods = b"\x00\x02" if username else b"\x00"
    writer.write(b"\x05" + bytes([len(methods)]) + methods)
    await writer.drain()
    version, method = await reader.readexactly(2)
    if version != 5 or method not in (0, 2) or (method == 2 and not username):
        raise ValueError("SOCKS5: прокси не принял способ входа")
    if method == 2:
        user, secret = username.encode(), password.encode()
        writer.write(b"\x01" + bytes([len(user)]) + user + bytes([len(secret)]) + secret)
        await writer.drain()
        _, status = await reader.readexactly(2)
        if status != 0:
            raise ValueError("SOCKS5: прокси не принял вход")
    packed = ip_address(address)
    kind = 1 if packed.version == 4 else 4
    writer.write(b"\x05\x01\x00" + bytes([kind]) + packed.packed + struct.pack(">H", port))
    await writer.drain()
    head = await reader.readexactly(4)
    if head[0] != 5 or head[1] != 0:
        raise ValueError("SOCKS5: прокси отказал в соединении")
    skip = {1: 4, 4: 16}.get(head[3])
    if skip is None:
        skip = (await reader.readexactly(1))[0]
    await reader.readexactly(skip + 2)


async def _connect_through(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    address: str,
    port: int,
    username: str,
    password: str,
) -> None:
    """HTTP CONNECT к адресу через прокси администратора."""
    authority = f"[{address}]:{port}" if ":" in address else f"{address}:{port}"
    lines = [f"CONNECT {authority} HTTP/1.1", f"Host: {authority}"]
    if username:
        token = base64.b64encode(f"{username}:{password}".encode()).decode()
        lines.append(f"Proxy-Authorization: Basic {token}")
    writer.write(("\r\n".join(lines) + "\r\n\r\n").encode())
    await writer.drain()
    head = await reader.readuntil(b"\r\n\r\n")
    status = head.split(b" ", 2)
    if len(status) < 2 or status[1] != b"200":
        raise ValueError("HTTP CONNECT: прокси отказал в соединении")
