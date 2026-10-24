"""
Музыка с YouTube на сервере, который до YouTube не достаёт (R112, продолжение): отказ сразу, а не
вечное «Ищем…».

Поиск и треки YouTube у музыки идут тем же yt-dlp и той же сетью, что каталог кинозала
(`YtDlp.offload_for`), поэтому и автомат у них один — кинозала (`cinema/reach.py`): кто первым узнал,
что площадка отсюда не видна, закрыл её для обоих. У поиска музыки — жёсткий срок, как у каталога;
у площадки без автомата (SoundCloud) — только срок. Отказ — своим кодом (`MUSIC_UNREACHABLE`,
`MUSIC_TIMEOUT`) и с площадкой, чтобы клиент назвал её на языке человека. Сети нет: yt-dlp и проба
подменены, тесты идут и с `--network none`.
"""

import threading
import time
import uuid
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from test_cinema_reach import ytdlp_timeout
from test_music_sources import FakeYdl, VIDEO
from test_services import Fixture, ROOM, GUEST
from cord_services import sources as music_sources
from cord_services.cinema import reach
from cord_services.webapp import Refusal

SEARCH = f"/api/v1/services/rooms/{ROOM}/music/search"
LINK = f"/api/v1/services/rooms/{ROOM}/music/link"
CATALOG = "/api/v1/services/catalog"
UNREACHABLE = {
    "code": "MUSIC_UNREACHABLE",
    "detail": "YouTube недоступен с этого сервера",
    "source": "youtube",
}


class Harness(Fixture):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.integrations_allowed = True
        self.sources = self.app.state.sources
        self.cinema = self.app.state.cinema
        self.youtube = self.cinema.registry.get("youtube")
        self.asked = []
        self.answers = {}
        self.release = threading.Event()
        self.addCleanup(self.release.set)

        def extract(address, options, provider):
            self.asked.append(address)
            answer = self.answers.get(address.rsplit(":", 1)[-1], {"entries": []})
            if answer == "hang":
                # Поток yt-dlp, до площадки которого нет сети: держит место, пока его не отпустят.
                self.release.wait(10)
                return {"entries": []}
            if isinstance(answer, BaseException):
                raise answer
            return answer

        patcher = patch.object(self.sources.ytdlp, "extract", side_effect=extract)
        patcher.start()
        self.addCleanup(patcher.stop)

    @property
    def gauge(self):
        return self.cinema.reach.gauge(self.youtube)

    def close_youtube(self, cause=reach.BY_PROBE):
        """YouTube признан недоступным: проба только что была — «Повторить» её снова не спрашивает."""
        with self.assertLogs("cord_services.cinema.reach", "WARNING"):
            self.cinema.reach._open(self.gauge, cause)
        self.gauge.probed_at = self.cinema.reach.clock()

    async def search(self, query, source="youtube"):
        return await self.client.post(
            SEARCH, headers=self.headers(GUEST), json={"source": source, "query": query}
        )


