"""
Надёжность показа YouTube (R216): одна группа звука в мастере, сроки и повтор целого кусочка, чтение вперёд.

Жалоба владельца 09.11.2026 с телевизора: после перемотки на 15 с видео грузилось плохо, потом зависло, а
бывало — картинка шла без звука. Здесь — серверная часть ответа: звук не меняет кодек и адрес при смене
качества, застрявший кусок не держит комнату минуту, следующий кусок уже лежит в памяти, когда плеер его
спросит.
"""

import asyncio
import re
import unittest
from unittest.mock import patch

import httpx
from fastapi import HTTPException

from cord_services.cinema import Cinema, rewrite
from cord_services.cinema import facade
from cord_services.cinema.providers.youtube import YouTube
from cord_services.cinema.transport.signer import Signer
from cord_services.cinema.transport.voices import one_audio_group

SECRET = "secret"
GV = "https://manifest.googlevideo.com/api/manifest/hls_playlist/itag"


def variant(bandwidth, codecs, resolution, rate, group, itag):
    return (
        f'#EXT-X-STREAM-INF:BANDWIDTH={bandwidth},CODECS="{codecs}",RESOLUTION={resolution},'
        f'FRAME-RATE={rate},VIDEO-RANGE=SDR,AUDIO="{group}",CLOSED-CAPTIONS=NONE\n{GV}/{itag}/index.m3u8\n'
    )


def voice(group, name="Default", language=None, itag=None):
    lang = f',LANGUAGE="{language}"' if language else ""
    return (
        f'#EXT-X-MEDIA:URI="{GV}/{itag or group}{language or ""}/index.m3u8",TYPE=AUDIO,GROUP-ID="{group}",'
        f'NAME="{name}"{lang},DEFAULT=YES,AUTOSELECT=YES\n'
    )


# Мастер YouTube в том виде, в каком площадка отдала его 09.11.2026 (`aqz-KE-bpKQ`), без лишних ступеней:
# группа 233 — HE-AAC у 144p и одной из 240p, группа 234 — AAC-LC у остальных.
YOUTUBE = (
    "#EXTM3U\n#EXT-X-INDEPENDENT-SEGMENTS\n"
    + voice("233")
    + voice("234")
    + variant(310801, "avc1.4D4015,mp4a.40.5", "426x240", 30, "233", 229)
    + variant(395368, "avc1.4D4015,mp4a.40.2", "426x240", 30, "234", 230)
    + variant(813450, "avc1.4D401E,mp4a.40.2", "640x360", 30, "234", 231)
    + variant(169684, "avc1.4D400C,mp4a.40.5", "256x144", 30, "233", 269)
    + variant(296277, "vp09.00.20.08,mp4a.40.5", "426x240", 30, "233", 604)
    + variant(380844, "vp09.00.20.08,mp4a.40.2", "426x240", 30, "234", 605)
    + variant(5022446, "vp09.00.41.08,mp4a.40.2", "1920x1080", 60, "234", 617)
)


def groups(body):
    return re.findall(r'AUDIO="([^"]+)"', body), re.findall(r'TYPE=AUDIO,GROUP-ID="([^"]+)"', body)


