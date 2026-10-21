"""
Правила плеера страниц без браузера (`sniffer/capture.py`): что считается потоком, какие заголовки уходят
службе, что лучше чего, когда это DRM, капча или вход.
"""

import unittest

from sniffer import capture
from sniffer.capture import Catch
from sniffer.entry import environment, key_for

PAGE = "https://site.example/watch/1"
AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0"


class WhatIsAStream(unittest.TestCase):
    def test_a_playlist_or_a_manifest_is_a_stream_whoever_asked_for_it(self):
        self.assertEqual(
            capture.kind_of("https://cdn.example/a/b", "application/vnd.apple.mpegURL", "xhr"), "hls"
        )
        self.assertEqual(capture.kind_of("https://cdn.example/master.m3u8?t=1", "text/plain", "fetch"), "hls")
        self.assertEqual(
            capture.kind_of("https://cdn.example/x", "application/x-mpegurl; charset=utf-8", "media"), "hls"
        )
        self.assertEqual(capture.kind_of("https://cdn.example/manifest.mpd", None, "xhr"), "dash")
        self.assertEqual(capture.kind_of("https://cdn.example/m", "application/dash+xml", "fetch"), "dash")

    def test_a_file_is_a_stream_only_when_the_video_tag_asked_for_it(self):
        self.assertEqual(capture.kind_of("https://cdn.example/film.mp4", "video/mp4", "media"), "file")
        self.assertEqual(capture.kind_of("https://cdn.example/get?id=1", "video/webm", "media"), "file")
        # Кусочек потока, который плеер на MSE спрашивает своим fetch, — не фильм.
        self.assertIsNone(capture.kind_of("https://cdn.example/seg-1.mp4", "video/mp4", "fetch"))
        self.assertIsNone(capture.kind_of("https://cdn.example/seg-1.m4s", "video/iso.segment", "xhr"))
        self.assertIsNone(capture.kind_of("https://cdn.example/page.html", "text/html", "document"))

    def test_a_piece_the_video_tag_asks_for_itself_is_not_a_file(self):
        # Тег `<video src=master.m3u8>` играет HLS сам (Chromium 153) и спрашивает кусочки видом `media`.
        self.assertIsNone(capture.kind_of("https://cdn.example/144p_0.m2ts", "video/mp2t", "media"))
        self.assertIsNone(capture.kind_of("https://cdn.example/seg-1.ts", "video/mp2t", "media"))
        self.assertIsNone(capture.kind_of("https://cdn.example/seg-1.m4s", "video/iso.segment", "media"))
        self.assertIsNone(capture.kind_of("https://cdn.example/seg-1.cmfv", "video/mp4", "media"))
        self.assertIsNone(capture.kind_of("https://cdn.example/get?seg=1", "video/MP2T", "media"))
        # Cookies кусочков всё равно нужны прокси.
        self.assertTrue(capture.streamish("https://cdn.example/144p_0.m2ts", "video/mp2t", "media"))
        self.assertTrue(capture.streamish("https://cdn.example/seg-1.m4s", "video/iso.segment", "media"))
        # Готовый файл тега — по-прежнему файл.
        self.assertEqual(capture.kind_of("https://cdn.example/film.mp4", "video/mp4", "media"), "file")
        self.assertEqual(capture.kind_of("https://cdn.example/song.aac", "audio/aac", "media"), "file")

    def test_a_list_names_its_pieces_and_a_master_names_none(self):
        media = (
            '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nseg-0.mp4\n'
            "#EXTINF:6,\nhttps://cdn2.example/v/seg-1.mp4?t=1\n#EXT-X-ENDLIST\n"
        )
        self.assertEqual(
            capture.playlist_pieces(media, "https://cdn.example/v/720.m3u8"),
            (
                "https://cdn.example/v/init.mp4",
                "https://cdn.example/v/seg-0.mp4",
                "https://cdn2.example/v/seg-1.mp4?t=1",
            ),
        )
        master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhi.m3u8\n"
        self.assertEqual(capture.playlist_pieces(master, "https://cdn.example/v/master.m3u8"), ())
        self.assertEqual(capture.playlist_pieces("<html>a.mp4</html>", "https://cdn.example/"), ())
        many = "#EXTM3U\n" + "".join(f"#EXTINF:1,\n{n}.aac\n" for n in range(capture.PIECES + 10))
        self.assertEqual(len(capture.playlist_pieces(many, "https://cdn.example/")), capture.PIECES)

    def test_the_pieces_of_a_stream_are_what_the_player_asks_for(self):
        self.assertTrue(capture.streamish("https://cdn.example/seg-1.ts", "video/mp2t", "xhr"))
        self.assertTrue(capture.streamish("https://cdn.example/key", "application/octet-stream", "xhr"))
        self.assertTrue(capture.streamish("https://cdn.example/k.key", None, "fetch"))
        self.assertFalse(capture.streamish("https://cdn.example/app.js", "application/javascript", "script"))
        self.assertFalse(capture.streamish("https://cdn.example/seg-1.ts", "video/mp2t", "document"))

    def test_a_file_kind_comes_from_its_address_or_its_type(self):
        self.assertEqual(capture.file_extension("https://cdn.example/film.webm", "video/mp4"), "webm")
        self.assertEqual(capture.file_extension("https://cdn.example/get?id=1", "video/mp4"), "mp4")
        self.assertEqual(capture.file_extension("https://cdn.example/get", "video/quicktime"), "mov")
        self.assertEqual(capture.file_extension("https://cdn.example/get", "video/x-flv"), "")

    def test_a_playlist_says_whether_it_is_a_master_and_its_steps(self):
        master = (
            "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x1080\nhi.m3u8\n"
            "#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=640x360\nlo.m3u8\n"
            "#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1080x1920\nvertical.m3u8\n"
        )
        self.assertEqual(capture.playlist_facts(master), (True, (1080, 360)))
        self.assertEqual(capture.playlist_facts("#EXTM3U\n#EXTINF:6,\na.ts\n"), (False, ()))
        self.assertEqual(capture.playlist_facts("<html>not a playlist</html>"), (None, ()))

    def test_a_playlist_says_how_long_a_finished_list_is_and_whether_it_is_all_ads(self):
        film = "#EXTM3U\n#EXTINF:6.5,\na.ts\n#EXTINF:4,\nb.ts\n#EXT-X-ENDLIST\n"
        self.assertEqual(capture.advert_facts(film, "https://cdn.example/v/"), (10.5, False))
        # Край живого эфира — длины у него нет: список растёт.
        live = film.replace("#EXT-X-ENDLIST\n", "")
        self.assertEqual(capture.advert_facts(live, "https://cdn.example/v/"), (None, False))
        ad = "#EXTM3U\n#EXTINF:15,\nhttps://s0.2mdn.net/ads/1.ts\n#EXT-X-ENDLIST\n"
        self.assertEqual(capture.advert_facts(ad, "https://cdn.example/v/"), (15.0, True))
        # Относительные адреса — по адресу самого списка.
        self.assertEqual(capture.advert_facts(film, "https://v.fwmrm.net/ad/"), (10.5, True))
        master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://pubads.g.doubleclick.net/hi.m3u8\n"
        self.assertEqual(capture.advert_facts(master, "https://site.example/"), (None, True))
        self.assertEqual(capture.advert_facts("<html>", "https://v.fwmrm.net/"), (None, False))