class SearchTests(Harness):
    async def test_while_youtube_is_unreachable_search_is_refused_at_once_without_yt_dlp(self):
        self.close_youtube()
        with patch.object(self.sources.ytdlp.pool, "submit", side_effect=AssertionError("пул не трогают")):
            response = await self.search("song")
        self.assertEqual(response.status_code, 503, response.text)
        self.assertEqual(response.json(), UNREACHABLE)
        self.assertEqual(response.headers["retry-after"], "30")
        self.assertEqual(self.asked, [])
        # Отказ не тратит предел поисков комнаты: ничего наружу он не стоил.
        self.assertNotIn(ROOM, self.sources.searches._events)
        self.assertEqual(self.gauge.refused, 1)

    async def test_youtube_closed_by_the_cinema_refuses_music_and_music_failures_close_it_for_the_cinema(
        self,
    ):
        for number in range(reach.FAILURES):
            self.answers[f"запрос {number}"] = ytdlp_timeout()
        with self.assertLogs("cord_services.cinema.reach", "WARNING"):
            for number in range(reach.FAILURES):
                response = await self.search(f"запрос {number}")
                self.assertEqual(response.status_code, 502)
        self.assertEqual(self.gauge.state, reach.OPEN)
        # Музыка узнала первой — кинозал отказывает сразу, своими словами.
        with self.assertRaises(Refusal) as refused:
            await self.cinema.search("youtube", "кино", room=ROOM)
        self.assertEqual(refused.exception.code, "CINEMA_UNREACHABLE")
        asked = len(self.asked)
        response = await self.search("запрос 4")
        self.assertEqual((response.status_code, response.json()["code"]), (503, "MUSIC_UNREACHABLE"))
        self.assertEqual(len(self.asked), asked)

    async def test_a_refusal_of_the_platform_in_its_own_words_is_not_a_network_failure(self):
        self.answers["song"] = RuntimeError("Sign in to confirm your age")
        response = await self.search("song")
        self.assertEqual(response.status_code, 502)
        self.assertEqual((self.gauge.state, self.gauge.failures), (reach.CLOSED, 0))

    async def test_a_search_that_hangs_ends_with_words_at_the_deadline_and_counts_into_the_breaker(self):
        self.answers["song"] = "hang"
        started = time.monotonic()
        with patch.object(music_sources, "SEARCH_DEADLINE", 0.2):
            response = await self.search("song")
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(response.status_code, 504)
        self.assertEqual(
            response.json(),
            {
                "code": "MUSIC_TIMEOUT",
                "detail": "YouTube не ответил вовремя — попробуйте ещё раз",
                "source": "youtube",
            },
        )
        self.assertEqual((self.gauge.deadlines, self.gauge.failures), (1, 1))
        self.release.set()

    async def test_soundcloud_has_no_breaker_but_keeps_the_deadline(self):
        self.answers["artist"] = "hang"
        with patch.object(music_sources, "SEARCH_DEADLINE", 0.2):
            response = await self.search("artist", source="soundcloud")
        self.assertEqual(response.status_code, 504)
        self.assertEqual(
            response.json(),
            {
                "code": "MUSIC_TIMEOUT",
                "detail": "SoundCloud не ответил вовремя — попробуйте ещё раз",
                "source": "soundcloud",
            },
        )
        self.release.set()

    async def test_soundcloud_keeps_working_while_youtube_is_unreachable(self):
        self.close_youtube()
        response = await self.search("artist", source="soundcloud")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(self.asked[0].startswith("scsearch"))

    async def test_after_the_pause_one_music_search_is_the_trial_and_its_answer_closes(self):
        self.close_youtube(reach.BY_TRAFFIC)
        self.gauge.retry_at = self.cinema.reach.clock() - 1
        self.answers["song"] = {"entries": [{"id": VIDEO, "title": "Song", "duration": 200}]}
        # Проба говорит «есть куда слать» — пробным становится сам поиск музыки.
        with patch.object(self.cinema.reach, "probe", AsyncMock(return_value=True)):
            with self.assertLogs("cord_services.cinema.reach", "WARNING"):
                response = await self.search("song")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.gauge.state, reach.CLOSED)

    async def test_a_refusal_is_not_remembered_and_the_next_search_asks_again(self):
        self.close_youtube()
        self.assertEqual((await self.search("song")).status_code, 503)
        with self.assertLogs("cord_services.cinema.reach", "WARNING"):
            self.cinema.reach._close(self.gauge)
        response = await self.search("song")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(self.asked), 1)