class OneAudioGroupTests(unittest.TestCase):
    def test_every_quality_of_a_youtube_film_hears_the_same_lc_track(self):
        body = one_audio_group(YOUTUBE)
        used, declared = groups(body)
        self.assertEqual(declared, ["234"])
        self.assertEqual(set(used), {"234"})
        self.assertNotIn("mp4a.40.5", body)

    def test_a_quality_with_a_twin_in_the_kept_group_leaves(self):
        body = one_audio_group(YOUTUBE)
        # 240p H.264 и 240p VP9 есть в обеих группах — остаётся по одной.
        self.assertNotIn("/229/", body)
        self.assertNotIn("/604/", body)
        self.assertIn("/230/", body)
        self.assertIn("/605/", body)
        self.assertEqual(body.count("#EXT-X-STREAM-INF"), 5)
        # Адрес ушедшей ступени уходит вместе с ней, а не повисает чужим адресом под соседней.
        lines = body.splitlines()
        for number, line in enumerate(lines):
            if line.startswith("#EXT-X-STREAM-INF"):
                self.assertFalse(lines[number + 1].startswith("#"))

    def test_a_quality_without_a_twin_moves_and_pays_for_the_better_sound(self):
        body = one_audio_group(YOUTUBE)
        moved = next(line for line in body.splitlines() if "256x144" in line)
        # Разница звука — по двойникам: 395368 − 310801 = 84567 (и у VP9 та же).
        self.assertIn("BANDWIDTH=254251,", moved)
        self.assertIn('CODECS="avc1.4D400C,mp4a.40.2"', moved)
        self.assertIn('AUDIO="234"', moved)

    def test_every_voice_survives_when_both_groups_carry_the_same_languages(self):
        dubbed = (
            "#EXTM3U\n"
            + voice("233", "English original", "en", 1)
            + voice("233", "French dubbed", "fr", 2)
            + voice("234", "English original", "en", 3)
            + voice("234", "French dubbed", "fr", 4)
            + variant(169684, "avc1.4D400C,mp4a.40.5", "256x144", 30, "233", 269)
            + variant(813450, "avc1.4D401E,mp4a.40.2", "640x360", 30, "234", 231)
        )
        body = one_audio_group(dubbed)
        self.assertEqual(groups(body)[1], ["234", "234"])
        self.assertIn('NAME="French dubbed",LANGUAGE="fr"', body)

    def test_groups_with_different_languages_are_not_glued(self):
        uneven = (
            "#EXTM3U\n"
            + voice("a", "English", "en")
            + voice("b", "French", "fr")
            + variant(169684, "avc1.4D400C,mp4a.40.5", "256x144", 30, "a", 1)
            + variant(813450, "avc1.4D401E,mp4a.40.2", "640x360", 30, "b", 2)
        )
        self.assertEqual(one_audio_group(uneven), uneven)

    def test_a_master_with_one_group_or_muxed_sound_is_left_as_it_was(self):
        lc = variant(813450, "avc1.4D401E,mp4a.40.2", "640x360", 30, "234", 1)
        single = "#EXTM3U\n" + voice("234") + lc
        self.assertEqual(one_audio_group(single), single)
        muxed = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="avc1.4d4015,mp4a.40.2"\n180p.m3u8\n'
        self.assertEqual(one_audio_group(muxed), muxed)

    def test_the_proxy_rewrites_masters_with_one_group(self):
        signer = Signer(SECRET, {"youtube": YouTube.hosts}.get)
        body = rewrite(YOUTUBE, GV + "/", signer, provider="youtube")
        self.assertEqual(body.count("#EXT-X-MEDIA:"), 1)
        self.assertEqual(body.count("/api/v1/services/cinema/playlist?"), 6)


class Broken(httpx.AsyncByteStream):
    """Тело, которое обрывается после первых байт — как соединение, сорвавшееся на середине куска."""

    async def __aiter__(self):
        yield b"x" * 10
        raise httpx.ReadError("соединение сорвалось")

    async def aclose(self):
        pass


SEGMENT = "https://rr5---sn-u14g55-5m.googlevideo.com/videoplayback/id/1/itag/311/sq/7"


class SegmentDeliveryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.answers = []
        self.seen = []
        self.cinema = Cinema(SECRET, httpx.AsyncClient(transport=httpx.MockTransport(self.serve)))

    async def asyncTearDown(self):
        await self.cinema.close()

    async def serve(self, request):
        self.seen.append(request)
        answer = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        if answer == "stuck":
            await asyncio.sleep(3600)
        if answer == "broken":
            return httpx.Response(200, headers={"content-length": "100"}, stream=Broken())
        return httpx.Response(200, headers={"content-type": "video/mp2t"}, content=answer)

    async def test_a_piece_broken_halfway_is_asked_again_with_a_new_connection(self):
        self.answers = ["broken", b"z" * 100]
        response = await self.cinema.fetch(SEGMENT, None, "youtube")
        self.assertEqual(response.body, b"z" * 100)
        self.assertEqual(len(self.seen), 2)
        self.assertEqual(self.cinema.retries, 1)
        self.assertEqual(self.cinema.segments.get(SEGMENT), (b"z" * 100, "video/mp2t"))

    async def test_a_piece_broken_every_time_is_an_honest_bad_gateway(self):
        self.answers = ["broken"]
        with self.assertRaises(HTTPException) as caught:
            await self.cinema.fetch(SEGMENT, None, "youtube")
        self.assertEqual(caught.exception.status_code, 502)
        self.assertEqual(len(self.seen), facade.SEGMENT_TRIES)

    async def test_a_piece_has_its_own_short_timeouts(self):
        self.answers = [b"z"]
        await self.cinema.fetch(SEGMENT, None, "youtube")
        asked = self.seen[0].extensions["timeout"]
        self.assertEqual((asked["connect"], asked["read"]), (5.0, 8.0))

    async def test_a_stuck_piece_lets_the_room_go_after_its_deadline(self):
        self.answers = ["stuck", b"z" * 5]
        with patch.object(facade, "SEGMENT_DEADLINE", 0.05):
            with self.assertRaises(HTTPException) as caught:
                await self.cinema.fetch(SEGMENT, None, "youtube")
        self.assertEqual(caught.exception.status_code, 504)
        # Замок кусочка свободен: следующий вопрос того же куска не ждёт застрявший.
        response = await asyncio.wait_for(self.cinema.fetch(SEGMENT, None, "youtube"), 1)
        self.assertEqual(response.body, b"z" * 5)

    async def test_a_range_request_keeps_the_general_timeouts(self):
        # Готовый файл идёт к зрителю потоком, и его чтение ждёт зрителя, а не площадку.
        self.answers = [b"z" * 5]
        response = await self.cinema.fetch(SEGMENT, "bytes=0-4", "youtube")
        await response.upstream.aclose()
        self.assertNotEqual(self.seen[0].extensions["timeout"]["read"], 8.0)


class ReadAheadTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.seen = []
        self.cinema = Cinema(SECRET, httpx.AsyncClient(transport=httpx.MockTransport(self.serve)))
        self.pieces = [f"{SEGMENT}/{n}" for n in range(3)]
        self.key = self.cinema.reels.remember(GV + "/311/index.m3u8", self.pieces, "youtube")

    async def asyncTearDown(self):
        await self.cinema.close()

    def serve(self, request):
        self.seen.append(str(request.url))
        return httpx.Response(200, headers={"content-type": "video/mp2t"}, content=str(request.url).encode())

    async def settle(self):
        await asyncio.gather(*list(self.cinema._ahead))

    async def test_the_next_piece_is_already_in_memory_when_the_player_asks(self):
        self.cinema.ahead(self.key, 0)
        await self.settle()
        self.assertIsNotNone(self.cinema.segments.get(self.pieces[1]))
        self.assertEqual(self.cinema.read_ahead, 1)
        before = len(self.seen)
        response = await self.cinema.fetch(self.pieces[1], None, "youtube")
        self.assertEqual(response.body, self.pieces[1].encode())
        self.assertEqual(len(self.seen), before)

    async def test_a_piece_already_kept_or_past_the_end_is_not_asked_again(self):
        await self.cinema.fetch(self.pieces[1], None, "youtube")
        self.cinema.ahead(self.key, 0)
        self.cinema.ahead(self.key, 2)
        await self.settle()
        self.assertEqual(self.seen, [self.pieces[1]])

    async def test_the_player_and_the_read_ahead_share_one_download(self):
        self.cinema.ahead(self.key, 0)
        response = await self.cinema.fetch(self.pieces[1], None, "youtube")
        await self.settle()
        self.assertEqual(response.body, self.pieces[1].encode())
        self.assertEqual(self.seen.count(self.pieces[1]), 1)

    async def test_reading_ahead_has_a_ceiling_per_server(self):
        with patch.object(facade, "AHEAD_LIMIT", 0):
            self.cinema.ahead(self.key, 0)
        self.assertFalse(self.cinema._ahead)

    async def test_pages_from_anywhere_are_not_read_ahead(self):
        pieces = ["https://example.com/0.ts"] * 2
        key = self.cinema.reels.remember("https://example.com/film.m3u8", pieces, "link")
        self.cinema.ahead(key, 0)
        self.assertFalse(self.cinema._ahead)


if __name__ == "__main__":
    unittest.main()
