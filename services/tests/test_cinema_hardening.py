"""
Укрепление кинозала без видимых изменений (задача 4): то, что раньше проходило молча, а теперь
отказывает, — и то, что раньше путалось, а теперь различается.

Каждый тест здесь падал на коде до задачи: он называет дыру и доказывает, что она закрыта.
Сцена та же, что у характеристики (`test_cinema_providers.Stage`): остановленные часы,
подменённый yt-dlp и сеть, которая знает только свои ответы.
"""

import unittest

from test_cinema_providers import Stage


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
