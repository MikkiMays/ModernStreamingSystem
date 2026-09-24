"""
Сеть кинозала: через какой выход ходит каждая площадка и куда ей нельзя.

Ни одного настоящего запроса наружу и ни одного настоящего разрешения имени: имена отвечает
справочник теста (`Directory`), а соединения — сеть теста (`Dialer`), которая только помнит,
куда звонили. Проверяется именно то место, где httpx соединяется, — поэтому тесты гоняют
настоящий `httpx.AsyncClient` поверх настоящего пула httpcore.
"""

import asyncio
import logging
import os
import pathlib
import tempfile
import unittest
from ipaddress import ip_address, ip_network
from unittest.mock import patch

import httpcore
import httpx
from fastapi import HTTPException

from cord_services.app import create_app
from cord_services.cinema import Cinema
from cord_services.cinema.net import Guard, GuardedTransport, Net, NetConfig, NotPublic, public
from cord_services.cinema.providers.twitch import Twitch
from cord_services.cinema.providers.youtube import YouTube
from cord_services.cinema.registry import HostPolicy
from cord_services.cinema.resolve import YtDlp
from cord_services.core import Core

OK = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"

COOKIES = (
    "# Netscape HTTP Cookie File\n"
    "# https://curl.se/docs/http-cookies.html\n"
    "\n"
    ".youtube.com\tTRUE\t/\tTRUE\t1893456000\tSID\tsecret-session-value\n"
    "#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tHSID\tanother-secret\n"
)


class Directory:
    """Справочник имён теста: что ответить на каждое имя (или функция, которая решит)."""

    def __init__(self, answers):
        self.answers = answers
        self.asked = []

    async def __call__(self, host, port):
        self.asked.append(host)
        answer = self.answers[host]
        return answer() if callable(answer) else answer


class Line(httpcore.AsyncMockStream):
    """Соединение теста: отвечает по порядку заготовленным и помнит, что в него написали."""

    def __init__(self, answers):
        super().__init__(list(answers))
        self.written = []
        self.tls = []

    async def write(self, buffer, timeout=None):
        self.written.append(bytes(buffer))

    async def start_tls(self, ssl_context, server_hostname=None, timeout=None):
        self.tls.append(server_hostname)
        return self


class Dialer(httpcore.AsyncNetworkBackend):
    """Сеть теста: помнит, куда звонили, и отвечает заготовленным ответом."""

    def __init__(self, *answers):
        self.dialed = []
        self.answers = answers or (OK,)
        self.lines = []

    async def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        self.dialed.append((host, port))
        self.lines.append(Line(self.answers))
        return self.lines[-1]

    async def connect_unix_socket(self, path, timeout=None, socket_options=None):
        raise AssertionError("кинозал не ходит через unix-сокеты")

    async def sleep(self, seconds):
        await asyncio.sleep(seconds)


