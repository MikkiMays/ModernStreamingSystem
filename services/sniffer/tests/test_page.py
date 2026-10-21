"""
Плеер страниц целиком: настоящий Chromium, настоящий охраняемый выход, страницы-фикстуры на 127.0.0.1 и
127.0.0.2 внутри контейнера теста — без сети наружу (`--network none`).

Выход пускает только к двум сайтам теста (частное разрешение по их портам, как `CINEMA_PRIVATE_HOSTS_LINK`);
ловушка (`sites.Trap`) — такой же 127.0.0.1, но на порту, куда выход не пускает. Ноль соединений у ловушки
при странице, которая стучится туда всеми способами, — это ноль путей браузера мимо выхода.
"""

import asyncio
import contextlib
import json
import os
import signal
import subprocess
import sys
import time
import unittest
from ipaddress import ip_network
from pathlib import Path
from unittest.mock import patch

from playwright.async_api import BrowserContext

from cord_services.cinema.egress import Busy, Egress
from cord_services.cinema.net import Allowance, Guard
from sniffer import page as page_module
from sniffer.capture import STREAMS, SYSTEMS
from sniffer.page import LAUNCH, TEARDOWN, Pages, kill_browsers
from sites import Site, Trap


def chromium() -> dict[int, bytes]:
    """
    Процессы headless shell в контейнере теста и их командные строки. Имя ищется во всей строке: зиготы, GPU,
    сеть и рендереры переписывают свой заголовок одной строкой, и первым словом оно есть только у браузера.
    """
    found = {}
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            command = (entry / "cmdline").read_bytes()
        except OSError:
            continue
        if b"chrome-headless-shell" in command:
            found[int(entry.name)] = command
    return found


def drivers() -> set[int]:
    """Драйверы Playwright (node `run-driver`) в контейнере теста."""
    found = set()
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            command = (entry / "cmdline").read_bytes()
        except OSError:
            continue
        if b"run-driver" in command.split(b"\0"):
            found.add(int(entry.name))
    return found


SECONDS = 10.0
LOOK = 2.5
LOOPBACK = ip_network("127.0.0.0/8")


class PageCase(unittest.IsolatedAsyncioTestCase):
    """
    Срок страницы считается с начала визита и включает холодный запуск браузера — так и в бою, после
    простоя `IDLE`. Но срок теста (`SECONDS`) втрое короче боевого, а у каждого теста свой `Pages`: холодный
    запуск Chromium и первый разговор с драйвером в процессе (секунда-другая на спокойном хосте и до восьми
    под нагрузкой) съедали ожидание плеера и нажатие, и тест краснел по сроку, а не по делу. Классы, которые
    проверяют не сам холодный запуск, греют браузер до страницы (`warm`); холодный — `Budget`, `Launch`,
    `TheBrowserItself`.
    """

    warm = False

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
        if self.warm:
            await self.pages._browser_ready()

    async def asyncTearDown(self):
        await self.pages.close()
        await self.egress.close()

    async def sniff_again(self):
        """
        Следующая страница после закрытого или убитого браузера. Новый запуск — до неё, как у `warm`:
        проверяется, что браузер поднимается снова и страница открывается, а не скорость холодного запуска в
        срок теста.
        """
        await self.pages._browser_ready()
        return await self.sniff("/pages/hls.html")

    async def sniff(self, path, site=None):
        started = time.monotonic()
        found = await self.pages.sniff((site or self.a).url(path))
        found["took"] = time.monotonic() - started
        return found


class ThePlayerOfThePage(PageCase):
    warm = True

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
        # Кусочки `.m2ts`, которые тег спросил сам (видом `media`), — не файлы и мест улова не занимают.
        self.assertEqual({stream["type"] for stream in found["streams"]}, {"hls"})


