"""
Охраняемый выход yt-dlp наружу (`cinema/egress.py`): куда прокси соединяет и куда — никогда.

Ни одного настоящего запроса наружу и ни одного настоящего разрешения имени: имена отвечает
справочник теста (`Directory`), а «интернет» — сеть теста (`Wires`), которая помнит, куда звонили,
и соединяет публичный адрес с сайтом теста на 127.0.0.1. Поэтому «звонок во внутреннюю сеть» здесь
виден прямо: адрес попал в `dialed` — значит, прокси туда пошёл. Там, где проверяется сам yt-dlp,
он настоящий и ходит через прокси по-настоящему (контейнер тестов — без сети: обойди он прокси,
имя `public.test` не разрешилось бы вовсе).
"""

import asyncio
import base64
import concurrent.futures
import contextlib
import datetime
import os
import ssl
import tempfile
import threading
import time
import unittest
from ipaddress import ip_network

from cord_services.cinema.egress import Busy, Egress
from cord_services.cinema.net import Allowance, Guard

PUBLIC = "93.184.216.34"
CDN = "151.101.1.69"
SIX = "2606:2800:220:1:248:1893:25c8:1946"


class CountingPool(concurrent.futures.ThreadPoolExecutor):
    """Пул потоков, который считает, сколько работ ему отдали."""

    submitted = 0

    def submit(self, *args, **kwargs):
        self.submitted += 1
        return super().submit(*args, **kwargs)


class Directory:
    """Справочник имён теста: что ответить на каждое имя."""

    def __init__(self, answers):
        self.answers = answers
        self.asked = []

    async def __call__(self, host, port):
        self.asked.append(host)
        return self.answers[host.lower().rstrip(".")]


class Wires:
    """Сеть теста: проверенный адрес → сайт теста на 127.0.0.1; всё, куда звонили, — в `dialed`."""

    def __init__(self):
        self.routes = {}
        self.dialed = []

    def connect(self, address, port, site):
        self.routes[(address, port)] = site

    async def __call__(self, address, port, timeout):
        self.dialed.append((address, port))
        site = self.routes.get((address, port))
        if site is None:
            raise ConnectionRefusedError(f"{address}:{port}")
        # TLS — между yt-dlp и сайтом, сквозь туннель: сеть теста соединяет простым TCP.
        return await asyncio.open_connection("127.0.0.1", site.port)


class Site:
    """Сайт теста: отвечает по пути и помнит каждый запрос — строку и заголовки."""

    def __init__(self, routes, tls=None):
        self.routes = routes
        self.tls = tls
        self.requests = []
        self.connections = 0
        # Сколько байт тела кусками сайт успел отдать, пока его читали.
        self.sent = 0

    async def start(self):
        self.server = await asyncio.start_server(self.handle, "127.0.0.1", 0, ssl=self.tls)
        self.port = self.server.sockets[0].getsockname()[1]
        return self

    async def handle(self, reader, writer):
        self.connections += 1
        try:
            while True:
                head = await reader.readuntil(b"\r\n\r\n")
                lines = head.decode("latin-1").split("\r\n")
                method, path, _ = lines[0].split(" ")
                headers = [tuple(part.strip() for part in line.split(":", 1)) for line in lines[1:] if line]
                self.requests.append((method, path, headers))
                answer = self.routes.get(path, (404, {}, b"no"))
                if callable(answer):
                    answer = await answer()
                status, extra, body = answer
                if not isinstance(body, bytes):
                    # Тело кусками, сколько сайт захочет: без длины, до закрытия соединения.
                    out = [f"HTTP/1.1 {status} X"] + [f"{name}: {value}" for name, value in extra.items()]
                    writer.write(("\r\n".join(out + ["Connection: close"]) + "\r\n\r\n").encode())
                    async for chunk in body():
                        self.sent += len(chunk)
                        writer.write(chunk)
                        await writer.drain()
                    break
                out = [f"HTTP/1.1 {status} X"]
                out += [f"{name}: {value}" for name, value in {"Content-Length": len(body), **extra}.items()]
                writer.write(("\r\n".join(out) + "\r\n\r\n").encode() + (b"" if method == "HEAD" else body))
                await writer.drain()
                if any(name.lower() == "connection" and value == "close" for name, value in headers):
                    break
        except (asyncio.IncompleteReadError, ConnectionError, ssl.SSLError):
            pass
        finally:
            writer.close()

    async def stop(self):
        self.server.close()