class WhatGoesToTheService(unittest.TestCase):
    def test_referer_origin_and_the_browser_name_go_as_the_browser_sent_them(self):
        found = capture.profile_of(
            {
                "referer": PAGE,
                "origin": "https://site.example",
                "user-agent": AGENT,
                "cookie": "a=b",
                "x": "y",
            }
        )
        self.assertEqual(found, {"referer": PAGE, "origin": "https://site.example", "user-agent": AGENT})

    def test_a_value_that_could_break_a_request_does_not_go_at_all(self):
        found = capture.profile_of(
            {
                "referer": PAGE + "\r\nX-Injected: 1",
                "origin": "null",
                "user-agent": "Агент",
            }
        )
        self.assertEqual(found, {})
        self.assertEqual(capture.profile_of({"referer": "javascript:alert(1)"}), {})
        self.assertEqual(capture.profile_of({"referer": "https://site.example/" + "a" * 2100}), {})

    def test_cookies_are_kept_per_host_only_for_what_can_be_repeated(self):
        catch = Catch()
        catch.cookie("https://cdn.example/a.m3u8", "sid=1")
        catch.cookie("https://cdn.example/b.ts", "sid=2")
        catch.cookie("https://other.example/k", "bad\r\nvalue")
        catch.cookie("https://other.example/k", "x" * (capture.LONGEST_COOKIE + 1))
        catch.cookie("https://third.example/k", "")
        self.assertEqual(catch.cookies, {"cdn.example": "sid=2"})

    def test_hosts_with_cookies_are_bounded(self):
        catch = Catch()
        for number in range(capture.HOSTS + 5):
            catch.cookie(f"https://cdn{number}.example/a.ts", "sid=1")
        self.assertEqual(len(catch.cookies), capture.HOSTS)
        # Уже знакомый хост обновляется и после предела.
        catch.cookie("https://cdn0.example/a.ts", "sid=2")
        self.assertEqual(catch.cookies["cdn0.example"], "sid=2")

    def test_streams_are_bounded_and_only_web_addresses(self):
        catch = Catch()
        self.assertFalse(catch.stream("blob:https://site.example/1", "hls", {}))
        self.assertFalse(catch.stream("https://user:pass@cdn.example/a.m3u8", "hls", {}))
        for number in range(capture.STREAMS + 3):
            catch.stream(f"https://cdn.example/{number}.m3u8", "hls", {})
        self.assertEqual(len(catch.streams), capture.STREAMS)

    def test_a_stream_after_the_page_went_away_is_not_this_page(self):
        catch = Catch()
        catch.closed = True
        self.assertFalse(catch.stream("https://ads.example/ad.mp4", "file", {}))

    def test_a_file_the_list_names_as_its_piece_is_not_kept(self):
        catch = Catch()
        # Ответ кусочка пришёл раньше, чем дочитан список, который его называет.
        catch.stream("https://cdn.example/v/seg-0.mp4", "file", {}, order=3, ext="mp4")
        catch.stream("https://cdn.example/film.mp4", "file", {}, order=4, ext="mp4")
        catch.listed(("https://cdn.example/v/init.mp4", "https://cdn.example/v/seg-0.mp4"))
        catch.stream("https://cdn.example/v/720.m3u8", "hls", {}, order=2, master=False, seconds=5400)
        self.assertEqual(
            sorted(catch.streams), ["https://cdn.example/film.mp4", "https://cdn.example/v/720.m3u8"]
        )
        # Кусочки после списка — ни места в улове, ни чтения заголовков ради них.
        self.assertFalse(catch.wants("https://cdn.example/v/init.mp4", 0, "file"))
        self.assertFalse(catch.stream("https://cdn.example/v/init.mp4", "file", {}, ext="mp4"))
        self.assertTrue(catch.wants("https://cdn.example/other.mp4", 0, "file"))
        for number in range(capture.PIECES + 10):
            catch.listed((f"https://cdn.example/v/{number}.aac",))
        self.assertEqual(len(catch.pieces), capture.PIECES)


