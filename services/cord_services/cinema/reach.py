"""
Достаёт ли сервер до площадки: автомат защиты на каждую площадку кинозала (R112).

ЗАЧЕМ. Сервер в дата-центре, откуда площадка не видна (московский сервер не достаёт до YouTube),
отвечал на поиск бесконечным «Спрашиваем площадку…»: yt-dlp ждёт каждое чтение по 20 с и сам
повторяет запрос, и один поиск через «чёрную дыру» держал поток пула 160 с (замер 24.10). Здесь
сервер узнаёт, что площадка отсюда не видна, и отвечает сразу словами — «YouTube недоступен с
этого сервера», — не трогая ни yt-dlp, ни пул потоков.

ТРИ СОСТОЯНИЯ, как у автомата в щитке:
- `closed` — площадка отвечает, запросы идут к ней как обычно;
- `open` — площадка признана недоступной: запрос получает отказ сразу (503 `CINEMA_UNREACHABLE`);
- `half_open` — пора проверить, вернулась ли она: один запрос идёт к площадке пробным, остальные
  пока получают тот же отказ. Пробный ответил — `closed`; нет — снова `open`, и следующая проверка
  позже (`RECHECK`).

ОТКУДА ЗНАНИЕ. Пассивно — из настоящих запросов: `FAILURES` сетевых сбоев или выходов за срок
подряд открывают автомат. Активно — дешёвой пробой (`Provider.probe`: адрес, который площадка
отдаёт почти пустым) фоном (`watch`): раз в `PROBE_EVERY`, пока площадка отвечает, и по `RECHECK`,
пока нет. Любой ответ пробы — «достаёт», ни одного за `PROBE_TIMEOUT` — «не достаёт»; открывают
автомат `PROBE_MISSES` таких проб подряд (вторая — через `PROBE_AGAIN`), а не одна. Автомат,
открытый пробой, закрывает проба; открытый запросами — только пробный запрос: проба лишь
проверяет, есть ли куда его посылать (маленький ответ проходит и там, где большие вязнут).

ТЕМ ЖЕ ПУТЁМ, ЧТО И ЗАПРОСЫ. Проба идёт клиентом самой площадки (`Net.client_for`): через её прокси
(`CINEMA_PROXY_<ID>` или общий `CINEMA_PROXY`) и под её защитой — тем же выходом, каким ходят её
каталог и её yt-dlp (`YtDlp.run` берёт тот же `proxy_for`). Проба мимо прокси врала бы: сервер с
прокси для YouTube видел бы его недоступным, а без прокси — доступным через чужую сеть.

Площадка «По ссылке» (`public_any`) здесь не считается: её сайты чужие и каждый раз другие, и
«недоступен» у одного ничего не говорит о следующем; у её разбора свой срок
(`facade.LINK_RESOLVE_SECONDS`).

МУЗЫКА — ТЕМ ЖЕ СЧЁТОМ. Поиск и треки YouTube у музыки (`sources.py`) идут тем же выходом и тем же
yt-dlp: они спрашивают тот же автомат и пишут в тот же счёт, а отказывают своими словами (`Words`).

В журнал идёт одна строка на смену состояния — какая площадка и почему, без адресов людей и
запросов.
"""

from __future__ import annotations

import asyncio
import errno
import logging
import math
import socket
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Iterable, TypeVar

import httpx

from ..webapp import Refusal

if TYPE_CHECKING:
    from .registry import Provider

logger = logging.getLogger(__name__)

T = TypeVar("T")

CLOSED, OPEN, HALF_OPEN = "closed", "open", "half_open"
# Чем открыт автомат: проба не дошла — или настоящие запросы подряд остались без ответа.
BY_PROBE, BY_TRAFFIC = "probe", "traffic"
# Чем кончился настоящий запрос к площадке: ответила; сети нет (сбой соединения или вышел срок);
# ни то ни другое (отказ ещё до сети, отмена, отказ площадки словами) — такой исход счёт не меняет.
OK, FAIL, NEUTRAL = "ok", "fail", "neutral"

