"""
Ссылка, вставленная в кинозал: чья она и на какой странице её открыть.

Грамматика адресов у каждой площадки своя (`Provider.match`), разбор самого адреса — общий и
строгий (`address.parse`). Здесь — настоящие формы ссылок каждой площадки (номера — из записанных
ответов службы, `web/e2e/fixtures/cinema/`), чужие хосты, похожие на свои, и мусор; маршрут
`POST …/cinema/link` с его пределом — и то, что ни одна ссылка не ведёт службу наружу.
"""

import os
import re
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient

from cord_services.app import create_app
from cord_services.cinema import Memo, address
from cord_services.cinema.facade import CATALOG_ID, SERIES_ID, Cinema
from cord_services.cinema.providers import PROVIDERS
from cord_services.cinema.providers.link import Link
from cord_services.cinema.providers.rutube import Rutube
from cord_services.cinema.providers.twitch import Twitch
from cord_services.cinema.providers.vk import OWNER, Vk
from cord_services.cinema.providers.youtube import YouTube
from cord_services.cinema.registry import Kit, Match, Provider
from cord_services.cinema.resolve import YtDlp
from cord_services.core import Core

ROOM = str(uuid.uuid4())

VIDEO = "dQw4w9WgXcQ"
PLAYLIST = "PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf"
ALBUM = "OLAK5uy_kvw0Ke1R5xDo5lEzjPCp8dScPqAyjQrLE"
CHANNEL = "UCuAXFkgsw1L7xaCfnd5JJOw"
# Rutube: выпуск «Экстрасенсы. Реванш» из сериала 356362 канала 23463954 и эфир «Звезды».
EPISODE = "d8061eab5d7ed2bad058162bc5762842"
STREAM = "5ab908fccfac5bb43ef2b1e4182256b0"
# VK: серия «Маши и Медведя», её плейлист «Сезон 8» и канал VK Видео Live.
CLIP = "-22277933_456242381"
SEASON = "-22277933_56093284"

