import struct
import unittest
import asyncio
import httpx
from unittest.mock import patch
from xml.etree import ElementTree as ET

from cord_services.dash import (
    MAX_PREFIX,
    mp4_ranges,
    manifest,
    candidates,
    read_ranges,
    codec_group,
)
from cord_services.cinema import Cinema, Resolve


def box(kind, payload=b""):
    return struct.pack(">I4s", len(payload) + 8, kind) + payload


def sample():
    # One media reference, 1000 Hz, 10 seconds.
    sidx = struct.pack(">IIIIIHHIII", 0, 1, 1000, 0, 0, 0, 1, 100, 10000, 0)
    return box(b"ftyp", b"isom0000") + box(b"moov", b"meta") + box(b"sidx", sidx)


class IndexTests(unittest.TestCase):
    def test_codec_levels_share_a_ladder_but_profiles_and_bit_depth_do_not(self):
        self.assertEqual(codec_group("av01.0.08M.08"), codec_group("av01.0.12M.08"))
        self.assertNotEqual(codec_group("av01.0.12M.08"), codec_group("av01.2.12M.10"))
        self.assertNotEqual(codec_group("av01.0.12M.08"), codec_group("av01.0.12M.10"))
        self.assertEqual(codec_group("avc1.4d4020"), codec_group("avc1.64002a"))
        self.assertNotEqual(codec_group("avc1.64002a"), codec_group("avc1.6e002a"))
        self.assertEqual(codec_group("vp09.00.41.08"), codec_group("vp09.00.50.08"))
        self.assertNotEqual(codec_group("vp09.00.50.08"), codec_group("vp09.02.50.10"))

    def test_exact_ranges(self):
        data = sample()
        self.assertEqual(mp4_ranges(data), ((0, 27), (28, len(data) - 1)))

    def test_incomplete_and_invalid_indexes_are_not_invented(self):
        self.assertIsNone(mp4_ranges(sample()[:40]))
        for data in [
            box(b"mdat", b"x"),
            box(b"ftyp") + box(b"sidx"),
            struct.pack(">I4s", 3, b"moov"),
        ]:
            with self.assertRaises(ValueError):
                mp4_ranges(data)

    def test_extended_boxes_and_version_one_index(self):
        init = box(b"ftyp", b"isom0000") + struct.pack(">I4sQ", 1, b"moov", 20) + b"meta"
        index = box(
            b"sidx", struct.pack(">IIIQQHHIII", 1 << 24, 1, 1000, 0, 0, 0, 1, 100, 10000, 0)
        )
        self.assertEqual(
            mp4_ranges(init + index), ((0, len(init) - 1), (len(init), len(init + index) - 1))
        )
        with self.assertRaises(ValueError):
            mp4_ranges(init + index, len(init + index) + 99)

    def test_zero_timescale_and_nested_references_are_rejected(self):
        data = bytearray(sample())
        struct.pack_into(">I", data, 28 + 8 + 8, 0)
        with self.assertRaises(ValueError):
            mp4_ranges(bytes(data))
        data = bytearray(sample())
        struct.pack_into(">I", data, 28 + 8 + 24, (1 << 31) | 100)
        with self.assertRaises(ValueError):
            mp4_ranges(bytes(data))

    def test_codecs_and_languages_stay_separate_and_best_bitrate_survives(self):
        def fmt(id, codec, bitrate, language=""):
            return dict(
                format_id=id,
                url="https://r.googlevideo.com/" + id,
                ext="mp4",
                protocol="https",
                vcodec=codec,
                acodec="none",
                height=1080,
                width=1920,
                fps=60,
                tbr=bitrate,
                language=language,
            )

        formats = [
            fmt("a", "avc1.64002a", 1000),
            fmt("b", "avc1.64002a", 4000),
            fmt("c", "av01.0.08M.08", 2000),
        ]
        formats += [
            dict(
                format_id=lang,
                url="https://r.googlevideo.com/" + lang,
                ext="m4a",
                protocol="https",
                vcodec="none",
                acodec="mp4a.40.2",
                abr=128,
                language=lang,
            )
            for lang in ["en", "ru"]
        ]
        self.assertEqual({f["format_id"] for f in candidates(formats)}, {"b", "c", "en", "ru"})

    def test_xml_escapes_urls_and_has_real_segment_base(self):
        video = dict(
            format_id="v",
            vcodec="avc1.64002a",
            acodec="none",
            height=1080,
            width=1920,
            fps=60,
            tbr=4000,
        )
        audio = dict(format_id="a", vcodec="none", acodec="mp4a.40.2", abr=128, language="en")
        xml = manifest(
            [
                (video, ((0, 27), (28, 79)), "/fetch?u=x&e=1&s=y"),
                (audio, ((0, 27), (28, 79)), "/fetch?u=z&e=1&s=y"),
            ],
            10,
        )
        root = ET.fromstring(xml)
        ns = {"d": "urn:mpeg:dash:schema:mpd:2011"}
        self.assertEqual(root.attrib["type"], "static")
        self.assertEqual(len(root.findall(".//d:AdaptationSet", ns)), 2)
        self.assertEqual(root.find(".//d:SegmentBase", ns).attrib["indexRange"], "28-79")
        self.assertIn("&amp;", xml)

    def test_audio_codecs_and_languages_do_not_share_an_adaptation_set(self):
        video = dict(vcodec="avc1.64002a", acodec="none", height=1080, width=1920, tbr=4000)
        tracks = [(video, ((0, 27), (28, 79)), "/v")]
        for lang, codec in [("en-orig", "mp4a.40.2"), ("ru", "mp4a.40.2"), ("ru", "mp4a.40.5")]:
            tracks.append(
                (
                    dict(vcodec="none", acodec=codec, abr=128, language=lang),
                    ((0, 27), (28, 79)),
                    "/a",
                )
            )
        root = ET.fromstring(manifest(tracks, 10))
        ns = {"d": "urn:mpeg:dash:schema:mpd:2011"}
        self.assertEqual(len(root.findall(".//d:AdaptationSet", ns)), 4)
        self.assertEqual(root.find(".//d:Role", ns).attrib["value"], "main")
        self.assertEqual(root.find(".//d:Label", ns).text, "en - original")
        self.assertEqual(root.findall(".//d:SupplementalProperty", ns), [])


