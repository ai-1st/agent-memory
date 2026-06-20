"""SQLite persistence layer.

Why SQLite (baseline): zero external services, single file on a Docker volume =>
real persistence with no infra; synchronous reads-after-writes by construction
(no eventual consistency); trivially fast to iterate. The store is deliberately
behind a small method surface so we can swap in Postgres+pgvector / Qdrant as a
benchmarked variant later without touching the API or pipelines.

Concurrency: WAL mode for concurrent readers; a process-level lock serializes
writes (SQLite allows a single writer). Each operation uses its own short-lived
connection so FastAPI's threadpool workers don't share cursors.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .extraction.base import ExtractedMemory
from .text import token_set

_SCHEMA = """
CREATE TABLE IF NOT EXISTS turns (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    user_id     TEXT,
    timestamp   TEXT,
    messages    TEXT NOT NULL,
    metadata    TEXT,
    text        TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);
CREATE INDEX IF NOT EXISTS idx_turns_user    ON turns(user_id);

CREATE TABLE IF NOT EXISTS memories (
    id             TEXT PRIMARY KEY,
    user_id        TEXT,
    session_id     TEXT,
    type           TEXT NOT NULL,
    key            TEXT NOT NULL,
    value          TEXT NOT NULL,
    confidence     REAL NOT NULL DEFAULT 0.7,
    source_session TEXT,
    source_turn    TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    supersedes     TEXT,
    active         INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_mem_user ON memories(user_id);
CREATE INDEX IF NOT EXISTS idx_mem_key  ON memories(user_id, key, active);
"""


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:24]}"


def _norm(value: str) -> str:
    return " ".join(value.lower().split())


@dataclass
class TurnRecord:
    id: str
    session_id: str
    user_id: str | None
    timestamp: str | None
    text: str
    metadata: dict[str, Any]


class Store:
    def __init__(self, db_path: str) -> None:
        self.db_path = db_path
        self._write_lock = threading.Lock()
        if db_path != ":memory:":
            Path(db_path).expanduser().parent.mkdir(parents=True, exist_ok=True)

    # -- connection ------------------------------------------------------- #
    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30.0, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=30000")
        return conn

    def init(self) -> None:
        with self._write_lock, self._connect() as conn:
            conn.executescript(_SCHEMA)

    # -- writes ----------------------------------------------------------- #
    def insert_turn(
        self,
        *,
        session_id: str,
        user_id: str | None,
        messages: list[dict[str, Any]],
        timestamp: str | None,
        metadata: dict[str, Any],
    ) -> str:
        turn_id = _new_id("turn")
        text = "\n".join(
            f"{m.get('role', '')}: {m.get('content', '')}".strip() for m in messages
        ).strip()
        with self._write_lock, self._connect() as conn:
            conn.execute(
                "INSERT INTO turns (id, session_id, user_id, timestamp, messages, metadata, text, created_at)"
                " VALUES (?,?,?,?,?,?,?,?)",
                (
                    turn_id,
                    session_id,
                    user_id,
                    timestamp,
                    json.dumps(messages, ensure_ascii=False),
                    json.dumps(metadata, ensure_ascii=False),
                    text,
                    _now_iso(),
                ),
            )
        return turn_id

    def add_memory(
        self,
        em: ExtractedMemory,
        *,
        user_id: str | None,
        session_id: str,
        source_turn: str,
    ) -> str:
        """Persist an extracted memory with fact-evolution semantics.

        - mutable (single-valued) slot: if an active memory exists for the same
          (user_id, key) with a *different* value, supersede it (active=0) and
          insert the new one with ``supersedes`` pointing at the old id. Same
          value => just bump confidence/updated_at (dedupe).
        - additive slot: dedupe on (key, value); otherwise insert.
        """
        now = _now_iso()
        with self._write_lock, self._connect() as conn:
            cur = conn.execute(
                "SELECT * FROM memories WHERE user_id IS ? AND key=? AND active=1 ORDER BY updated_at DESC",
                (user_id, em.key),
            )
            existing = cur.fetchall()

            if em.mutable:
                match = existing[0] if existing else None
                if match is not None:
                    if _norm(match["value"]) == _norm(em.value):
                        conn.execute(
                            "UPDATE memories SET updated_at=?, confidence=MAX(confidence, ?) WHERE id=?",
                            (now, em.confidence, match["id"]),
                        )
                        return str(match["id"])
                    conn.execute(
                        "UPDATE memories SET active=0, updated_at=? WHERE id=?",
                        (now, match["id"]),
                    )
                    return self._insert_memory(
                        conn,
                        em,
                        user_id,
                        session_id,
                        source_turn,
                        now,
                        supersedes=str(match["id"]),
                    )
            else:
                for row in existing:
                    if _norm(row["value"]) == _norm(em.value):
                        conn.execute(
                            "UPDATE memories SET updated_at=?, confidence=MAX(confidence, ?) WHERE id=?",
                            (now, em.confidence, row["id"]),
                        )
                        return str(row["id"])

            return self._insert_memory(
                conn, em, user_id, session_id, source_turn, now, supersedes=None
            )

    @staticmethod
    def _insert_memory(
        conn: sqlite3.Connection,
        em: ExtractedMemory,
        user_id: str | None,
        session_id: str,
        source_turn: str,
        now: str,
        *,
        supersedes: str | None,
    ) -> str:
        mem_id = _new_id("mem")
        conn.execute(
            "INSERT INTO memories (id, user_id, session_id, type, key, value, confidence,"
            " source_session, source_turn, created_at, updated_at, supersedes, active)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)",
            (
                mem_id,
                user_id,
                session_id,
                em.type,
                em.key,
                em.value,
                em.confidence,
                session_id,
                source_turn,
                now,
                now,
                supersedes,
            ),
        )
        return mem_id

    # -- reads ------------------------------------------------------------ #
    def list_memories(self, user_id: str, *, active_only: bool = False) -> list[dict[str, Any]]:
        q = "SELECT * FROM memories WHERE user_id IS ?"
        if active_only:
            q += " AND active=1"
        q += " ORDER BY created_at ASC"
        with self._connect() as conn:
            return [dict(r) for r in conn.execute(q, (user_id,)).fetchall()]

    def superseded_values(self, user_id: str | None, key: str) -> list[str]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT value FROM memories WHERE user_id IS ? AND key=? AND active=0"
                " ORDER BY updated_at DESC",
                (user_id, key),
            ).fetchall()
        return [str(r["value"]) for r in rows]

    def recent_turns(
        self, *, session_id: str | None, user_id: str | None, limit: int = 50
    ) -> list[TurnRecord]:
        clauses, params = [], []
        if session_id is not None:
            clauses.append("session_id = ?")
            params.append(session_id)
        elif user_id is not None:
            clauses.append("user_id IS ?")
            params.append(user_id)
        else:
            return []
        where = " WHERE " + " AND ".join(clauses)
        params.append(limit)
        with self._connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM turns{where} ORDER BY created_at DESC LIMIT ?", params
            ).fetchall()
        return [
            TurnRecord(
                id=r["id"],
                session_id=r["session_id"],
                user_id=r["user_id"],
                timestamp=r["timestamp"],
                text=r["text"],
                metadata=json.loads(r["metadata"] or "{}"),
            )
            for r in rows
        ]

    def search(
        self,
        query: str,
        *,
        user_id: str | None,
        session_id: str | None,
        limit: int = 10,
    ) -> list[dict[str, Any]]:
        """Keyword-overlap search across memories + turns (baseline)."""
        qset = token_set(query)
        results: list[dict[str, Any]] = []

        with self._connect() as conn:
            mem_clauses, mem_params = ["active=1"], []
            if user_id is not None:
                mem_clauses.append("user_id IS ?")
                mem_params.append(user_id)
            mrows = conn.execute(
                f"SELECT * FROM memories WHERE {' AND '.join(mem_clauses)}", mem_params
            ).fetchall()

            turn_clauses, turn_params = [], []
            if session_id is not None:
                turn_clauses.append("session_id = ?")
                turn_params.append(session_id)
            elif user_id is not None:
                turn_clauses.append("user_id IS ?")
                turn_params.append(user_id)
            twhere = (" WHERE " + " AND ".join(turn_clauses)) if turn_clauses else ""
            trows = conn.execute(f"SELECT * FROM turns{twhere}", turn_params).fetchall()

        for r in mrows:
            content = f"{r['key']}: {r['value']}"
            score = _overlap(qset, content)
            if score > 0:
                results.append(
                    {
                        "content": content,
                        "score": score,
                        "session_id": r["session_id"],
                        "timestamp": r["updated_at"],
                        "metadata": {"type": r["type"], "memory_id": r["id"]},
                    }
                )
        for r in trows:
            score = _overlap(qset, r["text"])
            if score > 0:
                results.append(
                    {
                        "content": r["text"],
                        "score": score,
                        "session_id": r["session_id"],
                        "timestamp": r["timestamp"],
                        "metadata": json.loads(r["metadata"] or "{}"),
                    }
                )

        results.sort(key=lambda x: x["score"], reverse=True)
        return results[: max(0, limit)]

    # -- deletes ---------------------------------------------------------- #
    def delete_session(self, session_id: str) -> None:
        with self._write_lock, self._connect() as conn:
            conn.execute("DELETE FROM turns WHERE session_id=?", (session_id,))
            conn.execute("DELETE FROM memories WHERE session_id=?", (session_id,))

    def delete_user(self, user_id: str) -> None:
        with self._write_lock, self._connect() as conn:
            conn.execute("DELETE FROM turns WHERE user_id IS ?", (user_id,))
            conn.execute("DELETE FROM memories WHERE user_id IS ?", (user_id,))


def _overlap(qset: set[str], text: str) -> float:
    if not qset:
        return 0.0
    tset = token_set(text)
    if not tset:
        return 0.0
    return round(len(qset & tset) / len(qset), 4)