class LinkTests(Harness):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.runs = []
        self.failure = None

        def run(platform, options, work):
            self.runs.append(platform.id)
            if self.failure is not None:
                raise self.failure
            self.options = options
            self.pages = []
            info = {
                "id": VIDEO,
                "title": "Song",
                "channel": "Artist",
                "duration": 1,
                "live_status": "not_live",
                "formats": [{"format_id": "251"}],
            }
            return work(FakeYdl(self, info, 1, thumbnail=False))

        patcher = patch.object(self.sources, "_run", side_effect=run)
        patcher.start()
        self.addCleanup(patcher.stop)

    async def add(self, url=f"https://youtu.be/{VIDEO}"):
        return await self.client.post(
            LINK, headers=self.headers(GUEST), json={"url": url, "commandId": str(uuid.uuid4())}
        )

    async def test_a_youtube_link_is_refused_at_once_while_youtube_is_unreachable(self):
        self.close_youtube()
        response = await self.add()
        self.assertEqual(response.status_code, 503, response.text)
        self.assertEqual(response.json(), UNREACHABLE)
        self.assertEqual(self.runs, [])
        self.assertNotIn(ROOM, self.sources.links._events)
        self.assertEqual(self.store.get(ROOM)["queue"], [])

    async def test_a_download_that_does_not_reach_youtube_counts_and_one_that_does_resets(self):
        self.failure = ytdlp_timeout()
        with self.assertLogs("cord_services.sources", "INFO"):
            response = await self.add()
        self.assertEqual(response.status_code, 502)
        self.assertEqual(self.gauge.failures, 1)
        self.failure = None
        response = await self.add()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.gauge.failures, 0)


class CatalogTests(Harness):
    async def test_the_catalog_names_the_sources_this_server_cannot_reach(self):
        self.assertEqual((await self.client.get(CATALOG)).json()["unreachable"], [])
        self.close_youtube()
        listed = (await self.client.get(CATALOG)).json()
        self.assertEqual(listed["unreachable"], ["youtube"])
        self.assertIn("youtube", listed["sources"], "площадка остаётся в списке — отмечена недоступной")

    async def test_retry_asks_the_probe_again_and_learns_that_youtube_is_back(self):
        self.close_youtube()
        self.gauge.probed_at = self.cinema.reach.clock() - reach.RETRY_PROBE_GAP

        async def back(source):
            self.cinema.reach._probed(self.cinema.reach.gauge(source), True)
            return True

        with patch.object(self.cinema.reach, "probe", side_effect=back) as probe:
            with self.assertLogs("cord_services.cinema.reach", "WARNING"):
                listed = (await self.client.get(CATALOG)).json()
        self.assertEqual(probe.await_count, 1)
        self.assertEqual(listed["unreachable"], [])

    async def test_a_traffic_opened_youtube_due_for_a_check_is_shown_reachable(self):
        # Иначе площадку, у которой проба проходит, а запросы — нет, никто никогда не спросил бы снова.
        self.close_youtube(reach.BY_TRAFFIC)
        self.gauge.retry_at = self.cinema.reach.clock() - 1
        self.assertEqual((await self.client.get(CATALOG)).json()["unreachable"], [])


class WithoutCinemaYoutubeTests(Fixture):
    """YouTube выключен у кинозала (`CINEMA_PROVIDERS`): автомата нет, но срок у поиска музыки есть."""

    async def asyncSetUp(self):
        with patch.dict("os.environ", {"CINEMA_PROVIDERS": "rutube"}):
            await super().asyncSetUp()
        self.integrations_allowed = True
        self.sources = self.app.state.sources
        self.release = threading.Event()
        self.addCleanup(self.release.set)

        def extract(address, options, provider):
            self.release.wait(10)
            return {"entries": []}

        patcher = patch.object(self.sources.ytdlp, "extract", side_effect=extract)
        patcher.start()
        self.addCleanup(patcher.stop)

    async def test_music_search_still_ends_at_the_deadline(self):
        with patch.object(music_sources, "SEARCH_DEADLINE", 0.2):
            with self.assertRaises(HTTPException) as late:
                await self.sources.search(ROOM, "youtube", "song")
        self.assertEqual((late.exception.status_code, late.exception.code), (504, "MUSIC_TIMEOUT"))
        self.release.set()
        listed = (await self.client.get(CATALOG)).json()
        self.assertEqual(listed["unreachable"], [])
        self.assertIn("youtube", listed["sources"])


class AppTests(Fixture):
    async def test_music_asks_youtube_through_the_cinema_breaker_and_soundcloud_without_one(self):
        sources = self.app.state.sources
        self.assertIs(sources.reach, self.app.state.cinema.reach)
        self.assertIs(sources.gate("youtube"), self.app.state.cinema.registry.get("youtube"))
        self.assertIsNone(sources.gate("soundcloud"))