class PublicAddressTests(unittest.IsolatedAsyncioTestCase):
    """Что считается публичным адресом — по таблицам IANA, а не по догадке."""

    INSIDE = [
        "127.0.0.1",
        "127.1.2.3",
        "10.0.0.1",
        "172.16.5.4",
        "172.31.255.255",
        "192.168.1.1",
        "169.254.169.254",  # метаданные облака — главная цель SSRF
        "100.64.0.1",  # CGNAT
        "0.0.0.0",
        "224.0.0.1",
        "239.255.255.250",
        "255.255.255.255",
        "240.0.0.1",
        "192.0.0.1",
        "192.0.2.1",
        "198.18.0.1",
        "198.51.100.7",
        "203.0.113.9",
        "::1",
        "::",
        "fe80::1",
        "fc00::1",
        "fd12:3456::1",
        "ff02::1",
        "::ffff:127.0.0.1",  # IPv4 внутри IPv6 — тот же 127.0.0.1
        "::ffff:10.0.0.1",
        "64:ff9b::a00:1",  # NAT64 к 10.0.0.1
        "2002:7f00:1::",  # 6to4 к 127.0.0.1
        "2001::1",  # Teredo
        "2001:db8::1",
        "100::1",
        "::127.0.0.1",  # устаревшая форма «IPv4-совместимый»
    ]
    OUTSIDE = [
        "8.8.8.8",
        "93.184.216.34",
        "172.32.0.1",
        "100.128.0.1",
        "2606:4700:4700::1111",
        "2a00:1450:4001:82b::200e",
        "::ffff:8.8.8.8",
        "64:ff9b::808:808",  # NAT64 к 8.8.8.8
    ]

    def test_inside_addresses_are_not_public(self):
        for text in self.INSIDE:
            self.assertFalse(public(ip_address(text)), text)

    def test_outside_addresses_are_public(self):
        for text in self.OUTSIDE:
            self.assertTrue(public(ip_address(text)), text)

    async def test_a_literal_is_checked_without_asking_anyone(self):
        directory = Directory({})
        guard = Guard(resolve=directory)
        for text in self.INSIDE:
            with self.assertRaises(NotPublic):
                await guard.vet(text, 443)
        self.assertEqual(await guard.vet("[2606:4700:4700::1111]", 443), ["2606:4700:4700::1111"])
        self.assertEqual(directory.asked, [])

    async def test_a_name_is_public_only_if_every_address_behind_it_is(self):
        guard = Guard(
            resolve=Directory(
                {
                    "localhost": ["127.0.0.1", "::1"],
                    "mixed.test": ["93.184.216.34", "10.0.0.1"],
                    "public.test": ["93.184.216.34", "2606:4700:4700::1111"],
                    "empty.test": [],
                }
            )
        )
        for name in ("localhost", "mixed.test"):
            with self.assertRaises(NotPublic):
                await guard.vet(name, 443)
        self.assertEqual(await guard.vet("public.test", 443), ["93.184.216.34", "2606:4700:4700::1111"])
        with self.assertRaises(httpcore.ConnectError):
            await guard.vet("empty.test", 443)

    async def test_networks_from_the_setting_are_let_in_and_nothing_else(self):
        # Своя медиатека на 127.0.0.1:8097 — только если её сеть названа в CINEMA_PRIVATE_HOSTS.
        guard = Guard(
            private=[ip_network("127.0.0.1/32"), ip_network("10.0.0.0/8")],
            resolve=Directory({"library.test": ["10.1.2.3"]}),
        )
        self.assertEqual(await guard.vet("127.0.0.1", 8097), ["127.0.0.1"])
        self.assertEqual(await guard.vet("::ffff:10.9.9.9", 80), ["::ffff:10.9.9.9"])
        self.assertEqual(await guard.vet("library.test", 443), ["10.1.2.3"])
        for text in ("127.0.0.2", "192.168.1.1", "169.254.169.254"):
            with self.assertRaises(NotPublic):
                await guard.vet(text, 443)