class WhatIsBest(unittest.TestCase):
    def test_a_master_playlist_then_other_hls_then_dash_then_a_file(self):
        catch = Catch()
        catch.stream("https://cdn.example/film.mp4", "file", {}, order=1)
        catch.stream("https://cdn.example/manifest.mpd", "dash", {}, order=2)
        catch.stream("https://cdn.example/720.m3u8", "hls", {}, order=3, master=False)
        catch.stream("https://cdn.example/unknown.m3u8", "hls", {}, order=5)
        catch.stream("https://cdn.example/master.m3u8", "hls", {}, order=4, master=True)
        self.assertEqual(
            [stream.url.rsplit("/", 1)[1] for stream in catch.ranked()],
            ["master.m3u8", "unknown.m3u8", "720.m3u8", "manifest.mpd", "film.mp4"],
        )

    def test_the_file_playing_in_the_largest_video_beats_an_earlier_ad(self):
        catch = Catch()
        catch.stream("https://ads.example/ad.mp4", "file", {}, order=1)
        catch.stream("https://cdn.example/film.mp4", "file", {}, order=2)
        best = catch.ranked(["https://cdn.example/film.mp4", "https://ads.example/ad.mp4"])[0]
        self.assertEqual(best.url, "https://cdn.example/film.mp4")
        self.assertEqual(catch.ranked()[0].url, "https://ads.example/ad.mp4")