# Сколько сетевых сбоев подряд открывают автомат. Один — это мигнувшая сеть, три подряд без единого
# ответа между ними — уже нет. Каждый выход за срок — один сбой: три поиска по 25 с, и площадка
# признана недоступной.
FAILURES = 3
# Сколько ждать ответ пробы. Из Франкфурта проба отвечает за 0,05–0,4 с (замер 24.10: YouTube
# `generate_204` 0,05 с, ivi 0,36–0,65 с, все пять разом при старте — до 0,6 с), из Москвы Rutube и VK
# целиком отвечают на поиск за 0,6–2,3 с; 2,5 с — с запасом и на прокси.
PROBE_TIMEOUT = 2.5
# Сколько проб подряд без ответа признают площадку недоступной, и через сколько после первой спросить
# вторую. Одна проба врёт: при живой проверке 24.10 одна из пяти стартовых проб (ivi) не дошла за срок,
# а следующая — за 0,4 с. Две подряд с паузой — уже не мигнувшая сеть, и Москва узнаёт свою
# недоступность YouTube через секунды после старта, а не через минуты.
PROBE_MISSES = 2
PROBE_AGAIN = 5.0
# Как часто проба спрашивает отвечающую площадку: одна пустая страница в пять минут площадку не
# нагружает, а пропажу посреди дня заметит и без запросов людей.
PROBE_EVERY = 300.0
# Когда проверить недоступную снова: через 30 с, минуту, две, четыре — и дальше каждые пять минут.
# Вернулась — узнаем быстро; лежит сутками — спрашиваем её реже.
RECHECK = (30.0, 60.0, 120.0, 240.0)
# «Повторить» у недоступной площадки спрашивает пробу сразу, но не чаще раза в полминуты: кнопку
# можно нажимать сколько угодно, а площадке от этого ничего не прибавится.
RETRY_PROBE_GAP = 30.0
# Как часто фоновая проверка смотрит, кого пора спросить.
WATCH_TICK = 5.0
# Backpressure (W1b шаг 6, docs/research §2.7 «Semaphore»): сколько вопросов к площадкам идёт разом
# от одной комнаты и от сервера целиком. Больше — отказ сразу (`429 PLATFORM_BUSY`, `Retry-After`),
# а не очередь без конца: пока yt-dlp и прокси площадок заняты, новый вопрос только удлинит ожидание
# всем. Два на комнату — поиск и разбор ролика одновременно; восемь на сервер — потоки yt-dlp (6) с
# запасом на быстрые вопросы каталога.
ROOM_LANES = 2
SERVER_LANES = 8
BUSY_RETRY_AFTER = 2

# Ошибки сокета, которые значат «сети до площадки нет», а не «площадка ответила отказом».
NET_ERRNOS = frozenset(
    {
        errno.ENETUNREACH,
        errno.EHOSTUNREACH,
        errno.ETIMEDOUT,
        errno.ECONNREFUSED,
        errno.ECONNRESET,
        errno.ECONNABORTED,
        errno.ENETDOWN,
        errno.EPIPE,
    }
)


def unreachable(provider: str, name: str, wait: float = RECHECK[0]) -> Refusal:
    """Отказ сразу: площадка отсюда недоступна. `provider` — чтобы клиент назвал её на своём языке."""
    return Refusal(
        503,
        "CINEMA_UNREACHABLE",
        name + " недоступен с этого сервера",
        headers={"Retry-After": str(max(1, math.ceil(wait)))},
        extra={"provider": provider},
    )


def late(provider: str, name: str) -> Refusal:
    """Отказ по сроку: площадка не ответила за `facade.CATALOG_DEADLINE` (или `RESOLVE_DEADLINE`)."""
    return Refusal(
        504,
        "CINEMA_TIMEOUT",
        name + " не ответил вовремя — попробуйте ещё раз",
        extra={"provider": provider},
    )


def busy() -> Refusal:
    """Отказ сразу: все полосы к площадкам заняты другими вопросами (`Lanes`)."""
    return Refusal(
        429,
        "PLATFORM_BUSY",
        "Площадки заняты другими запросами — повторите через пару секунд",
        headers={"Retry-After": str(BUSY_RETRY_AFTER)},
    )


