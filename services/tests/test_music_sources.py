"""Музыка с площадок без аккаунта (T18): ссылки, поиск, скачивание, обложки — без сети."""

import os
import subprocess
import time
import uuid
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import HTTPException

from test_services import Fixture, ROOM, HOST, GUEST, audio, track
from cord_services import covers
from cord_services.app import create_app
from cord_services.sources import TooBig, TooSlow, recognize
from cord_services.store import Store, size_of

SEARCH = f"/api/v1/services/rooms/{ROOM}/music/search"
LINK = f"/api/v1/services/rooms/{ROOM}/music/link"
COVERS = "/api/v1/services/music/covers/"
VIDEO = "dQw4w9WgXcQ"


def picture(path, size="64x48"):
    """Картинка для обложки — тем же ffmpeg, что в образе службы."""
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"color=c=red:s={size}",
            "-frames:v",
            "1",
            "-y",
            str(path),
        ],
        check=True,
    )


def tagged(path):
    """MP3 со встроенной обложкой — как у большинства купленных треков."""
    art = path.with_suffix(".png")
    picture(art)
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=d=1",
            "-i",
            str(art),
            "-map",
            "0:a",
            "-map",
            "1:v",
            "-c:a",
            "libmp3lame",
            "-c:v",
            "mjpeg",
            "-id3v2_version",
            "3",
            "-disposition:v:0",
            "attached_pic",
            "-y",
            str(path),
        ],
        check=True,
    )
    art.unlink()


class RecognizeTests(Fixture):
    def test_youtube_links_become_one_watch_address(self):
        canonical = f"https://www.youtube.com/watch?v={VIDEO}"
        for url in (
            f"https://www.youtube.com/watch?v={VIDEO}",
            f"https://youtube.com/watch?v={VIDEO}&t=42s",
            f"https://m.youtube.com/watch?v={VIDEO}",
            f"https://music.youtube.com/watch?v={VIDEO}&list=RDAMVM{VIDEO}",
            f"https://youtu.be/{VIDEO}?si=abc",
            f"https://www.youtube.com/shorts/{VIDEO}",
            f"http://www.youtube.com/watch?v={VIDEO}",
        ):
            with self.subTest(url=url):
                self.assertEqual(recognize(url), ("youtube", canonical))

    def test_soundcloud_track_links_lose_their_tracking(self):
        canonical = "https://soundcloud.com/artist-name/track-name"
        for url in (
            "https://soundcloud.com/artist-name/track-name",
            "https://www.soundcloud.com/artist-name/track-name?si=1&utm_source=x",
            "https://m.soundcloud.com/artist-name/track-name",
            "https://soundcloud.com/artist-name/track-name/",
        ):
            with self.subTest(url=url):
                self.assertEqual(recognize(url), ("soundcloud", canonical))

    def test_everything_else_is_not_a_track(self):
        for url in (
            "https://www.youtube.com/playlist?list=PL1234567890ab",
            "https://www.youtube.com/@channel",
            "https://www.youtube.com/watch",
            "https://www.youtube.com/watch?v=short",
            "https://youtube.com.evil.test/watch?v=" + VIDEO,
            "https://youtube.com@evil.test/watch?v=" + VIDEO,
            "https://www.youtube.com:8443/watch?v=" + VIDEO,
            "https://soundcloud.com/artist-name",
            "https://soundcloud.com/artist-name/sets/album",
            "https://soundcloud.com/discover/sets/charts",
            "https://soundcloud.com/search/sounds?q=x",
            "https://soundcloud.com/artist-name/likes",
            "https://soundcloud.com/artist-name/track-name/reposts",
            "https://music.yandex.ru/album/1/track/2",
            "https://example.test/song.mp3",
            "ftp://soundcloud.com/a/b",
            "не ссылка",
        ):
            with self.subTest(url=url):
                self.assertIsNone(recognize(url))


