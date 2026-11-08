"""Состояние пульта — SQLite (Р-117, Р-118): сессии, попытки входа, журнал, задачи и их вывод.

Журнал — только добавление: в коде нет ни UPDATE, ни DELETE по `audit`, кроме чистки старше
`AUDIT_KEEP_DAYS`. Соединение одно на процесс, с `check_same_thread=False`: служба однопоточная
(asyncio), а блокирующие запросы к SQLite короткие.
"""

from __future__ import annotations

import json
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .settings import AUDIT_KEEP_DAYS, LOCK_AFTER_FAILURES, LOCK_SECONDS, LOGIN_PER_MINUTE

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  actor TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT NOT NULL,
  at INTEGER NOT NULL,
  ok INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS login_attempts_ip ON login_attempts (ip, at);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  session_id TEXT,
  ip TEXT,
  action TEXT NOT NULL,
  target TEXT,
  args TEXT,
  outcome TEXT NOT NULL,
  detail TEXT,
  job_id TEXT
);
CREATE INDEX IF NOT EXISTS audit_ts ON audit (ts);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  machine TEXT NOT NULL,
  args TEXT NOT NULL,
  actor TEXT NOT NULL,
  dry_run INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  exit_code INTEGER,
  summary TEXT
);
CREATE INDEX IF NOT EXISTS jobs_created ON jobs (created_at);
CREATE TABLE IF NOT EXISTS job_lines (
  job_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  stream TEXT NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (job_id, n)
);
CREATE TABLE IF NOT EXISTS machine_state (
  machine TEXT PRIMARY KEY,
  status TEXT,
  updated_at INTEGER
);
"""


def now() -> int:
    return int(time.time())


@dataclass(frozen=True)
class Session:
    id: str
    actor: str
    ip: str | None
    user_agent: str | None
    created_at: int
    last_seen_at: int


@dataclass
class Job:
    id: str
    kind: str
    machine: str
    args: dict[str, Any]
    actor: str
    dry_run: bool
    status: str
    created_at: int
    started_at: int | None = None
    finished_at: int | None = None
    exit_code: int | None = None
    summary: str | None = None

    def view(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "machine": self.machine,
            "args": self.args,
            "actor": self.actor,
            "dryRun": self.dry_run,
            "status": self.status,
            "createdAt": self.created_at,
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
            "exitCode": self.exit_code,
            "summary": self.summary,
        }


class Store:
    def __init__(self, path: Path | str) -> None:
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA busy_timeout=5000")
        self.db.executescript(SCHEMA)

    def close(self) -> None:
        self.db.close()

    # ── Сессии ───────────────────────────────────────────────────────────────────────────────────
    def create_session(self, id: str, token_hash: str, actor: str, ip: str | None, user_agent: str | None) -> Session:
        at = now()
        self.db.execute(
            "INSERT INTO sessions (id, token_hash, actor, ip, user_agent, created_at, last_seen_at) VALUES (?,?,?,?,?,?,?)",
            (id, token_hash, actor, ip, (user_agent or "")[:200], at, at),
        )
        return Session(id, actor, ip, user_agent, at, at)

    def session_by_token(self, token_hash: str) -> Session | None:
        row = self.db.execute("SELECT * FROM sessions WHERE token_hash = ?", (token_hash,)).fetchone()
        return self._session(row) if row else None

    def touch_session(self, id: str) -> None:
        self.db.execute("UPDATE sessions SET last_seen_at = ? WHERE id = ?", (now(), id))

    def sessions(self) -> list[Session]:
        rows = self.db.execute("SELECT * FROM sessions ORDER BY created_at DESC").fetchall()
        return [self._session(row) for row in rows]

    def delete_session(self, id: str) -> bool:
        return self.db.execute("DELETE FROM sessions WHERE id = ?", (id,)).rowcount > 0

    def delete_sessions(self) -> int:
        return self.db.execute("DELETE FROM sessions").rowcount

    def expire_sessions(self, lifetime: int, idle: int) -> int:
        at = now()
        return self.db.execute(
            "DELETE FROM sessions WHERE created_at < ? OR last_seen_at < ?", (at - lifetime, at - idle)
        ).rowcount

    @staticmethod
    def _session(row: sqlite3.Row) -> Session:
        return Session(row["id"], row["actor"], row["ip"], row["user_agent"], row["created_at"], row["last_seen_at"])

    # ── Попытки входа ────────────────────────────────────────────────────────────────────────────
    def login_attempt(self, ip: str, ok: bool) -> None:
        self.db.execute("INSERT INTO login_attempts (ip, at, ok) VALUES (?,?,?)", (ip, now(), int(ok)))
        self.db.execute("DELETE FROM login_attempts WHERE at < ?", (now() - LOCK_SECONDS * 2,))

    def login_lock(self, ip: str) -> int:
        """Сколько секунд адресу ждать: 0 — можно пробовать; иначе — заперт или слишком часто."""
        at = now()
        recent = self.db.execute(
            "SELECT COUNT(*) FROM login_attempts WHERE ip = ? AND at > ?", (ip, at - 60)
        ).fetchone()[0]
        if recent >= LOGIN_PER_MINUTE:
            oldest = self.db.execute(
                "SELECT MIN(at) FROM login_attempts WHERE ip = ? AND at > ?", (ip, at - 60)
            ).fetchone()[0]
            return max(1, oldest + 60 - at)
        rows = self.db.execute(
            "SELECT ok, at FROM login_attempts WHERE ip = ? AND at > ? ORDER BY at DESC LIMIT ?",
            (ip, at - LOCK_SECONDS, LOCK_AFTER_FAILURES),
        ).fetchall()
        if len(rows) >= LOCK_AFTER_FAILURES and all(row["ok"] == 0 for row in rows):
            return max(1, rows[0]["at"] + LOCK_SECONDS - at)
        return 0

    # ── Журнал ───────────────────────────────────────────────────────────────────────────────────
    def audit(
        self,
        actor: str,
        action: str,
        outcome: str,
        *,
        session_id: str | None = None,
        ip: str | None = None,
        target: str | None = None,
        args: dict[str, Any] | None = None,
        detail: str | None = None,
        job_id: str | None = None,
    ) -> int:
        cursor = self.db.execute(
            "INSERT INTO audit (ts, actor, session_id, ip, action, target, args, outcome, detail, job_id)"
            " VALUES (?,?,?,?,?,?,?,?,?,?)",
            (
                now(),
                actor,
                session_id,
                ip,
                action,
                target,
                json.dumps(args, ensure_ascii=False) if args is not None else None,
                outcome,
                (detail or "")[:2048] or None,
                job_id,
            ),
        )
        return int(cursor.lastrowid or 0)

    def audit_query(
        self,
        *,
        since: int | None = None,
        until: int | None = None,
        actor: str | None = None,
        action: str | None = None,
        outcome: str | None = None,
        cursor: int | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        where, params = ["1=1"], []
        if since is not None:
            where.append("ts >= ?")
            params.append(since)
        if until is not None:
            where.append("ts <= ?")
            params.append(until)
        if actor:
            where.append("actor = ?")
            params.append(actor)
        if action:
            where.append("action LIKE ?")
            params.append(action + "%")
        if outcome:
            where.append("outcome = ?")
            params.append(outcome)
        if cursor is not None:
            where.append("id < ?")
            params.append(cursor)
        params.append(max(1, min(limit, 1000)))
        rows = self.db.execute(
            f"SELECT * FROM audit WHERE {' AND '.join(where)} ORDER BY id DESC LIMIT ?", params
        ).fetchall()
        return [self._audit(row) for row in rows]

    @staticmethod
    def _audit(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "ts": row["ts"],
            "actor": row["actor"],
            "sessionId": row["session_id"],
            "ip": row["ip"],
            "action": row["action"],
            "target": row["target"],
            "args": json.loads(row["args"]) if row["args"] else None,
            "outcome": row["outcome"],
            "detail": row["detail"],
            "jobId": row["job_id"],
        }

    def audit_prune(self) -> int:
        return self.db.execute("DELETE FROM audit WHERE ts < ?", (now() - AUDIT_KEEP_DAYS * 86400,)).rowcount

    # ── Задачи ───────────────────────────────────────────────────────────────────────────────────
    def create_job(self, job: Job) -> None:
        self.db.execute(
            "INSERT INTO jobs (id, kind, machine, args, actor, dry_run, status, created_at) VALUES (?,?,?,?,?,?,?,?)",
            (
                job.id,
                job.kind,
                job.machine,
                json.dumps(job.args, ensure_ascii=False),
                job.actor,
                int(job.dry_run),
                job.status,
                job.created_at,
            ),
        )

    def update_job(self, job: Job) -> None:
        self.db.execute(
            "UPDATE jobs SET status=?, started_at=?, finished_at=?, exit_code=?, summary=? WHERE id=?",
            (job.status, job.started_at, job.finished_at, job.exit_code, job.summary, job.id),
        )

    def job(self, id: str) -> Job | None:
        row = self.db.execute("SELECT * FROM jobs WHERE id = ?", (id,)).fetchone()
        return self._job(row) if row else None

    def jobs(self, *, machine: str | None = None, kind: str | None = None, limit: int = 50) -> list[Job]:
        where, params = ["1=1"], []
        if machine:
            where.append("machine = ?")
            params.append(machine)
        if kind:
            where.append("kind = ?")
            params.append(kind)
        params.append(max(1, min(limit, 500)))
        rows = self.db.execute(
            f"SELECT * FROM jobs WHERE {' AND '.join(where)} ORDER BY created_at DESC, rowid DESC LIMIT ?", params
        ).fetchall()
        return [self._job(row) for row in rows]

    def running_job(self, machine: str) -> Job | None:
        row = self.db.execute(
            "SELECT * FROM jobs WHERE machine = ? AND status IN ('queued','running') ORDER BY created_at LIMIT 1",
            (machine,),
        ).fetchone()
        return self._job(row) if row else None

    def abandon_running_jobs(self) -> int:
        """После перезапуска службы задач «в работе» быть не может — они прерваны."""
        return self.db.execute(
            "UPDATE jobs SET status='failed', finished_at=?, summary='Прервана перезапуском пульта'"
            " WHERE status IN ('queued','running')",
            (now(),),
        ).rowcount

    @staticmethod
    def _job(row: sqlite3.Row) -> Job:
        return Job(
            id=row["id"],
            kind=row["kind"],
            machine=row["machine"],
            args=json.loads(row["args"]),
            actor=row["actor"],
            dry_run=bool(row["dry_run"]),
            status=row["status"],
            created_at=row["created_at"],
            started_at=row["started_at"],
            finished_at=row["finished_at"],
            exit_code=row["exit_code"],
            summary=row["summary"],
        )

    def add_line(self, job_id: str, stream: str, text: str) -> int:
        n = self.db.execute("SELECT COALESCE(MAX(n), 0) + 1 FROM job_lines WHERE job_id = ?", (job_id,)).fetchone()[0]
        self.db.execute(
            "INSERT INTO job_lines (job_id, n, ts, stream, text) VALUES (?,?,?,?,?)",
            (job_id, n, now(), stream, text[:4000]),
        )
        return int(n)

    def lines(self, job_id: str, after: int = 0, limit: int = 2000) -> list[dict[str, Any]]:
        rows = self.db.execute(
            "SELECT n, ts, stream, text FROM job_lines WHERE job_id = ? AND n > ? ORDER BY n LIMIT ?",
            (job_id, after, max(1, min(limit, 5000))),
        ).fetchall()
        return [{"n": row["n"], "ts": row["ts"], "stream": row["stream"], "text": row["text"]} for row in rows]

    # ── Последнее известное состояние машины ─────────────────────────────────────────────────────
    def save_machine_state(self, machine: str, status: dict[str, Any]) -> None:
        self.db.execute(
            "INSERT INTO machine_state (machine, status, updated_at) VALUES (?,?,?)"
            " ON CONFLICT(machine) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at",
            (machine, json.dumps(status, ensure_ascii=False), now()),
        )

    def machine_state(self, machine: str) -> tuple[dict[str, Any], int] | None:
        row = self.db.execute("SELECT status, updated_at FROM machine_state WHERE machine = ?", (machine,)).fetchone()
        return (json.loads(row["status"]), row["updated_at"]) if row and row["status"] else None
