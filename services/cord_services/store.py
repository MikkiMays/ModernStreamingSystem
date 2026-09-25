"""Small durable ledger. One service process owns playback and SQLite writes."""

from __future__ import annotations

import json
import copy
import sqlite3
import time
from pathlib import Path
from typing import Any


# Сколько живёт принесённое в комнату: и сам файл в очереди, и запись о комнате после того,
# как музыку в ней выключили. Сутки — один срок на оба, потому что вопрос один: «этим ещё
# пользуются?». Разные числа здесь означали бы, что запись переживает собственную очередь
# неизвестно зачем.
TRACK_TTL = 86400000


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
            CREATE TABLE IF NOT EXISTS cinema_links(
                id TEXT PRIMARY KEY, body TEXT NOT NULL, expires_at INTEGER NOT NULL
            );
        """)
        self.links = Links(self.db)

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

    def forget(self, room_id: str):
        self.cache.pop(room_id, None)
        self.flushed.pop(room_id, None)
        self.db.execute("DELETE FROM music WHERE room_id=?", (room_id,))

    def cleanup(self):
        for room in self.rooms():
            expired = [
                track
                for track in room["queue"]
                if track.get("createdAt", 0) <= now() - TRACK_TTL
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
            # Пустая запись о музыке комнаты, которой давно не пользовались, не хранит
            # ничего: очередь пуста, музыка выключена, пропуск бота в комнату протух. А
            # запись остаётся — и не только в файле: весь ledger поднимается в память при
            # старте, то есть каждая встреча, где когда-либо включали музыку, занимает место
            # до перезапуска службы. Ядро свою комнату к этому моменту уже удалило; здесь
            # исчезает её тень. Понадобится снова — `initial()` заведёт запись заново.
            #
            # Срок считается по `lastHumanAt`, а не по `updatedAt`, и это не мелочь:
            # `updatedAt` двигает любая запись, включая ту, что делает сама уборка строкой
            # выше. По нему комната, у которой только что истекла очередь, выглядела бы
            # свежей — и держалась бы ещё сутки после каждой уборки. `lastHumanAt` отвечает
            # на нужный вопрос и меняется только от людей в комнате.
            if (
                not room["enabled"]
                and not room["queue"]
                and room.get("lastHumanAt", room["updatedAt"]) <= now() - TRACK_TTL
            ):
                self.forget(room["roomId"])
        self.db.execute("DELETE FROM claims WHERE expires_at<=?", (now(),))
        self.db.execute("DELETE FROM receipts WHERE expires_at<=?", (now(),))
        self.links.sweep()
        referenced = {track["file"] for room in self.rooms() for track in room["queue"]}
        for path in self.files.iterdir():
            if (
                path.name not in referenced
                and path.stat().st_mtime < time.time() - 3600
            ):
                path.unlink(missing_ok=True)


# Больше этого номеров ссылок в таблице не держится (M12). Уборка по сроку идёт раз в сутки, а флудить
# вставками можно куда чаще: без потолка таблица растёт весь день. Когда номеров больше, самые давние по
# сроку (у всех срок — сутки от последней записи, поэтому «давний срок» = «давно не трогали) уходят. При
# записи каждого номера ≤ 256 КБ (`providers/link.RECORD_LIMIT`) потолок ограничивает файл, а сутки и
# суточная уборка держат его далеко ниже.
LINKS_ROW_CAP = 50_000


class Links:
    """
    Ссылки кинозала «По ссылке»: непрозрачный номер → адрес страницы и что на ней нашлось.

    Номер уходит в комнату и в ядро (`watch.open`), а адрес остаётся здесь: по номеру поток
    разбирается снова — у каждого зрителя, через сутки после вставки, после перезапуска службы, —
    и адрес, присланный браузером, служба не берёт никогда. Поэтому таблица на диске, а не память
    процесса. Срок — сутки от последней записи: столько живёт и всё остальное, что принесли в
    комнату. Номеров не больше `LINKS_ROW_CAP`; лишние — самые давние — уходят (M12).
    """

    def __init__(self, db: sqlite3.Connection, cap: int = LINKS_ROW_CAP):
        self.db = db
        self.cap = cap

    def get(self, key: str) -> dict | None:
        row = self.db.execute(
            "SELECT body FROM cinema_links WHERE id=? AND expires_at>?", (key, now())
        ).fetchone()
        return json.loads(row[0]) if row else None

    def put(self, key: str, value: dict, ttl: float) -> None:
        self.put_many({key: value}, ttl)

    def put_many(self, values: dict[str, dict], ttl: float) -> None:
        """Сразу несколько — одной записью на диск: серии плейлиста приезжают порцией по тридцать."""
        expires = now() + int(ttl * 1000)
        rows = [(key, json.dumps(value, ensure_ascii=False), expires) for key, value in values.items()]
        # Соединение без неявных транзакций (`isolation_level=None`): порцию объединяет своя.
        self.db.execute("BEGIN")
        try:
            self.db.executemany(
                "INSERT INTO cinema_links VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET "
                "body=excluded.body, expires_at=excluded.expires_at",
                rows,
            )
            # Потолок числа номеров: лишние сверх `cap` — самые давние по сроку (то же, что «давно не
            # трогали»). Пусто, пока номеров меньше потолка.
            self.db.execute(
                "DELETE FROM cinema_links WHERE id IN ("
                "SELECT id FROM cinema_links ORDER BY expires_at DESC, id LIMIT -1 OFFSET ?)",
                (self.cap,),
            )
        except BaseException:
            self.db.execute("ROLLBACK")
            raise
        self.db.execute("COMMIT")

    def sweep(self) -> None:
        self.db.execute("DELETE FROM cinema_links WHERE expires_at<=?", (now(),))
