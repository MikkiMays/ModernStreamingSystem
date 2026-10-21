"""
Реклама в потоке, которую поток сам не размечает (E07, T17): разрывы `DISCONTINUITY` с рекламных доменов
помечаются прокси тегами `CUE-OUT`/`CUE-IN` — дальше их пропускает плеер комнаты (`theater/ad-breaks.ts`).

Списки сегментов — по форме вставки рекламы на стороне сервера (FreeWheel, Google DAI, ADFOX): основной
поток на своём CDN, вставка — отрезком между разрывами с хоста рекламной сети. Сеть не нужна.
"""

import unittest

from cord_services.cinema.ads import AD_HOSTS, ad_host, ad_url, mark_breaks
from cord_services.cinema.providers.link import Link
from cord_services.cinema.transport.playlists import Reels, rewrite
from cord_services.cinema.transport.signer import Signer

BASE = "https://cdn.site.example/vod/film/"

PREROLL = """#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:10.0,
https://v.fwmrm.net/ad/creative/1.ts
#EXTINF:5.5,
https://v.fwmrm.net/ad/creative/2.ts
#EXT-X-DISCONTINUITY
#EXTINF:10.0,
seg-1.ts
#EXTINF:10.0,
seg-2.ts
#EXT-X-ENDLIST
"""

MIDROLL = """#EXTM3U
#EXT-X-TARGETDURATION:10
#EXTINF:10.0,
seg-1.ts
#EXT-X-DISCONTINUITY
#EXT-X-PROGRAM-DATE-TIME:2026-10-21T10:00:10.000Z
#EXTINF:15.0,
https://video.adfox.ru/stream/ad-1.ts
#EXTINF:15.0,
https://s0.2mdn.net/ads/ad-2.ts
#EXT-X-DISCONTINUITY
#EXTINF:10.0,
seg-2.ts
#EXT-X-DISCONTINUITY
#EXTINF:20.0,
https://an.yandex.ru/vast/postroll.ts
#EXT-X-ENDLIST
"""


class AdHostTests(unittest.TestCase):
    def test_a_network_and_its_subdomains_are_ads(self):
        self.assertTrue(ad_host("doubleclick.net"))
        self.assertTrue(ad_host("pubads.g.doubleclick.net"))
        self.assertTrue(ad_host("VIDEO.ADFOX.RU."))
        self.assertTrue(ad_url("https://s0.2mdn.net/videoplayback/x.mp4"))

    def test_lookalikes_and_the_parent_of_a_listed_subdomain_are_not(self):
        self.assertFalse(ad_host("notdoubleclick.net"))
        self.assertFalse(ad_host("doubleclick.net.evil.example"))
        # `an.yandex.ru` — реклама Яндекса, а сам `yandex.ru` и его видео — нет.
        self.assertFalse(ad_host("yandex.ru"))
        self.assertFalse(ad_host("strm.yandex.ru"))
        self.assertFalse(ad_host(""))
        self.assertFalse(ad_host(None))
        self.assertFalse(ad_url("not a url"))

    def test_no_shared_cdn_is_on_the_list(self):
        # Общий CDN отдаёт и фильмы: такой хост в списке пропускал бы куски кино всей комнате.
        for cdn in ("akamaized.net", "cloudfront.net", "googlevideo.com", "gvt1.com", "fastly.net"):
            self.assertFalse(ad_host("x." + cdn), cdn)
        self.assertTrue(all(name == name.lower() and not name.startswith(".") for name in AD_HOSTS))