class GuardedTransportTests(unittest.IsolatedAsyncioTestCase):
    """Проверка стоит там, где httpx соединяется, и соединяется он ровно с проверенным адресом."""

    async def ask(self, transport, url):
        async with httpx.AsyncClient(transport=transport) as client:
            return await client.get(url)

    async def refused(self, transport, url):
        with self.assertRaises(httpx.ConnectError) as failure:
            await self.ask(transport, url)
        return failure.exception

    async def test_a_name_that_leads_inside_is_refused_before_dialling(self):
        dialer = Dialer()
        guard = Guard(resolve=Directory({"inside.test": ["10.0.0.7"]}))
        failure = await self.refused(GuardedTransport(guard, backend=dialer), "https://inside.test/secret")
        self.assertIsInstance(failure.__cause__, NotPublic)
        self.assertEqual(dialer.dialed, [])

    async def test_an_address_written_in_the_link_is_refused_the_same_way(self):
        dialer = Dialer()
        guard = Guard(resolve=Directory({}))
        for url in (
            "http://127.0.0.1:8080/admin",
            "http://[::1]/",
            "http://169.254.169.254/latest/meta-data/",
        ):
            await self.refused(GuardedTransport(guard, backend=dialer), url)
        self.assertEqual(dialer.dialed, [])

    async def test_a_public_name_is_dialled_by_the_address_that_was_checked(self):
        dialer = Dialer()
        guard = Guard(resolve=Directory({"cdn.test": ["93.184.216.34"]}))
        answer = await self.ask(GuardedTransport(guard, backend=dialer), "http://cdn.test/piece.ts")
        self.assertEqual((answer.status_code, answer.text), (200, "ok"))
        # Соединение — с адресом, а не с именем: второго разрешения имени, которое могло бы
        # ответить иначе, нет.
        self.assertEqual(dialer.dialed, [("93.184.216.34", 80)])

    async def test_a_name_that_changes_its_answer_is_checked_where_it_connects(self):
        # DNS rebinding: на проверке имя публичное, на соединении — 127.0.0.1. Проверка «по
        # имени» заранее это пропустила бы; проверка на соединении — нет.
        answers = iter([["93.184.216.34"], ["127.0.0.1"]])
        dialer = Dialer()
        guard = Guard(resolve=Directory({"rebind.test": lambda: next(answers)}))
        self.assertEqual(await guard.vet("rebind.test", 443), ["93.184.216.34"])
        await self.refused(GuardedTransport(guard, backend=dialer), "https://rebind.test/")
        self.assertEqual(dialer.dialed, [])

    async def test_a_configured_proxy_may_live_inside_and_resolves_names_itself(self):
        # Прокси назначил администратор: соединение с ним разрешено, где бы он ни стоял, а имя
        # площадки разрешает он сам (socks5h, обход подмены DNS) — у площадок со своим списком
        # хостов их политика уже стоит на подписи.
        dialer = Dialer()
        directory = Directory({})
        transport = GuardedTransport(Guard(resolve=directory), proxy="http://127.0.0.1:3128", backend=dialer)
        answer = await self.ask(transport, "http://cdn.test/piece.ts")
        self.assertEqual(answer.status_code, 200)
        self.assertEqual(dialer.dialed, [("127.0.0.1", 3128)])
        self.assertEqual(directory.asked, [])

    async def test_behind_a_proxy_a_platform_with_any_hosts_still_goes_only_outside(self):
        # Ссылка и своя медиатека ходят куда угодно — поэтому за прокси их цель проверяется
        # здесь, до прокси: локальный клиент прокси с «LAN напрямую» иначе открыл бы нашу сеть.
        dialer = Dialer()
        guard = Guard(resolve=Directory({"inside.test": ["10.0.0.7"]}))
        transport = GuardedTransport(guard, proxy="http://127.0.0.1:3128", strict=True, backend=dialer)
        failure = await self.refused(transport, "http://inside.test/")
        self.assertIsInstance(failure.__cause__, NotPublic)
        self.assertEqual(dialer.dialed, [])

    async def test_a_socks_proxy_is_dialled_through_the_same_guard_and_resolves_names_itself(self):
        # Ответ SOCKS5: «без пароля» и «соединено», дальше — ответ площадки.
        dialer = Dialer(b"\x05\x00", b"\x05\x00\x00\x01\x7f\x00\x00\x01\x00\x50", OK)
        directory = Directory({})
        transport = GuardedTransport(
            Guard(resolve=directory), proxy="socks5h://127.0.0.1:1080", backend=dialer
        )
        answer = await self.ask(transport, "http://cdn.test/piece.ts")
        self.assertEqual(answer.status_code, 200)
        self.assertEqual(dialer.dialed, [("127.0.0.1", 1080)])
        # Прокси получил имя (ATYP 3), а не адрес: DNS у площадки со своим списком хостов — его.
        self.assertEqual(dialer.lines[0].written[1][:5], b"\x05\x01\x00\x03\x08")
        self.assertEqual(directory.asked, [])

    async def test_behind_socks_the_proxy_is_sent_to_the_checked_address(self):
        # SOCKS соединяется туда, куда скажем: говорим проверенный адрес, а имя остаётся TLS
        # (SNI и сертификат) и заголовку Host. Второго разрешения имени нет и у прокси.
        dialer = Dialer(b"\x05\x00", b"\x05\x00\x00\x01\x5d\xb8\xd8\x22\x01\xbb", OK)
        guard = Guard(resolve=Directory({"media.test": ["93.184.216.34"]}))
        transport = GuardedTransport(guard, proxy="socks5h://127.0.0.1:1080", strict=True, backend=dialer)
        answer = await self.ask(transport, "https://media.test/film.m3u8")
        self.assertEqual(answer.status_code, 200)
        line = dialer.lines[0]
        # CONNECT к IPv4 (ATYP 1) 93.184.216.34:443 — ровно проверенный адрес.
        self.assertEqual(line.written[1], b"\x05\x01\x00\x01\x5d\xb8\xd8\x22\x01\xbb")
        self.assertEqual(line.tls, ["media.test"])
        self.assertIn(b"\r\nHost: media.test\r\n", line.written[2])


