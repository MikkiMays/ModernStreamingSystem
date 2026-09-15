"""Small durable ledger. One service process owns playback and SQLite writes."""

from __future__ import annotations

import json
import copy
import sqlite3
import time
from pathlib import Path
from typing import Any


def now() -> int:
    return int(time.time() * 1000)


def initial(room_id: str) -> dict[str, Any]:
    return {
        "roomId": room_id,
        "enabled": False,
        "paused": False,
        "queue": [],
        "position": 0.0,
        "epoch": 0,
        "revision": 0,
        "status": "disabled",
        "error": None,
        "participantId": None,
        "repeat": False,
        "admission": None,
        "updatedAt": now(),
        "lastHumanAt": now(),
    }


class Store:
    def __init__(self, root: Path):
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.root = root
        self.files = root / "audio"
        self.files.mkdir(mode=0o700, exist_ok=True)
        self.db = sqlite3.connect(root / "services.sqlite", isolation_level=None)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.execute("PRAGMA busy_timeout=5000")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS music(room_id TEXT PRIMARY KEY, body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS bindings(scope TEXT PRIMARY KEY, body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS claims(token TEXT PRIMARY KEY, body TEXT NOT NULL, expires_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS receipts(scope TEXT NOT NULL, command_id TEXT NOT NULL, body TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(scope, command_id));
            CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        """)

        self.cache = {
            room_id: json.loads(body)
            for room_id, body in self.db.execute("SELECT room_id,body FROM music")
        }
        self.flushed = {}

    def get(self, room_id: str) -> dict:
        return copy.deepcopy(self.cache.get(room_id, initial(room_id)))

    def revision(self, room_id: str) -> int:
        """Сколько раз состояние менялось — без копии всей очереди.

        Цикл воспроизведения спрашивает об этом много раз в секунду, чтобы пауза и
        перемотка были слышны сразу, а не через долю секунды. Копировать ради этого
        сотню треков было бы дорого.
        """
        value = self.cache.get(room_id)
        return value["revision"] if value else 0

    def save(self, value: dict, *, changed: bool = True):
        if changed:
            value["revision"] += 1
            value["updatedAt"] = now()
        self.cache[value["roomId"]] = copy.deepcopy(value)
        if not changed and now() - self.flushed.get(value["roomId"], 0) < 1000:
            return
        self.flushed[value["roomId"]] = now()
        self.db.execute(
            "INSERT INTO music VALUES (?,?) ON CONFLICT(room_id) DO UPDATE SET body=excluded.body",
            (value["roomId"], json.dumps(value, ensure_ascii=False)),
        )

    def rooms(self) -> list[dict]:
        return copy.deepcopy(list(self.cache.values()))

    def public(self, room_id: str) -> dict:
        value = self.get(room_id)
        return {
            key: value[key]
            for key in [
                "roomId",
                "enabled",
                "paused",
                "position",
                "revision",
                "status",
                "error",
                "participantId",
                "repeat",
            ]
        } | {
            "queue": [
                {
                    k: track[k]
                    for k in ["id", "title", "artist", "duration", "addedBy", "source"]
                }
                for track in value["queue"]
            ]
        }

    def receipt(self, scope: str, command_id: str) -> dict | None:
        row = self.db.execute(
            "SELECT body FROM receipts WHERE scope=? AND command_id=? AND expires_at>?",
            (scope, command_id, now()),
        ).fetchone()
        return json.loads(row[0]) if row else None

    def remember(self, scope: str, command_id: str, value: dict):
        self.db.execute(
            "INSERT INTO receipts VALUES (?,?,?,?) ON CONFLICT(scope,command_id) DO UPDATE SET body=excluded.body, expires_at=excluded.expires_at",
            (scope, command_id, json.dumps(value), now() + 86400000),
        )

    def binding(self, scope: str) -> dict | None:
        row = self.db.execute(
            "SELECT body FROM bindings WHERE scope=?", (scope,)
        ).fetchone()
        return json.loads(row[0]) if row else None

    def bind(self, scope: str, value: dict):
        self.db.execute(
            "INSERT INTO bindings VALUES (?,?) ON CONFLICT(scope) DO UPDATE SET body=excluded.body",
            (scope, json.dumps(value)),
        )

    def unbind(self, scope: str):
        self.db.execute("DELETE FROM bindings WHERE scope=?", (scope,))

    def claim(self, token: str) -> dict | None:
        row = self.db.execute(
            "SELECT body FROM claims WHERE token=? AND expires_at>?", (token, now())
        ).fetchone()
        return json.loads(row[0]) if row else None

    def put_claim(self, token: str, value: dict, ttl: int = 900000):
        self.db.execute(
            "INSERT INTO claims VALUES (?,?,?)", (token, json.dumps(value), now() + ttl)
        )

    def delete_claim(self, token: str):
        self.db.execute("DELETE FROM claims WHERE token=?", (token,))

    def state(self, key: str, default: str = "") -> str:
        row = self.db.execute("SELECT value FROM state WHERE key=?", (key,)).fetchone()
        return row[0] if row else default

    def set_state(self, key: str, value: str):
        self.db.execute(
            "INSERT INTO state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )

    def prune_files(self, files: list[str]):
        referenced = {track["file"] for room in self.rooms() for track in room["queue"]}
        for name in files:
            if name not in referenced:
                (self.files / name).unlink(missing_ok=True)

    def cleanup(self):
        for room in self.rooms():
            expired = [
                track
                for track in room["queue"]
                if track.get("createdAt", 0) <= now() - 86400000
            ]
            if expired:
                if room["queue"][0] in expired:
                    room["epoch"] += 1
                    room["position"] = 0.0
                room["queue"] = [
                    track for track in room["queue"] if track not in expired
                ]
                self.save(room)
                self.prune_files([track["file"] for track in expired])
        self.db.execute("DELETE FROM claims WHERE expires_at<=?", (now(),))
        self.db.execute("DELETE FROM receipts WHERE expires_at<=?", (now(),))
        referenced = {track["file"] for room in self.rooms() for track in room["queue"]}
        for path in self.files.iterdir():
            if (
                path.name not in referenced
                and path.stat().st_mtime < time.time() - 3600
            ):
                path.unlink(missing_ok=True)
