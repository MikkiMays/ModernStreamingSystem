"""
Укрепление кинозала без видимых изменений (задача 4): то, что раньше проходило молча, а теперь
отказывает, — и то, что раньше путалось, а теперь различается.

Каждый тест здесь падал на коде до задачи: он называет дыру и доказывает, что она закрыта.
Сцена та же, что у характеристики (`test_cinema_providers.Stage`): остановленные часы,
подменённый yt-dlp и сеть, которая знает только свои ответы.
"""

import asyncio
import copy
import json
import re
import time
import unittest
from unittest.mock import patch

import httpx
from test_cinema_providers import Stage

from cord_services.cinema import Cinema, Memo, Resolve
from cord_services.cinema.providers.youtube import YT_FLAT, YouTube
from cord_services.cinema.registry import Kit, Provider, Registry
from cord_services.cinema.resolve import YtDlp


def kit():
    return Kit(memo=Memo(), image=lambda url: None, ytdlp=YtDlp())


class MutatingYoutubeDL:
    """
    Как настоящий `yt_dlp.YoutubeDL`: хранит переданный словарь опций как есть и дописывает в
    него своё (`http_headers`, `compat_opts`, …) — в том числе внутрь вложенных словарей.
    """

    def __init__(self, params):
        params["http_headers"] = {"User-Agent": "yt-dlp"}
        params["compat_opts"] = set()
        for value in params.values():
            if isinstance(value, dict):
                value["touched"] = True

    def __enter__(self):
        return self

    def __exit__(self, *failure):
        return False

    def extract_info(self, address, download=True):
        return {"entries": []}


class IdentifierTests(Stage):
    """
    Идентификатор из браузера уходит в чужой адрес — поэтому проверяется целиком.

    Прежние проверки стояли на `re.match(r"^…$")`, а `$` в Python совпадает и перед
    завершающим переводом строки: `UCabc\\n` проходил и уезжал в адрес yt-dlp и в текст запроса
    GraphQL. `contentId` в `resolve` не проверялся вовсе (у pydantic `pattern` — поиск, а не
    совпадение целиком): `aqz-KE-bpKQ&list=…` дописывал параметры в адрес страницы YouTube.
    """

    async def test_a_line_break_after_an_id_is_refused_before_anything_is_asked(self):
        for action, detail in (
            (lambda: self.cinema.channel("youtube", "UCabcdefghij\n", "videos", ""), "Непонятное имя канала"),
            (lambda: self.cinema.channel("twitch", "someone\n", "videos", ""), "Непонятное имя канала"),
            (lambda: self.cinema.playlist("youtube", "PLabcdefghij\n", ""), "Непонятный адрес плейлиста"),
            (lambda: self.cinema.category("twitch", "743\n", ""), "Непонятный раздел"),
            (lambda: self.cinema.details("youtube", "aqz-KE-bpKQ\n", "video"), "Непонятный адрес видео"),
            (lambda: self.cinema.details("twitch", "2000000001\n", "video"), "Непонятный адрес видео"),
        ):
            await self.refused(action(), 400, detail)
        self.assertEqual(self.library.calls, [])
        self.assertEqual(self.seen, [])

    async def test_a_content_id_is_the_whole_platform_form_or_nothing(self):
        for provider, content in (
            ("youtube", "aqz-KE-bpKQ&list=PLabcdefghij"),
            ("youtube", "aqz-KE-bpKQ\n"),
            ("youtube", "../../feed/history"),
            ("twitch", "someone/videos"),
            ("twitch", "some one"),
        ):
            request = Resolve(provider=provider, contentId=content)
            await self.refused(self.cinema.resolve(request), 400, "Непонятный адрес видео")
        self.assertEqual(self.library.calls, [])
        self.assertEqual(self.kept(self.cinema.sources), {})