class NetConfigTests(unittest.TestCase):
    """Настройки читаются один раз, при сборке приложения, — из словаря, а не из окружения."""

    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.folder = pathlib.Path(folder.name)

    def cookies(self, text=COOKIES, name="cookies.txt"):
        path = self.folder / name
        path.write_text(text)
        return str(path)

    def read(self, env):
        with self.assertLogs("cord_services.cinema.net", "WARNING") as log:
            config = NetConfig.from_env(env)
            logging.getLogger("cord_services.cinema.net").warning("конец")
        return config, [record.getMessage() for record in log.records[:-1]]

    def test_a_platform_proxy_overrides_the_common_one(self):
        config, warnings = self.read(
            {
                "CINEMA_PROXY": "socks5h://user:pa55@proxy.example:1080",
                "CINEMA_PROXY_TWITCH": "http://10.8.0.1:3128",
            }
        )
        self.assertEqual(config.proxy_for("youtube"), "socks5h://user:pa55@proxy.example:1080")
        self.assertEqual(config.proxy_for("twitch"), "http://10.8.0.1:3128")
        self.assertEqual(warnings, [])
        self.assertNotIn("pa55", repr(config))
        self.assertIsNone(NetConfig.from_env({}).proxy_for("youtube"))

    def test_a_proxy_that_cannot_be_understood_is_one_warning_without_its_value(self):
        config, warnings = self.read({"CINEMA_PROXY_YOUTUBE": "ftp://user:pa55@proxy.example"})
        self.assertIsNone(config.proxy_for("youtube"))
        self.assertEqual(len(warnings), 1)
        self.assertIn("CINEMA_PROXY_YOUTUBE", warnings[0])
        self.assertNotIn("pa55", warnings[0])

    def test_private_networks_come_from_the_setting(self):
        config, warnings = self.read(
            {"CINEMA_PRIVATE_HOSTS": " 127.0.0.1/32, 10.0.0.0/8,fd00::/8, 192.168.1.7 ,x/99"}
        )
        self.assertEqual(
            config.private,
            (
                ip_network("127.0.0.1/32"),
                ip_network("10.0.0.0/8"),
                ip_network("fd00::/8"),
                ip_network("192.168.1.7/32"),
            ),
        )
        self.assertEqual(len(warnings), 1)
        self.assertIn("x/99", warnings[0])

    def test_readable_cookies_are_kept_for_their_platform_only(self):
        config, warnings = self.read({"CINEMA_COOKIES_YOUTUBE": self.cookies()})
        self.assertEqual(warnings, [])
        self.assertEqual(config.cookies_for("youtube"), COOKIES)
        self.assertIsNone(config.cookies_for("twitch"))
        self.assertNotIn("secret-session-value", repr(config))

    def test_cookies_that_cannot_be_read_are_one_warning_and_no_cookies(self):
        for value, reason in (
            (str(self.folder / "missing.txt"), "не читается"),
            (str(self.folder), "не читается"),
            (self.cookies('[{"name": "SID", "value": "secret-session-value"}]', "json.txt"), "Netscape"),
            (
                self.cookies("# Netscape HTTP Cookie File\nbroken secret-session-value\n", "bad.txt"),
                "Netscape",
            ),
            (
                self.cookies(".youtube.com\tTRUE\t/\tTRUE\t0\tSID\tsecret-session-value\n", "bare.txt"),
                "Netscape",
            ),
        ):
            config, warnings = self.read({"CINEMA_COOKIES_YOUTUBE": value})
            self.assertIsNone(config.cookies_for("youtube"), value)
            self.assertEqual(len(warnings), 1, warnings)
            self.assertIn("CINEMA_COOKIES_YOUTUBE", warnings[0])
            self.assertIn(reason, warnings[0])
            self.assertNotIn("secret-session-value", warnings[0])

    def test_the_usual_proxy_variables_are_named_as_ignored(self):
        # httpx кинозала больше не читает HTTP(S)_PROXY сам: выход задаёт CINEMA_PROXY. Молча
        # это не проходит — одна строка в журнале, без значения.
        _, warnings = self.read({"HTTPS_PROXY": "http://user:pa55@corp:3128"})
        self.assertEqual(len(warnings), 1)
        self.assertIn("CINEMA_PROXY", warnings[0])
        self.assertNotIn("pa55", warnings[0])
        with self.assertNoLogs("cord_services.cinema.net", "WARNING"):
            NetConfig.from_env({"HTTPS_PROXY": "http://corp:3128", "CINEMA_PROXY": "http://corp:3128"})


