"""
Самопроверка изоляции плеера страниц (`sniffer/isolation.py`): шлюз подсети, цели, «дотянулся — отказ»,
ожидание первой проверки и метка стены хоста. Сеть — своя, на 127.0.0.1 контейнера теста.
"""

import asyncio
import socket
import tempfile
import unittest
from ipaddress import ip_address
from pathlib import Path

from sniffer.isolation import CANARIES, Isolation, gateway, own_address, targets

ROUTES = """Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT
eth0\t00000000\t0100E70A\t0003\t0\t0\t0\t00000000\t0\t0\t0
eth0\t0000E70A\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0
"""


def listening() -> socket.socket:
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen(8)
    return server


def closed_port() -> int:
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    return port


class Targets(unittest.TestCase):
    def test_the_gateway_is_read_from_the_routes_of_the_container(self):
        with tempfile.NamedTemporaryFile("w", suffix=".route") as routes:
            routes.write(ROUTES)
            routes.flush()
            self.assertEqual(gateway(routes.name), "10.231.0.1")
        self.assertIsNone(gateway("/nonexistent/route"))

    def test_the_default_targets_are_the_host_neighbours_and_the_metadata(self):
        self.assertEqual(
            targets(CANARIES, "10.231.0.1"),
            [("10.231.0.1", 8090), ("10.231.0.1", 8091), ("169.254.169.254", 80)],
        )
        # Без шлюза (`--network none`) остаются остальные цели.
        self.assertEqual(targets(CANARIES, None), [("169.254.169.254", 80)])
        self.assertEqual(targets("x, :1, a:0, b:99999, [::1]:22", None), [("::1", 22)])


class Check(unittest.IsolatedAsyncioTestCase):
    async def test_a_target_that_answers_means_no_isolation(self):
        server = listening()
        try:
            port = server.getsockname()[1]
            isolation = Isolation([("127.0.0.1", closed_port()), ("127.0.0.1", port)], attempt=1.0)
            self.assertFalse(await isolation.check())
            self.assertEqual(isolation.reached, [f"127.0.0.1:{port}"])
            self.assertFalse(await isolation.ready())
            self.assertFalse(isolation.state()["isolated"])
        finally:
            server.close()

    async def test_targets_that_refuse_or_stay_silent_mean_isolation(self):
        isolation = Isolation([("127.0.0.1", closed_port()), ("192.0.2.1", 80)], attempt=0.5)
        self.assertTrue(await isolation.check())
        self.assertEqual(isolation.reached, [])
        self.assertTrue(await isolation.ready())

    async def test_the_first_check_is_waited_for_and_the_watch_repeats(self):
        server = listening()
        try:
            isolation = Isolation([("127.0.0.1", server.getsockname()[1])], attempt=0.5, period=0.2)
            watching = asyncio.ensure_future(isolation.watch())
            self.assertFalse(await isolation.ready())
            # Цель закрылась — следующая проверка возвращает изоляцию.
            server.close()
            for _ in range(30):
                if isolation.isolated:
                    break
                await asyncio.sleep(0.1)
            self.assertTrue(isolation.isolated)
            watching.cancel()
        finally:
            server.close()

    async def test_before_any_check_it_is_not_isolated(self):
        isolation = Isolation([("127.0.0.1", closed_port())], attempt=0.2)
        self.assertIsNone(isolation.isolated)
        # Проверки нет и не будет — ожидание кончается отказом, а не страницей.
        self.assertFalse(await isolation.ready())


class Mark(unittest.IsolatedAsyncioTestCase):
    """Метка стены: `/run/cord-sniffer/<подсеть>` на хосте — «правила этой подсети на месте»."""

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.walls = Path(self.folder.name)

    def tearDown(self):
        self.folder.cleanup()

    def isolation(self, **extra) -> Isolation:
        # Цель, которая отказывает: пробы молчат, и решает одна метка.
        options = {"attempt": 0.5, "walls": self.walls, "address": lambda: "10.231.0.2"}
        options.update(extra)
        return Isolation([("127.0.0.1", closed_port())], **options)

    def put(self, subnet: str) -> Path:
        mark = self.walls / subnet.replace("/", "_")
        mark.write_text(subnet + "\n")
        return mark

    async def test_without_the_mark_of_its_own_subnet_no_page_opens(self):
        isolation = self.isolation()
        self.assertFalse(await isolation.check())
        self.assertFalse(isolation.walled)
        self.assertEqual(isolation.reached, [])
        self.assertFalse(await isolation.ready())
        self.assertEqual(isolation.state()["walled"], False)

    async def test_the_mark_of_another_subnet_does_not_count(self):
        self.put("10.231.1.0/24")
        (self.walls / "10.231.0.0_24").write_bytes(b"\xff" * 100)
        self.assertFalse(await self.isolation().check())

    async def test_only_a_file_named_as_its_subnet_with_the_subnet_inside_is_a_mark(self):
        # Недописанная и переименованная метки, чужое содержимое под верным именем — не метки.
        (self.walls / ".10.231.0.0_24.new").write_text("10.231.0.0/24\n")
        (self.walls / ".held").write_text("10.231.0.0/24\n")
        (self.walls / "10.231.0.0_24").write_text("10.0.0.0/8\n")
        self.assertFalse(await self.isolation().check())
        (self.walls / "10.231.0.0_24").write_text("10.231.0.0/24\n")
        self.assertTrue(await self.isolation().check())

    async def test_with_the_mark_and_silent_neighbours_pages_open(self):
        self.put("10.231.0.0/24")
        isolation = self.isolation()
        self.assertTrue(await isolation.check())
        self.assertTrue(isolation.walled)
        self.assertTrue(await isolation.ready())

    async def test_without_its_own_address_there_is_no_mark_to_find(self):
        self.put("10.231.0.0/24")
        self.assertFalse(await self.isolation(address=lambda: None).check())
        # Каталога меток нет вовсе (не смонтирован) — тоже нет.
        self.assertFalse(await self.isolation(walls=self.walls / "absent").check())

    async def test_a_mark_taken_away_closes_pages_at_once_and_a_new_one_opens_them_soon(self):
        mark = self.put("10.231.0.0/24")
        isolation = self.isolation(period=3600.0, mark=0.05)
        watching = asyncio.ensure_future(isolation.watch())
        try:
            self.assertTrue(await isolation.ready())
            mark.unlink()
            # Страница не ждёт следующей проверки: метки нет — отказ сразу.
            self.assertFalse(await isolation.ready())
            self.put("10.231.0.0/24")
            for _ in range(40):
                if await isolation.ready():
                    break
                await asyncio.sleep(0.05)
            # Появилась — проверено заново через доли секунды, а не через час.
            self.assertTrue(await isolation.ready())
        finally:
            watching.cancel()

    def test_its_own_address_is_where_a_packet_out_would_leave_from(self):
        # В контейнере теста сети нет (`--network none`): маршрута наружу нет — и адреса нет; с сетью — IPv4.
        found = own_address()
        if found is not None:
            self.assertEqual(ip_address(found).version, 4)


if __name__ == "__main__":
    unittest.main()
