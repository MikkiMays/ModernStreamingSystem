import unittest

from fastapi import HTTPException

from cord_services.cinema import Cinema, Signer, allowed, master_playlist, rewrite

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
