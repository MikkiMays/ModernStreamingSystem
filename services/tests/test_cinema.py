import asyncio
import unittest

from fastapi import HTTPException

from cord_services.cinema import (
    Cinema,
    Memo,
    Reels,
    Signer,
    allowed,
    finished_playlist,
    master_playlist,
    rewrite,
)

MASTER = """#EXTM3U
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",URI="https://manifest.googlevideo.com/api/manifest/hls_playlist/audio"
#EXT-X-STREAM-INF:BANDWIDTH=310801,RESOLUTION=426x240
https://manifest.googlevideo.com/api/manifest/hls_playlist/itag/229/file/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=7417746,RESOLUTION=1920x1080
../other/index.m3u8
"""

MEDIA = """#EXTM3U
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI="https://rr5.googlevideo.com/videoplayback/init.mp4"
#EXTINF:4.033333,
https://rr5.googlevideo.com/videoplayback/seg1.ts
#EXTINF:4.033333,
seg2.ts
#EXT-X-ENDLIST
"""

LIVE = """#EXTM3U
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:8410
#EXTINF:2.0,
https://video-edge-1.hls.ttvnw.net/v1/segment/8410.ts
#EXTINF:2.0,
https://video-edge-1.hls.ttvnw.net/v1/segment/8411.ts
"""


class SignatureTests(unittest.TestCase):
    def setUp(self):
        self.signer = Signer("secret")

    def test_round_trip(self):
        url = "https://rr5.googlevideo.com/videoplayback?id=1"
        parts = self.signer.sign(url)
        self.assertEqual(self.signer.open(parts["u"], parts["e"], parts["s"]), url)

    def test_forged_signature_is_refused(self):
        parts = self.signer.sign("https://rr5.googlevideo.com/a")
        with self.assertRaises(HTTPException) as refusal:
            self.signer.open(parts["u"], parts["e"], "0" * 32)
        self.assertEqual(refusal.exception.status_code, 403)

    def test_another_secret_cannot_sign_for_us(self):
        parts = Signer("other").sign("https://rr5.googlevideo.com/a")
        with self.assertRaises(HTTPException):
            self.signer.open(parts["u"], parts["e"], parts["s"])

    def test_expired_link_is_gone_not_forbidden(self):
        parts = self.signer.sign("https://rr5.googlevideo.com/a", ttl=-10)
        with self.assertRaises(HTTPException) as refusal:
            self.signer.open(parts["u"], parts["e"], parts["s"])
        self.assertEqual(refusal.exception.status_code, 410)

    def test_only_the_two_platforms_are_proxied(self):
        # Иначе это открытый прокси: подпись есть, но пускать в чужую сеть всё равно нельзя.
        self.assertTrue(allowed("https://rr5---sn-x.googlevideo.com/videoplayback"))
        self.assertTrue(allowed("https://video-weaver.fra05.hls.ttvnw.net/v1/playlist.m3u8"))
        self.assertFalse(allowed("https://example.com/video.mp4"))
        self.assertFalse(allowed("http://rr5.googlevideo.com/videoplayback"))
        self.assertFalse(allowed("https://evil.com/?x=googlevideo.com"))

    def test_a_foreign_host_is_refused_even_with_a_good_signature(self):
        parts = self.signer.sign("https://example.com/secret")
        with self.assertRaises(HTTPException) as refusal:
            self.signer.open(parts["u"], parts["e"], parts["s"])
        self.assertEqual(refusal.exception.status_code, 403)


class PlaylistTests(unittest.TestCase):
    def setUp(self):
        self.signer = Signer("secret")

    def test_master_and_media_are_told_apart(self):
        self.assertTrue(master_playlist(MASTER))
        self.assertFalse(master_playlist(MEDIA))

    def test_master_sends_every_child_through_the_playlist_route(self):
        body = rewrite(MASTER, "https://manifest.googlevideo.com/api/manifest/x/", self.signer)
        self.assertNotIn("googlevideo.com", body.replace("#EXT-X", ""))
        self.assertEqual(body.count("/api/v1/services/cinema/playlist?"), 3)
        # Относительный адрес разворачивается по базе, а не теряется.
        self.assertNotIn("../other", body)

    def test_media_sends_segments_keys_and_maps_through_the_byte_route(self):
        body = rewrite(MEDIA, "https://rr5.googlevideo.com/videoplayback/", self.signer)
        self.assertEqual(body.count("/api/v1/services/cinema/fetch?"), 3)
        self.assertIn("#EXT-X-ENDLIST", body)
        self.assertIn("#EXTINF:4.033333,", body)

    def test_foreign_links_inside_a_playlist_are_left_alone(self):
        body = rewrite(
            "#EXTM3U\n#EXTINF:1,\nhttps://example.com/seg.ts\n",
            "https://rr5.googlevideo.com/",
            self.signer,
        )
        self.assertIn("https://example.com/seg.ts", body)