class Preroll(unittest.TestCase):
    """Основной поток, а не преролл (E07): реклама перед фильмом — тоже поток, и часто первый."""

    def test_a_master_from_an_ad_network_loses_to_the_film_master(self):
        catch = Catch()
        catch.stream("https://pubads.g.doubleclick.net/ad/master.m3u8", "hls", {}, order=1, master=True)
        catch.stream("https://cdn.example/film/master.m3u8", "hls", {}, order=2, master=True)
        self.assertEqual(catch.ranked()[0].url, "https://cdn.example/film/master.m3u8")

    def test_a_stream_asked_from_an_ad_frame_loses_too(self):
        catch = Catch()
        frame = "https://imasdk.googleapis.com/js/core/bridge3.html"
        catch.stream("https://cdn.example/ad/master.m3u8", "hls", {}, order=1, master=True, frame=frame)
        catch.stream("https://cdn.example/film/master.m3u8", "hls", {}, order=2, master=True, frame=PAGE)
        self.assertEqual(catch.ranked()[0].url, "https://cdn.example/film/master.m3u8")

    def test_a_list_of_ads_on_the_site_cdn_loses_by_its_segments(self):
        catch = Catch()
        catch.stream("https://cdn.example/a.m3u8", "hls", {}, order=1, master=False, advert=True, seconds=15)
        catch.stream("https://cdn.example/b.m3u8", "hls", {}, order=2, master=False, seconds=5400)
        self.assertEqual(catch.ranked()[0].url, "https://cdn.example/b.m3u8")

    def test_a_short_finished_list_loses_to_a_long_one_but_wins_alone(self):
        catch = Catch()
        catch.stream("https://cdn.example/pre.m3u8", "hls", {}, order=1, master=False, seconds=20)
        catch.stream("https://cdn.example/film.m3u8", "hls", {}, order=2, master=False, seconds=5400)
        self.assertEqual(catch.ranked()[0].url, "https://cdn.example/film.m3u8")
        alone = Catch()
        alone.stream("https://cdn.example/clip.m3u8", "hls", {}, order=1, master=False, seconds=20)
        self.assertEqual(alone.ranked()[0].url, "https://cdn.example/clip.m3u8")

    def test_a_film_file_beats_an_ad_playlist_whatever_the_kinds(self):
        catch = Catch()
        catch.stream("https://v.fwmrm.net/ad/master.m3u8", "hls", {}, order=1, master=True)
        catch.stream("https://cdn.example/film.mp4", "file", {}, order=2, ext="mp4")
        self.assertEqual(catch.ranked()[0].url, "https://cdn.example/film.mp4")

    def test_a_file_playing_fifteen_seconds_loses_to_the_long_one(self):
        catch = Catch()
        catch.stream("https://cdn.example/pre.mp4", "file", {}, order=1, ext="mp4")
        catch.stream("https://cdn.example/film.mp4", "file", {}, order=2, ext="mp4")
        lengths = {"https://cdn.example/pre.mp4": 15.0, "https://cdn.example/film.mp4": 5400.0}
        best = catch.ranked(["https://cdn.example/pre.mp4", "https://cdn.example/film.mp4"], lengths)[0]
        self.assertEqual(best.url, "https://cdn.example/film.mp4")

    def test_a_short_master_the_video_tag_plays_itself_stays_first(self):
        # SNIF-1: `<video src=master.m3u8>` с роликом в 6 с; тег спросил и кусочек — видом `media`.
        master = "https://site.example/media/master.m3u8"
        piece = "https://site.example/media/144p_0.m2ts"
        self.assertIsNone(capture.kind_of(piece, "video/mp2t", "media"))
        catch = Catch()
        catch.stream(master, "hls", {}, order=1, master=True)
        catch.stream("https://site.example/media/144p.m3u8", "hls", {}, order=2, master=False, seconds=6.0)
        # Даже кусочек, который прошёл бы файлом (`.mp4` из непрочитанного списка), мастера не обгоняет:
        # длина тега — длина файла, который он играет, а не мастера.
        catch.stream("https://site.example/media/144p_0.mp4", "file", {}, order=3, ext="mp4")
        for lengths in ({master: 6.0}, {}, {master: 6000.0}):
            self.assertEqual(catch.ranked([master], lengths)[0].url, master, lengths)

    def test_the_length_of_the_tag_does_not_put_a_master_behind_its_own_variant(self):
        # Список варианта не прочитан (без `Content-Length`, не успел) — длины у него нет, а у тега есть.
        master = "https://cdn.example/clip/master.m3u8"
        catch = Catch()
        catch.stream(master, "hls", {}, order=1, master=True)
        catch.stream("https://cdn.example/clip/720.m3u8", "hls", {}, order=2)
        self.assertEqual(catch.ranked([master], {master: 30.0})[0].url, master)

    def test_the_service_is_told_which_stream_is_an_ad(self):
        catch = Catch()
        catch.stream("https://s0.2mdn.net/ad.mp4", "file", {}, order=1, ext="mp4")
        catch.stream("https://cdn.example/a.m3u8", "hls", {}, order=2, advert=True)
        catch.stream("https://cdn.example/film.mp4", "file", {}, order=3, ext="mp4")
        wired = {stream.url: stream.wire() for stream in catch.ranked()}
        self.assertIs(wired["https://s0.2mdn.net/ad.mp4"]["ad"], True)
        self.assertIs(wired["https://cdn.example/a.m3u8"]["ad"], True)
        self.assertNotIn("ad", wired["https://cdn.example/film.mp4"])