class Drm(PageCase):
    warm = True

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
    warm = True

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
        # Ответ — в срок страницы, с последними вопросами к ней; закрыть вкладку — сверх него.
        self.assertLessEqual(found["seconds"], SECONDS + 0.5)
        self.assertLess(found["took"], SECONDS + TEARDOWN)

    async def test_a_page_that_never_loads_still_ends_at_its_budget(self):
        found = await self.sniff("/pages/hang.html")
        self.assertEqual(found["streams"], [])
        self.assertLessEqual(found["seconds"], SECONDS + 0.5)
        self.assertLess(found["took"], SECONDS + TEARDOWN)

    async def test_a_navigation_the_driver_does_not_answer_still_ends_at_its_budget(self):
        # Ответ драйвера о сроке навигации идёт той же трубой, что и всё, что страница шлёт привязке:
        # страница, которая заваливает её (`signals.html`), задерживала его за срок страницы. Здесь он не
        # приходит вовсе.
        async def unanswered(page, *args, **kwargs):
            await asyncio.sleep(3600)

        # Браузер тёплый: здесь проверяется срок навигации, а не запуска.
        await self.pages._browser_ready()
        with patch.object(page_module.Page, "goto", unanswered):
            async with asyncio.timeout(SECONDS + TEARDOWN):
                found = await self.sniff("/pages/hls.html")
        self.assertEqual(found["streams"], [])
        self.assertLessEqual(found["seconds"], SECONDS + 0.5)
        self.assertLess(found["took"], SECONDS + TEARDOWN)

    async def test_the_tab_and_its_connections_are_gone_after_the_page(self):
        await self.sniff("/pages/hls.html")
        # Ответ отдаётся раньше закрытия вкладки; закрытие — сразу за ним.
        await self.pages.settled()
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
        # Бросить открытую страницу: сайт её уже отдал браузеру. Пауза наугад не годится — холодный запуск
        # Chromium на нагруженном хосте дольше любой паузы. Брошенную посреди запуска — `Launch` ниже.
        opened = len(self.a.seen("/pages/empty.html"))
        task = asyncio.ensure_future(self.pages.sniff(self.a.url("/pages/empty.html")))
        async with asyncio.timeout(LAUNCH + SECONDS):
            while len(self.a.seen("/pages/empty.html")) == opened:
                await asyncio.sleep(0.05)
        self.assertFalse(task.done())
        started = time.monotonic()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertLess(time.monotonic() - started, TEARDOWN)
        self.assertEqual(self.egress._leases, {})
        self.assertEqual(self.pages._browser.contexts, [])


async def given_up_while_starting(phase: str) -> None:
    """
    Процесс-ребёнок `Launch`: холодный `Pages`, страница брошена посреди запуска — пока стартует драйвер
    Playwright (`driver`) или уже Chromium (`browser`), — затем `close()`. Печатает отчёт одной строкой JSON;
    выйти процесс должен сам — `asyncio.run` отменяет и дожидается всех задач цикла.
    """
    site = Site("127.0.0.1")
    egress = Egress(Guard((Allowance(network=LOOPBACK, port=site.port),)), sessions=2, wait=1.0)
    egress.seconds = SECONDS + TEARDOWN
    pages = Pages(egress, seconds=SECONDS, look=LOOK, idle=60.0)
    before = drivers()

    def reached() -> bool:
        if phase == "driver":
            return bool(drivers() - before) and pages._playwright is None
        return pages._playwright is not None and pages._browser is None

    task = asyncio.ensure_future(pages.sniff(site.url("/pages/empty.html")))
    async with asyncio.timeout(LAUNCH):
        while not reached():
            await asyncio.sleep(0.005)
    report: dict[str, object] = {
        "playwright": pages._playwright is not None,
        "browser": pages._browser is not None,
    }
    started = time.monotonic()
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
    report["cancel"] = time.monotonic() - started
    report["leases"] = len(egress._leases)
    started = time.monotonic()
    await pages.close()
    await egress.close()
    report["close"] = time.monotonic() - started
    for _ in range(100):
        if not drivers() - before and not chromium():
            break
        await asyncio.sleep(0.1)
    report["drivers"] = len(drivers() - before)
    report["chromium"] = len(chromium())
    current = asyncio.current_task()
    report["tasks"] = [repr(left.get_coro()) for left in asyncio.all_tasks() if left is not current]
    site.close()
    print(json.dumps(report), flush=True)