YOUTUBE = {
    f"https://www.youtube.com/watch?v={VIDEO}": ("video", VIDEO, "item"),
    f"https://youtube.com/watch?v={VIDEO}&t=42s": ("video", VIDEO, "item"),
    f"https://m.youtube.com/watch?v={VIDEO}&feature=youtu.be": ("video", VIDEO, "item"),
    f"https://music.youtube.com/watch?v={VIDEO}&list=RDAMVM{VIDEO}": ("video", VIDEO, "item"),
    # Ролик из плейлиста — это ролик: его и видно по ссылке.
    f"https://www.youtube.com/watch?v={VIDEO}&list={PLAYLIST}&index=3": ("video", VIDEO, "item"),
    f"https://youtu.be/{VIDEO}?si=Xy1&t=10": ("video", VIDEO, "item"),
    f"https://www.youtube.com/shorts/{VIDEO}": ("video", VIDEO, "item"),
    f"https://www.youtube.com/live/{VIDEO}?feature=share": ("video", VIDEO, "item"),
    f"https://www.youtube.com/embed/{VIDEO}?start=10": ("video", VIDEO, "item"),
    f"https://www.youtube-nocookie.com/embed/{VIDEO}": ("video", VIDEO, "item"),
    f"https://www.youtube.com/v/{VIDEO}": ("video", VIDEO, "item"),
    f"HTTPS://WWW.YouTube.COM./watch?v={VIDEO}": ("video", VIDEO, "item"),
    f"https://www.youtube.com/playlist?list={PLAYLIST}": ("playlist", PLAYLIST, "playlist"),
    f"https://music.youtube.com/playlist?list={ALBUM}": ("playlist", ALBUM, "playlist"),
    f"https://www.youtube.com/embed/videoseries?list={PLAYLIST}": ("playlist", PLAYLIST, "playlist"),
    "https://www.youtube.com/@Blender.Official": ("channel", "@Blender.Official", "channel"),
    "https://www.youtube.com/@Blender.Official/videos": ("channel", "@Blender.Official", "channel"),
    f"https://www.youtube.com/channel/{CHANNEL}": ("channel", CHANNEL, "channel"),
    f"https://m.youtube.com/channel/{CHANNEL}/streams": ("channel", CHANNEL, "channel"),
}
TWITCH = {
    # Канал — это его эфир: страница ролика с «Смотреть вместе», как у карточки канала в витрине.
    "https://www.twitch.tv/pesh": ("channel", "pesh", "item"),
    "https://twitch.tv/Pesh": ("channel", "pesh", "item"),
    "https://m.twitch.tv/pesh?sr=a": ("channel", "pesh", "item"),
    # Вкладка канала — его страница с записями.
    "https://www.twitch.tv/pesh/videos?filter=archives": ("channel", "pesh", "channel"),
    "https://www.twitch.tv/pesh/about": ("channel", "pesh", "channel"),
    "https://www.twitch.tv/videos/2000000001": ("video", "2000000001", "item"),
    "https://www.twitch.tv/videos/2000000001?t=1h2m3s": ("video", "2000000001", "item"),
    "https://www.twitch.tv/pesh/v/2000000001": ("video", "2000000001", "item"),
    "https://player.twitch.tv/?channel=pesh&parent=example.com": ("channel", "pesh", "item"),
    "https://player.twitch.tv/?video=v2000000001&parent=example.com": ("video", "2000000001", "item"),
}
RUTUBE = {
    f"https://rutube.ru/video/{EPISODE}/": ("video", EPISODE, "item"),
    f"https://rutube.ru/video/{EPISODE}/?t=30&r=wd": ("video", EPISODE, "item"),
    f"https://m.rutube.ru/video/{EPISODE}/": ("video", EPISODE, "item"),
    f"https://rutube.ru/shorts/{EPISODE}/": ("video", EPISODE, "item"),
    f"https://rutube.ru/play/embed/{EPISODE}": ("video", EPISODE, "item"),
    # Эфир ТВ — `channel` под номером ролика, как у карточки идущего эфира в витрине.
    f"https://rutube.ru/live/video/{STREAM}/": ("channel", STREAM, "item"),
    "https://rutube.ru/channel/23463954/": ("channel", "23463954", "channel"),
    "https://rutube.ru/channel/23463954/videos/": ("channel", "23463954", "channel"),
    "https://rutube.ru/video/person/23460655/": ("channel", "23460655", "channel"),
    "https://rutube.ru/metainfo/tv/356362/": ("series", "356362", "series"),
    "https://rutube.ru/metainfo/tv/356362/video/": ("series", "356362", "series"),
}
VK = {
    # Ролик — на всех доменах площадки, страницей, поверх страницы и встраиваемым плеером.
    f"https://vk.com/video{CLIP}": ("video", CLIP, "item"),
    f"https://vk.ru/video{CLIP}": ("video", CLIP, "item"),
    f"https://vkvideo.ru/video{CLIP}": ("video", CLIP, "item"),
    f"https://m.vkvideo.ru/video{CLIP}?list=ln-abc": ("video", CLIP, "item"),
    f"https://www.vk.com/video{CLIP}": ("video", CLIP, "item"),
    f"https://vkvideo.ru/playlist/{SEASON}/video{CLIP}": ("video", CLIP, "item"),
    f"https://vk.com/videos-22277933?z=video{CLIP}%2Fclub22277933": ("video", CLIP, "item"),
    f"https://vk.com/feed?z=clip{CLIP}": ("video", CLIP, "item"),
    "https://vkvideo.ru/video_ext.php?oid=-22277933&id=456242381&hash=87b046504ccd8bfa": (
        "video",
        CLIP,
        "item",
    ),
    "https://vk.com/video1_456239017": ("video", "1_456239017", "item"),
    "https://vk.com/clip-1_2": ("video", "-1_2", "item"),
    # Запись эфира — тоже ролик: идёт ли он сейчас, скажет поток, а не адрес.
    "https://vkvideo.ru/live-59526914_456267534": ("video", "-59526914_456267534", "item"),
    # Канал VK Видео Live — эфир на странице ролика, как идущий эфир в каталоге.
    "https://live.vkvideo.ru/near_you": ("channel", "near_you", "item"),
    "https://live.vkvideo.ru/near_you/": ("channel", "near_you", "item"),
    "https://vkplay.live/bayda": ("channel", "bayda", "item"),
    "https://live.vkplay.ru/bayda": ("channel", "bayda", "item"),
    # Плейлист и сообщество по номеру.
    f"https://vkvideo.ru/playlist/{SEASON}": ("playlist", SEASON, "playlist"),
    f"https://vk.com/video/playlist/{SEASON}": ("playlist", SEASON, "playlist"),
    "https://vk.com/videos-22277933?section=album_56093284": ("playlist", SEASON, "playlist"),
    "https://vk.com/club22277933": ("channel", "-22277933", "channel"),
    "https://vk.com/public22277933": ("channel", "-22277933", "channel"),
    "https://vk.com/videos-22277933": ("channel", "-22277933", "channel"),
}
KNOWN = {"youtube": YOUTUBE, "twitch": TWITCH, "rutube": RUTUBE, "vk": VK}