class MarkBreaksTests(unittest.TestCase):
    def test_a_preroll_before_the_first_cut_is_marked_out_and_in(self):
        marked = mark_breaks(PREROLL, BASE)
        lines = marked.splitlines()
        out = lines.index("#EXT-X-CUE-OUT:15.500")
        self.assertEqual(lines[out + 1], "#EXTINF:10.0,")
        self.assertEqual(lines[out + 2], "https://v.fwmrm.net/ad/creative/1.ts")
        cut = lines.index("#EXT-X-DISCONTINUITY")
        # CUE-IN — у первого сегмента фильма, после разрыва: hls.js кладёт его в `tagList` этого сегмента.
        self.assertEqual(lines[cut + 1 : cut + 4], ["#EXT-X-CUE-IN", "#EXTINF:10.0,", "seg-1.ts"])
        unmarked = marked.replace("#EXT-X-CUE-OUT:15.500\n", "").replace("#EXT-X-CUE-IN\n", "")
        self.assertEqual(unmarked, PREROLL)

    def test_a_midroll_and_a_postroll_get_their_own_marks(self):
        lines = mark_breaks(MIDROLL, BASE).splitlines()
        first = lines.index("#EXT-X-CUE-OUT:30.000")
        # Тег встаёт после времени сегмента, но перед его длительностью — в тот же сегмент.
        self.assertEqual(lines[first - 1], "#EXT-X-PROGRAM-DATE-TIME:2026-10-21T10:00:10.000Z")
        self.assertEqual(lines[first + 2], "https://video.adfox.ru/stream/ad-1.ts")
        back = lines.index("#EXT-X-CUE-IN")
        self.assertEqual(lines[back + 2], "seg-2.ts")
        # Последний отрезок — реклама до конца: CUE-OUT с длительностью, а CUE-IN ставить некуда.
        last = lines.index("#EXT-X-CUE-OUT:20.000")
        self.assertEqual(lines[last + 2], "https://an.yandex.ru/vast/postroll.ts")
        self.assertEqual(lines.count("#EXT-X-CUE-IN"), 1)

    def test_a_film_on_several_cdns_is_not_an_ad(self):
        body = PREROLL.replace("https://v.fwmrm.net/ad/creative/", "https://edge.other-cdn.example/film/")
        self.assertEqual(mark_breaks(body, BASE), body)

    def test_a_block_with_one_film_segment_is_not_an_ad(self):
        body = PREROLL.replace("https://v.fwmrm.net/ad/creative/2.ts", "seg-0.ts")
        self.assertEqual(mark_breaks(body, BASE), body)

    def test_a_stream_that_marks_its_ads_itself_is_left_to_its_marks(self):
        own = (
            "#EXT-X-CUE-OUT:15\n",
            '#EXT-X-DATERANGE:ID="a",SCTE35-OUT=0xFC\n',
            "#EXT-X-SCTE35:CUE-OUT=YES\n",
        )
        for tag in own:
            first = "#EXTINF:10.0,\nhttps://v.fwmrm"
            body = PREROLL.replace(first, tag + first, 1)
            self.assertEqual(mark_breaks(body, BASE), body)

    def test_all_ads_is_the_ad_itself_and_not_marked(self):
        body = PREROLL.replace("seg-1.ts", "https://v.fwmrm.net/a.ts").replace("seg-2.ts", "https://v.fwmrm.net/b.ts")
        self.assertEqual(mark_breaks(body, BASE), body)

    def test_a_master_and_a_list_without_cuts_are_left_alone(self):
        master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://v.fwmrm.net/ad.m3u8\n#EXT-X-DISCONTINUITY\n"
        self.assertEqual(mark_breaks(master, BASE), master)
        plain = "#EXTM3U\n#EXTINF:5,\nhttps://v.fwmrm.net/ad.ts\n#EXTINF:5,\nseg.ts\n"
        self.assertEqual(mark_breaks(plain, BASE), plain)

    def test_relative_segments_of_an_ad_host_playlist_are_ads_by_its_base(self):
        body = PREROLL.replace("https://v.fwmrm.net/ad/creative/", "").replace("seg-", "https://cdn.site.example/vod/film/seg-")
        lines = mark_breaks(body, "https://v.fwmrm.net/ad/creative/").splitlines()
        self.assertIn("#EXT-X-CUE-OUT:15.500", lines)


class ProxyTests(unittest.TestCase):
    """Прокси «По ссылке» помечает рекламу, переписывая адреса: оба пути — подпись и нумерация."""

    def setUp(self):
        self.signer = Signer("secret", {"link": Link.hosts}.get)

    def test_the_numbered_film_carries_the_marks(self):
        body = rewrite(PREROLL, BASE, self.signer, Reels(self.signer), provider="link")
        lines = body.splitlines()
        out = lines.index("#EXT-X-CUE-OUT:15.500")
        self.assertTrue(lines[out + 2].startswith("seg/"))
        self.assertIn("#EXT-X-CUE-IN", lines)
        self.assertNotIn("fwmrm.net", body)

    def test_the_signed_live_edge_carries_them_too(self):
        live = MIDROLL.replace("#EXT-X-ENDLIST\n", "")
        body = rewrite(live, BASE, self.signer, provider="link")
        self.assertIn("#EXT-X-CUE-OUT:30.000", body)
        self.assertNotIn("adfox.ru", body)
