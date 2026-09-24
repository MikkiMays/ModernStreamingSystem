"""
Укрепление кинозала без видимых изменений (задача 4): то, что раньше проходило молча, а теперь
отказывает, — и то, что раньше путалось, а теперь различается.

Каждый тест здесь падал на коде до задачи: он называет дыру и доказывает, что она закрыта.
Сцена та же, что у характеристики (`test_cinema_providers.Stage`): остановленные часы,
подменённый yt-dlp и сеть, которая знает только свои ответы.
"""

import json
import unittest

import httpx
from test_cinema_providers import Stage

from cord_services.cinema import Resolve


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
            await self.refused(
                self.cinema.resolve(Resolve(provider=provider, contentId=content)), 400, "Непонятный адрес видео"
            )
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


if __name__ == "__main__":
    unittest.main()