class Launch(unittest.TestCase):
    """
    SNIF-2: страница, брошенная посреди холодного запуска браузера (в бою он — после каждого простоя `IDLE`),
    не оставляет ни драйвера Playwright, ни Chromium, и процесс выходит. Отдельным процессом: ничейный
    драйвер вешал цикл событий на выходе навсегда, и в своём процессе тест не покраснел бы, а повис.
    """

    def given_up(self, phase: str) -> dict:
        before = drivers()
        script = f"import asyncio, test_page; asyncio.run(test_page.given_up_while_starting({phase!r}))"
        tests = str(Path(__file__).resolve().parent)
        env = {**os.environ, "PYTHONPATH": os.pathsep.join([os.getcwd(), tests])}
        try:
            done = subprocess.run(
                [sys.executable, "-c", script],
                cwd=os.getcwd(),
                env=env,
                capture_output=True,
                timeout=LAUNCH + 4 * TEARDOWN + 30,
            )
        except subprocess.TimeoutExpired:
            # Ребёнка убил `run`, а его драйвер и браузер остались бы следующим тестам.
            for pid in drivers() - before:
                with contextlib.suppress(OSError):
                    os.kill(pid, signal.SIGKILL)
            kill_browsers()
            self.fail(f"страница брошена посреди запуска ({phase}) — процесс не вышел")
        self.assertEqual(done.returncode, 0, done.stderr.decode(errors="replace")[-2000:])
        return json.loads(done.stdout.decode().strip().splitlines()[-1])

    def assert_clean(self, report: dict) -> None:
        # Брошенную страницу не ждут: место в выходе свободно сразу.
        self.assertLess(report["cancel"], TEARDOWN)
        self.assertEqual(report["leases"], 0)
        # Запуск дошёл до конца и закрыт: ни драйвера, ни браузера, ни задачи, которой ждал бы выход.
        self.assertLess(report["close"], LAUNCH + 2 * TEARDOWN)
        self.assertEqual((report["drivers"], report["chromium"]), (0, 0))
        self.assertEqual(report["tasks"], [])

    def test_a_page_given_up_while_the_driver_starts_leaves_nothing_running(self):
        report = self.given_up("driver")
        self.assertFalse(report["playwright"])
        self.assert_clean(report)

    def test_a_page_given_up_while_chromium_launches_leaves_nothing_running(self):
        report = self.given_up("browser")
        self.assertEqual((report["playwright"], report["browser"]), (True, False))
        self.assert_clean(report)


class TheBrowserItself(PageCase):
    async def test_it_runs_only_through_the_way_out_without_the_keys_and_goes_first_on_oom(self):
        await self.sniff("/pages/empty.html")
        processes = []
        for pid in chromium():
            entry = Path("/proc") / str(pid)
            try:
                arguments = (entry / "cmdline").read_bytes().split(b"\0")
                environ = (entry / "environ").read_bytes()
                score = (entry / "oom_score_adj").read_text().strip()
            except OSError:
                continue
            processes.append((arguments, environ, score))
        # Браузер, зиготы, сеть, рендерер: не один процесс.
        self.assertGreater(len(processes), 2)
        main = next(
            arguments for arguments, _, _ in processes if arguments[0].endswith(b"chrome-headless-shell")
        )
        for flag in (
            f"--proxy-server=http://127.0.0.1:{self.egress.port}".encode(),
            b"--proxy-bypass-list=<-loopback>",
            b"--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
            b"--disable-quic",
            b"--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
            b"--block-new-web-contents",
            # Без JIT: меньше поверхность для эксплойта рендерера, которому песочница не мешает.
            b"--js-flags=--jitless --max-old-space-size=384",
        ):
            self.assertIn(flag, main)
        server = int(Path("/proc/self/oom_score_adj").read_text())
        for arguments, environ, score in processes:
            self.assertNotIn(b"CINEMA_SNIFFER_KEY", environ)
            self.assertNotIn(b"INTERNAL_SECRET", environ)
            # Браузер — 1000 (`chrome.sh`); GPU и рендереры Chromium опускает по своему правилу (200 и 300),
            # но ниже сервера — никого: память первой отнимут у браузера.
            if arguments is main:
                self.assertEqual(score, "1000")
            self.assertGreater(int(score), server)
        self.assertNotIn("CINEMA_SNIFFER_KEY", os.environ)

    def test_killing_finds_only_the_browser(self):
        # Без браузера убивать нечего — и сам процесс теста цел.
        self.assertEqual(kill_browsers(), 0)


