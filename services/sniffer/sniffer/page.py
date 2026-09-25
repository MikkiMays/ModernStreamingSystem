"""
Страница в настоящем браузере: открыть, дать её плееру начать, записать, что он спросил, — и закрыть.

ПОРЯДОК. Страница открывается (до `domcontentloaded`), и мы ждём, пока её плеер спросит поток сам — до
`LOOK` секунд. Не спросил — одно нажатие по самому большому `<video>`, рамке или кнопке «смотреть» (так
начинает человек), и ждём дальше. Поток нашёлся — ещё чуть-чуть (`SETTLE_*`): мастер HLS плеер спрашивает
раньше своих вариантов, а готовый файл бывает рекламой перед фильмом. Всё — за `SECONDS`; после этого
вкладка (контекст браузера со своими cookies) закрывается целиком.

ВЫХОД НАРУЖУ. У каждой страницы — свой вход в охраняемый выход (`Egress.session`: имя входа и пароль
процесса — прокси этого контекста). Кончилась страница — вход убран и все её соединения оборваны, что бы
там ни догружалось. Сам браузер запущен с тем же прокси без входа: всё, что шло бы мимо контекстов, получает
407. Имена браузер не разрешает вовсе (`--host-resolver-rules`), QUIC и WebRTC мимо прокси выключены.

ЧТО СЧИТАЕТСЯ DRM. Скрипт в каждом кадре (и в рамках чужих сайтов) отмечает EME: вопрос о системе ключей
(`requestMediaKeySystemAccess`), ключи на элементе, запрос лицензии и событие `encrypted` (`capture.Catch`).

ПЕСОЧНИЦА CHROMIUM. В контейнере без привилегий (`cap_drop: ALL`, `no-new-privileges`, seccomp Docker)
пространства имён пользователя закрыты (`unshare --user`: «Operation not permitted»), а у headless shell нет
setuid-помощника, — песочница Chromium здесь не поднимается, и Playwright запускает его с `--no-sandbox`.
Держит контейнер: только чтение, свой пользователь, пределы памяти и процессов, ни секрета службы, ни сети
хоста; браузер к тому же первым уходит при нехватке памяти (`chrome.sh`).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from typing import Any, Awaitable
from urllib.parse import urlsplit

from playwright.async_api import Browser, BrowserContext, Page, Playwright, Request, Response
from playwright.async_api import Error as PlaywrightError
from playwright.async_api import async_playwright

from cord_services.cinema.egress import Egress, Lease

from . import capture

logger = logging.getLogger(__name__)

# Весь срок страницы: открыть, подождать, нажать, подождать.
SECONDS = 25.0
# Сколько ждать поток от открытой страницы, прежде чем нажать.
LOOK = 8.0
# Сколько ещё ждать после первого потока: у манифеста — вариантов и cookies кусочков, у файла — не реклама
# ли это перед фильмом, за которой придёт манифест.
SETTLE_STREAM = 1.5
SETTLE_FILE = 3.0
# Сама навигация — не дольше: страница, которая грузится вечно, всё равно успевает запустить плеер.
NAVIGATION = 15.0
# Сколько ждать, пока браузер закроет вкладку или ответит на вопрос о странице; дальше — закрыть весь браузер.
TEARDOWN = 5.0
QUESTION = 2.0
# Браузер без работы столько времени закрывается: он держит сотню-другую мегабайт.
IDLE = 300.0
# Плейлист HLS, у которого смотрим, мастер ли он: мастер — килобайты.
PLAYLIST_BYTES = 256 * 1024
# Сколько раз страница может сказать о своём EME: дальше её не слушаем.
SIGNALS = 200
VIEWPORT = {"width": 1280, "height": 720}
# Обёртка браузера (`chrome.sh`): поднимает ему `oom_score_adj` и запускает headless shell Playwright.
CHROME = "/app/chrome.sh"

ARGS = (
    # Наружу — только через охраняемый выход: QUIC ходит мимо HTTP-прокси, WebRTC — только через прокси,
    # и ни одного имени браузер не разрешает сам (прокси назван адресом).
    "--disable-quic",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
    # Новые окна и вкладки не создаются вовсе: блокировщик окон Playwright выключает сам.
    "--block-new-web-contents",
    # Плеер страницы начинает сам — как у человека, который пришёл смотреть.
    "--autoplay-policy=no-user-gesture-required",
    "--disable-gpu",
    # Куча JS одной вкладки — не больше этого: прожорливая страница падает сама, а не весь контейнер.
    "--js-flags=--max-old-space-size=384",
)
# Окружение браузера — своё и короткое: ключа службы в нём нет.
BROWSER_ENV = {
    "PATH": "/usr/local/bin:/usr/bin:/bin",
    "HOME": "/tmp",
    "XDG_CACHE_HOME": "/tmp/.cache",
    "XDG_CONFIG_HOME": "/tmp/.config",
    "LANG": "C.UTF-8",
}

# Скрипт в каждом кадре, до скриптов страницы: признаки EME — через `__cordSniff`.
HOOKS = """
(() => {
  const say = (signal, detail) => {
    try {
      const report = window.__cordSniff;
      if (typeof report === 'function') report(signal, String(detail || '').slice(0, 64));
    } catch (e) {}
  };
  try {
    const ask = Navigator.prototype.requestMediaKeySystemAccess;
    if (typeof ask === 'function') {
      Navigator.prototype.requestMediaKeySystemAccess = function (system, configs) {
        say('system', system);
        return ask.call(this, system, configs);
      };
    }
  } catch (e) {}
  try {
    const set = HTMLMediaElement.prototype.setMediaKeys;
    if (typeof set === 'function') {
      HTMLMediaElement.prototype.setMediaKeys = function (keys) {
        if (keys) say('keys', '');
        return set.call(this, keys);
      };
    }
  } catch (e) {}
  try {
    const generate = MediaKeySession.prototype.generateRequest;
    if (typeof generate === 'function') {
      MediaKeySession.prototype.generateRequest = function (type, data) {
        say('license', type);
        return generate.call(this, type, data);
      };
    }
  } catch (e) {}
  window.addEventListener('encrypted', (event) => say('encrypted', event.initDataType), true);
})();
"""

# Самое большое, по чему человек нажал бы, чтобы смотреть: `<video>`, рамка плеера, кнопка «смотреть». Если
# это сам `<video>`/`<audio>` страницы — и его номер среди них (`media`): см. `NATIVE`.
TARGET = """
() => {
  const seen = [];
  const consider = (element) => {
    const style = getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return;
    const box = element.getBoundingClientRect();
    if (box.width < 24 || box.height < 24) return;
    seen.push({ element, area: box.width * box.height });
  };
  const play = 'video, iframe, button, [role=button], [aria-label*=play i], [title*=play i], ' +
    '[aria-label*=воспроизв i], [aria-label*=смотреть i], [class*=play-button i], [class*=playbutton i], ' +
    '[class*=play-btn i], [class*=btn-play i], [class*=big-play i]';
  document.querySelectorAll(play).forEach(consider);
  if (!seen.length) return null;
  seen.sort((a, b) => b.area - a.area);
  const best = seen[0].element;
  best.scrollIntoView({ block: 'center', inline: 'center' });
  const box = best.getBoundingClientRect();
  const media = [...document.querySelectorAll('video, audio')].indexOf(best);
  return { x: box.left + box.width / 2, y: box.top + box.height / 2, media };
}
"""
# Нажатие по самому `<video controls>`: в настольном Chrome оно включает видео, а у headless shell своих
# кнопок на кадре нет, и нажатие ничего не делает. Поэтому то же нажатие доходит до элемента и его
# собственной кнопкой «играть» — `play()` этого же элемента, если он всё ещё стоит.
NATIVE = """
(index) => {
  const media = document.querySelectorAll('video, audio')[index];
  if (!media || !media.paused) return false;
  const started = media.play();
  if (started && started.catch) started.catch(() => null);
  return true;
}
"""

# Что видно на самой странице: имя, постер и поле пароля.
FACTS = """
() => {
  const meta = (selector) => (document.querySelector(selector) || {}).content || '';
  const absolute = (value) => {
    try { return value ? new URL(value, document.baseURI).href : ''; } catch (e) { return ''; }
  };
  const image = meta('meta[property="og:image"]') || meta('meta[name="twitter:image"]') ||
    ((document.querySelector('link[rel="image_src"]') || {}).href || '');
  const password = [...document.querySelectorAll('input[type=password]')]
    .some((input) => input.offsetWidth > 0 && input.offsetHeight > 0);
  const title = meta('meta[property="og:title"]') || document.title || '';
  return { title, poster: absolute(image), password };
}
"""

# Что играет в кадре: адрес и площадь каждого `<video>`/`<audio>` — самый большой первым.
PLAYING = """
() => [...document.querySelectorAll('video, audio')].map((media) => ({
  src: media.currentSrc || media.src || '',
  area: media.clientWidth * media.clientHeight,
  duration: Number.isFinite(media.duration) ? media.duration : null,
}))
"""


class Pages:
    """
    Один Chromium на процесс (запускается к первой странице, закрывается после `IDLE` без работы) и свой
    контекст на каждую страницу. Сколько страниц разом, решает выход (`Egress.sessions`): место ждётся не
    дольше `Egress.wait`, потом `Busy`.
    """

    def __init__(
        self,
        egress: Egress,
        *,
        seconds: float = SECONDS,
        look: float = LOOK,
        idle: float = IDLE,
        executable: str | None = CHROME,
    ):
        self.egress = egress
        self.seconds = seconds
        self.look = look
        self.idle = idle
        self.executable = executable
        self._playwright: Playwright | None = None
        self._browser: Browser | None = None
        self._launching = asyncio.Lock()
        self._active = 0
        self._resting: asyncio.Task[None] | None = None

    async def sniff(self, url: str) -> dict[str, Any]:
        """Что на странице: потоки с заголовками, cookies по хостам, признаки DRM, капчи и входа."""
        started = time.monotonic()
        async with self.egress.session(self.seconds + TEARDOWN) as lease:
            self._active += 1
            if self._resting is not None:
                self._resting.cancel()
                self._resting = None
            try:
                browser = await self._browser_ready()
                context = await browser.new_context(
                    proxy={
                        "server": f"http://127.0.0.1:{self.egress.port}",
                        "username": lease.id,
                        "password": self.egress.secret,
                    },
                    viewport=VIEWPORT,
                    locale="ru-RU",
                    service_workers="block",
                    accept_downloads=False,
                )
                try:
                    return await Watch(context, lease, url, started, self).run()
                finally:
                    await self._dispose(context)
            finally:
                self._active -= 1
                if not self._active:
                    self._resting = asyncio.ensure_future(self._rest())

    async def close(self) -> None:
        if self._resting is not None:
            self._resting.cancel()
        browser, self._browser = self._browser, None
        if browser is not None:
            with contextlib.suppress(Exception):
                async with asyncio.timeout(TEARDOWN):
                    await browser.close()
        playwright, self._playwright = self._playwright, None
        if playwright is not None:
            with contextlib.suppress(Exception):
                await playwright.stop()

    async def _browser_ready(self) -> Browser:
        async with self._launching:
            if self._browser is not None and self._browser.is_connected():
                return self._browser
            if self._playwright is None:
                self._playwright = await async_playwright().start()
            await self.egress.start()
            # Прокси браузера — тот же выход, но без входа: всё, что пошло бы мимо контекста страницы,
            # получает 407.
            self._browser = await self._playwright.chromium.launch(
                executable_path=self.executable,
                args=list(ARGS),
                proxy={"server": f"http://127.0.0.1:{self.egress.port}"},
                env=BROWSER_ENV,
                timeout=30_000,
            )
            return self._browser

    async def _dispose(self, context: BrowserContext) -> None:
        """Вкладка закрывается целиком; не закрылась вовремя — закрывается весь браузер."""
        try:
            async with asyncio.timeout(TEARDOWN):
                await context.close()
        except Exception:
            logger.warning("плеер страниц: вкладка не закрылась вовремя — браузер перезапускается")
            browser, self._browser = self._browser, None
            if browser is not None:
                with contextlib.suppress(Exception):
                    async with asyncio.timeout(TEARDOWN):
                        await browser.close()

    async def _rest(self) -> None:
        await asyncio.sleep(self.idle)
        if self._active:
            return
        browser, self._browser = self._browser, None
        if browser is not None:
            with contextlib.suppress(Exception):
                async with asyncio.timeout(TEARDOWN):
                    await browser.close()


class Watch:
    """Одна страница: что она спросила, пока мы на неё смотрели."""

    def __init__(self, context: BrowserContext, lease: Lease, url: str, started: float, pages: Pages):
        self.context = context
        self.lease = lease
        self.url = url
        self.started = started
        self.deadline = started + pages.seconds
        self.look = pages.look
        self.catch = capture.Catch()
        self.changed = asyncio.Event()
        self.tasks: set[asyncio.Task[Any]] = set()
        self.signals = 0
        # Когда пришёл первый манифест и первый файл — от них считается, сколько ещё ждать.
        self.first_manifest: float | None = None
        self.first_file: float | None = None
        self.clicked = False
        self.crashed = False
        self.page: Page | None = None

    async def run(self) -> dict[str, Any]:
        context = self.context
        context.on("response", lambda response: self._spawn(self._response(response)))
        context.on("request", self._request)
        await context.expose_binding("__cordSniff", self._signal)
        await context.add_init_script(HOOKS)
        page = self.page = await context.new_page()
        # Любая другая вкладка (окно, которое всё же родилось) закрывается сразу. Слушать — только после
        # своей: о ней браузер говорит тем же событием.
        context.on("page", lambda extra: extra is not page and self._spawn(self._close_extra(extra)))
        page.on("crash", lambda _: self._crash())
        status: int | None = None
        failed = False
        try:
            response = await page.goto(
                self.url, wait_until="domcontentloaded", timeout=self._ms(min(NAVIGATION, self._left()))
            )
            status = response.status if response is not None else None
        except PlaywrightError:
            # Текст ошибки не пишется: в нём адрес страницы, а в адресе бывают ключи.
            failed = True
        await self._wait(min(self.deadline, time.monotonic() + self.look))
        if not self.catch.streams and not self.catch.used and not self.crashed and self._left() > 1:
            self.clicked = await self._click(page)
            await self._wait(self.deadline)
        await self._drain()
        facts = await self._facts(page)
        playing = await self._playing(page)
        return self._answer(status, failed, facts, playing)

    # --- что говорит браузер -------------------------------------------------------------

    def _spawn(self, work: Awaitable[Any]) -> None:
        task = asyncio.ensure_future(work)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    def _request(self, request: Request) -> None:
        """После нашего нажатия главная страница ушла на другой документ — её потоки уже не те."""
        if not self.clicked or self.page is None:
            return
        with contextlib.suppress(PlaywrightError):
            if request.is_navigation_request() and request.frame == self.page.main_frame:
                self.catch.closed = True
                self.changed.set()

    async def _response(self, response: Response) -> None:
        order = self.catch.ticket()
        try:
            request = response.request
            url = request.url
            kind_header = response.headers.get("content-type")
            request_kind = request.resource_type
            kind = capture.kind_of(url, kind_header, request_kind)
            if kind is None and not capture.streamish(url, kind_header, request_kind):
                return
            if not 200 <= response.status < 300 or not capture.web(url):
                return
            headers = await request.all_headers()
            self.catch.cookie(url, headers.get("cookie"))
            if kind is None:
                return
            master: bool | None = None
            heights: tuple[int, ...] = ()
            if kind == "hls":
                master, heights = await self._playlist(response)
            ext = capture.file_extension(url, kind_header) if kind == "file" else ""
            fresh = self.catch.stream(
                url,
                kind,
                headers,
                order=order,
                frame=_frame_url(request),
                master=master,
                heights=heights,
                ext=ext,
            )
            if fresh:
                now = time.monotonic()
                if kind == "file":
                    self.first_file = self.first_file or now
                else:
                    self.first_manifest = self.first_manifest or now
                self.changed.set()
        except PlaywrightError:
            # Вкладку закрыли, пока мы читали ответ, — это не поток.
            return

    @staticmethod
    async def _playlist(response: Response) -> tuple[bool | None, tuple[int, ...]]:
        """Мастер ли это и его ступени — только у маленького плейлиста с объявленной длиной."""
        length = response.headers.get("content-length", "")
        if not length.isdigit() or int(length) > PLAYLIST_BYTES:
            return None, ()
        try:
            async with asyncio.timeout(QUESTION):
                body = await response.body()
        except (PlaywrightError, TimeoutError):
            return None, ()
        return capture.playlist_facts(body[:PLAYLIST_BYTES].decode("utf-8", errors="replace"))

    def _signal(self, source: Any, signal: Any = "", detail: Any = "") -> None:
        """Признак EME из скрипта кадра (`HOOKS`). Страница может звать это сама — ей же хуже."""
        self.signals += 1
        if self.signals > SIGNALS:
            return
        before = self.catch.used
        self.catch.eme(str(signal), str(detail))
        if self.catch.used and not before:
            self.changed.set()

    def _crash(self) -> None:
        self.crashed = True
        self.changed.set()

    @staticmethod
    async def _close_extra(extra: Page) -> None:
        with contextlib.suppress(Exception):
            await extra.close()

    # --- ожидание и нажатие -----------------------------------------------------------------

    def _left(self) -> float:
        return self.deadline - time.monotonic()

    @staticmethod
    def _ms(seconds: float) -> float:
        return max(1.0, seconds) * 1000

    async def _wait(self, until: float) -> None:
        """
        До `until` — или раньше: поток пойман и прошло время `SETTLE_*`, EME в деле, вкладка упала или
        после нажатия ушла на другой документ (там уже не то видео, что вставили).
        """
        while True:
            if self.catch.used or self.crashed or self.catch.closed:
                return
            limit = until
            if self.first_manifest is not None:
                limit = min(limit, self.first_manifest + SETTLE_STREAM)
            elif self.first_file is not None:
                limit = min(limit, self.first_file + SETTLE_FILE)
            left = limit - time.monotonic()
            if left <= 0:
                return
            self.changed.clear()
            with contextlib.suppress(TimeoutError):
                async with asyncio.timeout(left):
                    await self.changed.wait()

    async def _click(self, page: Page) -> bool:
        """
        Одно нажатие — по центру самого большого `<video>`, рамки или кнопки «смотреть». По самому `<video>` —
        ещё и его кнопкой «играть» (`NATIVE`), если нажатие по кадру его не включило.
        """
        clicked = False
        try:
            async with asyncio.timeout(QUESTION):
                point = await page.evaluate(TARGET)
            if not point:
                return False
            async with asyncio.timeout(QUESTION):
                await page.mouse.click(float(point["x"]), float(point["y"]))
            clicked = True
            media = int(point.get("media", -1))
            if media >= 0:
                await asyncio.sleep(0.3)
                async with asyncio.timeout(QUESTION):
                    await page.evaluate(NATIVE, media)
        except (PlaywrightError, TimeoutError, KeyError, TypeError, ValueError):
            return clicked
        return True

    async def _drain(self) -> None:
        """Ответы, которые ещё читаются, — дочитать коротко: срок страницы уже вышел."""
        if not self.tasks:
            return
        with contextlib.suppress(TimeoutError):
            async with asyncio.timeout(QUESTION):
                await asyncio.gather(*list(self.tasks), return_exceptions=True)

    # --- ответ службе --------------------------------------------------------------------

    async def _facts(self, page: Page) -> dict[str, Any]:
        try:
            async with asyncio.timeout(QUESTION):
                found = await page.evaluate(FACTS)
        except (PlaywrightError, TimeoutError):
            return {}
        return found if isinstance(found, dict) else {}

    async def _playing(self, page: Page) -> list[dict[str, Any]]:
        """Что играет во всех кадрах страницы, и в рамках чужих сайтов, — самое большое первым."""
        found: list[dict[str, Any]] = []
        for frame in page.frames[:16]:
            try:
                async with asyncio.timeout(QUESTION):
                    media = await frame.evaluate(PLAYING)
            except (PlaywrightError, TimeoutError):
                continue
            if isinstance(media, list):
                found.extend(item for item in media[:16] if isinstance(item, dict))
        return sorted(found, key=lambda item: -float(item.get("area") or 0))

    def _frames(self) -> list[str]:
        if self.page is None:
            return []
        with contextlib.suppress(PlaywrightError):
            return [frame.url for frame in self.page.frames[:32]]
        return []

    def _answer(
        self, status: int | None, failed: bool, facts: dict[str, Any], playing: list[dict[str, Any]]
    ) -> dict[str, Any]:
        page = self.page.url if self.page is not None else ""
        page = page if capture.web(page) else self.url
        title = capture.title_of(facts.get("title"))
        poster = str(facts.get("poster") or "")
        shown = [str(item.get("src") or "") for item in playing]
        streams = self.catch.ranked(shown)
        durations = [
            float(item["duration"])
            for item in playing
            if isinstance(item.get("duration"), (int, float)) and 0 < float(item["duration"]) < 7 * 86400
        ]
        return {
            "page": page,
            "status": status,
            "title": title,
            "poster": poster if capture.web(poster) else None,
            "duration": durations[0] if durations else None,
            "drm": self.catch.drm(),
            "systems": list(self.catch.systems),
            "robot": capture.challenged(page, title, self._frames()),
            "login": capture.login_wall(page, bool(facts.get("password"))),
            # Саму страницу выход не открыл: она или её переадресация ведёт внутрь сети или на закрытый порт.
            "inside": _authority(page) in self.lease.blocked,
            "unreachable": failed and not self.lease.blocked and self.lease.failed is not None,
            "clicked": self.clicked,
            "seconds": round(time.monotonic() - self.started, 1),
            "streams": [stream.wire() for stream in streams],
            "cookies": dict(self.catch.cookies),
        }


def _frame_url(request: Request) -> str:
    """Адрес кадра, который спросил поток; у навигации кадра ещё нет — тогда пусто."""
    try:
        url = request.frame.url
    except PlaywrightError:
        return ""
    return url if capture.web(url) else ""


def _authority(url: str) -> tuple[str, int]:
    """Хост и порт адреса — так, как их запоминает выход (`Lease.blocked`)."""
    parts = urlsplit(url)
    try:
        port = parts.port or (443 if parts.scheme == "https" else 80)
    except ValueError:
        port = 0
    return (parts.hostname or "").lower(), port