class ReadingYoutubeDL:
    """Как настоящий yt-dlp: читает cookies при старте и записывает их обратно при выходе."""

    seen = []

    def __init__(self, params):
        self.params = params
        path = params.get("cookiefile")
        ReadingYoutubeDL.seen.append((dict(params), pathlib.Path(path).read_text() if path else None))

    def __enter__(self):
        return self

    def __exit__(self, *failure):
        if self.params.get("cookiefile"):
            pathlib.Path(self.params["cookiefile"]).write_text("# Netscape HTTP Cookie File\nrotated\n")
        return False

    def extract_info(self, address, download=True):
        if "fail" in address:
            raise RuntimeError(f"Unable to connect to proxy {self.params.get('proxy')}")
        return {"id": address}


class YtDlpNetworkTests(unittest.TestCase):
    def setUp(self):
        ReadingYoutubeDL.seen = []
        library = patch("yt_dlp.YoutubeDL", ReadingYoutubeDL)
        library.start()
        self.addCleanup(library.stop)
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.path = pathlib.Path(folder.name) / "cookies.txt"
        self.path.write_text(COOKIES)
        self.config = NetConfig.from_env(
            {
                "CINEMA_PROXY": "socks5h://user:pa55@proxy.example:1080",
                "CINEMA_COOKIES_YOUTUBE": str(self.path),
            }
        )

    def test_the_platform_gets_its_proxy_and_its_cookies_and_no_one_else_does(self):
        door = YtDlp(self.config)
        door.extract("https://www.youtube.com/watch?v=x", {"quiet": True}, "youtube")
        door.extract("https://www.twitch.tv/someone", {"quiet": True}, "twitch")
        (youtube, cookies), (twitch, none) = ReadingYoutubeDL.seen
        self.assertEqual(youtube["proxy"], "socks5h://user:pa55@proxy.example:1080")
        self.assertEqual(cookies, COOKIES)
        self.assertEqual(twitch["proxy"], "socks5h://user:pa55@proxy.example:1080")
        self.assertNotIn("cookiefile", twitch)
        self.assertIsNone(none)

    def test_yt_dlp_writes_only_its_own_copy_and_the_copy_is_gone(self):
        # yt-dlp записывает cookies обратно при выходе: в файл администратора (он может быть и
        # только для чтения) и из нескольких потоков сразу — это была бы порча или отказ.
        door = YtDlp(self.config)
        door.extract("https://www.youtube.com/watch?v=x", {}, "youtube")
        door.extract("https://www.youtube.com/watch?v=y", {}, "youtube")
        first, second = (params["cookiefile"] for params, _ in ReadingYoutubeDL.seen)
        self.assertNotEqual(first, str(self.path))
        self.assertFalse(os.path.exists(first) or os.path.exists(second))
        self.assertEqual(self.path.read_text(), COOKIES)
        self.assertEqual(ReadingYoutubeDL.seen[1][1], COOKIES)

    def test_a_proxy_password_does_not_reach_the_room(self):
        with self.assertRaises(HTTPException) as refusal:
            YtDlp(self.config).probe("https://www.youtube.com/watch?v=fail", "youtube")
        self.assertEqual(refusal.exception.status_code, 502)
        self.assertNotIn("pa55", refusal.exception.detail)
        self.assertIn("proxy.example", refusal.exception.detail)