class TwitchQueryTests(Stage):
    """Строка в GraphQL Twitch — настоящий строковый литерал, а не текст между кавычками."""

    def serve(self, request):
        # Любой поиск отвечает пустым списком: здесь важен сам запрос, а не ответ.
        self.seen.append(request)
        empty = {"searchFor": {"channels": {"items": []}, "games": {"items": []}}}
        return httpx.Response(200, json={"data": empty})

    async def test_quotes_backslashes_and_line_breaks_travel_as_they_were_typed(self):
        # Раньше кавычки и обратные косые черты заменялись пробелами (искался другой текст), а
        # перевод строки уходил в литерал как есть — и Twitch отвечал синтаксической ошибкой.
        typed = 'a"b\\c\nd") { __typename } #'
        await self.cinema.search("twitch", typed, "")
        asked = self.gql_asked()
        self.assertEqual(len(asked), 2)
        for query in asked:
            start = query.index("userQuery: ") + len("userQuery: ")
            # Нестрогий разбор: на старом коде перевод строки стоял в литерале как есть.
            value, end = json.JSONDecoder(strict=False).raw_decode(query, start)
            self.assertEqual(value, typed)
            # После литерала — ровно то, что стояло в шаблоне: ввод из строки не вышел.
            self.assertTrue(query[end:].startswith(', platform: "web", target: {index: '), query)


class MemoryKeyTests(Stage):
    """Ключи памяти: у каждой площадки свои, и регистр в них значит то же, что у площадки."""

    async def test_video_ids_that_differ_only_in_case_are_different_videos(self):
        # Идентификаторы YouTube различают регистр: `aqz-KE-bpKQ` и `aqz-ke-bpkq` — два ролика.
        # Память, сложившая их в один ключ, показывала бы у второго страницу первого.
        self.library.answers["https://www.youtube.com/watch?v=aqz-KE-bpKQ"] = {"title": "Первый"}
        self.library.answers["https://www.youtube.com/watch?v=aqz-ke-bpkq"] = {"title": "Второй"}
        first = await self.cinema.details("youtube", "aqz-KE-bpKQ", "video")
        second = await self.cinema.details("youtube", "aqz-ke-bpkq", "video")
        self.assertEqual((first["title"], second["title"]), ("Первый", "Второй"))

    async def test_playlists_that_differ_only_in_case_are_different_playlists(self):
        for playlist in ("PLabcdefghij", "PLABCDEFGHIJ"):
            self.library.answers[f"https://www.youtube.com/playlist?list={playlist}"] = {"title": playlist}
        first = await self.cinema.playlist("youtube", "PLabcdefghij", "")
        second = await self.cinema.playlist("youtube", "PLABCDEFGHIJ", "")
        self.assertEqual(
            (first["playlist"]["title"], second["playlist"]["title"]), ("PLabcdefghij", "PLABCDEFGHIJ")
        )

    async def test_channels_that_differ_only_in_case_are_different_channels(self):
        for channel in ("UCabcdefghij", "UCABCDEFGHIJ"):
            self.library.answers[f"https://www.youtube.com/channel/{channel}/videos"] = {"channel": channel}
        first = await self.cinema.channel("youtube", "UCabcdefghij", "videos", "")
        second = await self.cinema.channel("youtube", "UCABCDEFGHIJ", "videos", "")
        self.assertEqual(
            (first["channel"]["title"], second["channel"]["title"]), ("UCabcdefghij", "UCABCDEFGHIJ")
        )

    async def test_a_query_shaped_like_the_shelf_key_is_still_a_search_for_videos(self):
        # Лента роликов и полка каналов лежали под `search:youtube:<запрос>` и
        # `search:youtube:channels:<запрос>`: набранное «channels:big buck» попадало в полку
        # каналов по «big buck» и показывало каналы вместо роликов.
        shelf = "https://www.youtube.com/results?search_query=big+buck&sp=EgIQAg%3D%3D"
        self.library.answers["ytsearch60:big buck"] = {"entries": []}
        self.library.answers[shelf] = {"entries": [{"channel_id": "UCshelf", "channel": "Полка"}]}
        self.library.answers["ytsearch60:channels:big buck"] = {"entries": [{"id": "vid00000001"}]}
        await self.cinema.search("youtube", "big buck", "")
        found = await self.cinema.search("youtube", "channels:big buck", "")
        self.assertEqual([(item["kind"], item["id"]) for item in found["items"]], [("video", "vid00000001")])

    async def test_every_key_starts_with_the_platform_it_belongs_to(self):
        # Правило одно для фасада и для площадок: чужая площадка не может ни прочитать, ни
        # затереть твой ответ, даже если у неё найдётся ролик с таким же номером.
        self.library.answers["https://www.youtube.com/watch?v=aqz-KE-bpKQ"] = {"title": "t"}
        self.library.answers["https://www.youtube.com/playlist?list=PLabcdefghij"] = {"title": "p"}
        self.library.answers["https://www.youtube.com/channel/UCabcdefghij/videos"] = {"channel": "c"}
        self.library.answers["ytsearch60:x y"] = {"entries": []}
        self.library.answers["https://www.youtube.com/results?search_query=x+y&sp=EgIQAg%3D%3D"] = {}
        await self.cinema.details("youtube", "aqz-KE-bpKQ", "video")
        await self.cinema.playlist("youtube", "PLabcdefghij", "")
        await self.cinema.channel("youtube", "UCabcdefghij", "videos", "")
        await self.cinema.search("youtube", "x y", "")
        self.assertTrue(self.cinema.catalog._items)
        for key in self.cinema.catalog._items:
            self.assertTrue(key.startswith("youtube:"), key)


