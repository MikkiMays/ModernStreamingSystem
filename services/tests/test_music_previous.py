"""
«Назад» в плеере музыки (R44, DECISIONS Р-14): история сыгранных треков и правило «трек идёт дольше
трёх секунд — сначала, иначе — предыдущий», как у любого плеера.

Сыгранный трек раньше уходил из очереди вместе с файлом, и вернуться к нему было нечем. Теперь
последние `HISTORY` сыгранных (доигранных или пропущенных) помнятся вместе с файлами; «назад» ставит
последний из них снова первым и играет с начала, а тот, что играл, становится следующим.
"""

import uuid
from unittest.mock import patch

from test_services import Fixture, ROOM, HOST, track
from cord_services import music as music_module
from cord_services.music import HISTORY, played
from cord_services.store import TRACK_TTL

COMMANDS = f"/api/v1/services/rooms/{ROOM}/music/commands"


class PreviousTests(Fixture):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.tracks = [track(self.store, title) for title in ("One", "Two", "Three")]
        for item in self.tracks:
            await self.music.enqueue(ROOM, item)

    async def send(self, action, command=None, **extra):
        return await self.client.post(
            COMMANDS,
            headers=self.headers(HOST),
            json={"commandId": command or str(uuid.uuid4()), "action": action, **extra},
        )

    def titles(self):
        return [t["title"] for t in self.store.get(ROOM)["queue"]]

    def at(self, position):
        state = self.store.get(ROOM)
        state["position"] = position
        self.store.save(state)

    async def test_back_right_after_a_skip_plays_the_skipped_track_again_from_the_start(self):
        await self.send("skip")
        self.assertEqual(self.titles(), ["Two", "Three"])
        epoch = self.store.get(ROOM)["epoch"]
        self.at(1.5)
        response = await self.send("previous")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.titles(), ["One", "Two", "Three"])
        state = self.store.get(ROOM)
        self.assertEqual(state["position"], 0.0)
        self.assertGreater(state["epoch"], epoch, "новая эпоха — издатель переключится сразу")
        self.assertFalse(response.json()["previous"], "история кончилась")

    async def test_back_after_three_seconds_restarts_the_current_track(self):
        await self.send("skip")
        self.at(42.0)
        response = await self.send("previous")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.titles(), ["Two", "Three"])
        self.assertEqual(self.store.get(ROOM)["position"], 0.0)
        self.assertTrue(response.json()["previous"], "история осталась на следующее «назад»")

    async def test_back_with_nothing_played_restarts_the_current_track(self):
        self.at(2.0)
        response = await self.send("previous")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.titles(), ["One", "Two", "Three"])
        self.assertEqual(self.store.get(ROOM)["position"], 0.0)
        self.assertFalse(response.json()["previous"])

    async def test_back_walks_the_history_one_track_at_a_time(self):
        await self.send("skip")
        await self.send("skip")
        self.assertEqual(self.titles(), ["Three"])
        await self.send("previous")
        self.assertEqual(self.titles(), ["Two", "Three"])
        await self.send("previous")
        self.assertEqual(self.titles(), ["One", "Two", "Three"])

    async def test_back_from_an_empty_queue_brings_the_last_track_back(self):
        for _ in self.tracks:
            await self.send("skip")
        self.assertEqual(self.titles(), [])
        await self.send("previous")
        self.assertEqual(self.titles(), ["Three"])

    async def test_with_repeat_the_track_moves_back_to_the_front_instead_of_doubling(self):
        await self.send("repeat", enabled=True)
        await self.send("skip")
        self.assertEqual(self.titles(), ["Two", "Three", "One"])
        await self.send("previous")
        self.assertEqual(self.titles(), ["One", "Two", "Three"])
        ids = [t["id"] for t in self.store.get(ROOM)["queue"]]
        self.assertEqual(len(ids), len(set(ids)))

    async def test_the_same_command_twice_goes_back_once(self):
        await self.send("skip")
        await self.send("skip")
        command = str(uuid.uuid4())
        await self.send("previous", command)
        await self.send("previous", command)
        self.assertEqual(self.titles(), ["Two", "Three"])

    async def test_files_of_played_tracks_stay_while_they_are_in_the_history(self):
        await self.send("skip")
        self.assertTrue((self.store.files / self.tracks[0]["file"]).is_file())
        self.assertIn(self.tracks[0]["file"], self.store.referenced())

    async def test_a_history_track_whose_file_is_gone_is_passed_over(self):
        await self.send("skip")
        await self.send("skip")
        (self.store.files / self.tracks[1]["file"]).unlink()
        await self.send("previous")
        self.assertEqual(self.titles(), ["One", "Three"])

    async def test_the_route_knew_no_previous_before(self):
        response = await self.send("back")
        self.assertEqual(response.status_code, 422)


class HistoryTests(Fixture):
    async def test_only_the_last_tracks_are_remembered_and_older_files_go_away(self):
        state = self.store.get(ROOM)
        tracks = [track(self.store, f"T{number}") for number in range(HISTORY + 3)]
        dropped = []
        for item in tracks:
            dropped += played(state, item)
        self.assertEqual([t["title"] for t in state["history"]], [t["title"] for t in tracks[3:]])
        self.assertEqual([t["id"] for t in dropped], [t["id"] for t in tracks[:3]])

    async def test_a_finished_track_lands_in_the_history_like_a_skipped_one(self):
        first, second = track(self.store, "One"), track(self.store, "Two")
        for item in (first, second):
            await self.music.enqueue(ROOM, item)
        epoch = self.store.get(ROOM)["epoch"]
        self.music.finished(self.store.get(ROOM))
        state = self.store.get(ROOM)
        self.assertEqual([t["title"] for t in state["queue"]], ["Two"])
        self.assertEqual([t["title"] for t in state["history"]], ["One"])
        self.assertEqual(state["epoch"], epoch + 1)
        self.assertTrue((self.store.files / first["file"]).is_file())

    async def test_expired_history_goes_away_with_its_files(self):
        old = track(self.store, "Old", age=TRACK_TTL + 1000)
        state = self.store.get(ROOM)
        played(state, old)
        self.store.save(state)
        self.store.cleanup()
        self.assertEqual(self.store.get(ROOM).get("history"), [])
        self.assertFalse((self.store.files / old["file"]).exists())

    async def test_a_full_server_sheds_the_history_before_refusing_a_track(self):
        state = self.store.get(ROOM)
        kept = track(self.store, "Kept")
        played(state, kept)
        self.store.save(state)
        size = (self.store.files / kept["file"]).stat().st_size
        with patch.object(music_module, "MAX_TOTAL", size + 10):
            self.music.check_quota(ROOM, 20)
        self.assertEqual(self.store.get(ROOM)["history"], [])
        self.assertFalse((self.store.files / kept["file"]).exists())