class Lanes:
    """
    Полосы к площадкам: не больше `ROOM_LANES` вопросов разом от комнаты и `SERVER_LANES` от сервера.

    Это не очередь: кому полосы не хватило, отвечают сразу, и клиент повторит сам через `Retry-After`.
    Комната — ключ счёта, а не метка метрики: в `/metrics` уходит только число отказов.
    """

    def __init__(self, per_room: int = ROOM_LANES, per_server: int = SERVER_LANES):
        self.per_room, self.per_server = per_room, per_server
        self.rooms: dict[str, int] = {}
        self.busy = 0
        self.refused = 0

    def take(self, room: str | None) -> None:
        if self.busy >= self.per_server or (room and self.rooms.get(room, 0) >= self.per_room):
            self.refused += 1
            raise busy()
        self.busy += 1
        if room:
            self.rooms[room] = self.rooms.get(room, 0) + 1

    def release(self, room: str | None) -> None:
        self.busy -= 1
        if room:
            left = self.rooms.get(room, 0) - 1
            if left > 0:
                self.rooms[room] = left
            else:
                self.rooms.pop(room, None)


@dataclass(frozen=True)
class Words:
    """
    Чьими словами отказать. Автомат у площадки один, а спрашивают её двое: кинозал и музыка
    (`sources.py`: поиск и треки YouTube идут той же сетью и тем же yt-dlp). Сбои и сроки обоих
    считаются в один счёт — кто первым узнал, что площадка отсюда не видна, тот и закрыл её для
    другого, — но отказ каждый называет своим кодом: у музыки свой (`MUSIC_UNREACHABLE`).
    """

    unreachable: Callable[[str, str, float], Refusal]
    late: Callable[[str, str], Refusal]


CINEMA = Words(unreachable, late)


def network(error: BaseException) -> bool:
    """
    Сетевой ли это сбой: до площадки не дошли (соединение, срок, обрыв, имя), а не она ответила отказом.

    Площадки переводят сбой в свои слова (`HTTPException(502, …) from None`), но исходная ошибка
    остаётся в `__context__`; yt-dlp заворачивает её в `DownloadError` → `ExtractorError` (`exc_info`,
    `cause`) → свой `TransportError`. Поэтому смотрится вся цепочка, а не одно верхнее исключение.
    """
    seen: set[int] = set()
    pending: list[Any] = [error]
    while pending:
        found = pending.pop()
        if not isinstance(found, BaseException) or id(found) in seen:
            continue
        seen.add(id(found))
        if isinstance(found, httpx.TransportError):
            # Неверный адрес или запрос — ошибка наша, а не сети.
            if not isinstance(found, (httpx.UnsupportedProtocol, httpx.LocalProtocolError)):
                return True
        elif isinstance(found, (TimeoutError, ConnectionError, socket.gaierror)):
            return True
        elif isinstance(found, OSError) and found.errno in NET_ERRNOS:
            return True
        elif _ytdlp_transport(found):
            return True
        info = getattr(found, "exc_info", None)
        pending.extend(
            [
                found.__cause__,
                found.__context__,
                getattr(found, "cause", None),
                info[1] if isinstance(info, tuple) and len(info) > 1 else None,
            ]
        )
    return False


def _ytdlp_transport(error: BaseException) -> bool:
    """`yt_dlp.networking.exceptions.TransportError` и наследники — без импорта самого yt-dlp (он тяжёлый)."""
    kind = type(error)
    return kind.__module__.startswith("yt_dlp.networking") and any(
        base.__name__ == "TransportError" for base in kind.__mro__
    )


@dataclass
class Gauge:
    """Автомат одной площадки и его счётчики для `/metrics`."""

    id: str
    name: str
    state: str = CLOSED
    cause: str = ""
    # Сетевых сбоев подряд.
    failures: int = 0
    # Сколько проверок подряд площадка не прошла: номер шага в `RECHECK`.
    misses: int = 0
    # Сколько проб подряд не дошли, пока автомат закрыт (`PROBE_MISSES`).
    probe_misses: int = 0
    # Когда пора проверить открытый автомат (по `clock`).
    retry_at: float = 0.0
    # Когда кончилась последняя проба; `None` — ещё ни одной.
    probed_at: float | None = None
    changes: dict[str, int] = field(default_factory=lambda: {OPEN: 0, CLOSED: 0})
    refused: int = 0
    deadlines: int = 0