# Похожее на ссылку площадки, но не она: чужой хост, хост с её именем внутри, имя и пароль перед
# хостом, чужой порт, не та форма номера, разделы самих сайтов и то, что по ссылке не узнать.
FOREIGN = [
    f"https://evilyoutube.com/watch?v={VIDEO}",
    f"https://youtube.com.evil.ru/watch?v={VIDEO}",
    f"https://youtube.com@evil.ru/watch?v={VIDEO}",
    f"https://www.youtube.com:8443/watch?v={VIDEO}",
    f"ftp://youtube.com/watch?v={VIDEO}",
    f"javascript://youtube.com/watch?v={VIDEO}",
    f"youtube.com/watch?v={VIDEO}",
    f"https://studio.youtube.com/video/{VIDEO}/edit",
    "https://www.youtube.com/watch?v=short",
    f"https://www.youtube.com/watch?v={VIDEO}X",
    f"https://www.youtube.com/watch?v={VIDEO}%0A",
    "https://www.youtube.com/watch",
    f"https://www.youtube.com/watch/extra?v={VIDEO}",
    "https://www.youtube.com/results?search_query=blender",
    "https://www.youtube.com/feed/trending",
    "https://www.youtube.com/c/BlenderFoundation",
    "https://www.youtube.com/user/BlenderFoundation",
    "https://www.youtube.com/@x",
    "https://www.youtube.com/@Blender.Official/videos/extra",
    "https://www.youtube.com/channel/UCshort",
    "https://www.youtube.com/playlist?list=PL",
    "https://youtu.be/",
    f"https://youtu.be/{VIDEO}/extra",
    "https://www.twitch.tv/",
    "https://www.twitch.tv/directory",
    "https://www.twitch.tv/directory/category/just-chatting",
    "https://www.twitch.tv/directory/videos",
    "https://www.twitch.tv/settings/v/2000000001",
    "https://www.twitch.tv/p/ru-ru/legal/",
    "https://www.twitch.tv/pesh/clip/SomeSlug-abc",
    "https://clips.twitch.tv/SomeSlug-abc",
    "https://www.twitch.tv/videos/abc",
    "https://www.twitch.tv/videos",
    "https://www.twitch.tv/ab",
    "https://www.twitch.tv/some-one",
    "https://player.twitch.tv/?video=vabc&parent=example.com",
    "https://dashboard.twitch.tv/u/pesh/home",
    "https://eviltwitch.tv/pesh",
    "https://rutube.ru/",
    "https://rutube.ru/video/NOTHEX/",
    f"https://rutube.ru/video/{EPISODE.upper()}/",
    f"https://rutube.ru/video/private/{EPISODE}/?p=Key",
    "https://rutube.ru/channel/abc/",
    "https://rutube.ru/channel/23463954/unknown/",
    "https://rutube.ru/u/someone/",
    "https://rutube.ru/plst/123/",
    "https://rutube.ru/metainfo/tv/abc/",
    "https://rutube.ru/feeds/tvchannels/",
    f"https://evilrutube.ru/video/{EPISODE}/",
    f"https://rutube.ru.evil.com/video/{EPISODE}/",
    "https://vk.com/wall-22277933_1",
    "https://vk.com/mashaimedvedtv",
    "https://vkvideo.ru/@mashaimedvedtv",
    "https://evilvk.com/video-1_2",
    "https://vk.com.evil.ru/video-1_2",
    "https://vk.com/video-١_٢",
    "https://vkvideo.ru/video_ext.php?oid=abc&id=1",
    "https://vk.com/feed?z=video-1_2abc",
    "https://live.vkvideo.ru/",
    "https://live.vkvideo.ru/lebwa/record/33a4e4ce",
    "https://example.com/video.mp4",
    "https://ok.ru/video/123456",
    "https://[::1]/watch?v=" + VIDEO,
    "",
]