class RangeTests(unittest.IsolatedAsyncioTestCase):
    async def test_media_and_manifests_never_follow_a_redirect_to_an_unapproved_host(self):
        seen = []

        def serve(request):
            seen.append(str(request.url))
            return httpx.Response(302, headers={"location": "http://127.0.0.1/private"})

        async with httpx.AsyncClient(
            transport=httpx.MockTransport(serve), follow_redirects=True
        ) as client:
            cinema = Cinema("secret", client)
            for action in [
                lambda: cinema.fetch("https://r.googlevideo.com/a", "bytes=0-100"),
                lambda: cinema.fetch("https://r.googlevideo.com/a", None),
                lambda: cinema.manifest("https://r.googlevideo.com/a", None, "youtube"),
            ]:
                with self.assertRaises(Exception) as failure:
                    await action()
                self.assertEqual(failure.exception.status_code, 502)
        self.assertEqual(seen, ["https://r.googlevideo.com/a"] * 3)

    async def test_range_budget_grows_only_until_real_index(self):
        payload = box(b"ftyp", b"isom0000") + box(b"free", b"x" * 70000) + sample()[16:]
        requested = []

        def serve(request):
            requested.append(request.headers["range"])
            end = min(int(request.headers["range"].split("-")[1]), len(payload) - 1)
            return httpx.Response(
                206,
                headers={"content-range": f"bytes 0-{end}/{len(payload) + 100}"},
                content=payload[: end + 1],
            )

        async with httpx.AsyncClient(transport=httpx.MockTransport(serve)) as client:
            result = await read_ranges(client, "https://r.googlevideo.com/a", asyncio.Semaphore(4))
        self.assertEqual(requested, ["bytes=0-65535", "bytes=0-131071"])
        self.assertEqual(result[1][1], len(payload) - 1)

    async def test_ignored_redirected_truncated_and_oversized_ranges_are_rejected(self):
        for response in [
            httpx.Response(200, content=sample()),
            httpx.Response(302, headers={"location": "http://127.0.0.1/private"}),
            httpx.Response(206, headers={"content-range": "bytes 0-100/200"}, content=b"x"),
            httpx.Response(206, headers={"content-range": "bytes 0-100000/200000"}, content=b"x"),
        ]:
            async with httpx.AsyncClient(
                transport=httpx.MockTransport(lambda _: response)
            ) as client:
                with self.assertRaises(ValueError):
                    await read_ranges(client, "https://r.googlevideo.com/a", asyncio.Semaphore(4))

    async def test_maximum_prefix_and_concurrency_are_bounded(self):
        active = peak = 0
        requested = []

        async def serve(request):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(0.001)
            end = int(request.headers["range"].split("-")[1])
            requested.append(end + 1)
            active -= 1
            # A long sequence of complete free boxes, no fictitious index.
            return httpx.Response(
                206,
                headers={"content-range": f"bytes 0-{end}/{MAX_PREFIX * 2}"},
                content=box(b"free") * ((end + 1) // 8),
            )

        async with httpx.AsyncClient(transport=httpx.MockTransport(serve)) as client:
            sem = asyncio.Semaphore(4)
            results = await asyncio.gather(
                *(read_ranges(client, "https://r.googlevideo.com/a", sem) for _ in range(6)),
                return_exceptions=True,
            )
        self.assertTrue(all(isinstance(r, ValueError) for r in results))
        self.assertEqual(max(requested), MAX_PREFIX)
        self.assertEqual(peak, 4)

    async def test_opt_in_only_and_expired_manifest(self):
        payload = sample()
        client = httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda _: httpx.Response(
                    206,
                    headers={"content-range": f"bytes 0-{len(payload) - 1}/{len(payload) + 100}"},
                    content=payload,
                )
            )
        )
        cinema = Cinema("secret", client)
        info = {
            "duration": 10,
            "formats": [
                dict(
                    format_id="v",
                    url="https://r.googlevideo.com/v",
                    protocol="https",
                    ext="mp4",
                    vcodec="avc1.64002a",
                    acodec="none",
                    height=1080,
                    width=1920,
                    tbr=3000,
                ),
                dict(
                    format_id="a",
                    url="https://r.googlevideo.com/a",
                    protocol="https",
                    ext="m4a",
                    vcodec="none",
                    acodec="mp4a.40.2",
                    abr=128,
                ),
                dict(
                    format_id="p",
                    url="https://r.googlevideo.com/p",
                    protocol="https",
                    ext="mp4",
                    vcodec="avc1.4d",
                    acodec="mp4a.40.2",
                    height=360,
                ),
            ],
        }
        with patch.object(cinema.ytdlp, "probe", return_value=info):
            old = await cinema.resolve(Resolve(provider="youtube", contentId="abc"))
            new = await cinema.resolve(Resolve(provider="youtube", contentId="abc", adaptive=True))
        self.assertEqual(old["kind"], "file")
        self.assertEqual(new["kind"], "dash")
        key = new["url"].rsplit("/", 1)[-1]
        self.assertIn(b'height="1080"', cinema.dash(key).body)
        with patch("cord_services.cinema.time.time", return_value=new["expiresAt"] / 1000 + 1):
            with self.assertRaises(Exception) as failure:
                cinema.dash(key)
            self.assertEqual(failure.exception.status_code, 410)
        for value in ["bytes=4-1", "bytes=0-2,4-6", "x", "bytes=--"]:
            with self.assertRaises(Exception) as failure:
                await cinema.fetch("https://r.googlevideo.com/a", value)
            self.assertEqual(failure.exception.status_code, 416)
        await cinema.close()
