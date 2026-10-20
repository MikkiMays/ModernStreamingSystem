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
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import logging
import os
import re
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable

from fastapi import HTTPException

from . import covers
from .cinema import address
from .cinema.limits import Window
from .cinema.memo import Memo
from .cinema.providers.youtube import LINK_HOSTS, PLAYERS, SHORT_HOSTS, VIDEO_LINK
from .cinema.resolve import BOT_CHECK, YtDlp
from .media import MAX_FILE, probe
from .store import now

logger = logging.getLogger(__name__)

# Сколько результатов поиска у площадки: восемь помещаются в панель без «показать ещё».
RESULTS = 8
# Сколько поисков и скачиваний по ссылке комната может начать за минуту. Ответ из памяти не в счёт.
SEARCHES_PER_MINUTE = 20
LINKS_PER_MINUTE = 20
# Сколько помнится ответ поиска: тот же вопрос второго участника не идёт к площадке.
SEARCH_TTL = 300
# Скачивание целиком — не дольше: трек в 50 МБ с живой площадки приезжает за секунды, а дольше
# браузер ждать ответа не станет (`AbortSignal.timeout(180000)` у панели).
DOWNLOAD_SECONDS = 150
# Трек длиннее часа очередь не берёт (как и файл, `media.probe`).
LONGEST = 3600
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
    """Поиск и скачивание с площадок без аккаунта. Один на службу."""

    def __init__(self, ytdlp: YtDlp, store, music, enabled: Iterable[str] = PLATFORMS):
        self.ytdlp, self.store, self.music = ytdlp, store, music
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

    # ---------- поиск ----------

    async def search(
        self, room_id: str, source: str, query: str
    ) -> list[dict[str, Any]]:
        platform = self.platform(source)
        query = " ".join(query.split())
        if len(query) < 2:
            raise HTTPException(400, "Напишите название трека или исполнителя")
        key = f"{platform.id}:{query.lower()}"
        if not self.memo.known(key):
            self.searches.take(room_id)
        return await self.memo.get(
            key, lambda: self.ytdlp.offload(self._search, platform, query), SEARCH_TTL
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
        return {
            "url": url,
            "title": _text(entry.get("title"), 180) or "Без названия",
            "artist": artist,
            "duration": duration or 0.0,
            "available": not _live(entry) and not preview,
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
                    found = await asyncio.shield(work)
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