class UpstreamFailureTests(Stage):
    """Сбой по дороге к площадке — это «площадка не ответила» (502), а не ошибка сервера (500)."""

    URL = "https://rr1.googlevideo.com/videoplayback?id=1"

    def serve(self, request):
        self.seen.append(request)
        if isinstance(self.failure, Exception):
            raise self.failure
        return self.failure

    async def test_twitch_that_cannot_be_reached_or_answers_garbage_is_a_bad_gateway(self):
        for failure in (
            httpx.ConnectError("нет сети"),
            httpx.ReadTimeout("молчит"),
            httpx.Response(200, content=b"<html>not json</html>"),
            httpx.Response(200, json=["not", "an", "object"]),
        ):
            self.failure = failure
            refusal = "Twitch не ответил на запрос каталога"
            await self.refused(self.cinema.search("twitch", "", ""), 502, refusal)
        self.assertEqual(self.kept(self.cinema.catalog), {})

    async def test_a_search_yt_dlp_could_not_do_is_a_bad_gateway_cut_short(self):
        self.library.answers["ytsearch60:big buck"] = RuntimeError("HTTP Error 429: " + "x" * 300)
        await self.refused(
            self.cinema.search("youtube", "big buck", "30"),
            502,
            ("Поиск не удался: HTTP Error 429: " + "x" * 300)[:200],
        )

    async def test_a_playlist_or_a_piece_that_cannot_be_reached_is_a_bad_gateway(self):
        self.failure = httpx.ConnectError("нет сети")
        await self.refused(self.cinema.manifest(self.URL), 502, "Площадка не отдала плейлист")
        for range_header in (None, "bytes=0-100"):
            await self.refused(self.cinema.fetch(self.URL, range_header), 502, "Площадка не отдала данные")


class YtDlpOptionTests(unittest.TestCase):
    """yt-dlp получает свою копию опций: общий словарь места вызова он испортить не может."""

    def test_the_shared_search_options_stay_as_written(self):
        # Настоящий YoutubeDL дописывал `http_headers` и прочее прямо в модульный `YT_FLAT`, и
        # после первого поиска эти ключи уезжали в каждый следующий вызов — одним объектом на
        # все потоки `to_thread`.
        before = copy.deepcopy(YT_FLAT)
        with patch("yt_dlp.YoutubeDL", MutatingYoutubeDL):
            YouTube(kit())._videos("big buck", 1)
        self.assertEqual(YT_FLAT, before)

    def test_nested_options_are_copied_too(self):
        options = {"quiet": True, "extractor_args": {"youtube": {"player_client": ["web"]}}}
        before = copy.deepcopy(options)
        with patch("yt_dlp.YoutubeDL", MutatingYoutubeDL):
            YtDlp().extract("ytsearch1:x", options)
        self.assertEqual(options, before)


