"""
Фасад кинозала: проверка ввода → площадка из реестра → её метод → память → ответ.

О площадках он знает только то, что они сами о себе объявили (`features`): ни одной развилки
«YouTube это или Twitch» здесь нет. Ключи памяти — под именем площадки и с регистром id как у
неё, сроки — прежние: клиент к ним не привязан, но от них зависит, сколько раз мы ходим
наружу. Здесь же прокси поверх подписанных адресов — он общий для всех площадок, а выход
наружу у каждой свой (`net.py`).
"""

from __future__ import annotations

import asyncio
import functools
import gzip
import logging
import re
import time
import uuid
from dataclasses import asdict
from typing import Any, Literal

import httpx
from fastapi import HTTPException
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

from . import wire
from .captions import webvtt
from .limits import Window
from .memo import Memo
from .net import Net, NetConfig
from .paging import absolute, offset_of
from .providers import PROVIDERS
from .registry import Ctx, HostPolicy, Kit, Provider, Registry
from .resolve import Resolver, YtDlp
from .transport.playlists import Reels, rewrite
from .transport.segments import Segments
from .transport.signer import Signer, proxied

logger = logging.getLogger(__name__)

# Обложки живут дольше: они не меняются и ничего не стоят.
IMAGE_TTL = 24 * 3600

# Сколько разборов ссылок (yt-dlp, секунды работы и запросы к площадке) комната может начать
# за минуту. Ответ из общей памяти в счёт не идёт — он ничего не стоит.
RESOLVES_PER_MINUTE = 30

Kind = Literal["video", "channel"]

# Имя канала приходит от браузера и уходит в чужой адрес, поэтому проверяется здесь, а не
# «где-нибудь потом»: у YouTube это `UC…` или `@псевдоним`, у Twitch — логин. Проверка —
# `fullmatch`, а не `match` с `$`: `$` совпадает и перед завершающим переводом строки, и
# `UCabc\n` доезжал до адреса yt-dlp и до текста запроса GraphQL.
CHANNEL_ID = re.compile(r"[A-Za-z0-9_.@-]{1,80}")


class Resolve(BaseModel):
    # Площадку проверяет реестр, а не перечень в схеме: незнакомая или выключенная — это отказ
    # 400 с человеческим текстом, как и любой другой вопрос, на который у площадки ответа нет.
    provider: str = Field(max_length=32)
    contentId: str = Field(min_length=1, max_length=64, pattern=r"[A-Za-z0-9_-]+")
    kind: Kind = "video"
    adaptive: bool = False
    refresh: bool = False


# Что показывает страница канала. `about` — единственная без ленты: она про сам канал.
Tab = Literal["videos", "streams", "shorts", "playlists", "about"]

# Плейлист (`PL…`, `UU…`, `OLAK5uy_…`) проверяется тем же правилом, что и имя канала: строка
# уходит в чужой адрес, и всё, что не буква, цифра или знак из списка, до него не доходит.
CATALOG_ID = CHANNEL_ID
# Идентификатор категории Twitch — только цифры.
CATEGORY_ID = re.compile(r"[0-9]{1,20}")
# Сериал и его сезон: у Rutube это числа, у медиатеки — GUID. Общая форма здесь только
# отсекает то, чему в чужом адресе не место (слэши, точки, пробелы); свою форму площадка
# проверяет сама.
SERIES_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")
SEASON_ID = SERIES_ID
# Больше субтитров не бывает: реплики трёхчасового фильма — пара сотен килобайт.
SUBTITLES_LIMIT = 2 * 1024 * 1024
# Срок на весь ответ субтитров, от запроса до последнего байта. Сроки httpx — на каждое чтение
# отдельно, и площадка, отдающая по байту раз в несколько секунд, держала бы запрос сколько
# угодно; файл в сотню килобайт за пятнадцать секунд приезжает с любой связью.
SUBTITLES_DEADLINE = 15.0


def _room(room: str) -> str:
    """
    Одно написание номера комнаты. Ядро принимает UUID в любом регистре, и счёт по строке из
    адреса давал бы каждой комнате свой предел на каждое её написание.
    """
    try:
        return str(uuid.UUID(room))
    except ValueError:
        return room