class NumberedPlaylistTests(unittest.TestCase):
    """
    Фильм целиком нумеруется, живой эфир — подписывается.

    Речь не об экономии на пустом месте: у YouTube один адрес сегмента — тысяча двести
    символов, и тринадцатичасовой ролик превращался в шестнадцать мегабайт, которые браузер
    обязан скачать до первого кадра.
    """

    def setUp(self):
        self.signer = Signer("secret")
        self.reels = Reels(self.signer, ttl=60)

    def test_a_finished_film_is_told_from_a_live_edge(self):
        self.assertTrue(finished_playlist(MEDIA))
        self.assertFalse(finished_playlist(LIVE))

    def test_segments_of_a_film_become_short_relative_numbers(self):
        body = rewrite(MEDIA, "https://rr5.googlevideo.com/videoplayback/", self.signer, self.reels)
        lines = [line for line in body.splitlines() if line and not line.startswith("#")]
        self.assertEqual(len(lines), 2)
        for number, line in enumerate(lines):
            key, index = line.split("/")[1], int(line.split("/")[2])
            self.assertEqual(index, number)
            self.assertLess(len(line), 40)
            self.assertTrue(self.reels.find(key, index).startswith("https://rr5.googlevideo.com/"))
        # Относительный адрес развёрнут по базе, а не оставлен как был.
        self.assertIn("videoplayback/seg2.ts", self.reels.find(key, 1))
        # Карта инициализации — одна на плейлист, ей нумерация ни к чему.
        self.assertIn("/api/v1/services/cinema/fetch?", body)

    def test_a_live_edge_keeps_signatures_because_its_numbers_move(self):
        body = rewrite(LIVE, "https://video-edge-1.hls.ttvnw.net/v1/", self.signer, self.reels)
        self.assertEqual(body.count("/api/v1/services/cinema/fetch?"), 2)
        self.assertNotIn("seg/", body)

    def test_the_same_playlist_is_one_list_for_the_whole_room(self):
        base = "https://rr5.googlevideo.com/videoplayback/"
        first = rewrite(MEDIA, base, self.signer, self.reels)
        second = rewrite(MEDIA, base, self.signer, self.reels)
        self.assertEqual(first, second)

    def test_a_forgotten_list_is_gone_rather_than_wrong(self):
        stale = Reels(self.signer, ttl=-1)
        key = stale.remember("https://rr5.googlevideo.com/x", ["https://rr5.googlevideo.com/a.ts"])
        with self.assertRaises(HTTPException) as refusal:
            stale.find(key, 0)
        self.assertEqual(refusal.exception.status_code, 410)

    def test_a_number_outside_the_film_is_not_a_server_error(self):
        key = self.reels.remember("https://rr5.googlevideo.com/x", ["https://rr5.googlevideo.com/a.ts"])
        with self.assertRaises(HTTPException) as refusal:
            self.reels.find(key, 7)
        self.assertEqual(refusal.exception.status_code, 404)

    def test_another_secret_cannot_name_a_list(self):
        url = "https://rr5.googlevideo.com/x"
        self.assertNotEqual(self.reels.remember(url, []), Signer("other").name(url))

    def test_only_the_watched_list_survives_a_full_shelf(self):
        small = Reels(self.signer, ttl=60, capacity=2)
        keys = [
            small.remember(f"https://rr5.googlevideo.com/{name}", [f"https://rr5.googlevideo.com/{name}.ts"])
            for name in "ab"
        ]
        small.find(keys[0], 0)  # первый смотрят прямо сейчас
        small.remember("https://rr5.googlevideo.com/c", ["https://rr5.googlevideo.com/c.ts"])
        self.assertTrue(small.find(keys[0], 0))
        with self.assertRaises(HTTPException):
            small.find(keys[1], 0)