class Drm(unittest.TestCase):
    def test_eme_in_use_is_drm_whatever_else_was_caught(self):
        for signal in ("encrypted", "keys", "license"):
            catch = Catch()
            catch.stream("https://cdn.example/master.m3u8", "hls", {})
            catch.eme(signal, "cenc")
            self.assertTrue(catch.drm(), signal)

    def test_a_drm_key_system_asked_with_nothing_open_to_play_is_drm(self):
        catch = Catch()
        catch.eme("system", "com.widevine.alpha")
        self.assertTrue(catch.drm())
        catch.stream("https://cdn.example/manifest.mpd", "dash", {})
        self.assertTrue(catch.drm())

    def test_a_question_about_the_key_system_next_to_an_open_stream_is_not_drm(self):
        catch = Catch()
        catch.eme("system", "com.widevine.alpha")
        catch.stream("https://cdn.example/master.m3u8", "hls", {})
        self.assertFalse(catch.drm())
        self.assertEqual(catch.systems, ["com.widevine.alpha"])

    def test_clear_key_alone_is_not_drm(self):
        catch = Catch()
        catch.eme("system", "org.w3.clearkey")
        self.assertFalse(catch.drm())

    def test_what_the_page_says_is_bounded(self):
        catch = Catch()
        for number in range(40):
            catch.eme("system", f"com.example.{number}")
        catch.eme("system", "x" * 500)
        self.assertEqual(len(catch.systems), capture.SYSTEMS)


class WhatThePageAsks(unittest.TestCase):
    def test_a_robot_check_is_seen_by_title_frame_or_address(self):
        self.assertTrue(capture.challenged(PAGE, "Just a moment..."))
        self.assertTrue(capture.challenged(PAGE, "Вы не робот?"))
        self.assertTrue(capture.challenged(PAGE, "Фильм", ["https://challenges.cloudflare.com/cdn-cgi/x"]))
        self.assertTrue(capture.challenged(PAGE, "Фильм", ["https://www.google.com/recaptcha/api2/anchor"]))
        self.assertTrue(capture.challenged("https://dzen.ru/showcaptcha?retpath=1", "Dzen"))
        self.assertFalse(capture.challenged(PAGE, "Фильм про роботов", ["https://www.google.com/maps"]))

    def test_a_login_wall_is_seen_by_its_address_or_a_password_field(self):
        self.assertTrue(capture.login_wall("https://site.example/login?next=/watch/1", False))
        self.assertTrue(capture.login_wall("https://site.example/auth/", False))
        self.assertTrue(capture.login_wall(PAGE, True))
        self.assertFalse(capture.login_wall("https://site.example/catalogue/authors", False))

    def test_a_title_is_one_clean_line(self):
        self.assertEqual(capture.title_of("  Фильм\n\tстраницы\x00 "), "Фильм страницы")
        self.assertEqual(len(capture.title_of("я" * 1000)), capture.LONGEST_TITLE)


class Key(unittest.TestCase):
    # Тот же образец, что у службы (`services/tests/test_keys.py`): одна формула HKDF (A14) у обеих сторон.
    SAMPLE = (
        "local-development-internal-secret-32bytes",
        "64c7335b9f98d139169be2c3a4bdc43aa6377edfe614b1a9913624ea41ef17e8",
    )

    def test_the_key_is_the_one_the_service_computes(self):
        secret, key = self.SAMPLE
        self.assertEqual(key_for(secret), key)

    def test_the_secret_of_the_installation_does_not_survive_into_the_server(self):
        source = {
            "INTERNAL_SECRET": "top-secret-value",
            "DATABASE_PASSWORD": "db",
            "PATH": "/usr/bin",
            "CINEMA_PROXY_LINK": "socks5://proxy.lan:1080",
            "CINEMA_PRIVATE_HOSTS_LINK": "10.0.0.0/8:8096",
        }
        found = environment(source)
        self.assertNotIn("INTERNAL_SECRET", found)
        self.assertNotIn("DATABASE_PASSWORD", found)
        self.assertNotIn("top-secret-value", repr(found))
        self.assertEqual(found["CINEMA_SNIFFER_KEY"], key_for("top-secret-value"))
        self.assertEqual(found["CINEMA_PROXY_LINK"], "socks5://proxy.lan:1080")
        self.assertEqual(environment({"PATH": "/usr/bin"})["CINEMA_SNIFFER_KEY"], "")


if __name__ == "__main__":
    unittest.main()
