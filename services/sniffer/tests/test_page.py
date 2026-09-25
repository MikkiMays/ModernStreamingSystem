"""
Плеер страниц целиком: настоящий Chromium, настоящий охраняемый выход, страницы-фикстуры на 127.0.0.1 и
127.0.0.2 внутри контейнера теста — без сети наружу (`--network none`).

Выход пускает только к двум сайтам теста (частное разрешение по их портам, как `CINEMA_PRIVATE_HOSTS_LINK`);
ловушка (`sites.Trap`) — такой же 127.0.0.1, но на порту, куда выход не пускает. Ноль соединений у ловушки
при странице, которая стучится туда всеми способами, — это ноль путей браузера мимо выхода.
"""

import asyncio
import os
import time
import unittest
from ipaddress import ip_network
from pathlib import Path

from cord_services.cinema.egress import Busy, Egress
from cord_services.cinema.net import Allowance, Guard
from sniffer.page import TEARDOWN, Pages
from sites import Site, Trap

SECONDS = 8.0
LOOK = 2.5
LOOPBACK = ip_network("127.0.0.0/8")


class PageCase(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.a = Site("127.0.0.1")
        # Плеер в чужой рамке: cookie третьей стороны браузер не шлёт — его поток держится на Referer.
        cls.b = Site("127.0.0.2", strict_cookie=False)
        cls.trap = Trap()
        values = {"A": cls.a.origin, "B": cls.b.origin, "C": cls.trap.origin, "CPORT": str(cls.trap.port)}
        cls.a.values.update(values)
        cls.b.values.update(values)

    @classmethod
    def tearDownClass(cls):
        cls.a.close()
        cls.b.close()
        cls.trap.close()

    async def asyncSetUp(self):
        guard = Guard(
            (Allowance(network=LOOPBACK, port=self.a.port), Allowance(network=LOOPBACK, port=self.b.port))
        )
        self.egress = Egress(guard, sessions=2, wait=1.0, tunnels=192, per_lease=96, pending=64)
        self.egress.seconds = SECONDS + TEARDOWN
        self.pages = Pages(self.egress, seconds=SECONDS, look=LOOK, idle=60.0)

    async def asyncTearDown(self):
        await self.pages.close()
        await self.egress.close()

    async def sniff(self, path, site=None):
        started = time.monotonic()
        found = await self.pages.sniff((site or self.a).url(path))
        found["took"] = time.monotonic() - started
        return found


class ThePlayerOfThePage(PageCase):
    async def test_the_player_is_caught_with_the_cookie_and_the_referer_it_sent(self):
        found = await self.sniff("/pages/hls.html")
        stream = found["streams"][0]
        self.assertEqual(stream["url"], self.a.url("/media/master.m3u8?token=t1"))
        self.assertEqual(stream["type"], "hls")
        self.assertTrue(stream["master"])
        self.assertEqual(stream["heights"], [180, 144])
        self.assertEqual(stream["headers"]["referer"], self.a.url("/pages/hls.html"))
        self.assertIn("HeadlessChrome", stream["headers"]["user-agent"])
        self.assertNotIn("cookie", stream["headers"])
        self.assertEqual(found["cookies"], {"127.0.0.1": f"sid={self.a.cookie}"})
        self.assertEqual(found["title"], "Фильм страницы")
        self.assertEqual(found["poster"], self.a.url("/poster.png"))
        self.assertFalse(found["drm"] or found["robot"] or found["login"] or found["inside"])
        self.assertFalse(found["clicked"])
        # Плеер нашёлся сам, и ждать срока страницы было незачем.
        self.assertLess(found["took"], SECONDS)
        # Мастер сайт отдал только своему плееру — с его cookie и Referer: без них 403 (`sites.Site`).
        self.assertTrue(self.a.seen("/media/master.m3u8"))

    async def test_a_player_in_a_frame_of_another_site_is_caught_there(self):
        found = await self.sniff("/pages/frame.html")
        stream = found["streams"][0]
        self.assertEqual(stream["url"], self.b.url("/media/master.m3u8"))
        self.assertEqual(stream["headers"]["referer"], self.b.url("/pages/player.html"))
        self.assertEqual(stream["frame"], self.b.url("/pages/player.html"))
        self.assertEqual(found["title"], "Фикстура: плеер в рамке чужого сайта")

    async def test_a_player_that_waits_for_a_click_gets_exactly_one(self):
        found = await self.sniff("/pages/click.html")
        self.assertTrue(found["clicked"])
        self.assertEqual(found["streams"][0]["url"], self.a.url("/media/master.m3u8?token=t1"))
        self.assertEqual(len(self.a.seen("/api/source")) >= 1, True)

    async def test_a_file_the_video_tag_asks_for_is_a_file(self):
        found = await self.sniff("/pages/file.html")
        stream = found["streams"][0]
        self.assertEqual(
            (stream["url"], stream["type"], stream["ext"]), (self.a.url("/film.mp4"), "file", "mp4")
        )

    async def test_a_video_with_browser_controls_is_started_by_its_own_play_button(self):
        # Нажатие по кадру у headless shell ничего не включает: у него на кадре нет кнопок браузера.
        found = await self.sniff("/pages/controls.html")
        self.assertTrue(found["clicked"])
        self.assertEqual(found["streams"][0]["url"], self.a.url("/film.mp4"))

    async def test_hls_the_video_tag_plays_itself_is_caught_too(self):
        found = await self.sniff("/pages/native.html")
        self.assertEqual(found["streams"][0]["url"], self.a.url("/media/master.m3u8"))
        self.assertEqual(found["streams"][0]["type"], "hls")


class Drm(PageCase):
    async def test_a_page_that_asks_for_widevine_and_has_nothing_open_is_drm(self):
        found = await self.sniff("/pages/widevine.html")
        self.assertTrue(found["drm"])
        self.assertEqual(found["systems"], ["com.widevine.alpha"])
        self.assertEqual(found["streams"], [])

    async def test_keys_set_on_the_element_are_drm_at_once(self):
        found = await self.sniff("/pages/clearkey.html")
        self.assertTrue(found["drm"])
        # EME в деле — ждать срока страницы незачем.
        self.assertLess(found["took"], SECONDS)

    async def test_a_question_about_widevine_next_to_open_video_is_not_drm(self):
        found = await self.sniff("/pages/probe.html")
        self.assertFalse(found["drm"])
        self.assertEqual(found["systems"], ["com.widevine.alpha"])
        self.assertEqual(found["streams"][0]["type"], "hls")


class Walls(PageCase):
    async def test_popups_and_new_tabs_never_open(self):
        found = await self.sniff("/pages/popups.html")
        self.assertTrue(found["clicked"])
        self.assertEqual(found["streams"][0]["url"], self.a.url("/media/master.m3u8?token=t1"))
        self.assertEqual(self.a.seen("/popup"), [])

    async def test_a_click_that_leads_away_ends_the_page_and_takes_nothing_from_the_next_one(self):
        found = await self.sniff("/pages/away.html")
        self.assertTrue(found["clicked"])
        # Страница, куда увело нажатие, свой файл спросила — но это уже не та страница.
        self.assertTrue(self.a.seen("/pages/file.html"))
        self.assertEqual(found["streams"], [])
        self.assertLess(found["took"], SECONDS)

    async def test_nothing_leaves_the_browser_but_through_the_guarded_way_out(self):
        found = await self.sniff("/pages/inside.html")
        # Дать WebRTC и маякам время: ловушка должна остаться пустой и после страницы.
        await asyncio.sleep(1.0)
        self.assertEqual((self.trap.accepted, self.trap.datagrams), (0, 0))
        self.assertEqual(found["streams"], [])
        self.assertEqual(self.egress._leases, {})

    async def test_a_redirect_inside_is_refused_before_it_connects(self):
        found = await self.sniff("/go-inside")
        self.assertEqual(self.trap.accepted, 0)
        self.assertTrue(found["inside"])
        self.assertEqual(found["streams"], [])

    async def test_a_page_that_checks_for_robots_is_said_so(self):
        found = await self.sniff("/pages/captcha.html")
        self.assertTrue(found["robot"])
        self.assertEqual(found["streams"], [])

    async def test_a_login_page_is_said_so(self):
        found = await self.sniff("/pages/login.html")
        self.assertTrue(found["login"])
        self.assertEqual(found["streams"], [])


class Budget(PageCase):
    async def test_a_page_without_video_ends_at_its_budget(self):
        found = await self.sniff("/pages/empty.html")
        self.assertEqual(found["streams"], [])
        self.assertLess(found["took"], SECONDS + 1.5)

    async def test_a_page_that_never_loads_still_ends_at_its_budget(self):
        found = await self.sniff("/pages/hang.html")
        self.assertEqual(found["streams"], [])
        self.assertLess(found["took"], SECONDS + TEARDOWN)

    async def test_the_tab_and_its_connections_are_gone_after_the_page(self):
        await self.sniff("/pages/hls.html")
        browser = self.pages._browser
        self.assertIsNotNone(browser)
        self.assertEqual(browser.contexts, [])
        self.assertEqual(self.egress._leases, {})
        self.assertEqual(self.egress._open, 0)

    async def test_two_pages_at_once_and_a_third_gives_up_waiting(self):
        first = asyncio.ensure_future(self.pages.sniff(self.a.url("/pages/empty.html")))
        second = asyncio.ensure_future(self.pages.sniff(self.a.url("/pages/empty.html")))
        await asyncio.sleep(0.5)
        with self.assertRaises(Busy):
            await self.pages.sniff(self.a.url("/pages/hls.html"))
        await asyncio.gather(first, second)

    async def test_a_page_given_up_closes_at_once(self):
        task = asyncio.ensure_future(self.pages.sniff(self.a.url("/pages/empty.html")))
        await asyncio.sleep(1.5)
        started = time.monotonic()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertLess(time.monotonic() - started, TEARDOWN)
        self.assertEqual(self.egress._leases, {})
        self.assertEqual(self.pages._browser.contexts, [])


class TheBrowserItself(PageCase):
    async def test_it_runs_only_through_the_way_out_without_the_keys_and_goes_first_on_oom(self):
        await self.sniff("/pages/empty.html")
        processes = []
        for entry in Path("/proc").iterdir():
            if not entry.name.isdigit():
                continue
            try:
                arguments = (entry / "cmdline").read_bytes().split(b"\0")
                environ = (entry / "environ").read_bytes()
                score = (entry / "oom_score_adj").read_text().strip()
            except OSError:
                continue
            if arguments and arguments[0].endswith(b"chrome-headless-shell"):
                processes.append((arguments, environ, score))
        self.assertTrue(processes)
        main = next(
            arguments for arguments, _, _ in processes if not any(a.startswith(b"--type=") for a in arguments)
        )
        for flag in (
            f"--proxy-server=http://127.0.0.1:{self.egress.port}".encode(),
            b"--proxy-bypass-list=<-loopback>",
            b"--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
            b"--disable-quic",
            b"--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
            b"--block-new-web-contents",
        ):
            self.assertIn(flag, main)
        for _, environ, score in processes:
            self.assertNotIn(b"CINEMA_SNIFFER_KEY", environ)
            self.assertNotIn(b"INTERNAL_SECRET", environ)
            self.assertEqual(score, "1000")
        self.assertNotIn("CINEMA_SNIFFER_KEY", os.environ)


if __name__ == "__main__":
    unittest.main()
