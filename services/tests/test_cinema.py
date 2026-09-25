import asyncio
import time
import unittest
from unittest.mock import patch

from fastapi import HTTPException

from cord_services.cinema import (
    PAGE,
    Cinema,
    Memo,
    Reels,
    Signer,
    absolute,
    address,
    allowed,
    finished_playlist,
    master_playlist,
    offset_of,
    page,
    rewrite,
)
from cord_services.cinema.providers.twitch import Twitch
from cord_services.cinema.providers.youtube import YouTube
from cord_services.cinema.resolve import Resolver
from cord_services.cinema.transport.playlists import Reel
from cord_services.cinema.transport.signer import SIGNATURE_TTL

# Политики хостов площадок, как их видит подпись: адрес открывается только своей площадкой.
HOSTS = {"youtube": YouTube.hosts, "twitch": Twitch.hosts}

# Строка EXT-X-MEDIA — один токен без пробелов длиннее 110 знаков; переносить внутри `"""` нельзя
# (это вставило бы настоящий перевод строки в середину тега), поэтому здесь — склейка кусков,
# байт в байт то же самое, чем была одна строка.
MASTER = (
    "#EXTM3U\n"
    "#EXT-X-INDEPENDENT-SEGMENTS\n"
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",'
    'URI="https://manifest.googlevideo.com/api/manifest/hls_playlist/audio"\n'
    "#EXT-X-STREAM-INF:BANDWIDTH=310801,RESOLUTION=426x240\n"
    "https://manifest.googlevideo.com/api/manifest/hls_playlist/itag/229/file/index.m3u8\n"
    "#EXT-X-STREAM-INF:BANDWIDTH=7417746,RESOLUTION=1920x1080\n"
    "../other/index.m3u8\n"
)

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
        self.signer = Signer("secret", HOSTS.get)

    def sign(self, url, ttl=SIGNATURE_TTL, route="fetch", provider="youtube", signer=None):
        return (signer or self.signer).sign(url, ttl, route, provider)

    def open(self, parts, route="fetch"):
        return self.signer.open(route, parts["u"], parts["e"], parts["s"], parts["p"])

    def test_round_trip(self):
        url = "https://rr5.googlevideo.com/videoplayback?id=1"
        self.assertEqual(self.open(self.sign(url)), url)

    def test_forged_signature_is_refused(self):
        parts = self.sign("https://rr5.googlevideo.com/a")
        with self.assertRaises(HTTPException) as refusal:
            self.open({**parts, "s": "0" * 32})
        self.assertEqual(refusal.exception.status_code, 403)

    def test_another_secret_cannot_sign_for_us(self):
        parts = self.sign("https://rr5.googlevideo.com/a", signer=Signer("other", HOSTS.get))
        with self.assertRaises(HTTPException):
            self.open(parts)

    def test_expired_link_is_gone_not_forbidden(self):
        parts = self.sign("https://rr5.googlevideo.com/a", ttl=-10)
        with self.assertRaises(HTTPException) as refusal:
            self.open(parts)
        self.assertEqual(refusal.exception.status_code, 410)

    def test_each_platform_proxies_only_its_own_hosts(self):
        # Иначе это открытый прокси: подпись есть, но пускать в чужую сеть всё равно нельзя. И
        # не общим списком: YouTube не отдаёт через нас адреса Twitch, и наоборот.
        self.assertTrue(allowed("https://rr5---sn-x.googlevideo.com/videoplayback", YouTube.hosts))
        self.assertTrue(allowed("https://video-weaver.fra05.hls.ttvnw.net/v1/playlist.m3u8", Twitch.hosts))
        self.assertFalse(allowed("https://video-weaver.fra05.hls.ttvnw.net/v1/playlist.m3u8", YouTube.hosts))
        self.assertFalse(allowed("https://rr5---sn-x.googlevideo.com/videoplayback", Twitch.hosts))
        for hosts in HOSTS.values():
            self.assertFalse(allowed("https://example.com/video.mp4", hosts))
            self.assertFalse(allowed("https://evil.com/?x=googlevideo.com", hosts))
        self.assertFalse(allowed("http://rr5.googlevideo.com/videoplayback", YouTube.hosts))
        self.assertFalse(allowed("https://rr5.googlevideo.com/videoplayback", None))

    def test_a_foreign_host_is_refused_even_with_a_good_signature(self):
        parts = self.sign("https://example.com/secret")
        with self.assertRaises(HTTPException) as refusal:
            self.open(parts)
        self.assertEqual(refusal.exception.status_code, 403)