def certificate(directory, name="public.test"):
    """Сертификат сайта на один прогон: yt-dlp его не проверяет (`nocheckcertificate`), но TLS — настоящий."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    key = ec.generate_private_key(ec.SECP256R1())
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, name)])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(name)]), critical=False)
        .sign(key, hashes.SHA256())
    )
    certfile = os.path.join(directory, "cert.pem")
    keyfile = os.path.join(directory, "key.pem")
    with open(certfile, "wb") as out:
        out.write(cert.public_bytes(serialization.Encoding.PEM))
    with open(keyfile, "wb") as out:
        out.write(
            key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        )
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certfile, keyfile)
    return context


def through(lease, url, **params):
    """yt-dlp, как у площадки: только через вход разбора. Зовётся в потоке — прокси в цикле событий."""
    import yt_dlp

    options = {
        "quiet": True,
        "no_warnings": True,
        "proxy": lease.url,
        "socket_timeout": 5,
        "nocheckcertificate": True,
        "cachedir": False,
        **params,
    }
    with yt_dlp.YoutubeDL(options) as ydl:
        with ydl.urlopen(url) as response:
            return response.status, response.read()


class EgressCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.names = Directory(
            {
                "public.test": [PUBLIC],
                "cdn.test": [CDN],
                "inside.test": ["127.0.0.1"],
                "metadata.test": ["169.254.169.254"],
                "mixed.test": [PUBLIC, "10.1.2.3"],
                "mapped.test": ["::ffff:10.0.0.1"],
                "six.test": [SIX],
            }
        )
        self.wires = Wires()
        self.egress = self.make()
        await self.egress.start()

    async def asyncTearDown(self):
        await self.egress.close()

    def make(self, allowances=(), **options):
        return Egress(Guard(allowances, self.names), dial=self.wires, **options)

    async def site(self, routes, address=PUBLIC, port=80, tls=None):
        found = await Site(routes, tls).start()
        self.addAsyncCleanup(found.stop)
        self.wires.connect(address, port, found)
        return found

    async def ask(self, lease, request: bytes, egress=None):
        """Сырой разговор с прокси: что он ответил первой строкой и весь ответ."""
        reader, writer = await asyncio.open_connection("127.0.0.1", (egress or self.egress).port)
        try:
            writer.write(request)
            await writer.drain()
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 5)
            return head.split(b"\r\n", 1)[0].decode(), head, reader, writer
        except BaseException:
            writer.close()
            raise

    @staticmethod
    def auth(lease, name=None, password=None):
        user = name or lease.id
        secret = password or lease.url.split(":")[2].split("@")[0]
        token = base64.b64encode(f"{user}:{secret}".encode()).decode()
        return f"Proxy-Authorization: Basic {token}\r\n"

    async def connect(self, lease, target):
        return await self.connect_to(self.egress, lease, target)

    async def connect_to(self, egress, lease, target):
        request = f"CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n{self.auth(lease)}\r\n".encode()
        status, _, reader, writer = await self.ask(lease, request, egress)
        return status, reader, writer

    async def in_thread(self, work):
        return await asyncio.to_thread(work)

    async def open_lease(self, seconds=30.0, egress=None):
        manager = (egress or self.egress).session(seconds)
        lease = await manager.__aenter__()
        self.addAsyncCleanup(manager.__aexit__, None, None, None)
        return lease


class WhereItConnects(EgressCase):
    async def test_a_public_name_is_reached_by_the_address_that_was_checked(self):
        site = await self.site({"/": (200, {}, b"hello")}, port=443)
        lease = await self.open_lease()
        status, reader, writer = await self.connect(lease, "public.test:443")
        self.assertEqual(status, "HTTP/1.1 200 Connection established")
        writer.write(b"GET / HTTP/1.1\r\nHost: public.test\r\nConnection: close\r\n\r\n")
        await writer.drain()
        answer = await asyncio.wait_for(reader.read(), 5)
        writer.close()
        self.assertTrue(answer.endswith(b"hello"), answer)
        self.assertEqual(self.names.asked, ["public.test"])
        self.assertEqual(self.wires.dialed, [(PUBLIC, 443)])
        self.assertEqual(site.requests[0][:2], ("GET", "/"))

    async def test_an_address_inside_is_refused_before_dialling(self):
        lease = await self.open_lease()
        for target in (
            "127.0.0.1:18100",
            "10.0.0.1:443",
            "169.254.169.254:80",
            "192.168.1.1:8080",
            "[::1]:443",
            "[fd00::1]:443",
            "0.0.0.0:443",
        ):
            status, _, writer = await self.connect(lease, target)
            writer.close()
            self.assertEqual(status, "HTTP/1.1 403 Forbidden", target)
        self.assertEqual(self.wires.dialed, [])
        self.assertIn("не публичный", lease.refused)

    async def test_a_name_that_resolves_inside_is_refused(self):
        lease = await self.open_lease()
        for target in ("inside.test:443", "metadata.test:80", "INSIDE.test.:443"):
            status, _, writer = await self.connect(lease, target)
            writer.close()
            self.assertEqual(status, "HTTP/1.1 403 Forbidden", target)
        self.assertEqual(self.wires.dialed, [])

    async def test_one_inside_address_behind_a_name_is_enough_to_refuse_it(self):
        await self.site({"/": (200, {}, b"hello")}, port=443)
        lease = await self.open_lease()
        status, _, writer = await self.connect(lease, "mixed.test:443")
        writer.close()
        self.assertEqual(status, "HTTP/1.1 403 Forbidden")
        self.assertEqual(self.wires.dialed, [])

    async def test_ipv4_inside_ipv6_is_checked_as_that_ipv4(self):
        lease = await self.open_lease()
        for target in (
            "[::ffff:127.0.0.1]:443",
            "[::ffff:a00:1]:443",
            "[64:ff9b::a9fe:a9fe]:80",
            "[2002:a00:1::1]:443",
            "mapped.test:443",
        ):
            status, _, writer = await self.connect(lease, target)
            writer.close()
            self.assertEqual(status, "HTTP/1.1 403 Forbidden", target)
        self.assertEqual(self.wires.dialed, [])

    async def test_a_public_ipv6_is_dialled_as_itself(self):
        await self.site({"/": (200, {}, b"six")}, address=SIX, port=443)
        lease = await self.open_lease()
        status, _, writer = await self.connect(lease, "six.test:443")
        writer.close()
        self.assertEqual(status, "HTTP/1.1 200 Connection established")
        self.assertEqual(self.wires.dialed, [(SIX, 443)])

    async def test_a_name_that_does_not_resolve_or_does_not_answer_is_a_gateway_failure(self):
        lease = await self.open_lease()
        status, _, writer = await self.connect(lease, "nowhere.test:443")
        writer.close()
        self.assertEqual(status, "HTTP/1.1 502 Bad Gateway")
        self.assertEqual(lease.failed, "nowhere.test: имя не разрешилось")
        # Имя есть, а сайт молчит (сеть теста не знает этого адреса).
        status, _, writer = await self.connect(lease, "cdn.test:443")
        writer.close()
        self.assertEqual(status, "HTTP/1.1 502 Bad Gateway")
        self.assertEqual(self.wires.dialed, [(CDN, 443)])
        self.assertIsNone(lease.refused)

    async def test_ports_no_browser_would_open_are_closed(self):
        lease = await self.open_lease()
        for target in ("public.test:25", "public.test:22", "public.test:6667", f"{PUBLIC}:465"):
            status, _, writer = await self.connect(lease, target)
            writer.close()
            self.assertEqual(status, "HTTP/1.1 403 Forbidden", target)
        self.assertEqual(self.wires.dialed, [])
        self.assertIn("порт закрыт", lease.refused)

    async def test_an_allowance_opens_its_own_network_and_port_only(self):
        egress = self.make(allowances=(Allowance(network=ip_network("127.0.0.1/32"), port=8097),))
        await egress.start()
        self.addAsyncCleanup(egress.close)
        await self.site({"/": (200, {}, b"library")}, address="127.0.0.1", port=8097)
        lease = await self.open_lease(egress=egress)
        opened = f"CONNECT inside.test:8097 HTTP/1.1\r\n{self.auth(lease)}\r\n".encode()
        status, _, _, writer = await self.ask(lease, opened, egress)
        writer.close()
        self.assertEqual(status, "HTTP/1.1 200 Connection established")
        other = f"CONNECT inside.test:18100 HTTP/1.1\r\n{self.auth(lease)}\r\n".encode()
        status, _, _, writer = await self.ask(lease, other, egress)
        writer.close()
        self.assertEqual(status, "HTTP/1.1 403 Forbidden")
        self.assertEqual(self.wires.dialed, [("127.0.0.1", 8097)])


class PlainHttp(EgressCase):
    async def test_a_full_address_request_goes_once_to_the_checked_address_and_closes(self):
        site = await self.site({"/watch?v=1": (200, {"Keep-Alive": "timeout=5"}, b"page")})
        lease = await self.open_lease()
        request = (
            "GET http://public.test/watch?v=1 HTTP/1.1\r\nHost: evil.test\r\nAccept: */*\r\n"
            f"{self.auth(lease)}Proxy-Connection: keep-alive\r\nConnection: keep-alive, X-Secret\r\n"
            "X-Secret: drop-me\r\n\r\n"
        ).encode()
        status, head, reader, writer = await self.ask(lease, request)
        body = await asyncio.wait_for(reader.read(), 5)
        writer.close()
        self.assertEqual((status, body), ("HTTP/1.1 200 X", b"page"))
        # К yt-dlp ответ приходит закрывающим: следующий запрос — новым соединением и новой проверкой.
        self.assertIn(b"Connection: close", head)
        self.assertNotIn(b"Keep-Alive", head)
        method, path, headers = site.requests[0]
        names = {name.lower(): value for name, value in headers}
        self.assertEqual((method, path), ("GET", "/watch?v=1"))
        self.assertEqual(names["host"], "public.test")
        self.assertEqual(names["connection"], "close")
        self.assertEqual(names["accept"], "*/*")
        for gone in ("proxy-authorization", "proxy-connection", "x-secret"):
            self.assertNotIn(gone, names)
        self.assertEqual(self.wires.dialed, [(PUBLIC, 80)])

    async def test_what_is_not_a_plain_http_request_is_refused(self):
        lease = await self.open_lease()
        for request, expected in (
            (f"GET https://public.test/ HTTP/1.1\r\n{self.auth(lease)}\r\n", "400"),
            (f"GET / HTTP/1.1\r\n{self.auth(lease)}\r\n", "400"),
            (f"GET http://user:pw@public.test/ HTTP/1.1\r\n{self.auth(lease)}\r\n", "400"),
            (f"TRACE http://public.test/ HTTP/1.1\r\n{self.auth(lease)}\r\n", "501"),
            (
                f"POST http://public.test/ HTTP/1.1\r\n{self.auth(lease)}Transfer-Encoding: chunked\r\n\r\n",
                "501",
            ),
            (f"POST http://public.test/ HTTP/1.1\r\n{self.auth(lease)}Content-Length: 9999999\r\n", "413"),
            ("GET http://public.test/ HTTP/1.1\r\nX-Evil: a\nb\r\n" + self.auth(lease), "400"),
            ("CONNECT public.test:443 HTTP/1.1\r\nX: " + "a" * 20000 + "\r\n", "431"),
            (f"CONNECT public.test HTTP/1.1\r\n{self.auth(lease)}\r\n", "400"),
            (f"CONNECT public.test:99999 HTTP/1.1\r\n{self.auth(lease)}\r\n", "400"),
        ):
            status, _, _, writer = await self.ask(lease, (request + "\r\n").encode())
            writer.close()
            self.assertIn(expected, status, request[:60])
        self.assertEqual(self.wires.dialed, [])


class Entry(EgressCase):
    async def test_without_the_right_password_or_a_live_lease_nothing_opens(self):
        await self.site({"/": (200, {}, b"hello")}, port=443)
        lease = await self.open_lease()
        for header in (
            "",
            self.auth(lease, password="wrong"),
            self.auth(lease, name="someone-else"),
            "Proxy-Authorization: Bearer x\r\n",
            "Proxy-Authorization: Basic !!!\r\n",
        ):
            status, head, _, writer = await self.ask(
                lease, f"CONNECT public.test:443 HTTP/1.1\r\n{header}\r\n".encode()
            )
            writer.close()
            self.assertEqual(status, "HTTP/1.1 407 Proxy Authentication Required", header)
            self.assertIn(b'Proxy-Authenticate: Basic realm="cord"', head)
        self.assertEqual(self.wires.dialed, [])

    async def test_a_finished_lease_opens_nothing_and_closes_what_it_had(self):
        site = await self.site({"/": (200, {}, b"hello")}, port=443)
        manager = self.egress.session()
        lease = await manager.__aenter__()
        status, reader, writer = await self.connect(lease, "public.test:443")
        self.assertEqual(status, "HTTP/1.1 200 Connection established")
        await manager.__aexit__(None, None, None)
        # Открытый туннель закрылся вместе с разбором.
        self.assertEqual(await asyncio.wait_for(reader.read(), 5), b"")
        writer.close()
        status, _, again = await self.connect(lease, "public.test:443")
        again.close()
        self.assertEqual(status, "HTTP/1.1 407 Proxy Authentication Required")
        self.assertEqual(site.connections, 1)

    async def test_a_cancelled_extraction_hangs_up_its_lease_at_once(self):
        # Разбор отменили (следующая ссылка комнаты, срок): вход закрыт сразу, а не когда поток
        # yt-dlp сам заметит, что его ответ больше не нужен.
        site = await self.site({"/": (200, {}, b"hello")}, port=443)
        egress = self.make(sessions=1)
        self.addAsyncCleanup(egress.close)
        opened = asyncio.Event()
        held = {}

        async def extraction():
            async with egress.session() as lease:
                held["lease"] = lease
                status, held["reader"], held["writer"] = await self.connect_to(
                    egress, lease, "public.test:443"
                )
                self.assertEqual(status, "HTTP/1.1 200 Connection established")
                opened.set()
                await asyncio.sleep(3600)

        task = asyncio.ensure_future(extraction())
        await asyncio.wait_for(opened.wait(), 5)
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        self.assertEqual(await asyncio.wait_for(held["reader"].read(), 5), b"")
        held["writer"].close()
        status, _, again = await self.connect_to(egress, held["lease"], "public.test:443")
        again.close()
        self.assertEqual(status, "HTTP/1.1 407 Proxy Authentication Required")
        self.assertEqual(site.connections, 1)
        # И место отменённого разбора свободно сразу: следующий входит, не дожидаясь `wait`.
        async with asyncio.timeout(1):
            async with egress.session():
                pass

    async def test_the_proxy_starts_with_the_first_session(self):
        idle = self.make()
        self.addAsyncCleanup(idle.close)
        self.assertIsNone(idle.port)
        async with idle.session() as lease:
            self.assertTrue(lease.url.endswith(f"@127.0.0.1:{idle.port}"))

    async def test_the_address_of_a_lease_carries_its_name_and_the_process_password(self):
        lease = await self.open_lease()
        self.assertTrue(lease.url.startswith(f"http://{lease.id}:{self.egress.secret}@127.0.0.1:"))
        self.assertTrue(lease.url.endswith(f":{self.egress.port}"))
        self.assertNotIn(self.egress.secret, repr(lease))
        self.assertNotIn(self.egress.secret, repr(self.egress.__dict__.get("_leases")))


class Limits(EgressCase):
    async def test_the_lease_deadline_cuts_its_tunnels(self):
        await self.site({"/": (200, {}, b"hello")}, port=443)
        lease = await self.open_lease(seconds=0.6)
        status, reader, writer = await self.connect(lease, "public.test:443")
        self.assertEqual(status, "HTTP/1.1 200 Connection established")
        started = time.monotonic()
        self.assertEqual(await asyncio.wait_for(reader.read(), 5), b"")
        writer.close()
        self.assertLess(time.monotonic() - started, 2.0)
        self.assertTrue(lease.expired)
        status, _, writer = await self.connect(lease, "public.test:443")
        writer.close()
        self.assertEqual(status, "HTTP/1.1 503 Service Unavailable")

    async def test_a_lease_that_reads_more_than_its_budget_is_cut(self):
        egress = self.make(budget=64 * 1024)
        await egress.start()
        self.addAsyncCleanup(egress.close)
        await self.site({"/big": (200, {}, b"x" * (1024 * 1024))})
        lease = await self.open_lease(egress=egress)
        request = f"GET http://public.test/big HTTP/1.1\r\n{self.auth(lease)}\r\n".encode()
        status, _, reader, writer = await self.ask(lease, request, egress)
        body = await asyncio.wait_for(reader.read(), 5)
        writer.close()
        self.assertEqual(status, "HTTP/1.1 200 X")
        self.assertLess(len(body), 1024 * 1024)
        self.assertGreater(lease.received, 64 * 1024)

    async def test_a_lease_has_only_so_many_connections_at_once(self):
        egress = self.make(per_lease=2)
        await egress.start()
        self.addAsyncCleanup(egress.close)
        await self.site({"/": (200, {}, b"hello")}, port=443)
        lease = await self.open_lease(egress=egress)
        request = f"CONNECT public.test:443 HTTP/1.1\r\n{self.auth(lease)}\r\n".encode()
        answers = [await self.ask(lease, request, egress) for _ in range(3)]
        self.assertEqual(
            [status for status, *_ in answers],
            ["HTTP/1.1 200 Connection established"] * 2 + ["HTTP/1.1 503 Service Unavailable"],
        )
        for _, _, _, writer in answers:
            writer.close()

    async def test_leases_beyond_the_cap_wait_their_turn_and_then_give_up(self):
        egress = self.make(sessions=1, wait=0.2)
        await egress.start()
        self.addAsyncCleanup(egress.close)
        await self.open_lease(egress=egress)
        started = time.monotonic()
        with self.assertRaises(Busy):
            async with egress.session():
                pass
        self.assertGreaterEqual(time.monotonic() - started, 0.2)

    async def test_waiting_for_a_place_takes_no_thread_of_the_pool(self):
        # Пул в один поток, и тот занят: место разбора ждётся в цикле событий. Жди его поток пула —
        # второй вход не получил бы места, пока первый поток не освободится.
        loop = asyncio.get_running_loop()
        loop.set_default_executor(concurrent.futures.ThreadPoolExecutor(max_workers=1))
        egress = self.make(sessions=1, wait=5)
        await egress.start()
        self.addAsyncCleanup(egress.close)
        release = threading.Event()
        self.addCleanup(release.set)
        busy = loop.run_in_executor(None, release.wait)
        first = egress.session()
        await first.__aenter__()
        entered = asyncio.Event()

        async def second():
            async with egress.session():
                entered.set()

        waiting = asyncio.ensure_future(second())
        await asyncio.sleep(0.1)
        self.assertFalse(entered.is_set())
        await first.__aexit__(None, None, None)
        await asyncio.wait_for(waiting, 2)
        self.assertTrue(entered.is_set())
        self.assertFalse(busy.done())
        release.set()
        await busy

    async def test_a_cancelled_parse_keeps_its_place_until_its_thread_ends_in_its_own_pool(self):
        # Отменённый разбор: вход закрыт сразу, а место — у потока, пока тот не кончится; и поток —
        # из пула выхода, не из общего пула цикла событий (там разрешение имён и прочие `to_thread`).
        common = CountingPool(max_workers=2)
        asyncio.get_running_loop().set_default_executor(common)
        egress = self.make(sessions=1, wait=0.2)
        self.addAsyncCleanup(egress.close)
        release, started = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        seen = []

        def work(lease):
            seen.append((lease, threading.current_thread().name))
            started.set()
            release.wait(5)
            return "разобрано"

        parse = asyncio.ensure_future(egress.run(work))
        while not started.is_set():
            await asyncio.sleep(0.01)
        lease, thread = seen[0]
        self.assertIn(lease.id, egress._leases)
        parse.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await parse
        self.assertNotIn(lease.id, egress._leases)
        # Поток ещё считает — место его, и следующий ждёт, а не берёт второй поток.
        with self.assertRaises(Busy):
            await egress.run(lambda lease: "второй")
        release.set()
        egress.wait = 5
        self.assertEqual(await egress.run(lambda lease: threading.current_thread().name), thread)
        self.assertTrue(thread.startswith("cinema-link"), thread)
        self.assertEqual(common.submitted, 0)

    async def test_a_parse_that_fails_gives_its_place_back_and_says_why(self):
        egress = self.make(sessions=1, wait=0.2)
        self.addAsyncCleanup(egress.close)

        def broken(lease):
            raise ValueError("разборщик упал")

        with self.assertRaises(ValueError):
            await egress.run(broken)
        self.assertEqual(await egress.run(lambda lease: "снова"), "снова")
        self.assertEqual(egress._leases, {})

    async def test_silent_connections_do_not_lock_out_a_real_lease(self):
        # Чужой процесс машины открыл соединений больше, чем мест, и молчит. Предел туннелей считает
        # только вошедших, а молчащих держится не больше `pending` — новое вытесняет самое старое.
        egress = self.make(tunnels=2, pending=3)
        await egress.start()
        self.addAsyncCleanup(egress.close)
        await self.site({"/": (200, {}, b"hello")}, port=443)
        silent = [await asyncio.open_connection("127.0.0.1", egress.port) for _ in range(10)]
        self.addCleanup(lambda: [writer.close() for _, writer in silent])
        await asyncio.sleep(0.1)
        lease = await self.open_lease(egress=egress)
        request = f"CONNECT public.test:443 HTTP/1.1\r\n{self.auth(lease)}\r\n".encode()
        answers = [await self.ask(lease, request, egress) for _ in range(3)]
        self.assertEqual(
            [status for status, *_ in answers],
            ["HTTP/1.1 200 Connection established"] * 2 + ["HTTP/1.1 503 Service Unavailable"],
        )
        for _, _, _, writer in answers:
            writer.close()
        # Самые старые молчащие закрыты прокси; открытыми остались не больше `pending`.
        self.assertEqual(await asyncio.wait_for(silent[0][0].read(), 2), b"")
        still = 0
        for reader, _ in silent:
            try:
                await asyncio.wait_for(reader.read(), 0.05)
            except TimeoutError:
                still += 1
        self.assertLessEqual(still, 3)


class YtDlpThroughTheProxy(EgressCase):
    """yt-dlp настоящий: он ходит только через вход разбора и каждый шаг переадресации — тоже."""

    async def test_a_public_page_opens(self):
        await self.site({"/": (200, {"Content-Type": "text/plain"}, b"hello")})
        manager = self.egress.session()
        lease = await manager.__aenter__()
        try:
            status, body = await self.in_thread(lambda: through(lease, "http://public.test/"))
        finally:
            await manager.__aexit__(None, None, None)
        self.assertEqual((status, body), (200, b"hello"))
        self.assertEqual(self.wires.dialed, [(PUBLIC, 80)])

    async def test_a_redirect_inside_is_refused_at_its_own_hop(self):
        await self.site(
            {
                "/next": (302, {"Location": "http://cdn.test/film"}, b""),
                "/inside": (302, {"Location": "http://10.0.0.5/secret"}, b""),
                "/named": (302, {"Location": "http://inside.test:18100/"}, b""),
            }
        )
        await self.site({"/film": (200, {}, b"film")}, address=CDN)
        manager = self.egress.session()
        lease = await manager.__aenter__()
        try:
            # Шаг наружу — идёт: каждый новый хост проверен и открыт заново.
            self.assertEqual(
                await self.in_thread(lambda: through(lease, "http://public.test/next")), (200, b"film")
            )
            for path in ("/inside", "/named"):
                with self.assertRaises(Exception):
                    await self.in_thread(lambda: through(lease, f"http://public.test{path}"))
        finally:
            await manager.__aexit__(None, None, None)
        self.assertEqual(self.wires.dialed, [(PUBLIC, 80), (CDN, 80), (PUBLIC, 80), (PUBLIC, 80)])
        self.assertIn("10.0.0.5", lease.refused)

    async def test_https_goes_through_connect_and_a_redirect_inside_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            tls = certificate(directory)
        await self.site(
            {
                "/": (200, {}, b"secure"),
                "/inside": (302, {"Location": "https://metadata.test/latest/meta-data/"}, b""),
            },
            port=443,
            tls=tls,
        )
        manager = self.egress.session()
        lease = await manager.__aenter__()
        try:
            self.assertEqual(
                await self.in_thread(lambda: through(lease, "https://public.test/")), (200, b"secure")
            )
            with self.assertRaises(Exception):
                await self.in_thread(lambda: through(lease, "https://public.test/inside"))
        finally:
            await manager.__aexit__(None, None, None)
        self.assertNotIn(("169.254.169.254", 443), self.wires.dialed)
        self.assertIn("169.254.169.254", lease.refused)

    async def test_generic_extraction_of_a_page_goes_only_through_the_proxy(self):
        page = (
            b"<html><head><title>Film night</title>"
            b'<meta property="og:image" content="http://cdn.test/poster.jpg"></head><body>'
            b'<video controls poster="http://cdn.test/poster.jpg">'
            b'<source src="http://cdn.test/film-720.mp4" type="video/mp4" res="720">'
            b'<track kind="subtitles" srclang="ru" label="Russian" src="http://cdn.test/film.ru.vtt">'
            b"</video></body></html>"
        )
        await self.site({"/film": (200, {"Content-Type": "text/html; charset=utf-8"}, page)})
        manager = self.egress.session()
        lease = await manager.__aenter__()

        def extract():
            import yt_dlp

            options = {"quiet": True, "no_warnings": True, "proxy": lease.url, "socket_timeout": 5}
            with yt_dlp.YoutubeDL({**options, "cachedir": False, "check_formats": False}) as ydl:
                return ydl.extract_info("http://public.test/film", download=False)

        try:
            info = await self.in_thread(extract)
        finally:
            await manager.__aexit__(None, None, None)
        # Одно видео на странице yt-dlp называет «Имя страницы (1)» — номер снимает площадка.
        self.assertEqual(info["title"], "Film night (1)")
        self.assertEqual([item["url"] for item in info["formats"]], ["http://cdn.test/film-720.mp4"])
        self.assertEqual(info["subtitles"]["ru"][0]["url"], "http://cdn.test/film.ru.vtt")
        # Страницу yt-dlp спросил через прокси, а файлы только перечислил: звонок был один.
        self.assertEqual(self.wires.dialed, [(PUBLIC, 80)])


class UpstreamProxy(unittest.IsolatedAsyncioTestCase):
    """С прокси администратора прокси разбора зовёт его к проверенному адресу, а не к имени."""

    async def asyncSetUp(self):
        self.names = Directory({"public.test": [PUBLIC], "inside.test": ["10.0.0.7"]})
        self.target = await Site({"/": (200, {}, b"hello")}).start()
        self.addAsyncCleanup(self.target.stop)
        self.asked = []

    async def socks(self, reader, writer):
        """SOCKS5 с входом по имени и паролю: помнит, куда его попросили, и соединяет с сайтом теста."""
        try:
            _, count = await reader.readexactly(2)
            await reader.readexactly(count)
            writer.write(b"\x05\x02")
            await writer.drain()
            await reader.readexactly(1)
            user = await reader.readexactly((await reader.readexactly(1))[0])
            secret = await reader.readexactly((await reader.readexactly(1))[0])
            writer.write(b"\x01" + (b"\x00" if (user, secret) == (b"admin", b"p@ss") else b"\x01"))
            await writer.drain()
            head = await reader.readexactly(4)
            size = {1: 4, 4: 16}[head[3]]
            address = await reader.readexactly(size)
            port = int.from_bytes(await reader.readexactly(2), "big")
            self.asked.append((address, port))
            up_reader, up_writer = await asyncio.open_connection("127.0.0.1", self.target.port)
            writer.write(b"\x05\x00\x00\x01" + bytes(4) + b"\x00\x00")
            await writer.drain()
            await asyncio.gather(pipe(reader, up_writer), pipe(up_reader, writer))
        except (asyncio.IncompleteReadError, ConnectionError):
            writer.close()

    async def http_connect(self, reader, writer):
        head = await reader.readuntil(b"\r\n\r\n")
        self.asked.append(head.decode())
        up_reader, up_writer = await asyncio.open_connection("127.0.0.1", self.target.port)
        writer.write(b"HTTP/1.1 200 OK\r\n\r\n")
        await writer.drain()
        await asyncio.gather(pipe(reader, up_writer), pipe(up_reader, writer))

    async def proxied(self, handler, scheme):
        server = await asyncio.start_server(handler, "127.0.0.1", 0)
        self.addAsyncCleanup(server.wait_closed)
        self.addCleanup(server.close)
        port = server.sockets[0].getsockname()[1]
        egress = Egress(Guard((), self.names), upstream=f"{scheme}://admin:p%40ss@127.0.0.1:{port}")
        await egress.start()
        self.addAsyncCleanup(egress.close)
        return egress

    async def fetch(self, egress):
        manager = egress.session()
        lease = await manager.__aenter__()
        try:
            return lease, await asyncio.to_thread(lambda: through(lease, "http://public.test/"))
        finally:
            await manager.__aexit__(None, None, None)

    async def test_socks5_is_asked_for_the_checked_address(self):
        egress = await self.proxied(self.socks, "socks5h")
        _, answer = await self.fetch(egress)
        self.assertEqual(answer, (200, b"hello"))
        self.assertEqual(self.asked, [(bytes([93, 184, 216, 34]), 80)])

    async def test_http_connect_is_asked_for_the_checked_address(self):
        egress = await self.proxied(self.http_connect, "http")
        _, answer = await self.fetch(egress)
        self.assertEqual(answer, (200, b"hello"))
        self.assertTrue(self.asked[0].startswith(f"CONNECT {PUBLIC}:80 HTTP/1.1"), self.asked[0])
        token = base64.b64encode(b"admin:p@ss").decode()
        self.assertIn(f"Proxy-Authorization: Basic {token}", self.asked[0])

    async def test_the_inside_is_refused_before_the_proxy_is_asked(self):
        egress = await self.proxied(self.http_connect, "http")
        manager = egress.session()
        lease = await manager.__aenter__()
        try:
            with self.assertRaises(Exception):
                await asyncio.to_thread(lambda: through(lease, "http://inside.test/"))
        finally:
            await manager.__aexit__(None, None, None)
        self.assertEqual(self.asked, [])


async def pipe(source, target):
    try:
        while chunk := await source.read(65536):
            target.write(chunk)
            await target.drain()
    except ConnectionError:
        pass
    finally:
        target.close()


if __name__ == "__main__":
    unittest.main()