def kit():
    return Kit(memo=Memo(), image=lambda url: None, ytdlp=YtDlp())


def platforms() -> list[Provider]:
    return [kind(kit()) for kind in PROVIDERS]


def matched(url: str) -> list[tuple[str, tuple[str, str, str]]]:
    """Какие площадки узнали ссылку и что именно: чужую ссылку не должен узнать никто."""
    found = []
    for platform in platforms():
        match = platform.match(url)
        if match is not None:
            found.append((platform.id, (match.kind, match.id, match.page)))
    return found


class AddressTests(unittest.TestCase):
    def test_a_link_is_a_web_page_with_a_host(self):
        for url in ("https://example.com/", "http://example.com/a?b=c", "https://example.com:8443/x"):
            self.assertTrue(address.web(url), url)
        for url in (
            "",
            "example.com/video",
            "ftp://example.com/video",
            "javascript:alert(1)",
            "mailto:someone@example.com",
            "data:text/html,hello",
            "https://",
            "https:///path",
            " https://example.com/",
            "https://example.com/a b",
            "https://example.com/\n",
            "https://exa\tmple.com/",
            "https://user:secret@example.com/",
            "https://example.com:99999/",
            "https://example.com:port/",
            "https://example.com/" + "a" * 2000,
        ):
            self.assertFalse(address.web(url), repr(url[:60]))

    def test_the_host_is_normalised_and_the_path_is_kept_as_it_came(self):
        found = address.parse("HTTPS://WWW.Example.COM.:443/A%2FB//c/?x=1&x=2&empty=&q=a+b")
        self.assertEqual(found.host, "www.example.com")
        # `%2F` — часть имени, а не разделитель: раскодированный путь стал бы другой ссылкой.
        self.assertEqual(found.path, ("A%2FB", "c"))
        self.assertEqual(dict(found.query), {"x": "1", "empty": "", "q": "a b"})
        self.assertIsNotNone(address.parse("http://example.com:80/"))
        # Чужой порт — не ссылка площадки: у площадок другого не бывает.
        for url in ("https://example.com:80/", "http://example.com:443/", "https://example.com:8443/"):
            self.assertIsNone(address.parse(url), url)
        self.assertIsNone(address.parse("https://example.com/\x00"))


class GrammarTests(unittest.TestCase):
    def test_each_platform_knows_its_own_links(self):
        for provider, links in KNOWN.items():
            self.assertGreaterEqual(len(links), 5, provider)
            for url, expected in links.items():
                self.assertEqual(matched(url), [(provider, expected)], url)

    def test_links_that_only_look_like_a_platform_are_nobody_s(self):
        for url in FOREIGN:
            self.assertEqual(matched(url), [], url)

    def test_what_a_link_opens_fits_the_form_the_catalogue_accepts(self):
        # Ссылка не должна открывать того, чего не открыл бы каталог: номер из ссылки проходит ту же
        # проверку, что и номер карточки, — у ролика форму площадки, у страниц — форму фасада.
        by_id = {platform.id: platform for platform in platforms()}
        for provider, links in KNOWN.items():
            platform = by_id[provider]
            for url, (kind, identity, page) in links.items():
                if page == "item":
                    self.assertIn(kind, ("video", "channel"), url)
                    self.assertTrue(platform.content_id.fullmatch(identity), url)
                elif page == "series":
                    self.assertTrue(SERIES_ID.fullmatch(identity), url)
                else:
                    self.assertTrue(CATALOG_ID.fullmatch(identity), url)
                if provider == "vk" and page == "channel":
                    self.assertTrue(OWNER.fullmatch(identity), url)
                if provider == "rutube" and page != "item":
                    self.assertTrue(re.fullmatch(r"[0-9]{1,12}", identity), url)

    def test_a_platform_without_a_grammar_knows_no_links(self):
        class Bare(Provider):
            id = "bare"
            name = "Bare"
            content_id = re.compile(r"x")

        self.assertIsNone(Bare(kit()).match(f"https://www.youtube.com/watch?v={VIDEO}"))

    def test_a_match_names_a_page_the_scenes_have(self):
        self.assertEqual(Match("video", VIDEO, "item").page, "item")
        for page in ("home", "search", ""):
            with self.assertRaises(ValueError):
                Match("video", VIDEO, page)
        with self.assertRaises(ValueError):
            Match("video", "", "item")

    def test_every_platform_that_has_a_scene_has_a_grammar(self):
        # Площадки из реестра — все со своей грамматикой: новая площадка без неё отдавала бы свои
        # ссылки общему пути, и это стоит заметить сразу, а не по жалобе. Сам общий путь («По ссылке»)
        # грамматики не имеет нарочно: к нему приходит то, чего не узнал никто.
        self.assertEqual([kind for kind in PROVIDERS], [YouTube, Twitch, Rutube, Vk, Link])
        for kind in PROVIDERS[:-1]:
            self.assertIsNot(kind.match, Provider.match, kind.id)
        self.assertIs(Link.match, Provider.match)