class SearchTests(Fixture):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.integrations_allowed = True
        self.sources = self.app.state.sources
        self.asked = []

    def answer(self, entries):
        def extract(address, options, provider):
            self.asked.append((address, options, provider))
            return {"entries": entries}

        patcher = patch.object(self.sources.ytdlp, "extract", side_effect=extract)
        patcher.start()
        self.addCleanup(patcher.stop)

    async def test_youtube_results_are_tracks_with_a_watch_address(self):
        self.answer(
            [
                {"id": VIDEO, "title": "Song", "channel": "Artist", "duration": 213},
                {
                    "id": "AAAAAAAAAAA",
                    "title": "Live now",
                    "channel": "Radio",
                    "live_status": "is_live",
                },
                {"id": "bad id", "title": "Broken"},
                None,
            ]
        )
        response = await self.client.post(
            SEARCH,
            headers=self.headers(GUEST),
            json={"source": "youtube", "query": "song"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        found = response.json()
        self.assertEqual(
            found[0],
            {
                "url": f"https://www.youtube.com/watch?v={VIDEO}",
                "title": "Song",
                "artist": "Artist",
                "duration": 213.0,
                "available": True,
                "source": "youtube",
            },
        )
        self.assertFalse(found[1]["available"])
        self.assertEqual(len(found), 2)
        address, options, provider = self.asked[0]
        self.assertTrue(address.startswith("ytsearch"))
        self.assertTrue(address.endswith(":song"))
        self.assertEqual(provider, "youtube")
        self.assertEqual(options["allowed_extractors"], ["youtube:search"])
        self.assertTrue(options["extract_flat"])

    async def test_soundcloud_fragments_cannot_be_added(self):
        self.answer(
            [
                {
                    "id": "1",
                    "title": "Full",
                    "uploader": "Artist",
                    "duration": 322.6,
                    "webpage_url": "https://soundcloud.com/artist/full",
                },
                {
                    "id": "2",
                    "title": "Go+",
                    "uploader": "Artist",
                    "duration": 30.0,
                    "webpage_url": "https://soundcloud.com/artist/plus",
                },
                {
                    "id": "3",
                    "title": "Elsewhere",
                    "webpage_url": "https://evil.test/a/b",
                },
            ]
        )
        response = await self.client.post(
            SEARCH,
            headers=self.headers(),
            json={"source": "soundcloud", "query": "artist"},
        )
        found = response.json()
        self.assertEqual(
            [t["url"] for t in found],
            [
                "https://soundcloud.com/artist/full",
                "https://soundcloud.com/artist/plus",
            ],
        )
        self.assertEqual([t["available"] for t in found], [True, False])
        self.assertTrue(self.asked[0][0].startswith("scsearch"))

    async def test_same_question_is_answered_from_memory_and_rooms_are_limited(self):
        self.answer([{"id": VIDEO, "title": "Song", "duration": 1}])
        for _ in range(2):
            await self.sources.search(ROOM, "youtube", "Song")
        self.assertEqual(len(self.asked), 1)
        with self.assertRaises(HTTPException) as short:
            await self.sources.search(ROOM, "youtube", " ")
        self.assertEqual(short.exception.status_code, 400)
        for i in range(19):
            await self.sources.search(ROOM, "youtube", f"q{i}")
        with self.assertRaises(HTTPException) as limited:
            await self.sources.search(ROOM, "youtube", "one more")
        self.assertEqual(limited.exception.status_code, 429)

    async def test_switched_off_source_is_refused(self):
        self.sources.enabled = frozenset({"youtube"})
        with self.assertRaises(HTTPException) as refused:
            await self.sources.search(ROOM, "soundcloud", "x")
        self.assertEqual(refused.exception.status_code, 400)

    async def test_platform_failure_is_a_human_refusal(self):
        patcher = patch.object(
            self.sources.ytdlp, "extract", side_effect=RuntimeError("boom")
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        with self.assertRaises(HTTPException) as failed:
            await self.sources.search(ROOM, "youtube", "anything")
        self.assertEqual(failed.exception.status_code, 502)
        self.assertIn("YouTube", failed.exception.detail)


class FakeYdl:
    """yt-dlp без сети: отдаёт заданный разбор и «скачивает» заданный файл."""

    def __init__(self, test, info, seconds=1, thumbnail=True):
        self.test, self.info, self.seconds, self.thumbnail = (
            test,
            info,
            seconds,
            thumbnail,
        )
        self.downloaded = False

    def extract_info(self, url, download=False):
        self.test.assertFalse(download)
        self.test.pages.append(url)
        return dict(self.info)

    def process_ie_result(self, info, download=True):
        self.downloaded = True
        template = self.test.options["outtmpl"]
        target = Path(template["default"].replace("%(ext)s", "webm"))
        audio(target, self.seconds)
        if self.thumbnail:
            picture(Path(template["thumbnail"].replace("%(ext)s", "png")))
        return {**info, "requested_downloads": [{"filepath": str(target)}]}


class LinkTests(Fixture):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.integrations_allowed = True
        self.sources = self.app.state.sources
        self.pages = []
        self.options = None
        self.ydl = None
        self.info = {
            "id": VIDEO,
            "title": "Song",
            "channel": "Artist",
            "duration": 1,
            "live_status": "not_live",
            "formats": [{"format_id": "251", "acodec": "opus", "vcodec": "none"}],
        }
        self.seconds = 1

        def run(platform, options, work):
            self.options = options
            self.ydl = FakeYdl(self, self.info, self.seconds)
            return work(self.ydl)

        patcher = patch.object(self.sources, "_run", side_effect=run)
        patcher.start()
        self.addCleanup(patcher.stop)

    async def add(self, url=f"https://youtu.be/{VIDEO}", command=None, member=GUEST):
        return await self.client.post(
            LINK,
            headers=self.headers(member),
            json={"url": url, "commandId": command or str(uuid.uuid4())},
        )

    async def test_a_link_lands_in_the_queue_with_its_cover(self):
        response = await self.add()
        self.assertEqual(response.status_code, 200, response.text)
        queued = response.json()["queue"][0]
        self.assertEqual(queued["source"], "youtube")
        self.assertEqual(queued["title"], "Song")
        self.assertEqual(queued["artist"], "Artist")
        self.assertEqual(queued["addedBy"], "Guest")
        self.assertRegex(queued["cover"], r"^[0-9a-f-]{36}\.jpg$")
        self.assertEqual(self.pages, [f"https://www.youtube.com/watch?v={VIDEO}"])
        self.assertEqual(self.options["allowed_extractors"], ["youtube"])
        self.assertTrue(self.options["noplaylist"])
        # Куски и миниатюра — в `incoming/`, время файла — время скачивания, а не площадки.
        self.assertTrue(
            self.options["outtmpl"]["default"].startswith(str(self.store.incoming))
        )
        self.assertFalse(self.options["updatetime"])
        self.assertEqual(list(self.store.incoming.iterdir()), [])
        stored = self.store.get(ROOM)["queue"][0]
        self.assertTrue((self.store.files / stored["file"]).is_file())
        self.assertTrue((self.store.files / stored["cover"]).is_file())
        # Миниатюра площадки своё отслужила: на диске только звук и обложка.
        self.assertEqual(len(list(self.store.files.iterdir())), 2)
        cover = await self.client.get(COVERS + queued["cover"])
        self.assertEqual(cover.status_code, 200)
        self.assertEqual(cover.headers["content-type"], "image/jpeg")
        self.assertIn("max-age", cover.headers["cache-control"])
        self.assertEqual(cover.content[:2], b"\xff\xd8")

    async def test_the_same_command_does_not_download_twice(self):
        command = str(uuid.uuid4())
        first = await self.add(command=command)
        again = await self.add(command=command)
        self.assertEqual(again.json(), first.json())
        self.assertEqual(len(self.pages), 1)
        reused = await self.add(url="https://soundcloud.com/a/b", command=command)
        self.assertEqual(reused.status_code, 409)

    async def test_live_long_and_fragments_are_refused_and_leave_nothing_behind(self):
        cases = [
            ({"live_status": "is_live"}, 400, "Эфир"),
            ({"duration": 4000}, 400, "60 минут"),
            ({"duration": None}, 400, "60 минут"),
            (
                {
                    "formats": [
                        {"format_id": "hls_mp3_1_0_preview", "acodec": "mp3"},
                        {"format_id": "http_mp3_1_0_preview", "acodec": "mp3"},
                    ]
                },
                403,
                "фрагмент",
            ),
        ]
        for patch_info, status, words in cases:
            with self.subTest(case=patch_info):
                self.info = {**self.info, **patch_info}
                refused = await self.add()
                self.assertEqual(refused.status_code, status, refused.text)
                self.assertIn(words, refused.json()["detail"])
                self.assertFalse(self.ydl.downloaded)
                self.info = {
                    **self.info,
                    "live_status": "not_live",
                    "duration": 1,
                    "formats": [],
                }
        self.info["duration"] = 60
        short = await self.add()
        self.assertEqual(short.status_code, 403)
        self.assertIn("фрагмент", short.json()["detail"])
        self.assertEqual(list(self.store.files.iterdir()), [])
        self.assertEqual(self.store.get(ROOM)["queue"], [])

    async def test_foreign_links_and_switched_off_sources_are_refused(self):
        refused = await self.add(url="https://example.test/song.mp3")
        self.assertEqual(refused.status_code, 400)
        self.assertIn("YouTube", refused.json()["detail"])
        self.sources.enabled = frozenset({"soundcloud"})
        off = await self.add()
        self.assertEqual(off.status_code, 400)
        self.assertEqual(self.pages, [])

    async def test_oversized_or_slow_download_is_refused_in_words(self):
        for error, status in ((TooBig(), 413), (TooSlow(), 504)):
            with self.subTest(error=type(error).__name__):
                with patch.object(self.sources, "_run", side_effect=error):
                    refused = await self.add()
                self.assertEqual(refused.status_code, status)
                self.assertTrue(refused.json()["detail"])
        # yt-dlp оборачивает исключение крючка прогресса в своё — узнаётся по тексту.
        wrapped = RuntimeError("ERROR: TooBig()")
        with patch.object(self.sources, "_run", side_effect=wrapped):
            self.assertEqual((await self.add()).status_code, 413)
        with patch.object(
            self.sources, "_run", side_effect=RuntimeError("HTTP Error 403")
        ) as refused:
            failed = await self.add()
        self.assertEqual(failed.status_code, 502)
        self.assertIn("YouTube", failed.json()["detail"])
        # Необъяснённый отказ повторяется один раз, не больше.
        self.assertEqual(refused.call_count, 2)

    async def test_one_flaky_refusal_is_retried(self):
        real = self.sources._run
        attempts = []

        def flaky(platform, options, work):
            attempts.append(1)
            if len(attempts) == 1:
                raise RuntimeError("ERROR: [youtube] Requested format is not available")
            return real(platform, options, work)

        with patch.object(self.sources, "_run", side_effect=flaky):
            response = await self.add()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(attempts), 2)


class CoverTests(Fixture):
    async def test_embedded_picture_becomes_a_square_jpeg(self):
        source = self.root / "tagged.mp3"
        tagged(source)
        name = await covers.extract(source, self.store.files)
        self.assertRegex(name, r"^[0-9a-f-]{36}\.jpg$")
        data = (self.store.files / name).read_bytes()
        self.assertEqual(data[:2], b"\xff\xd8")
        probe = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "stream=width,height",
                "-of",
                "csv=p=0",
                str(self.store.files / name),
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        self.assertEqual(probe.stdout.strip(), f"{covers.SIDE},{covers.SIDE}")

    async def test_audio_without_a_picture_has_no_cover(self):
        source = self.root / "plain.wav"
        audio(source)
        self.assertIsNone(await covers.extract(source, self.store.files))
        self.assertEqual(list(self.store.files.iterdir()), [])
        self.assertIsNone(await covers.from_bytes(b"not an image", self.store.files))
        self.assertEqual(list(self.store.files.iterdir()), [])

    async def test_upload_keeps_the_embedded_cover(self):
        source = self.root / "tagged.mp3"
        tagged(source)
        response = await self.client.put(
            f"/api/v1/services/rooms/{ROOM}/music/upload/{uuid.uuid4()}",
            headers={**self.headers(), "X-Filename": "tagged.mp3"},
            content=source.read_bytes(),
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertRegex(response.json()["queue"][0]["cover"], r"\.jpg$")

    async def test_only_covers_of_queued_tracks_are_served(self):
        loose = await covers.from_bytes(self.png(), self.store.files)
        self.assertEqual((await self.client.get(COVERS + loose)).status_code, 404)
        queued = track(self.store, "One")
        queued["cover"] = loose
        await self.music.enqueue(ROOM, queued)
        self.assertEqual((await self.client.get(COVERS + loose)).status_code, 200)
        for name in (
            "../services.sqlite",
            queued["file"],
            "x.jpg",
            "%2e%2e%2fservices.sqlite",
        ):
            with self.subTest(name=name):
                self.assertEqual(
                    (await self.client.get(COVERS + name)).status_code, 404
                )

    async def test_cover_goes_away_with_its_track(self):
        queued = track(self.store, "One")
        queued["cover"] = await covers.from_bytes(self.png(), self.store.files)
        second = track(self.store, "Two")
        for item in (queued, second):
            await self.music.enqueue(ROOM, item)
        await self.music.command(
            ROOM, {"commandId": str(uuid.uuid4()), "action": "skip"}
        )
        self.assertFalse((self.store.files / queued["cover"]).exists())
        self.assertFalse((self.store.files / queued["file"]).exists())
        # Обложка переживает перезапуск службы вместе с очередью — и уборку свежих файлов.
        other = track(self.store, "Three")
        other["cover"] = await covers.from_bytes(self.png(), self.store.files)
        await self.music.enqueue(ROOM, other)
        self.store.cleanup()
        self.assertTrue((self.store.files / other["cover"]).exists())
        restored = Store(self.root)
        self.assertEqual(restored.public(ROOM)["queue"][-1]["cover"], other["cover"])
        restored.db.close()

    def png(self):
        path = self.root / "art.png"
        picture(path)
        return path.read_bytes()


class StorageRaceTests(Fixture):
    async def test_vanished_files_count_as_nothing_instead_of_failing(self):
        self.assertEqual(size_of(self.root / "missing"), 0)
        queued = track(self.store, "One")
        await self.music.enqueue(ROOM, queued)
        # Файл трека пропал (его убрал соседний поток) — подсчёт места не падает.
        (self.store.files / queued["file"]).unlink()
        self.music.check_quota(ROOM, 1)

    async def test_cleanup_sweeps_stale_downloads_but_not_fresh_ones(self):
        stale = self.store.incoming / "stale.webm.part"
        fresh = self.store.incoming / "fresh.webm.part"
        for path in (stale, fresh):
            path.write_bytes(b"x")
        old = time.time() - 7200
        os.utime(stale, (old, old))
        self.store.cleanup()
        self.assertFalse(stale.exists())
        self.assertTrue(fresh.exists())

    async def test_startup_forgets_downloads_of_the_previous_run(self):
        leftover = self.store.incoming / "left.m4a.part"
        leftover.write_bytes(b"x")
        self.app.state.sources.__class__(
            self.app.state.cinema.ytdlp, self.store, self.music
        ).close()
        self.assertFalse(leftover.exists())


class MoveTests(Fixture):
    async def test_a_track_moves_to_any_place_after_the_current_one(self):
        tracks = [track(self.store, title) for title in ("One", "Two", "Three", "Four")]
        for item in tracks:
            await self.music.enqueue(ROOM, item)

        async def move(item, index):
            return await self.client.post(
                f"/api/v1/services/rooms/{ROOM}/music/commands",
                headers=self.headers(HOST),
                json={
                    "commandId": str(uuid.uuid4()),
                    "action": "move",
                    "trackId": item["id"],
                    "index": index,
                },
            )

        self.assertEqual((await move(tracks[3], 1)).status_code, 200)
        self.assertEqual(
            [t["title"] for t in self.store.get(ROOM)["queue"]],
            ["One", "Four", "Two", "Three"],
        )
        self.assertEqual((await move(tracks[3], 99)).status_code, 200)
        self.assertEqual(
            [t["title"] for t in self.store.get(ROOM)["queue"]],
            ["One", "Two", "Three", "Four"],
        )
        playing = await move(tracks[0], 2)
        self.assertEqual(playing.status_code, 409)
        self.assertEqual((await move(tracks[1], 0)).status_code, 422)
        gone = await move({"id": str(uuid.uuid4())}, 1)
        self.assertEqual(gone.status_code, 404)


class CatalogTests(Fixture):
    async def test_catalog_lists_only_switched_on_sources(self):
        response = await self.client.get("/api/v1/services/catalog")
        self.assertEqual(
            response.json()["sources"],
            ["upload", "telegram", "yandex", "youtube", "soundcloud"],
        )
        await self.client.aclose()
        await self.music.close()
        await self.app.state.yandex.http.aclose()
        self.store.db.close()
        with patch.dict(
            "os.environ", {"MUSIC_SOURCES": "soundcloud, upload, nonsense"}
        ):
            self.app = create_app(self.root, self.core, telegram_enabled=False)
        self.store = self.app.state.store
        self.music = self.app.state.music
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(self.app), base_url="http://services.test"
        )
        response = await self.client.get("/api/v1/services/catalog")
        self.assertEqual(response.json()["sources"], ["upload", "soundcloud"])
        self.assertEqual(self.app.state.sources.enabled, frozenset({"soundcloud"}))