class PlaylistTests(unittest.TestCase):
    def setUp(self):
        self.signer = Signer("secret", HOSTS.get)

    def test_master_and_media_are_told_apart(self):
        self.assertTrue(master_playlist(MASTER))
        self.assertFalse(master_playlist(MEDIA))

    def test_master_sends_every_child_through_the_playlist_route(self):
        base = "https://manifest.googlevideo.com/api/manifest/x/"
        body = rewrite(MASTER, base, self.signer, provider="youtube")
        self.assertNotIn("googlevideo.com", body.replace("#EXT-X", ""))
        self.assertEqual(body.count("/api/v1/services/cinema/playlist?"), 3)
        # Относительный адрес разворачивается по базе, а не теряется.
        self.assertNotIn("../other", body)

    def test_media_sends_segments_keys_and_maps_through_the_byte_route(self):
        body = rewrite(MEDIA, "https://rr5.googlevideo.com/videoplayback/", self.signer, provider="youtube")
        self.assertEqual(body.count("/api/v1/services/cinema/fetch?"), 3)
        self.assertIn("#EXT-X-ENDLIST", body)
        self.assertIn("#EXTINF:4.033333,", body)

    def test_foreign_links_inside_a_playlist_are_left_alone(self):
        body = rewrite(
            "#EXTM3U\n#EXTINF:1,\nhttps://example.com/seg.ts\n",
            "https://rr5.googlevideo.com/",
            self.signer,
            provider="youtube",
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
        self.signer = Signer("secret", HOSTS.get)
        self.reels = Reels(self.signer, ttl=60)

    def test_a_finished_film_is_told_from_a_live_edge(self):
        self.assertTrue(finished_playlist(MEDIA))
        self.assertFalse(finished_playlist(LIVE))

    def test_segments_of_a_film_become_short_relative_numbers(self):
        base = "https://rr5.googlevideo.com/videoplayback/"
        body = rewrite(MEDIA, base, self.signer, self.reels, provider="youtube")
        lines = [line for line in body.splitlines() if line and not line.startswith("#")]
        self.assertEqual(len(lines), 2)
        for number, line in enumerate(lines):
            key, index = line.split("/")[1], int(line.split("/")[2])
            self.assertEqual(index, number)
            self.assertLess(len(line), 40)
            self.assertTrue(self.reels.find(key, index).url.startswith("https://rr5.googlevideo.com/"))
            # Кусочек помнит свою площадку: за ним прокси пойдёт её выходом наружу.
            self.assertEqual(self.reels.find(key, index).provider, "youtube")
        # Относительный адрес развёрнут по базе, а не оставлен как был.
        self.assertIn("videoplayback/seg2.ts", self.reels.find(key, 1).url)
        # Карта инициализации — одна на плейлист, ей нумерация ни к чему.
        self.assertIn("/api/v1/services/cinema/fetch?", body)

    def test_a_live_edge_keeps_signatures_because_its_numbers_move(self):
        base = "https://video-edge-1.hls.ttvnw.net/v1/"
        body = rewrite(LIVE, base, self.signer, self.reels, provider="twitch")
        self.assertEqual(body.count("/api/v1/services/cinema/fetch?"), 2)
        self.assertNotIn("seg/", body)

    def test_the_same_playlist_is_one_list_for_the_whole_room(self):
        base = "https://rr5.googlevideo.com/videoplayback/"
        # Часы стоят: строка карты инициализации подписана со сроком, и два разбора на границе
        # секунды иначе отличались бы сроком подписи — тест изредка падал сам по себе.
        with patch("time.time", return_value=1_800_000_000.0):
            first = rewrite(MEDIA, base, self.signer, self.reels, provider="youtube")
            second = rewrite(MEDIA, base, self.signer, self.reels, provider="youtube")
        self.assertEqual(first, second)

    def test_a_forgotten_list_is_gone_rather_than_wrong(self):
        stale = Reels(self.signer, ttl=-1)
        key = stale.remember("https://rr5.googlevideo.com/x", ["https://rr5.googlevideo.com/a.ts"], "youtube")
        with self.assertRaises(HTTPException) as refusal:
            stale.find(key, 0)
        self.assertEqual(refusal.exception.status_code, 410)

    def test_a_number_outside_the_film_is_not_a_server_error(self):
        key = self.reels.remember(
            "https://rr5.googlevideo.com/x", ["https://rr5.googlevideo.com/a.ts"], "youtube"
        )
        with self.assertRaises(HTTPException) as refusal:
            self.reels.find(key, 7)
        self.assertEqual(refusal.exception.status_code, 404)

    def test_another_secret_cannot_name_a_list(self):
        url = "https://rr5.googlevideo.com/x"
        other = Reels(Signer("other"))
        self.assertNotEqual(self.reels.remember(url, [], "youtube"), other.remember(url, [], "youtube"))

    def test_one_address_under_two_platforms_is_two_lists(self):
        # Площадка с любыми хостами (ссылка) может разобрать тот же плейлист, что и YouTube, но
        # отобрать в нём другие строки: общий список сбил бы нумерацию и выход наружу обоим.
        url = "https://rr5.googlevideo.com/x"
        youtube = self.reels.remember(url, ["https://rr5.googlevideo.com/a.ts"], "youtube")
        both = ["https://example.org/b.ts", "https://rr5.googlevideo.com/a.ts"]
        other = self.reels.remember(url, both, "link")
        self.assertNotEqual(youtube, other)
        self.assertEqual(self.reels.find(youtube, 0), Reel("https://rr5.googlevideo.com/a.ts", "youtube"))
        self.assertEqual(self.reels.find(other, 0), Reel("https://example.org/b.ts", "link"))
        with self.assertRaises(HTTPException):
            self.reels.find(youtube, 1)

    def test_only_the_watched_list_survives_a_full_shelf(self):
        small = Reels(self.signer, ttl=60, capacity=2)
        keys = [
            small.remember(
                f"https://rr5.googlevideo.com/{name}", [f"https://rr5.googlevideo.com/{name}.ts"], "youtube"
            )
            for name in "ab"
        ]
        small.find(keys[0], 0)  # первый смотрят прямо сейчас
        small.remember("https://rr5.googlevideo.com/c", ["https://rr5.googlevideo.com/c.ts"], "youtube")
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

    def test_the_waiters_share_the_failure_instead_of_repeating_it(self):
        # Пятеро открыли ролик, площадка отказала через две секунды. Раньше каждый следующий
        # по очереди спрашивал её заново — и пятый ждал отказа десять секунд вместо двух.
        memo = Memo()
        calls = 0

        async def produce():
            nonlocal calls
            calls += 1
            await asyncio.sleep(0.01)
            raise RuntimeError("площадка отказала")

        async def room():
            waiting = (memo.get("k", produce, 60) for _ in range(5))
            return await asyncio.gather(*waiting, return_exceptions=True)

        answers = asyncio.run(room())
        self.assertEqual(calls, 1)
        self.assertEqual([str(answer) for answer in answers], ["площадка отказала"] * 5)
        self.assertTrue(all(isinstance(answer, RuntimeError) for answer in answers))

    def test_a_failure_is_not_remembered(self):
        # Отказ делится только с теми, кто ждал его вместе: следующий вопрос — снова к площадке.
        memo = Memo()
        calls = 0

        async def produce():
            nonlocal calls
            calls += 1
            if calls == 1:
                raise RuntimeError("временно")
            return "ответ"

        async def twice():
            with self.assertRaises(RuntimeError):
                await memo.get("k", produce, 60)
            return await memo.get("k", produce, 60)

        self.assertEqual(asyncio.run(twice()), "ответ")
        self.assertEqual(calls, 2)

    def test_a_waiter_that_leaves_does_not_cancel_the_answer_for_the_others(self):
        # Первый зритель закрыл вкладку, пока площадка думала: остальные всё равно получат ответ,
        # а не отмену чужого запроса.
        memo = Memo()
        calls = 0

        async def produce():
            nonlocal calls
            calls += 1
            await asyncio.sleep(0.02)
            return "ответ"

        async def room():
            first = asyncio.ensure_future(memo.get("k", produce, 60))
            await asyncio.sleep(0)
            second = asyncio.ensure_future(memo.get("k", produce, 60))
            await asyncio.sleep(0.005)
            first.cancel()
            return await second

        self.assertEqual(asyncio.run(room()), "ответ")
        self.assertEqual(calls, 1)

    def test_a_platform_keeps_its_answers_under_its_own_name(self):
        # Площадка не может занять чужой ключ: её память — это общая память с её именем впереди.
        memo = Memo()

        async def fill():
            await memo.scope("youtube").get("search:videos:x", lambda: asyncio.sleep(0, "a"), 60)
            await memo.scope("twitch").get("search:videos:x", lambda: asyncio.sleep(0, "b"), 60)

        asyncio.run(fill())
        self.assertEqual(
            {key: value for key, (_, value) in memo._items.items()},
            {"youtube:search:videos:x": "a", "twitch:search:videos:x": "b"},
        )


class StreamChoiceTests(unittest.TestCase):
    def test_hls_master_wins_because_it_carries_every_quality(self):
        info = {
            "formats": [
                {
                    "protocol": "https",
                    "url": "https://x/file.mp4",
                    "acodec": "aac",
                    "vcodec": "h264",
                    "height": 360,
                },
                {"protocol": "m3u8_native", "manifest_url": "https://m/master.m3u8"},
            ]
        }
        self.assertEqual(Resolver._stream(info), ("https://m/master.m3u8", "hls"))

    def test_without_a_playlist_the_best_complete_file_is_taken(self):
        info = {
            "formats": [
                {
                    "protocol": "https",
                    "url": "https://x/360.mp4",
                    "acodec": "aac",
                    "vcodec": "h264",
                    "height": 360,
                },
                {
                    "protocol": "https",
                    "url": "https://x/720.mp4",
                    "acodec": "aac",
                    "vcodec": "h264",
                    "height": 720,
                },
                {
                    "protocol": "https",
                    "url": "https://x/1080.mp4",
                    "acodec": "none",
                    "vcodec": "h264",
                    "height": 1080,
                },
            ]
        }
        self.assertEqual(Resolver._stream(info), ("https://x/720.mp4", "file"))

    def test_nothing_playable_is_an_honest_nothing(self):
        self.assertEqual(Resolver._stream({"formats": []}), (None, "file"))


class CaptionTests(unittest.TestCase):
    """
    Какие дорожки текста уезжают в плеер, а какие остаются здесь.

    Правило одно: наружу идёт то, чего в самом потоке нет и что площадка нам отдаёт. Ручные
    субтитры лежат в мастере HLS, автоперевод площадка не отдаёт вовсе, и обе эти вещи
    видно прямо в ответе — ни того, ни другого в списке быть не должно.
    """

    def setUp(self):
        self.cinema = Cinema("secret")

    @staticmethod
    def _entry(name, url, ext="vtt", protocol=None):
        return {"ext": ext, "name": name, "url": url, "protocol": protocol}

    def test_recognised_speech_travels_because_the_playlist_has_none(self):
        info = {
            "subtitles": {},
            "automatic_captions": {
                "ko": [self._entry("Korean", "https://www.youtube.com/api/timedtext?lang=ko&fmt=vtt")],
                "ko-orig": [
                    self._entry("Korean (Original)", "https://www.youtube.com/api/timedtext?lang=ko&fmt=vtt")
                ],
                "ru": [
                    self._entry(
                        "Russian", "https://www.youtube.com/api/timedtext?lang=ko&tlang=ru&fmt=vtt"
                    )
                ],
            },
        }
        tracks = self.cinema.resolver._captions(info, embedded=True, provider="youtube")
        # Один язык — одна строка: `ko` и `ko-orig` это одна и та же распознанная речь.
        self.assertEqual([track["lang"] for track in tracks], ["ko"])
        self.assertTrue(tracks[0]["auto"])
        self.assertTrue(tracks[0]["url"].startswith("/api/v1/services/cinema/fetch?"))

    def test_written_by_hand_is_not_repeated_after_the_playlist(self):
        info = {
            "subtitles": {"ru": [self._entry("Russian", "https://www.youtube.com/api/timedtext?lang=ru")]},
            "automatic_captions": {
                "ru": [self._entry("Russian", "https://www.youtube.com/api/timedtext?kind=asr&lang=ru")]
            },
        }
        # Поток несёт ручные сам — отсюда не едет ничего, в том числе распознанное на том же языке.
        self.assertEqual(self.cinema.resolver._captions(info, embedded=True, provider="youtube"), [])
        # Потока с субтитрами нет — ручные едут, распознанное на том же языке по-прежнему нет.
        alone = self.cinema.resolver._captions(info, embedded=False, provider="youtube")
        self.assertEqual([(track["lang"], track["auto"]) for track in alone], [("ru", False)])

    def test_a_track_address_longer_than_any_link_is_not_offered(self):
        # Адрес дорожки называет чужой ответ, а подписанный он уходит в каждый ответ `resolve` (I2).
        base = "https://www.youtube.com/api/timedtext?fmt=vtt&v="
        info = {
            "subtitles": {
                "ru": [self._entry("Русский", base + "r" * (address.LONGEST - len(base)))],
                "en": [self._entry("English", base + "e" * (address.LONGEST - len(base) + 1))],
            },
            "automatic_captions": {},
        }
        tracks = self.cinema.resolver._captions(info, embedded=False, provider="youtube")
        self.assertEqual([track["lang"] for track in tracks], ["ru"])

    def test_a_playlist_of_pieces_is_not_a_file_for_the_tag(self):
        info = {
            "subtitles": {},
            "automatic_captions": {
                "en": [
                    self._entry(
                        "English", "https://manifest.googlevideo.com/api/manifest/hls_timedtext_playlist/x",
                        protocol="m3u8_native",
                    ),
                ]
            },
        }
        self.assertEqual(self.cinema.resolver._captions(info, embedded=True, provider="youtube"), [])




class PagingTests(unittest.TestCase):
    """
    Лента каталога отдаётся порциями, и место в ней уходит наружу строкой.

    Клиент передаёт её обратно, не разбирая: так одинаково листаются и настоящее продолжение
    ленты YouTube, и уже полученный список Twitch — их GraphQL отвечает на продолжение отказом
    `failed integrity check`, если спрашивать анонимно.
    """

    def test_no_cursor_is_the_beginning(self):
        self.assertEqual(offset_of(""), 0)
        self.assertEqual(offset_of(None), 0)
        self.assertEqual(offset_of("30"), 30)

    def test_a_cursor_that_is_not_a_place_in_the_list_is_refused(self):
        for bad in ("завтра", "-1", "1e5", "99999"):
            with self.assertRaises(HTTPException) as refusal:
                offset_of(bad)
            self.assertEqual(refusal.exception.status_code, 400)

    def test_the_last_portion_says_there_is_nothing_after_it(self):
        items = list(range(PAGE + 5))
        first = page(items, 0)
        self.assertEqual(len(first["items"]), PAGE)
        self.assertEqual(first["next"], str(PAGE))
        second = page(items, PAGE)
        self.assertEqual(len(second["items"]), 5)
        self.assertIsNone(second["next"])

    def test_a_picture_without_a_scheme_still_gets_one(self):
        # Обложки каналов YouTube приходят как `//yt3.ggpht.com/…`; без схемы такой адрес не
        # проходит белый список, и лицо канала тихо пропадало бы с карточки.
        self.assertEqual(absolute("//yt3.ggpht.com/x"), "https://yt3.ggpht.com/x")
        self.assertEqual(absolute("https://i.ytimg.com/x"), "https://i.ytimg.com/x")
        self.assertEqual(absolute(""), "")
        self.assertTrue(Cinema("s").image("//yt3.ggpht.com/x", "youtube"))

    def test_a_picture_address_longer_than_any_link_is_not_signed(self):
        # Обложку называет чужой ответ, а подписанная она лежит в общей памяти и в каждом ответе `resolve`
        # (I2): адрес длиннее `address.LONGEST` не подписывается вовсе — как и на карточке ссылки.
        cinema = Cinema("s")
        longest = "https://i.ytimg.com/" + "x" * (address.LONGEST - len("https://i.ytimg.com/"))
        self.assertTrue(cinema.image(longest, "youtube"))
        self.assertIsNone(cinema.image(longest + "x", "youtube"))


class TwitchChannelPageTests(unittest.TestCase):
    """Эфир стоит первым и только в первой порции; записи листаются по уже полученному списку."""

    def setUp(self):
        self.cinema = Cinema("secret")
        live = {"id": "one", "live": True}
        records = [{"id": str(number), "live": False} for number in range(PAGE + 4)]
        self.cinema.catalog._items["twitch:user:someone"] = (
            time.time() + 60,
            {"channel": {"id": "someone"}, "items": [live, *records]},
        )

    def ask(self, tab="videos", offset=0):
        return asyncio.run(self.cinema.channel("twitch", "someone", tab, str(offset)))

    def test_the_live_stream_leads_the_first_portion_only(self):
        first = self.ask()
        self.assertTrue(first["items"][0]["live"])
        self.assertEqual(len(first["items"]), PAGE + 1)
        self.assertEqual(first["next"], str(PAGE))
        second = self.ask(offset=PAGE)
        self.assertFalse(any(item["live"] for item in second["items"]))
        # Ни один ролик не пропал между порциями: эфир не занимает место записи.
        self.assertEqual(
            [item["id"] for item in second["items"]],
            [str(PAGE), str(PAGE + 1), str(PAGE + 2), str(PAGE + 3)],
        )
        self.assertIsNone(second["next"])

    def test_the_about_tab_is_the_channel_without_a_feed(self):
        about = self.ask(tab="about")
        self.assertEqual(about["items"], [])
        self.assertIsNone(about["next"])
        self.assertEqual(about["channel"]["id"], "someone")


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