class RouteTests(unittest.TestCase):
    """`POST …/cinema/link` через настоящий FastAPI: участие в комнате подменено, сети нет вовсе."""

    def serve(self, platforms=None):
        root = tempfile.TemporaryDirectory()
        self.addCleanup(root.cleanup)
        self.core = Core("http://core.test", "internal-test")
        self.core.member = AsyncMock(return_value=({"id": ROOM}, {"id": "member"}))
        setting = {} if platforms is None else {"CINEMA_PROVIDERS": platforms}
        with patch.dict(os.environ, setting):
            if platforms is None:
                os.environ.pop("CINEMA_PROVIDERS", None)
            app = create_app(Path(root.name), self.core, telegram_enabled=False)
        self.addCleanup(app.state.store.db.close)
        self.cinema: Cinema = app.state.cinema
        self.now = 1000.0
        self.cinema.links.clock = lambda: self.now
        # Узнать ссылку — это разбор адреса: ни клиента площадки, ни yt-dlp маршрут не трогает.
        outside = AssertionError("ссылка повела службу наружу")
        for target, name in (
            (self.cinema.net, "client_for"),
            (self.cinema.ytdlp, "extract"),
            (self.cinema.ytdlp, "probe"),
        ):
            patcher = patch.object(target, name, side_effect=outside)
            patcher.start()
            self.addCleanup(patcher.stop)
        return TestClient(app, headers={"Authorization": "Bearer member.secret"})

    def ask(self, client, url, room=ROOM):
        return client.post(f"/api/v1/services/rooms/{room}/cinema/link", json={"url": url})

    def test_a_link_of_a_platform_is_a_route_to_its_scene(self):
        client = self.serve()
        for url, route in (
            (
                f"https://youtu.be/{VIDEO}",
                {"provider": "youtube", "kind": "video", "id": VIDEO, "page": "item"},
            ),
            (
                "https://www.twitch.tv/pesh",
                {"provider": "twitch", "kind": "channel", "id": "pesh", "page": "item"},
            ),
            (
                f"https://rutube.ru/video/{EPISODE}/",
                {"provider": "rutube", "kind": "video", "id": EPISODE, "page": "item"},
            ),
            (
                "https://rutube.ru/metainfo/tv/356362/",
                {"provider": "rutube", "kind": "series", "id": "356362", "page": "series"},
            ),
            (
                f"https://vkvideo.ru/video{CLIP}",
                {"provider": "vk", "kind": "video", "id": CLIP, "page": "item"},
            ),
            (
                f"  https://vkvideo.ru/playlist/{SEASON}\n",
                {"provider": "vk", "kind": "playlist", "id": SEASON, "page": "playlist"},
            ),
        ):
            answer = self.ask(client, url)
            self.assertEqual((answer.status_code, answer.json()), (200, {"route": route}), url)
        self.core.member.assert_awaited_with(ROOM, "Bearer member.secret")

    def test_an_unknown_link_goes_to_the_general_path_and_its_answer_is_the_answer(self):
        # Что нашлось на чужой странице, решает общий путь (`test_cinema_link.py`); маршрут отдаёт его
        # ответ как есть, а грамматику площадок спрашивает до него.
        client = self.serve()
        found = {"item": None, "reason": "На этой странице не нашлось видео, которое можно показать комнате"}
        # Клиент общего пути заводится (он нужен разбору потока), но наружу здесь не ходит никто.
        with (
            patch.object(self.cinema.net, "client_for", return_value=None),
            patch.object(Link, "inspect", AsyncMock(return_value=found)) as inspect,
        ):
            answer = self.ask(client, "https://example.com/films/1/video.mp4")
        self.assertEqual((answer.status_code, answer.json()), (200, found))
        self.assertEqual(inspect.await_args.args[1], "https://example.com/films/1/video.mp4")

    def test_without_the_general_path_an_unknown_link_says_why(self):
        client = self.serve("youtube,twitch,rutube,vk")
        answer = self.ask(client, "https://example.com/films/1/video.mp4")
        reason = "Эту ссылку пока не открыть: кинозал узнаёт ссылки YouTube, Twitch, Rutube и VK Видео"
        self.assertEqual((answer.status_code, answer.json()), (200, {"item": None, "reason": reason}))

    def test_a_link_of_a_platform_switched_off_is_known_but_not_opened(self):
        client = self.serve("twitch")
        answer = self.ask(client, f"https://www.youtube.com/watch?v={VIDEO}")
        self.assertEqual(
            answer.json(),
            {"item": None, "reason": "Это ссылка на YouTube, а эта площадка выключена на этом сервере"},
        )
        self.assertEqual(
            self.ask(client, "https://example.com/").json(),
            {"item": None, "reason": "Эту ссылку пока не открыть: кинозал узнаёт ссылки Twitch"},
        )
        self.assertEqual(self.ask(client, "https://www.twitch.tv/pesh").json()["route"]["provider"], "twitch")

    def test_what_is_not_a_link_is_refused_in_words(self):
        client = self.serve()
        refused = {
            "detail": "Это не ссылка на страницу: нужен адрес, который начинается с https:// или http://"
        }
        for url in (
            "javascript:alert(1)",
            f"youtube.com/watch?v={VIDEO}",
            "ftp://example.com/video.mp4",
            "https://",
            "маша и медведь",
            f"https://user:secret@youtube.com/watch?v={VIDEO}",
            f"https://www.youtube.com/watch?v={VIDEO} https://example.com",
        ):
            answer = self.ask(client, url)
            self.assertEqual((answer.status_code, answer.json()), (400, refused), url)
        # Длина и пустота — схема запроса: такую ссылку ни вставить, ни набрать нельзя.
        for body in ({"url": "https://example.com/" + "a" * 2000}, {"url": ""}, {}):
            answer = client.post(f"/api/v1/services/rooms/{ROOM}/cinema/link", json=body)
            self.assertEqual(answer.status_code, 422, body)

    def test_the_link_is_for_members_of_the_room_only(self):
        client = self.serve()
        self.core.member.side_effect = HTTPException(403, "Сначала войдите во встречу")
        answer = self.ask(client, f"https://youtu.be/{VIDEO}")
        self.assertEqual((answer.status_code, answer.json()), (403, {"detail": "Сначала войдите во встречу"}))

    def test_twenty_links_a_minute_for_a_room_however_its_number_is_spelled(self):
        client = self.serve()
        room = "8f3cab1e-dead-beef-cafe-0123456789ab"
        self.core.member.return_value = ({"id": room}, {"id": "member"})
        # Не ссылка — отказ раньше предела: опечатка не стоит комнате места в минуте.
        self.assertEqual(self.ask(client, "не ссылка", room=room).status_code, 400)
        answers = [
            self.ask(
                client, f"https://youtu.be/{VIDEO}", room=room.upper() if number % 2 else room
            ).status_code
            for number in range(20)
        ]
        self.assertEqual(answers, [200] * 20)
        refused = self.ask(client, "https://example.com/", room=room)
        self.assertEqual(
            (refused.status_code, refused.json(), refused.headers["Retry-After"]),
            (429, {"detail": "Комната слишком часто открывает ссылки, подождите минуту"}, "60"),
        )
        # Другая комната живёт своим счётом, а через минуту место освобождается и у этой.
        self.assertEqual(self.ask(client, f"https://youtu.be/{VIDEO}", room=ROOM).status_code, 200)
        self.now += 60
        self.assertEqual(self.ask(client, f"https://youtu.be/{VIDEO}", room=room).status_code, 200)


if __name__ == "__main__":
    unittest.main()