def _checked(answer: Any) -> tuple[bool, str | None]:
    """Ответ `gather` с `return_exceptions`: исключение мимо `_availability` — тоже «недоступна»."""
    if isinstance(answer, BaseException):
        return False, "Не удалось проверить площадку"
    return answer


class Cinema:
    # Сколько ждать ответа площадки на «работаешь ли ты отсюда». Список площадок — первое, что
    # видит открывший кинозал, и дольше трёх секунд он ждать не должен.
    AVAILABILITY_TIMEOUT = 3.0

    def __init__(
        self,
        secret: str,
        client: httpx.AsyncClient | None = None,
        *,
        enabled: str | None = None,
        net: NetConfig | None = None,
    ):
        """
        `enabled` — какие площадки включены, строкой как в `CINEMA_PROVIDERS`; пусто — все.
        `net` — выход наружу (`NetConfig.from_env`): прокси, cookies и разрешённые частные сети.
        `client` — один клиент httpx на все площадки вместо своих (так тесты подменяют сеть).
        """
        config = net or NetConfig()
        # Подпись открывает адрес только по политике хостов своей площадки — и только
        # включённой: выключенная площадка не отдаёт через прокси ничего, даже по старой ссылке.
        self.signer = Signer(secret, self._hosts)
        self.segments = Segments()
        self.reels = Reels(self.signer)
        self.catalog = Memo()
        self.sources = Memo(capacity=64)
        self.resolves = Window(
            RESOLVES_PER_MINUTE, 60.0, "Комната слишком часто открывает видео, подождите минуту"
        )
        # Каждая площадка ходит наружу своим клиентом: своим прокси и под общей защитой
        # «только наружу» (`net.py`).
        self.net = Net(config, self._hosts, client=client)
        # Кому cookies — только запасной ход, решает не эта строка, а сама площадка
        # (`Provider.cookies_fallback`, см. `providers/youtube.py`): здесь его просто собирают.
        self.ytdlp = YtDlp(
            config, cookies_fallback=(kind.id for kind in PROVIDERS if kind.cookies_fallback)
        )
        self.resolver = Resolver(self.signer, self.ytdlp, self.image)
        self.registry = Registry((kind(self._kit(kind)) for kind in PROVIDERS), enabled)
        known = {kind.id for kind in PROVIDERS}
        strangers = sorted((set(config.proxies) | set(config.cookies) | set(config.private)) - known)
        if strangers:
            # Опечатка в имени площадки не гасит кинозал, но и молча не проглатывается.
            logger.warning(
                "CINEMA_PROXY_*/CINEMA_COOKIES_*/CINEMA_PRIVATE_HOSTS_*: незнакомые площадки пропущены: "
                "%s (кинозал знает: %s)",
                ", ".join(strangers),
                ", ".join(sorted(known)),
            )

    async def close(self):
        await self.net.close()

    def _kit(self, kind: type[Provider]) -> Kit:
        # Память площадки — общая память под её именем: ключ одной площадки не может ни
        # прочитать, ни затереть ответ другой, даже при одинаковом номере ролика. Обложки она
        # подписывает своим именем: чужой хост её подпись не откроет.
        return Kit(
            memo=self.catalog.scope(kind.id),
            image=functools.partial(self.image, provider=kind.id),
            ytdlp=self.ytdlp,
        )

    def _hosts(self, provider: str) -> HostPolicy | None:
        found = self.registry.find(provider)
        return found.hosts if found else None

    def _ctx(self, room: str, source: Provider) -> Ctx:
        return Ctx(room=_room(room), net=self.net.client_for(source.id))

    def _able(self, provider: str, feature: str) -> Provider:
        """
        Площадка, у которой это есть.

        Отказ звучит раньше, чем разбирается остальной ввод, — как и тогда, когда проверка
        площадки стояла первой строкой метода: у Twitch «плейлистов нет» и с кривым адресом.
        """
        source = self.registry.get(provider)
        if not getattr(source.features, feature):
            raise source.refuse(feature)
        return source

    # --- площадки ----------------------------------------------------------------------

    async def providers(self) -> dict[str, list[wire.ProviderEntry]]:
        """Какие площадки включены, работают ли они отсюда и что у каждой есть."""
        listed = list(self.registry)
        answers = await asyncio.gather(
            *(self._availability(source) for source in listed), return_exceptions=True
        )
        return {
            "providers": [
                {
                    "id": source.id,
                    "available": available,
                    "reason": reason,
                    "account": source.features.account,
                    # Входить пока не во что: ни одной площадке аккаунт не нужен, а сейфа
                    # входов комнаты ещё нет.
                    "connected": False,
                    "features": {
                        name: value for name, value in asdict(source.features).items() if name != "account"
                    },
                }
                for source, (available, reason) in zip(listed, map(_checked, answers))
            ]
        }

    async def _availability(self, source: Provider) -> tuple[bool, str | None]:
        """
        Проверка одной площадки — под своим сроком и своей защитой.

        Список площадок — первое, что видит открывший кинозал, и он не должен зависеть от
        самой медленной или самой сломанной из них: упавшая проверка — это «недоступна» у одной
        карточки, а не 500 на весь список, зависшая — «не ответила» через три секунды.
        """
        try:
            async with asyncio.timeout(self.AVAILABILITY_TIMEOUT):
                available, reason = await source.availability()
        except TimeoutError:
            return False, "Площадка не ответила вовремя"
        except Exception as error:
            # Текст исключения в журнал не идёт: в нём бывают адреса с ключами доступа.
            logger.warning("кинозал: проверка площадки %s упала: %s", source.id, type(error).__name__)
            return False, "Не удалось проверить площадку"
        return bool(available), reason

    # --- поиск и каталог -------------------------------------------------------------

    async def search(self, provider: str, query: str, cursor: str = "", *, room: str = "") -> dict[str, Any]:
        """
        Что показать по набранному — и что показать, пока не набрано ничего.

        Ответ один на все площадки: лента карточек, а над ней полки — каналы у YouTube,
        категории у Twitch. Полка приезжает только с первой порцией: листая ленту вниз,
        каналы второй раз не ищут.
        """
        source = self._able(provider, "search")
        offset = offset_of(cursor)
        return await source.search(self._ctx(room, source), query.strip(), offset)

    async def channel(
        self, provider: str, channel_id: str, tab: Tab = "videos", cursor: str = "", *, room: str = ""
    ) -> dict[str, Any]:
        """
        Страница канала, вкладка за вкладкой.

        Вкладки здесь те же, что у площадки, и это не украшение: канал, у которого пять сотен
        роликов, десяток плейлистов и идущий прямо сейчас эфир, одной лентой не показывается
        никак. Каждая вкладка листается своей лентой; `about` ленты не имеет вовсе.
        """
        source = self._able(provider, "channels")
        if not CATALOG_ID.fullmatch(channel_id):
            raise HTTPException(400, "Непонятное имя канала")
        offset = offset_of(cursor)
        ctx = self._ctx(room, source)
        # Регистр в ключе — как у площадки: `UCabc` и `UCABC` у YouTube два разных канала.
        return await self.catalog.scope(source.id).get(
            f"channel:{channel_id}:{tab}:{offset}",
            lambda: source.channel(ctx, channel_id, tab, offset),
            # Память короткая нарочно: сверху у канала лежит самое свежее, и «самое свежее»
            # не должно означать «самое свежее полчаса назад».
            60,
        )

    async def playlist(
        self, provider: str, playlist_id: str, cursor: str = "", *, room: str = ""
    ) -> dict[str, Any]:
        """Плейлист целиком: его описание и ролики в том порядке, в котором их собрали."""
        source = self._able(provider, "playlists")
        if not CATALOG_ID.fullmatch(playlist_id):
            raise HTTPException(400, "Непонятный адрес плейлиста")
        offset = offset_of(cursor)
        ctx = self._ctx(room, source)
        return await self.catalog.scope(source.id).get(
            f"playlist:{playlist_id}:{offset}",
            lambda: source.playlist(ctx, playlist_id, offset),
            60,
        )

    async def categories(
        self, provider: str, query: str = "", cursor: str = "", *, room: str = ""
    ) -> dict[str, Any]:
        """Разделы площадки: что смотрят прямо сейчас, по играм и рубрикам."""
        source = self.registry.get(provider)
        if not source.features.categories:
            # Площадка без разделов отвечает пустым списком, а не отказом, — и раньше, чем
            # разбирается курсор: так кинозал отвечал всегда.
            return {"items": [], "next": None}
        offset = offset_of(cursor)
        return await source.categories(self._ctx(room, source), query.strip(), offset)

    async def category(
        self, provider: str, category_id: str, cursor: str = "", *, room: str = ""
    ) -> dict[str, Any]:
        """Один раздел: его карточка и эфиры, которые идут в нём сейчас."""
        source = self._able(provider, "categories")
        if not CATEGORY_ID.fullmatch(category_id):
            raise HTTPException(400, "Непонятный раздел")
        offset = offset_of(cursor)
        return await source.category(self._ctx(room, source), category_id, offset)

    async def series(
        self, provider: str, series_id: str, season: str = "", cursor: str = "", *, room: str = ""
    ) -> dict[str, Any]:
        """
        Страница сериала: шапка, сезоны и серии открытого сезона порциями.

        Сезон не выбран — площадка открывает свой первый. Память — как у страниц канала, но
        длиннее: серии у сериала появляются раз в неделю, а не раз в минуту.
        """
        source = self._able(provider, "series")
        if not SERIES_ID.fullmatch(series_id):
            raise HTTPException(400, "Непонятный адрес сериала")
        if season and not SEASON_ID.fullmatch(season):
            raise HTTPException(400, "Непонятный сезон")
        offset = offset_of(cursor)
        ctx = self._ctx(room, source)
        return await self.catalog.scope(source.id).get(
            f"series:{series_id}:{season}:{offset}",
            lambda: source.series(ctx, series_id, season or None, offset),
            300,
        )

    async def details(self, provider: str, content_id: str, kind: Kind, *, room: str = "") -> dict[str, Any]:
        source = self.registry.get(provider)
        # Форма адреса — площадки: она знает, какие id у неё бывают (`Provider.content_id`).
        if not source.content_id.fullmatch(content_id):
            raise HTTPException(400, "Непонятный адрес видео")
        ctx = self._ctx(room, source)
        return await self.catalog.scope(source.id).get(
            f"details:{kind}:{content_id}",
            lambda: source.details(ctx, kind, content_id),
            600,
        )

    def image(self, url: str, provider: str) -> str | None:
        """Обложка у нас, а не у площадки. Адрес без схемы получает её здесь — иначе он
        не прошёл бы политику хостов и картинка тихо пропала бы с карточки. Картинка с хоста
        чужой площадки не подписывается вовсе: её подпись всё равно ничего бы не открыла."""
        full = absolute(url)
        if not full or not self.signer.allows(full, provider):
            return None
        return proxied(self.signer, full, "image", IMAGE_TTL, provider=provider)

    # --- разрешение ссылки в поток ---------------------------------------------------

    async def resolve(self, request: Resolve, *, room: str = "") -> dict[str, Any]:
        # Один разбор на всю комнату: пятеро зрителей открывают одно и то же видео в одну и ту
        # же минуту, и пять запросов к площадке ради одного ответа — это просто пять ожиданий.
        # Живой эфир держится меньше: его адреса обновляются чаще, чем меняется афиша.
        source = self.registry.get(request.provider)
        # Схема запроса проверяет только общий вид, а `pattern` у pydantic ищет совпадение, а не
        # сравнивает целиком: `aqz-KE-bpKQ&list=…` дописывал параметры в адрес страницы. Форму
        # целиком знает площадка — ей и решать, раньше памяти и раньше yt-dlp.
        if not source.content_id.fullmatch(request.contentId):
            raise HTTPException(400, "Непонятный адрес видео")
        key = f"{source.id}:{request.kind}:{request.contentId}:{request.adaptive}"
        # Предел — на работу, а не на вопросы: готовый ответ и разбор, который уже идёт для
        # соседа по комнате, наружу ничего не стоят. Иначе комната из десяти человек упиралась бы
        # в предел за три ролика, а злоумышленник с `refresh` — нет. `refresh` — работа всегда,
        # кроме присоединения к идущему разбору. Предел проверяется раньше, чем `refresh`
        # забывает готовый ответ: отказ 429 не должен стоить комнате того, что у неё уже есть.
        if not (self.sources.pending(key) if request.refresh else self.sources.known(key)):
            self.resolves.take(_room(room))
        if request.refresh:
            self.sources.forget(key)
        ctx = self._ctx(room, source)
        return await self.sources.get(
            key,
            lambda: self._resolve(source, ctx, request),
            lambda found: min(
                45 if found["live"] else 1800,
                max(0, found["expiresAt"] / 1000 - time.time() - 60),
            ),
        )

    async def _resolve(self, source: Provider, ctx: Ctx, request: Resolve) -> dict[str, Any]:
        """Площадка говорит, откуда брать поток, а разбирает его общий `Resolver`."""
        plan = await source.source(ctx, request.kind, request.contentId, {})
        return await self.resolver.resolve(plan, ctx.net, source.id, request.contentId, request.adaptive)

    def dash(self, key: str) -> Response:
        return self.resolver.dash(key)

    # --- прокси ------------------------------------------------------------------------

    async def manifest(self, url: str, encodings: str | None, provider: str) -> Response:
        try:
            response = await self.net.client_for(provider).get(url, follow_redirects=False)
        except httpx.HTTPError:
            # Обрыв по дороге к площадке — её отказ (502), а не наша ошибка (500).
            raise HTTPException(502, "Площадка не отдала плейлист") from None
        if response.status_code >= 300:
            raise HTTPException(502, "Площадка не отдала плейлист")
        body = rewrite(response.text, str(response.url), self.signer, self.reels, provider=provider)
        headers = {"Cache-Control": "no-store"}
        payload = body.encode()
        # Плейлист фильма — это тысячи почти одинаковых строк. Сжатие снимает с них ещё
        # порядок, и делать это стоит именно здесь: у сегментов сжимать нечего, они уже видео.
        if "gzip" in (encodings or "") and len(payload) > 4096:
            payload = gzip.compress(payload, 6)
            headers["Content-Encoding"] = "gzip"
        return Response(payload, media_type="application/vnd.apple.mpegurl", headers=headers)

    async def subtitles(self, url: str, provider: str) -> Response:
        """
        Файл субтитров площадки — в WebVTT, как его читает `<track>`.

        Файл читается целиком (он маленький) и не больше предела: что больше двух мегабайт, то
        не субтитры, и держать это в памяти ради перевода незачем. Спрашивается он несжатым: сжатое
        тело httpx распаковывает кусками, и кусок сжатой «бомбы» — это десятки мегабайт в памяти
        ещё до проверки предела. Сжатый ответ вопреки просьбе — отказ: это не то, что спросили.
        Срок у всего ответа один (`SUBTITLES_DEADLINE`).
        """
        try:
            async with asyncio.timeout(SUBTITLES_DEADLINE):
                upstream = await self._open(
                    self.net.client_for(provider), url, {"Accept-Encoding": "identity"}
                )
                try:
                    if not _plain(upstream):
                        raise HTTPException(502, "Площадка не отдала данные")
                    body = await self._read(upstream, SUBTITLES_LIMIT)
                finally:
                    await upstream.aclose()
        except TimeoutError:
            raise HTTPException(504, "Площадка не отдала субтитры вовремя") from None
        return Response(
            webvtt(body),
            media_type="text/vtt; charset=utf-8",
            headers={"Cache-Control": "private, max-age=600"},
        )

    async def fetch(self, url: str, range_header: str | None, provider: str) -> Response:
        if range_header and not re.fullmatch(r"bytes=(?:\d+-\d*|-\d+)", range_header):
            raise HTTPException(416, "Неверный диапазон байтов")
        if (
            range_header
            and (match := re.fullmatch(r"bytes=(\d+)-(\d+)", range_header))
            and int(match[1]) > int(match[2])
        ):
            raise HTTPException(416, "Неверный диапазон байтов")
        # Частичный запрос (перемотка в готовом файле) обслуживается напрямую, потоком.
        client = self.net.client_for(provider)
        if range_header:
            return self._stream(await self._open(client, url, {"Range": range_header}))
        # Целый сегмент — то, что просят все и одинаково: он идёт через общую память.
        cached = self.segments.get(url)
        if cached:
            return _kept(*cached)
        async with self.segments.lock(url):
            cached = self.segments.get(url)
            if cached:
                return _kept(*cached)
            upstream = await self._open(client, url, {})
            if not self._storable(upstream):
                # В общую память такой ответ не ляжет, поэтому и в нашу целиком не читается: он
                # идёт к зрителю потоком, как ответ на `Range`. Ждущие за этим замком пойдут
                # своими потоками — держать гигабайт ради них в памяти нельзя.
                return self._stream(upstream, "video/mp2t")
            try:
                body = await self._read(upstream)
            finally:
                await upstream.aclose()
            kind = upstream.headers.get("content-type", "video/mp2t")
            self.segments.put(url, body, kind)
            return _kept(body, kind)

    async def _open(self, client: httpx.AsyncClient, url: str, headers: dict[str, str]) -> httpx.Response:
        """Ответ площадки с непрочитанным телом. Переадресацию прокси не выполняет никогда."""
        request = client.build_request("GET", url, headers=headers)
        try:
            upstream = await client.send(request, stream=True, follow_redirects=False)
        except httpx.HTTPError:
            raise HTTPException(502, "Площадка не отдала данные") from None
        if upstream.status_code >= 300:
            await upstream.aclose()
            raise HTTPException(502, "Площадка не отдала данные")
        return upstream

    def _storable(self, upstream: httpx.Response) -> bool:
        """
        Поместится ли ответ в общую память: размер объявлен, не больше предела, тело не сжато.

        Сжатое тело не распаковывается у нас вовсе — объявленный размер у него про сжатые байты,
        а распакованные могут оказаться в тысячу раз больше.
        """
        length = upstream.headers.get("content-length", "")
        return length.isdigit() and int(length) <= self.segments.largest and _plain(upstream)

    async def _read(self, upstream: httpx.Response, limit: int | None = None) -> bytes:
        """Тело целиком — но не больше предела памяти, что бы площадка ни объявила.

        Сжатое тело сюда не попадает: кусочек видео — по `_storable`, субтитры спрашиваются
        несжатыми и сжатые отвергаются (`subtitles`), — поэтому байты те же, что пришли по сети, и
        предел — это ровно столько памяти, сколько занято."""
        largest = self.segments.largest if limit is None else limit
        body = bytearray()
        try:
            async for chunk in upstream.aiter_bytes():
                body.extend(chunk)
                if len(body) > largest:
                    raise HTTPException(502, "Площадка не отдала данные")
        except httpx.HTTPError:
            raise HTTPException(502, "Площадка не отдала данные") from None
        return bytes(body)

    def _stream(self, upstream: httpx.Response, kind: str | None = None) -> StreamingResponse:
        """Ответ площадки к зрителю как есть: байты без распаковки и заголовки, которые их описывают."""

        async def body():
            try:
                async for chunk in upstream.aiter_raw():
                    yield chunk
            finally:
                await upstream.aclose()

        passed = {
            name: value
            for name, value in upstream.headers.items()
            if name.lower()
            in ("content-length", "content-range", "accept-ranges", "content-type", "content-encoding")
        }
        if kind and "content-type" not in upstream.headers:
            passed["Content-Type"] = kind
        passed["Cache-Control"] = "private, max-age=600"
        return StreamingResponse(body(), status_code=upstream.status_code, headers=passed)


def _plain(upstream: httpx.Response) -> bool:
    """Тело не сжато: его байты — ровно те, что придут по сети."""
    return upstream.headers.get("content-encoding", "identity").strip().lower() in ("", "identity")


def _kept(body: bytes, kind: str) -> Response:
    """Кусочек из общей памяти: браузер держит его у себя, и отмотка назад не качает его снова."""
    return Response(body, media_type=kind, headers={"Cache-Control": "private, max-age=600"})