class DeclarationTests(unittest.TestCase):
    """Площадка без обязательного объявления падает при импорте, а не отказом 500 на запросе."""

    def test_a_platform_without_a_name_id_or_form_does_not_load(self):
        form = re.compile(r"[0-9]{1,12}")
        for missing, body in (
            ("name", {"id": "nameless", "content_id": form}),
            ("id", {"name": "Без id", "content_id": form}),
            ("content_id", {"id": "formless", "name": "Без формы"}),
        ):
            with self.assertRaises(TypeError) as failure:
                type("Broken", (Provider,), body)
            self.assertIn(missing, str(failure.exception))

    def test_an_id_must_be_a_short_lowercase_word(self):
        # Имя площадки становится префиксом ключей памяти, частью подписи и именем переменной
        # `CINEMA_PROXY_<ID>` — в нём не место пробелам, двоеточиям и заглавным.
        for bad in ("You Tube", "YouTube", "you:tube", "", "x" * 33, 7):
            with self.assertRaises(TypeError):
                type("Broken", (Provider,), {"id": bad, "name": "X", "content_id": re.compile(r"x")})

    def test_a_form_must_be_a_compiled_pattern(self):
        with self.assertRaises(TypeError):
            type("Broken", (Provider,), {"id": "stringy", "name": "X", "content_id": r"[0-9]+"})

    def test_a_shared_base_may_leave_the_declaration_to_its_heirs(self):
        class Base(Provider, abstract=True):
            pass

        class Heir(Base):
            id = "heir"
            name = "Наследник"
            content_id = re.compile(r"[0-9]+")

        self.assertEqual(Heir(kit()).refuse("search").detail, "У площадки Наследник такого нет")
        with self.assertRaises(TypeError):
            type("Orphan", (Base,), {"id": "orphan"})


class AvailabilityTests(unittest.IsolatedAsyncioTestCase):
    """
    Одна площадка, чья проверка упала или замолчала, не роняет весь список.

    Раньше `providers` собирал ответы `asyncio.gather` без защиты: исключение одной площадки
    превращало ответ в 500 для всех, а зависшая проверка держала список, пока не ответит.
    """

    async def test_a_broken_or_silent_check_marks_only_its_platform_unavailable(self):
        def platform(key, check=None):
            body = {"id": key, "name": key.title(), "content_id": re.compile(r"x")}
            if check:
                body["availability"] = check
            return type(key.title(), (Provider,), body)(kit())

        async def broken(self):
            raise RuntimeError("ключ в логе не нужен")

        async def silent(self):
            await asyncio.sleep(3600)

        cinema = Cinema("secret")
        self.addAsyncCleanup(cinema.close)
        cinema.registry = Registry(
            [
                platform("broken", broken),
                platform("silent", silent),
                platform("quiet", silent),
                platform("fine"),
            ]
        )
        started = time.monotonic()
        with patch.object(Cinema, "AVAILABILITY_TIMEOUT", 0.05, create=True):
            with self.assertLogs("cord_services.cinema.facade", "WARNING") as log:
                answer = await asyncio.wait_for(cinema.providers(), 1)
        self.assertLess(time.monotonic() - started, 0.5)
        self.assertEqual(
            [(entry["id"], entry["available"], entry["reason"]) for entry in answer["providers"]],
            [
                ("broken", False, "Не удалось проверить площадку"),
                ("silent", False, "Площадка не ответила вовремя"),
                ("quiet", False, "Площадка не ответила вовремя"),
                ("fine", True, None),
            ],
        )
        # В журнал — чья проверка и чем упала, но не текст исключения: в нём бывают адреса с ключами.
        self.assertEqual(len(log.records), 1)
        self.assertIn("broken", log.output[0])
        self.assertNotIn("ключ в логе", log.output[0])


if __name__ == "__main__":
    unittest.main()
