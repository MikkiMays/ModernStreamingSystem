"""Музыка с площадок без аккаунта: YouTube и SoundCloud через yt-dlp кинозала (T18).

ЧТО И ПОЧЕМУ ТАК. Яндекс Музыка просит аккаунт с подпиской у кого-то во встрече, файл — чтобы он был
под рукой. Большая часть того, что люди хотят включить, лежит на YouTube и SoundCloud, и yt-dlp,
который уже стоит в образе ради кинозала, достаёт оттуда звук без ключей. Берём только то, что площадка
отдаёт анонимному посетителю: без входа, без DRM, без платного слоя — 30-секундный фрагмент трека
SoundCloud Go+ не выдаётся за трек, как и превью Яндекса. Решение и риск — `DECISIONS.md` (E06-B).

ДВЕРЬ В YT-DLP ОДНА — кинозала (`cinema.resolve.YtDlp`): тот же выход наружу, прокси площадки и запасные
cookies YouTube. Ссылки узнаются точным списком хостов, и только отдельный трек; yt-dlp получает
`allowed_extractors` своей площадки, поэтому общий разборщик страниц не участвует никогда — ссылка
на что-то третье до него не доходит.

СКАЧИВАНИЕ — в своём пуле из двух потоков: поток yt-dlp снаружи не прервать, и ему нельзя занимать
пул каталога кинозала. Каждое скачивание само себя обрывает по сроку и по размеру (крючок прогресса).

АВТОМАТ ПЛОЩАДКИ — тоже кинозала (`cinema/reach.py`, R112). Сервер, который не достаёт до YouTube
(московский), отвечал на поиск музыки так же, как каталогу: вечным ожиданием — yt-dlp ждёт каждое чтение
по 20 с. Поиск и треки YouTube идут тем же выходом, поэтому и счёт у них общий с кинозалом: три сбоя или
срока подряд у музыки закрывают YouTube и кинозалу, и наоборот. Пока площадка закрыта, поиск и ссылка
получают отказ сразу (`MUSIC_UNREACHABLE`), не трогая ни yt-dlp, ни пул, ни предел поисков комнаты; у
поиска — жёсткий срок (`SEARCH_DEADLINE`, `MUSIC_TIMEOUT`). У площадки без автомата (SoundCloud — не
площадка кинозала) — только срок.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import logging
import math
import os
import re
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Iterable, TypeVar

from fastapi import HTTPException

from . import covers
from .cinema import address
from .cinema.limits import Window
from .cinema.memo import Memo
from .cinema.providers.youtube import LINK_HOSTS, PLAYERS, SHORT_HOSTS, VIDEO_LINK
from .cinema.reach import RECHECK, Reach, Words
from .cinema.registry import HostPolicy
from .cinema.resolve import BOT_CHECK, YtDlp
from .media import LONGEST, MAX_FILE, probe
from .store import now
from .webapp import Refusal

if TYPE_CHECKING:
    from .cinema.registry import Provider

T = TypeVar("T")

logger = logging.getLogger(__name__)

# Сколько результатов поиска у площадки: восемь помещаются в панель без «показать ещё».
RESULTS = 8
# Сколько поисков и скачиваний по ссылке комната может начать за минуту. Ответ из памяти не в счёт.
SEARCHES_PER_MINUTE = 20
LINKS_PER_MINUTE = 20
# Сколько помнится ответ поиска: тот же вопрос второго участника не идёт к площадке.
SEARCH_TTL = 300
# Жёсткий срок на поиск — тот же, что у вопроса каталога кинозала (`facade.CATALOG_DEADLINE`): поиск
# YouTube на здоровом сервере — 3–5 с у yt-dlp и до 15 с при нагрузке машины, а через «чёрную дыру» он
# висел бы минуты. Выход за срок — сбой в счёт автомата площадки. Клиент ждёт на 5 с дольше.
SEARCH_DEADLINE = 25.0
# Скачивание целиком — не дольше: трек в 50 МБ с живой площадки приезжает за секунды, а дольше
# браузер ждать ответа не станет (`AbortSignal.timeout(180000)` у панели).
DOWNLOAD_SECONDS = 150
# У площадки звук короче обещанного больше чем на столько — это фрагмент, а не трек.
SHORTFALL = 5
# Фрагмент SoundCloud Go+ ровно тридцать секунд — по этой длине его видно уже в поиске.
PREVIEW_SECONDS = 30.0

FLAT = {
    "quiet": True,
    "no_warnings": True,
    "skip_download": True,
    "extract_flat": True,
    "cachedir": False,
    "socket_timeout": 20,
}
# Звук целиком, лучший — если влезает в предел файла, иначе худший из звуковых (тридцатиминутный
# микс в Opus 130 кбит/с — это уже 30 МБ). Видео не берётся никогда.
FORMAT = f"bestaudio[filesize<?{MAX_FILE}][filesize_approx<?{MAX_FILE}]/worstaudio"

# Пути SoundCloud, у которых два сегмента, но это не трек: вкладки профиля и разделы сайта.
SOUNDCLOUD_HOSTS = frozenset(
    {"soundcloud.com", "www.soundcloud.com", "m.soundcloud.com"}
)
SOUNDCLOUD_SECTIONS = frozenset(
    {
        "discover",
        "search",
        "you",
        "stream",
        "upload",
        "charts",
        "pages",
        "settings",
        "messages",
        "notifications",
        "people",
        "stations",
        "jobs",
        "tags",
        "mobile",
        "signin",
        "logout",
        "connect",
        "imprint",
        "popular",
        "feed",
        "terms-of-use",
        "pro",
        "for-artists",
    }
)
SOUNDCLOUD_TABS = frozenset(
    {
        "sets",
        "likes",
        "reposts",
        "tracks",
        "albums",
        "popular-tracks",
        "followers",
        "following",
        "comments",
        "spotlight",
        "toptracks",
    }
)
SLUG = re.compile(r"[A-Za-z0-9_-]{1,255}")

NOT_A_TRACK = (
    "Подойдёт ссылка на трек YouTube или SoundCloud — или найдите трек по названию"
)
SWITCHED_OFF = "Этот источник музыки выключен на сервере"
LIVE = "Эфир в очередь не добавить — только запись"
TOO_LONG = "Нужен трек до 60 минут"
FRAGMENT = "Площадка отдаёт только фрагмент этого трека — целиком его не получить"
TOO_BIG = "Трек больше 50 МБ — такие очередь не берёт"
TOO_SLOW = "Площадка отдаёт трек слишком медленно — попробуйте ещё раз"


def unreachable(source: str, name: str, wait: float = RECHECK[0]) -> Refusal:
    """Отказ сразу: площадка отсюда недоступна. `source` — чтобы клиент назвал её на своём языке."""
    return Refusal(
        503,
        "MUSIC_UNREACHABLE",
        name + " недоступен с этого сервера",
        headers={"Retry-After": str(max(1, math.ceil(wait)))},
        extra={"source": source},
    )


def late(source: str, name: str) -> Refusal:
    """Отказ по сроку: площадка не ответила на поиск за `SEARCH_DEADLINE`."""
    return Refusal(
        504,
        "MUSIC_TIMEOUT",
        name + " не ответил вовремя — попробуйте ещё раз",
        extra={"source": source},
    )


# Отказы автомата кинозала — словами и кодами музыки.
MUSIC = Words(unreachable, late)


@dataclass(frozen=True)
class Gate:
    """
    Площадка музыки без двойника в кинозале — SoundCloud, Яндекс Музыка: свой автомат в том же
    `Reach` (W1b шаг 6, не второй автомат). Поля — те, что автомат спрашивает у площадки кинозала:
    имя, хосты (не «любые»), адрес пробы. Проба идёт клиентом `Net.client_for(id)` — тем же выходом
    (`CINEMA_PROXY_<ID>` или общий), каким yt-dlp качает SoundCloud; у Яндекса пробы нет: его клиент
    ходит своим httpx, и проба мимо него врала бы, — автомат там считает только настоящие запросы.
    """

    id: str
    name: str
    hosts: HostPolicy
    probe: str | None = None


GATES = {
    "soundcloud": Gate(
        "soundcloud",
        "SoundCloud",
        HostPolicy(tuple(sorted(SOUNDCLOUD_HOSTS))),
        "https://soundcloud.com/robots.txt",
    ),
    "yandex": Gate("yandex", "Яндекс Музыка", HostPolicy(("api.music.yandex.net",))),
}
YANDEX_GATE = GATES["yandex"]


@dataclass(frozen=True)
class Platform:
    id: str
    name: str
    # Префикс поиска yt-dlp и разборщики, которые ему разрешены.
    search: str
    search_extractors: tuple[str, ...]
    extractors: tuple[str, ...]


PLATFORMS = {
    "youtube": Platform(
        "youtube", "YouTube", "ytsearch", ("youtube:search",), ("youtube",)
    ),
    "soundcloud": Platform(
        "soundcloud", "SoundCloud", "scsearch", ("soundcloud:search",), ("soundcloud",)
    ),
}


class TooBig(Exception):
    """Скачанное перевалило за предел файла: крючок прогресса оборвал загрузку."""


class TooSlow(Exception):
    """Скачивание шло дольше `DOWNLOAD_SECONDS`: крючок прогресса оборвал загрузку."""


def recognize(url: str) -> tuple[str, str] | None:
    """Площадка и единый адрес трека — или `None`, если это не ссылка на отдельный трек.

    Единый адрес нужен дважды: yt-dlp получает его, а не то, что вставил человек (метки, `list=`,
    `si=`), и по нему же узнаётся повтор той же команды.
    """
    found = address.parse(url) if isinstance(url, str) else None
    if found is None:
        return None
    if found.host in SHORT_HOSTS:
        video = found.path[0] if len(found.path) == 1 else ""
    elif found.host in LINK_HOSTS and found.path:
        head, rest = found.path[0], found.path[1:]
        if head == "watch" and not rest:
            video = found.query.get("v", "")
        elif head in PLAYERS and len(rest) == 1:
            video = rest[0]
        else:
            video = ""
    elif found.host in SOUNDCLOUD_HOSTS:
        if (
            len(found.path) == 2
            and all(SLUG.fullmatch(part) for part in found.path)
            and found.path[0] not in SOUNDCLOUD_SECTIONS
            and found.path[1] not in SOUNDCLOUD_TABS
        ):
            return (
                "soundcloud",
                f"https://soundcloud.com/{found.path[0]}/{found.path[1]}",
            )
        return None
    else:
        return None
    if not VIDEO_LINK.fullmatch(video):
        return None
    return "youtube", f"https://www.youtube.com/watch?v={video}"


def _text(value: Any, limit: int) -> str:
    return value.strip()[:limit] if isinstance(value, str) else ""


def _seconds(value: Any) -> float | None:
    return float(value) if isinstance(value, (int, float)) and value > 0 else None


def _live(info: dict[str, Any]) -> bool:
    return bool(info.get("is_live")) or info.get("live_status") in (
        "is_live",
        "is_upcoming",
        "post_live",
    )


class Sources:
    """
    Поиск и скачивание с площадок без аккаунта. Один на службу.

    `reach` — автомат площадок кинозала, `provider` — включённая площадка кинозала по имени
    (`Registry.find`): у музыкальной площадки, которая есть и в кинозале, счёт доступности общий.
    """

    def __init__(
        self,
        ytdlp: YtDlp,
        store,
        music,
        enabled: Iterable[str] = PLATFORMS,
        *,
        reach: Reach | None = None,
        provider: Callable[[str], Provider | None] | None = None,
    ):
        self.ytdlp, self.store, self.music = ytdlp, store, music
        self.reach, self.provider = reach, provider
        self.enabled = frozenset(source for source in enabled if source in PLATFORMS)
        self.memo = Memo(256)
        self.searches = Window(
            SEARCHES_PER_MINUTE, 60, "Слишком много поисков подряд — подождите минуту"
        )
        self.links = Window(
            LINKS_PER_MINUTE, 60, "Слишком много треков подряд — подождите минуту"
        )
        self.pool = concurrent.futures.ThreadPoolExecutor(
            max_workers=2, thread_name_prefix="music-download"
        )
        # Скачиваний сейчас нет ни одного: всё в `incoming/` — остаток прошлого запуска.
        for leftover in self.store.incoming.iterdir():
            leftover.unlink(missing_ok=True)

    def close(self) -> None:
        self.pool.shutdown(wait=False, cancel_futures=True)

    def platform(self, source: str) -> Platform:
        if source not in self.enabled:
            raise HTTPException(400, SWITCHED_OFF)
        return PLATFORMS[source]

    # ---------- доступность площадки ----------

    def gate(self, source: str) -> Provider | Gate | None:
        """
        Автомат площадки: площадка кинозала под тем же именем (YouTube), иначе своя (`GATES`:
        SoundCloud) — или `None` без автомата вовсе, тогда у музыки только срок.
        """
        if self.reach is None:
            return None
        found = self.provider(source) if self.provider is not None else None
        if found is not None and self.reach.tracked(found):
            return found
        return GATES.get(source)

    def gates(self) -> list[Gate]:
        """Свои площадки включённых источников — для фоновой пробы и `/metrics` (`app.py`)."""
        if self.reach is None:
            return []
        # Яндекс — не источник `PLATFORMS` (у него свой вход), но автомат и метрики у него здесь же.
        return [
            gate
            for source, gate in GATES.items()
            if (source in self.enabled or source not in PLATFORMS) and self.gate(source) is gate
        ]

    def metric_lines(self) -> list[str]:
        """Строки `/metrics` своих площадок — `cord_music_*`, тем же автоматом."""
        if self.reach is None:
            return []
        return self.reach.metric_lines(self.gates(), prefix="cord_music")

    def refuse_if_down(self, platform: Platform) -> None:
        """Отказ сразу, если площадка признана недоступной, — до предела комнаты и места в очереди."""
        gate = self.gate(platform.id)
        if gate is not None:
            self.reach.refuse_if_down(gate, MUSIC)

    async def _ask(
        self,
        platform: Platform,
        work: Callable[[], Awaitable[T]],
        deadline: float | None,
        room: str | None = None,
    ) -> T:
        """
        Вопрос к площадке: через её автомат, если он есть, по полосе комнаты (`Lanes`) и под сроком
        (`None` — срок у работы свой).
        """
        gate = self.gate(platform.id)
        if gate is not None:
            return await self.reach.call(gate, work, deadline, MUSIC, room=room)
        scope = asyncio.timeout(deadline)
        try:
            async with scope:
                return await work()
        except TimeoutError:
            if not scope.expired():
                raise
            raise late(platform.id, platform.name) from None

    async def unreachable(self) -> list[str]:
        """
        Включённые площадки, до которых этот сервер сейчас не достаёт (`catalog.unreachable`).

        Закрытую пробой сначала спрашивают снова, если с прошлой пробы прошло полминуты
        (`Reach.refresh`): «Повторить» в панели музыки спрашивает каталог заново и узнаёт правду
        сейчас, а не через минуты фоновой проверки.
        """
        gates = {
            source: gate
            for source in PLATFORMS
            if source in self.enabled and (gate := self.gate(source)) is not None
        }
        await asyncio.gather(
            *(self.reach.refresh(gate) for gate in gates.values()), return_exceptions=True
        )
        return [source for source, gate in gates.items() if self.reach.down(gate) is not None]

    # ---------- поиск ----------

    async def search(
        self, room_id: str, source: str, query: str
    ) -> list[dict[str, Any]]:
        platform = self.platform(source)
        query = " ".join(query.split())
        if len(query) < 2:
            raise HTTPException(400, "Напишите название трека или исполнителя")
        # Недоступная отсюда площадка — отказ сразу: ни yt-dlp, ни места в пуле, ни поиска из предела.
        self.refuse_if_down(platform)
        key = f"{platform.id}:{query.lower()}"
        if not self.memo.known(key):
            self.searches.take(room_id)
        # Поток — на месте площадки в пуле кинозала (`YtDlp.offload_for`): YouTube, до которого нет
        # сети, держит поток минутами, и места у него те же, что у кинозала. Срок и счёт автомата — у
        # общего ответа, а не у каждого ждущего: пятеро с одним вопросом — один сбой, а не пять.
        # Отказ памятью не запоминается (`Memo`): следующий вопрос снова идёт к площадке.
        return await self.memo.get(
            key,
            lambda: self._ask(
                platform,
                lambda: self.ytdlp.offload_for(platform.id, self._search, platform, query),
                SEARCH_DEADLINE,
                room_id,
            ),
            SEARCH_TTL,
        )

    def _search(self, platform: Platform, query: str) -> list[dict[str, Any]]:
        options = {**FLAT, "allowed_extractors": list(platform.search_extractors)}
        try:
            found = self.ytdlp.extract(
                f"{platform.search}{RESULTS}:{query}", options, platform.id
            )
        # yt_dlp поднимает свои типы; наружу — отказ площадки, не 500.
        except Exception as error:
            logger.info(
                "музыка: поиск %s не удался: %s", platform.id, self.ytdlp.explain(error)
            )
            raise HTTPException(
                502, f"{platform.name} не ответил. Повторите поиск"
            ) from None
        tracks = []
        for entry in found.get("entries") or []:
            if not isinstance(entry, dict):
                continue
            item = self._item(platform, entry)
            if item:
                tracks.append(item)
        return tracks

    @staticmethod
    def _item(platform: Platform, entry: dict[str, Any]) -> dict[str, Any] | None:
        if platform.id == "youtube":
            video = entry.get("id")
            if not isinstance(video, str) or not VIDEO_LINK.fullmatch(video):
                return None
            url = f"https://www.youtube.com/watch?v={video}"
            artist = _text(entry.get("channel") or entry.get("uploader"), 120)
        else:
            known = recognize(entry.get("webpage_url") or "")
            if not known or known[0] != "soundcloud":
                return None
            url = known[1]
            artist = _text(entry.get("uploader") or entry.get("artist"), 120)
        duration = _seconds(entry.get("duration"))
        preview = platform.id == "soundcloud" and duration == PREVIEW_SECONDS
        # Длительность выдача уже знает: ролик длиннее часа помечен сразу (R116), а не «+», после
        # которого скачивание откажет «Нужен трек до 60 минут». Неизвестная длительность — не
        # отказ: её проверит разбор ссылки (`_check`).
        long = duration is not None and duration > LONGEST
        return {
            "url": url,
            "title": _text(entry.get("title"), 180) or "Без названия",
            "artist": artist,
            "duration": duration or 0.0,
            "available": not _live(entry) and not preview and not long,
            "source": platform.id,
        }

    # ---------- трек по ссылке ----------

    async def enqueue(
        self, room_id: str, url: str, command_id: str, actor: str
    ) -> dict:
        known = recognize(url)
        if not known:
            raise HTTPException(400, NOT_A_TRACK)
        source, page = known
        platform = self.platform(source)
        scope = "music-link:" + room_id
        async with self.music.locks[scope]:
            receipt = self.store.receipt(scope, command_id)
            if receipt:
                if receipt["url"] != page:
                    raise HTTPException(409, "Идентификатор команды уже использован")
                return self.store.public(room_id)
            # Площадка отсюда недоступна — отказ сразу, до предела комнаты и места в хранилище.
            self.refuse_if_down(platform)
            self.links.take(room_id)
            self.music.check_quota(room_id, 0)
            key = str(uuid.uuid4())
            cover = None
            path = None
            # Поток yt-dlp снаружи не прервать — но он сам спрашивает этот флаг на каждом куске.
            stop = threading.Event()
            loop = asyncio.get_running_loop()
            work = loop.run_in_executor(
                self.pool, self._download, platform, page, key, stop
            )
            try:
                try:
                    # Скачивание — через автомат площадки: не дошло до неё — сбой в общий счёт с
                    # кинозалом, дошло — счёт сначала. Срок у него свой (`DOWNLOAD_SECONDS`).
                    found = await self._ask(
                        platform, lambda: asyncio.shield(work), None, room_id
                    )
                except TooBig:
                    raise HTTPException(413, TOO_BIG) from None
                except TooSlow:
                    raise HTTPException(504, TOO_SLOW) from None
                # Готовый файл переезжает к остальному звуку одним переименованием: до этого его
                # не видят ни подсчёт места, ни уборка.
                path = self.store.files / found["path"].name
                os.replace(found["path"], path)
                metadata = await probe(path)
                if metadata["duration"] < found["duration"] - SHORTFALL:
                    raise HTTPException(403, FRAGMENT)
                if found["thumbnail"]:
                    cover = await covers.extract(found["thumbnail"], self.store.files)
                result = await self.music.enqueue(
                    room_id,
                    {
                        "id": key,
                        "file": path.name,
                        "title": found["title"] or metadata["title"] or "Без названия",
                        "artist": found["artist"] or metadata["artist"],
                        "duration": metadata["duration"],
                        "source": platform.id,
                        "addedBy": actor,
                        "createdAt": now(),
                        "cover": cover,
                    },
                )
                self.store.remember(scope, command_id, {"url": page})
                return result
            except BaseException:
                stop.set()
                if not work.done():
                    # Отменили запрос, а поток ещё качает: подчищаем, когда он остановится.
                    work.add_done_callback(lambda _: self._forget(key, path, cover))
                else:
                    self._forget(key, path, cover)
                raise
            finally:
                for leftover in self.store.incoming.glob(f"{key}*"):
                    leftover.unlink(missing_ok=True)

    def _forget(self, key: str, path: Path | None, cover: str | None) -> None:
        """Не вошедшее в очередь — с диска: куски и миниатюра, переехавший звук, обложка."""
        for leftover in self.store.incoming.glob(f"{key}*"):
            leftover.unlink(missing_ok=True)
        referenced = self.store.referenced()
        for name in [path.name if path else None, cover]:
            if name and name not in referenced:
                (self.store.files / name).unlink(missing_ok=True)

    def _download(
        self,
        platform: Platform,
        page: str,
        key: str,
        stop: threading.Event | None = None,
    ) -> dict[str, Any]:
        """Разбор, проверки и скачивание — в потоке пула, одним открытым yt-dlp, в `incoming/`."""
        started = time.monotonic()

        def hook(progress: dict[str, Any]) -> None:
            if (progress.get("downloaded_bytes") or 0) > MAX_FILE:
                raise TooBig()
            if stop is not None and stop.is_set():
                raise TooSlow()
            if time.monotonic() - started > DOWNLOAD_SECONDS:
                raise TooSlow()

        files = self.store.incoming
        options = {
            "quiet": True,
            "no_warnings": True,
            "noprogress": True,
            "noplaylist": True,
            "cachedir": False,
            "socket_timeout": 20,
            "format": FORMAT,
            "outtmpl": {
                "default": str(files / f"{key}.%(ext)s"),
                "thumbnail": str(files / f"{key}.thumb.%(ext)s"),
            },
            "writethumbnail": True,
            "max_filesize": MAX_FILE,
            "progress_hooks": [hook],
            "retries": 2,
            "fragment_retries": 2,
            "concurrent_fragment_downloads": 1,
            # Кусками по 10 МБ: YouTube режет скорость длинным запросам целого файла.
            "http_chunk_size": 10 * 1024 * 1024,
            "overwrites": True,
            # Время файла — время скачивания, а не `Last-Modified` площадки: по нему уборка
            # отличает свежее от забытого.
            "updatetime": False,
            "allowed_extractors": list(platform.extractors),
        }

        def work(ydl: Any) -> dict[str, Any]:
            info = ydl.extract_info(page, download=False) or {}
            duration = self._check(info)
            done = ydl.process_ie_result(info, download=True) or {}
            downloads = done.get("requested_downloads") or []
            path = (
                Path(downloads[0]["filepath"])
                if downloads and downloads[0].get("filepath")
                else None
            )
            if path is None or not path.is_file():
                # yt-dlp молча пропускает формат больше `max_filesize`, если размер знал заранее.
                raise TooBig()
            if path.stat().st_size > MAX_FILE:
                raise TooBig()
            thumbnail = next(iter(sorted(files.glob(f"{key}.thumb.*"))), None)
            return {
                "path": path,
                "duration": duration,
                "title": _text(info.get("track") or info.get("title"), 180),
                "artist": _text(
                    info.get("artist") or info.get("channel") or info.get("uploader"),
                    120,
                ),
                "thumbnail": thumbnail,
            }

        # Один повтор на необъяснённый отказ площадки: на живой пробе YouTube раз из трёх не отдал
        # ролик, который со второго раза пришёл за две секунды. Срок — общий на обе попытки.
        for attempt in (1, 2):
            try:
                return self._run(platform, options, work)
            except (HTTPException, TooBig, TooSlow):
                raise
            except Exception as error:  # yt_dlp поднимает свои типы — решает текст
                text = str(error)
                if TooBig.__name__ in text or "max-filesize" in text:
                    raise TooBig() from None
                if TooSlow.__name__ in text:
                    raise TooSlow() from None
                reason = self.ytdlp.explain(error)
                if attempt == 1 and time.monotonic() - started < DOWNLOAD_SECONDS / 2:
                    logger.info("музыка: %s, повтор после: %s", platform.id, reason)
                    continue
                logger.info("музыка: %s не отдал трек: %s", platform.id, reason)
                raise HTTPException(
                    502, f"{platform.name} не отдал трек. Попробуйте другой"
                ) from None
        raise AssertionError("недостижимо")

    @staticmethod
    def _check(info: dict[str, Any]) -> float:
        """Можно ли этот разбор в очередь — и сколько секунд площадка обещает."""
        if info.get("_type") in ("playlist", "multi_video"):
            raise HTTPException(400, NOT_A_TRACK)
        if _live(info):
            raise HTTPException(400, LIVE)
        duration = _seconds(info.get("duration"))
        if duration is None or duration > LONGEST:
            raise HTTPException(400, TOO_LONG)
        formats = [f for f in info.get("formats") or [] if isinstance(f, dict)]
        if formats and all("preview" in str(f.get("format_id", "")) for f in formats):
            raise HTTPException(403, FRAGMENT)
        return duration

    def _run(
        self, platform: Platform, options: dict[str, Any], work: Callable[[Any], Any]
    ) -> Any:
        """Открытый yt-dlp площадки — без cookies, а с ними только после проверки на человека."""
        cookies = self.ytdlp.cookies.get(platform.id)
        try:
            return self.ytdlp.run(platform.id, options, work)
        except Exception as error:
            if (
                cookies
                and platform.id in self.ytdlp.cookies_fallback
                and BOT_CHECK.search(str(error))
            ):
                return self.ytdlp.run(platform.id, options, work, cookies=cookies)
            raise
