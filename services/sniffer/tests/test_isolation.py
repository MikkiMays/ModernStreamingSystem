"""
Самопроверка изоляции плеера страниц (`sniffer/isolation.py`): шлюз подсети, цели, «дотянулся — отказ» и
ожидание первой проверки. Сеть — своя, на 127.0.0.1 контейнера теста.
"""

import asyncio
import socket
import tempfile
import unittest

from sniffer.isolation import CANARIES, Isolation, gateway, targets

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


if __name__ == "__main__":
    unittest.main()