class Reach:
    """
    Автоматы всех площадок кинозала. Живёт в цикле событий: все решения и счёт — в нём, не в потоках.

    `client_for` — клиент площадки (`Net.client_for`): им идёт проба, а значит — её прокси и её защитой.
    """

    def __init__(
        self,
        client_for: Callable[[str], httpx.AsyncClient],
        *,
        clock: Callable[[], float] = time.monotonic,
    ):
        self._client_for = client_for
        self.clock = clock
        self._gauges: dict[str, Gauge] = {}
        self._probes: dict[str, asyncio.Future[bool | None]] = {}
        self.lanes = Lanes()

    @staticmethod
    def tracked(source: Provider) -> bool:
        """Своя ли это площадка с известными хостами (не «По ссылке»): только у таких есть автомат."""
        return not source.hosts.public_any

    def gauge(self, source: Provider) -> Gauge:
        found = self._gauges.get(source.id)
        if found is None:
            found = self._gauges[source.id] = Gauge(source.id, source.name)
        return found

    # --- что сказать о площадке ------------------------------------------------------------

    def down(self, source: Provider) -> str | None:
        """
        Почему площадка сейчас недоступна — или `None`, если к ней можно идти (`GET providers`).

        Открытый запросами автомат, которому пора проверки, показывается доступным: карточка в
        каталоге загорается, и следующий запрос человека станет пробным. Иначе площадку, у которой
        проба проходит, а запросы — нет, никто никогда не спросил бы снова.
        """
        if not self.tracked(source):
            return None
        state = self.gauge(source)
        if state.state == CLOSED:
            return None
        if state.state == OPEN and state.cause == BY_TRAFFIC and self.clock() >= state.retry_at:
            return None
        return unreachable(source.id, source.name).detail

    async def refresh(self, source: Provider) -> None:
        """
        Перед ответом `GET providers`: площадку, закрытую пробой, спросить снова, если с прошлой пробы
        прошло полминуты. Так «Повторить» в каталоге (он спрашивает список площадок заново) узнаёт
        правду сейчас, а не через минуты фоновой проверки, — и не чаще раза в `RETRY_PROBE_GAP`.
        """
        if not self.tracked(source) or not source.probe:
            return
        state = self.gauge(source)
        last = state.probed_at
        stale = last is None or self.clock() - last >= RETRY_PROBE_GAP
        if state.state == OPEN and state.cause == BY_PROBE and stale:
            await self.probe(source)

    def refuse_if_down(self, source: Provider, words: Words = CINEMA) -> None:
        """Отказ сразу, если площадка недоступна (`link`: ссылка на неё не открывает её сцену зря)."""
        if self.down(source) is not None:
            self._refuse(self.gauge(source), words)

    # --- запрос к площадке ---------------------------------------------------------------

    async def call(
        self,
        source: Provider,
        work: Callable[[], Awaitable[T]],
        deadline: float | None,
        words: Words = CINEMA,
        room: str | None = None,
    ) -> T:
        """
        Настоящий запрос к площадке: через автомат, по свободной полосе и под жёстким сроком.

        Вышел срок — отказ `late` словами (504), а не 500 и не вечное ожидание; работа в потоке yt-dlp
        при этом не останавливается (потоки не прерываются), но её место в пуле ограничено
        (`YtDlp.offload_for`). `deadline=None` — срок у работы свой (скачивание трека музыки сам
        обрывает себя по времени): автомат тогда только считает исход. `room` — чья полоса занята
        (`Lanes`): без комнаты считается только общая.
        """
        state = await self.admit(source, words)
        self.lanes.take(room)
        try:
            scope = asyncio.timeout(deadline)
            try:
                async with scope:
                    result = await work()
            except TimeoutError as error:
                if not scope.expired():
                    self.record(state, FAIL if network(error) else NEUTRAL)
                    raise
                state.deadlines += 1
                self.record(state, FAIL)
                raise words.late(source.id, source.name) from None
            except asyncio.CancelledError:
                self.record(state, NEUTRAL)
                raise
            except Exception as error:
                self.record(state, FAIL if network(error) else NEUTRAL)
                raise
        finally:
            self.lanes.release(room)
        self.record(state, OK)
        return result

    async def admit(self, source: Provider, words: Words = CINEMA) -> Gauge:
        """Пускать ли запрос к площадке. Нет — отказ `unreachable` сразу, до yt-dlp и пула потоков."""
        state = self.gauge(source)
        if state.state == CLOSED:
            return state
        if state.state == HALF_OPEN:
            # Пробный запрос уже идёт: остальным ждать его исхода незачем.
            self._refuse(state, words)
        if state.cause == BY_PROBE:
            # Площадка закрыта пробой — её же и спросить, если с прошлой прошло полминуты («Повторить»).
            last = state.probed_at
            if source.probe and (last is None or self.clock() - last >= RETRY_PROBE_GAP):
                await self.probe(source)
            if state.state == CLOSED:
                return state
            self._refuse(state, words)
        # Открыт запросами.
        if self.clock() < state.retry_at:
            self._refuse(state, words)
        if source.probe:
            await self.probe(source)
            if state.state == CLOSED:
                return state
            # Пробный уже ушёл (тот, кто ждал ту же пробу раньше) — или проба не дошла.
            if state.state != OPEN or state.cause != BY_TRAFFIC:
                self._refuse(state, words)
        state.state = HALF_OPEN
        return state

    def record(self, state: Gauge, outcome: str) -> None:
        """Исход настоящего запроса: ответ закрывает автомат, сбои подряд — открывают."""
        if outcome == OK:
            state.failures = 0
            if state.state != CLOSED:
                self._close(state)
            return
        if outcome == FAIL:
            state.failures += 1
            if state.state == HALF_OPEN or (state.state == CLOSED and state.failures >= FAILURES):
                self._open(state, BY_TRAFFIC)
            return
        if state.state == HALF_OPEN:
            # Пробный ничего не показал (отказ до сети, отмена): следующий запрос снова пробный.
            state.state = OPEN
            state.retry_at = self.clock()

    def _refuse(self, state: Gauge, words: Words = CINEMA) -> None:
        state.refused += 1
        raise words.unreachable(state.id, state.name, state.retry_at - self.clock())

    # --- проба ----------------------------------------------------------------------------

    async def probe(self, source: Provider) -> bool | None:
        """
        Дешёвая проба площадки: одна на площадку разом (кто спросил, пока она идёт, ждёт её же).

        `True` — площадка ответила (любым кодом), `False` — сети до неё нет, `None` — проба сама упала
        не сетью: тогда состояние не меняется.
        """
        if not source.probe:
            return None
        flight = self._probes.get(source.id)
        if flight is None:
            flight = asyncio.ensure_future(self._probe(source))
            self._probes[source.id] = flight
            flight.add_done_callback(lambda done, key=source.id: self._landed(key, done))
        return await asyncio.shield(flight)

    def _landed(self, key: str, flight: asyncio.Future[bool | None]) -> None:
        if self._probes.get(key) is flight:
            del self._probes[key]
        if not flight.cancelled():
            flight.exception()

    async def _probe(self, source: Provider) -> bool | None:
        state = self.gauge(source)
        # Клиент — до срока: первый клиент площадки собирается дольше самой пробы (свой TLS и пул).
        client = self._client_for(source.id)
        headers = {"Accept-Encoding": "identity"}
        try:
            async with asyncio.timeout(PROBE_TIMEOUT):
                async with client.stream("GET", source.probe, headers=headers, follow_redirects=False):
                    pass
            ok = True
        except (TimeoutError, httpx.TransportError, OSError):
            ok = False
        except Exception as error:
            # Текст исключения в журнал не идёт: в нём бывают адреса с ключами доступа.
            logger.warning("кинозал: проба площадки %s упала: %s", source.id, type(error).__name__)
            return None
        state.probed_at = self.clock()
        self._probed(state, ok)
        return ok

    def _probed(self, state: Gauge, ok: bool) -> None:
        if ok:
            state.probe_misses = 0
            if state.state == OPEN and state.cause == BY_PROBE:
                self._close(state)
            return
        if state.state == CLOSED:
            state.probe_misses += 1
            if state.probe_misses >= PROBE_MISSES:
                self._open(state, BY_PROBE)
        elif state.state == OPEN:
            state.cause = BY_PROBE
            self._next_check(state)

    # --- фоновая проверка ------------------------------------------------------------------

    def due(self, source: Provider) -> bool:
        """Пора ли пробе спросить площадку."""
        if not source.probe or not self.tracked(source):
            return False
        state = self.gauge(source)
        if state.probed_at is None:
            return True
        now = self.clock()
        if state.state == CLOSED:
            # Одна проба не дошла — вторая через несколько секунд, а не через пять минут.
            return now - state.probed_at >= (PROBE_AGAIN if state.probe_misses else PROBE_EVERY)
        if state.state == OPEN:
            # После срока — один раз: у открытого запросами автомата проба только проверяет, есть ли
            # куда слать пробный запрос, и спрашивать её каждые пять секунд до этого запроса незачем.
            return now >= state.retry_at and state.probed_at < state.retry_at
        return False

    async def check(self, sources: Iterable[Provider]) -> None:
        """Спросить разом все площадки, которым пора."""
        due = [source for source in sources if self.due(source)]
        if due:
            await asyncio.gather(*(self.probe(source) for source in due), return_exceptions=True)

    async def watch(self, sources: Callable[[], Iterable[Provider]]) -> None:
        """
        Фоновая проверка на всё время службы (`app.py`, `lifespan`): первая — сразу при старте.

        Список площадок спрашивается каждый раз заново: реестр собирается раньше, чем служба запущена.
        """
        while True:
            try:
                await self.check(list(sources()))
            except Exception as error:  # одна сломанная проверка не должна останавливать все следующие
                logger.warning("кинозал: фоновая проверка площадок упала: %s", type(error).__name__)
            await asyncio.sleep(WATCH_TICK)

    # --- переходы ------------------------------------------------------------------------------

    def _open(self, state: Gauge, cause: str) -> None:
        was = state.state
        state.state = OPEN
        state.cause = cause
        self._next_check(state)
        if was == CLOSED:
            state.changes[OPEN] += 1
            why = (
                f"{PROBE_MISSES} пробы подряд не дошли"
                if cause == BY_PROBE
                else f"{FAILURES} запроса подряд без ответа"
            )
            logger.warning(
                "кинозал: площадка %s недоступна с этого сервера (%s), проверим через %.0f с",
                state.id,
                why,
                state.retry_at - self.clock(),
            )

    def _next_check(self, state: Gauge) -> None:
        step = RECHECK[state.misses] if state.misses < len(RECHECK) else PROBE_EVERY
        state.misses += 1
        state.retry_at = self.clock() + step

    def _close(self, state: Gauge) -> None:
        state.state = CLOSED
        state.cause = ""
        state.failures = 0
        state.misses = 0
        state.probe_misses = 0
        state.retry_at = 0.0
        state.changes[CLOSED] += 1
        logger.warning("кинозал: площадка %s снова отвечает с этого сервера", state.id)

    # --- метрики ---------------------------------------------------------------------------------

    def metric_lines(self, sources: Iterable[Provider], prefix: str = "cord_cinema") -> list[str]:
        """
        Строки `/metrics`: в метках только площадка и состояние — ни встреч, ни людей, ни запросов.

        `prefix` — чьи это площадки: `cord_cinema_*` у кинозала, `cord_music_*` у площадок музыки без
        двойника в кинозале (`sources.py`); автомат у всех один.
        """
        gauges = [self.gauge(source) for source in sources if self.tracked(source)]
        name = f"{prefix}_reachable"
        lines = _metric(name, "gauge", "Площадка отвечает с этого сервера (1) или нет (0).")
        lines += [f'{name}{{provider="{g.id}"}} {int(g.state == CLOSED)}' for g in gauges]
        name = f"{prefix}_reach_changes_total"
        lines += _metric(name, "counter", "Сколько раз площадка пропадала и снова отвечала.")
        for g in gauges:
            for state in (OPEN, CLOSED):
                lines.append(f'{name}{{provider="{g.id}",state="{state}"}} {g.changes[state]}')
        name = f"{prefix}_unreachable_refusals_total"
        lines += _metric(name, "counter", "Запросы, которым сразу ответили «площадка недоступна».")
        lines += [f'{name}{{provider="{g.id}"}} {g.refused}' for g in gauges]
        name = f"{prefix}_deadline_total"
        lines += _metric(name, "counter", "Запросы к площадке, не уложившиеся в срок.")
        lines += [f'{name}{{provider="{g.id}"}} {g.deadlines}' for g in gauges]
        return lines

    def lane_lines(self) -> list[str]:
        """Полосы к площадкам: сколько занято сейчас и скольким отказали «заняты»."""
        return [
            *_metric("cord_platform_lanes_busy", "gauge", "Вопросов к площадкам идёт сейчас (все комнаты)."),
            f"cord_platform_lanes_busy {self.lanes.busy}",
            *_metric("cord_platform_busy_refusals_total", "counter", "Отказы «площадки заняты» (429)."),
            f"cord_platform_busy_refusals_total {self.lanes.refused}",
        ]


def _metric(name: str, kind: str, text: str) -> list[str]:
    return [f"# HELP {name} {text}", f"# TYPE {name} {kind}"]
