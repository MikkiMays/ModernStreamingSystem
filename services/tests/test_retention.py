"""Срок содержимого в службе (Р-134): принесённое в комнату — не дольше суток от добавления, а память
кинозала — своим сроком, даже если её больше никто не спросит. Сколько ушло — метрика
`cord_retention_deleted_total`."""

import tempfile
import time
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace

from cord_services.cinema.memo import Memo
from cord_services.cinema.transport.segments import Segments
from cord_services.metrics import render
from cord_services.retention import Retention
from cord_services.store import TRACK_TTL, Store, initial, now

ROOM = "11111111-1111-4111-8111-111111111111"


class StoreSweepTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.tmp.name))

    def tearDown(self):
        self.store.db.close()
        self.tmp.cleanup()

    def track(self, title: str, age: int = 0) -> dict:
        key = str(uuid.uuid4())
        (self.store.files / key).write_bytes(b"ID3")
        return {
            "id": key,
            "file": key,
            "title": title,
            "artist": "",
            "duration": 1,
            "addedBy": "Tester",
            "source": "upload",
            "createdAt": now() - age,
        }

    def test_a_track_older_than_a_day_leaves_the_queue_the_history_and_the_disk(self):
        old, recent = self.track("Old", TRACK_TTL + 1), self.track("New")
        played = self.track("Was", TRACK_TTL + 1)
        room = initial(ROOM)
        room["enabled"] = True
        room["queue"] = [old, recent]
        room["history"] = [played]
        self.store.save(room)
        gone = self.store.cleanup()
        kept = self.store.get(ROOM)
        self.assertEqual([t["title"] for t in kept["queue"]], ["New"])
        self.assertEqual(kept.get("history"), [])
        self.assertFalse((self.store.files / old["file"]).exists())
        self.assertFalse((self.store.files / played["file"]).exists())
        self.assertTrue((self.store.files / recent["file"]).exists())
        self.assertEqual(gone["music_track"], 2)

    def test_a_cinema_link_older_than_its_day_is_counted_and_gone(self):
        self.store.links.put("A" * 22, {"kind": "video", "url": "https://site.example/film"}, -1)
        self.store.links.put("B" * 22, {"kind": "video", "url": "https://site.example/next"}, 3600)
        gone = self.store.cleanup()
        self.assertEqual(gone["cinema_link"], 1)
        rows = self.store.db.execute("SELECT id FROM cinema_links").fetchall()
        self.assertEqual(rows, [("B" * 22,)])

    def test_the_sweep_counts_by_kind_and_the_metric_names_only_the_kind(self):
        room = initial(ROOM)
        room["queue"] = [self.track("Old", TRACK_TTL + 1)]
        self.store.save(room)
        retention = Retention()
        retention.sweep(self.store)
        text = render(SimpleNamespace(retention=retention))
        self.assertIn('cord_retention_deleted_total{kind="music_track"} 1\n', text)
        self.assertIn("cord_retention_last_sweep_timestamp_seconds ", text)
        self.assertNotIn(ROOM, text)


class CinemaMemoryTests(unittest.TestCase):
    def test_stale_segments_leave_memory_even_if_nobody_asks_again(self):
        segments = Segments(capacity=1000, ttl=60)
        segments.put("old", b"abc", "video/mp2t")
        segments.put("new", b"def", "video/mp2t")
        born, body, kind = segments._items["old"]
        segments._items["old"] = (born - 61, body, kind)
        self.assertEqual(segments.sweep(), 1)
        self.assertNotIn("old", segments._items)
        self.assertEqual(segments._size, 3)
        self.assertEqual(segments.get("new"), (b"def", "video/mp2t"))

    def test_expired_answers_leave_memory(self):
        memo = Memo()
        memo.put("gone", {"url": "https://a"}, -1)
        memo.put("kept", {"url": "https://b"}, 60)
        self.assertEqual(memo.sweep(), 1)
        self.assertIsNone(memo.peek("gone"))
        self.assertEqual(memo.peek("kept"), {"url": "https://b"})

    def test_the_cinema_sweep_is_part_of_the_service_sweep(self):
        class Cinema:
            def sweep(self):
                return {"cinema_segment": 3, "cinema_answer": 0}

        with tempfile.TemporaryDirectory() as root:
            store = Store(Path(root))
            retention = Retention()
            gone = retention.sweep(store, Cinema())
            store.db.close()
        self.assertEqual(gone["cinema_segment"], 3)
        self.assertEqual(retention.deleted["cinema_segment"], 3)
        self.assertNotIn("cinema_answer", retention.deleted)
        self.assertGreater(retention.swept_at, time.time() - 5)


if __name__ == "__main__":
    unittest.main()