class ClientTests(unittest.IsolatedAsyncioTestCase):
    """Каждая площадка ходит наружу своим клиентом: своим прокси и под той же защитой."""

    def net(self, config, hosts=None, **extra):
        policies = hosts or {"youtube": YouTube.hosts, "twitch": Twitch.hosts}
        net = Net(config, policies.get, **extra)
        self.addAsyncCleanup(net.close)
        return net

    async def test_one_client_per_platform_with_its_own_way_out(self):
        net = self.net(
            NetConfig(proxy="socks5h://proxy.example:1080", proxies={"twitch": "http://10.8.0.1:3128"})
        )
        youtube, twitch = net.client_for("youtube"), net.client_for("twitch")
        self.assertIs(net.client_for("youtube"), youtube)
        self.assertIsNot(youtube, twitch)
        self.assertIsInstance(youtube._transport._pool, httpcore.AsyncSOCKSProxy)
        self.assertIsInstance(twitch._transport._pool, httpcore.AsyncHTTPProxy)
        direct = self.net(NetConfig()).client_for("youtube")
        self.assertIsInstance(direct._transport._pool, httpcore.AsyncConnectionPool)

    async def test_every_platform_client_refuses_the_inside(self):
        dialer = Dialer()
        net = self.net(
            NetConfig(),
            {"youtube": YouTube.hosts, "library": HostPolicy(public_any=True)},
            resolve=Directory({"rr1.googlevideo.com": ["127.0.0.1"], "media.test": ["192.168.1.5"]}),
            backend=dialer,
        )
        for provider, url in (
            ("youtube", "https://rr1.googlevideo.com/x"),
            ("library", "https://media.test/x"),
        ):
            with self.assertRaises(httpx.ConnectError):
                await net.client_for(provider).get(url)
        self.assertEqual(dialer.dialed, [])

    async def test_the_cinema_asks_each_platform_through_its_own_client(self):
        cinema = Cinema("secret", net=NetConfig())
        self.addAsyncCleanup(cinema.close)
        asked = []

        def client_for(provider):
            asked.append(provider)
            return httpx.AsyncClient(
                transport=httpx.MockTransport(lambda request: httpx.Response(200, content=b"x"))
            )

        with patch.object(cinema.net, "client_for", client_for):
            await cinema.fetch("https://static-cdn.jtvnw.net/a.jpg", None, "twitch")
            await cinema.fetch("https://rr1.googlevideo.com/v", "bytes=0-1", "youtube")
            await cinema.manifest("https://usher.ttvnw.net/x.m3u8", None, "twitch")
        self.assertEqual(asked, ["twitch", "youtube", "twitch"])


class AppConfigTests(unittest.TestCase):
    """Приложение читает выход наружу из окружения один раз — при сборке, как и CINEMA_PROVIDERS."""

    def build(self, env):
        root = tempfile.TemporaryDirectory()
        self.addCleanup(root.cleanup)
        core = Core("http://core.test", "internal-test")
        with patch.dict(os.environ, env, clear=True):
            app = create_app(pathlib.Path(root.name), core, telegram_enabled=False)
        self.addCleanup(app.state.store.db.close)
        return app.state.cinema

    def test_the_setting_reaches_the_clients_and_yt_dlp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        cookies = pathlib.Path(folder.name) / "youtube.txt"
        cookies.write_text(COOKIES)
        cinema = self.build(
            {
                "CINEMA_PROXY": "socks5h://proxy.example:1080",
                "CINEMA_COOKIES_YOUTUBE": str(cookies),
                "CINEMA_PRIVATE_HOSTS": "127.0.0.1/32",
            }
        )
        self.assertEqual(cinema.net.config.proxy_for("twitch"), "socks5h://proxy.example:1080")
        self.assertEqual(cinema.ytdlp.network.cookies_for("youtube"), COOKIES)
        self.assertEqual(cinema.net.guard.private, (ip_network("127.0.0.1/32"),))
        self.assertIsInstance(cinema.net.client_for("twitch")._transport._pool, httpcore.AsyncSOCKSProxy)

    def test_a_platform_the_cinema_does_not_know_is_one_line_in_the_log(self):
        with self.assertLogs("cord_services.cinema.facade", "WARNING") as log:
            self.build({"CINEMA_PROXY_YOTUBE": "http://proxy.example:3128"})
        self.assertEqual(len(log.records), 1)
        self.assertIn("yotube", log.output[0])
        self.assertNotIn("proxy.example", log.output[0])


if __name__ == "__main__":
    unittest.main()