class MemoTests(unittest.TestCase):
    """Один разбор на комнату: пятеро зрителей одного ролика — это один запрос наружу."""

    def test_the_first_caller_works_and_the_rest_wait_for_the_answer(self):
        memo = Memo()
        calls = 0

        async def produce():
            nonlocal calls
            calls += 1
            await asyncio.sleep(0.01)
            return {"live": False}

        async def room():
            return await asyncio.gather(*(memo.get("k", produce, 60) for _ in range(5)))

        answers = asyncio.run(room())
        self.assertEqual(calls, 1)
        self.assertEqual(len(answers), 5)

    def test_a_stale_answer_is_asked_again(self):
        memo = Memo()
        calls = 0

        async def produce():
            nonlocal calls
            calls += 1
            return calls

        async def twice():
            first = await memo.get("k", produce, -1)
            return first, await memo.get("k", produce, -1)

        self.assertEqual(asyncio.run(twice()), (1, 2))

    def test_how_long_to_keep_may_depend_on_the_answer(self):
        # Живой эфир держится меньше ролика: его адреса обновляются чаще, чем афиша.
        memo = Memo()
        calls = 0

        async def produce():
            nonlocal calls
            calls += 1
            return {"live": True}

        async def twice():
            keep = lambda value: -1 if value["live"] else 3600  # noqa: E731
            await memo.get("k", produce, keep)
            await memo.get("k", produce, keep)

        asyncio.run(twice())
        self.assertEqual(calls, 2)


class StreamChoiceTests(unittest.TestCase):
    def test_hls_master_wins_because_it_carries_every_quality(self):
        info = {
            "formats": [
                {"protocol": "https", "url": "https://x/file.mp4", "acodec": "aac", "vcodec": "h264", "height": 360},
                {"protocol": "m3u8_native", "manifest_url": "https://m/master.m3u8"},
            ]
        }
        self.assertEqual(Cinema._stream(info), ("https://m/master.m3u8", "hls"))

    def test_without_a_playlist_the_best_complete_file_is_taken(self):
        info = {
            "formats": [
                {"protocol": "https", "url": "https://x/360.mp4", "acodec": "aac", "vcodec": "h264", "height": 360},
                {"protocol": "https", "url": "https://x/720.mp4", "acodec": "aac", "vcodec": "h264", "height": 720},
                {"protocol": "https", "url": "https://x/1080.mp4", "acodec": "none", "vcodec": "h264", "height": 1080},
            ]
        }
        self.assertEqual(Cinema._stream(info), ("https://x/720.mp4", "file"))

    def test_nothing_playable_is_an_honest_nothing(self):
        self.assertEqual(Cinema._stream({"formats": []}), (None, "file"))




class SegmentMemoryTests(unittest.TestCase):
    def setUp(self):
        from cord_services.cinema import Segments

        self.cache = Segments(capacity=1000, ttl=60)

    def test_a_kept_segment_is_served_from_memory(self):
        self.cache.put("u", b"abc", "video/mp2t")
        self.assertEqual(self.cache.get("u"), (b"abc", "video/mp2t"))

    def test_stale_segments_are_forgotten(self):
        from cord_services.cinema import Segments

        short = Segments(capacity=1000, ttl=-1)
        short.put("u", b"abc", "video/mp2t")
        self.assertIsNone(short.get("u"))

    def test_the_oldest_leaves_when_memory_is_full(self):
        for name in "abcd":
            self.cache.put(name, b"x" * 300, "video/mp2t")
        kept = [name for name in "abcd" if self.cache.get(name)]
        self.assertEqual(kept, ["b", "c", "d"])

    def test_a_segment_too_large_is_not_kept_at_all(self):
        big = b"x" * (12 * 1024 * 1024 + 1)
        self.cache.put("big", big, "video/mp2t")
        self.assertIsNone(self.cache.get("big"))


if __name__ == "__main__":
    unittest.main()