class Bounds(PageCase):
    warm = True

    async def test_a_flood_of_playlists_reads_at_most_as_many_bodies_as_streams_are_kept(self):
        reads = []
        original = page_module.Watch._playlist

        async def counted(response):
            reads.append(response.url)
            return await original(response)

        # Ждать после первого плейлиста дольше обычного: пусть придут все двести ответов страницы.
        with (
            patch.object(page_module.Watch, "_playlist", staticmethod(counted)),
            patch.object(page_module, "SETTLE_STREAM", 5.0),
        ):
            found = await self.sniff("/pages/many.html")
        self.assertEqual(len(found["streams"]), STREAMS)
        self.assertLessEqual(len(reads), STREAMS)
        # Один и тот же адрес шестьдесят раз — одно тело, не шестьдесят.
        self.assertLessEqual(sum(1 for url in reads if "same.m3u8" in url), 1)

    async def test_what_the_page_tells_the_binding_is_counted_first_and_kept_short(self):
        found = await self.sniff("/pages/signals.html")
        self.assertLessEqual(len(found["systems"]), SYSTEMS)
        self.assertTrue(all(len(system) <= 64 for system in found["systems"]))


class Wall(PageCase):
    warm = True

    async def test_a_page_that_hangs_its_own_thread_is_answered_within_the_budget(self):
        found = await self.sniff("/pages/busy.html")
        self.assertLessEqual(found["seconds"], SECONDS + 0.5)
        # Вкладку с занятым потоком закрыли — или убили браузер; следующая страница открывается.
        self.assertLess(found["took"], SECONDS + 2 * TEARDOWN + 1)
        again = await self.sniff_again()
        self.assertEqual(again["streams"][0]["type"], "hls")

    async def test_a_browser_that_does_not_close_in_time_is_killed(self):
        await self.sniff("/pages/empty.html")
        await self.pages.settled()
        self.assertTrue(chromium())
        browser = self.pages._browser

        async def stuck():
            await asyncio.sleep(3600)

        with patch.object(browser, "close", stuck), patch.object(page_module, "TEARDOWN", 0.5):
            await page_module._shut(browser)
        for _ in range(40):
            if not chromium():
                break
            await asyncio.sleep(0.1)
        self.assertEqual(chromium(), {})
        self.pages._browser = None
        again = await self.sniff_again()
        self.assertEqual(again["streams"][0]["type"], "hls")

    async def test_every_process_of_a_browser_with_a_stuck_renderer_is_killed(self):
        opened = len(self.a.seen("/pages/busy.html"))
        visit = asyncio.ensure_future(self.pages.sniff(self.a.url("/pages/busy.html")))
        try:
            # Страница заняла свой поток навсегда через секунду после загрузки: рендерер крутится. Ждать, пока
            # сайт её отдал, а не паузу наугад.
            async with asyncio.timeout(SECONDS):
                while len(self.a.seen("/pages/busy.html")) == opened:
                    await asyncio.sleep(0.05)
            await asyncio.sleep(1.5)
            before = chromium()
            self.assertTrue(any(b"--type=renderer" in command for command in before.values()))
            # По первому слову нашёлся бы один браузер: остальные переписали свой заголовок.
            first_word = [
                c for c in before.values() if c.split(b"\0", 1)[0].endswith(b"chrome-headless-shell")
            ]
            self.assertLess(len(first_word), len(before))
            self.assertGreaterEqual(kill_browsers(), len(before))
            for _ in range(40):
                if not chromium():
                    break
                await asyncio.sleep(0.1)
            self.assertEqual(chromium(), {})
        finally:
            with contextlib.suppress(Exception):
                await visit
        await self.pages.settled()
        again = await self.sniff_again()
        self.assertEqual(again["streams"][0]["type"], "hls")


class Answer(PageCase):
    warm = True

    async def test_the_answer_does_not_wait_for_a_tab_that_will_not_close(self):
        async def stuck(context, *args, **kwargs):
            await asyncio.sleep(3600)

        with patch.object(BrowserContext, "close", stuck), patch.object(page_module, "TEARDOWN", 2.0):
            found = await self.sniff("/pages/hls.html")
            self.assertEqual(found["streams"][0]["type"], "hls")
            # Ответ — сразу за страницей; вкладку ещё закрывают, и место в выходе ещё занято.
            self.assertLess(found["took"], found["seconds"] + 1.0)
            self.assertTrue(self.pages._visits)
            self.assertNotEqual(self.egress._leases, {})
            started = time.monotonic()
            await self.pages.settled()
        # Вкладка не закрылась за срок — браузер закрыт (или убит), место в выходе свободно.
        self.assertGreaterEqual(time.monotonic() - started, 1.0)
        self.assertEqual(self.egress._leases, {})
        again = await self.sniff_again()
        self.assertEqual(again["streams"][0]["type"], "hls")


if __name__ == "__main__":
    unittest.main()
