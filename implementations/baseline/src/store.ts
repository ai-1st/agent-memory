/**
 * SQLite persistence layer (better-sqlite3) — the v0 control store.
 *
 * Why SQLite for the control: zero external services (single file on a Docker
 * volume = real persistence with no infra), and better-sqlite3 is synchronous,
 * so reads-after-writes are correct by construction — no eventual-consistency
 * gap. The store sits behind a small method surface so the exploration branches
 * can swap in pglite/pgvector without touching the API or pipelines.
 *
 * Node runs JS single-threaded, so no write lock is needed; WAL mode keeps reads
 * concurrent with the occasional writer.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { ExtractedMemory } from "./extraction/types";
import { tokenSet } from "./text";

const SCHEMA = `
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
`;

export interface MemoryRow {
  id: string;
  user_id: string | null;
  session_id: string | null;
  type: string;
  key: string;
  value: string;
  confidence: number;
  source_session: string | null;
  source_turn: string | null;
  created_at: string;
  updated_at: string;
  supersedes: string | null;
  active: number;
}

export interface TurnRecord {
  id: string;
  session_id: string;
  user_id: string | null;
  timestamp: string | null;
  text: string;
  metadata: Record<string, unknown>;
}

export interface SearchHit {
  content: string;
  score: number;
  session_id: string | null;
  timestamp: string | null;
  metadata: Record<string, unknown>;
}

export interface InsertTurnInput {
  sessionId: string;
  userId: string | null;
  messages: Array<Record<string, unknown>>;
  timestamp: string | null;
  metadata: Record<string, unknown>;
}

const nowIso = (): string => new Date().toISOString();
const newId = (prefix: string): string =>
  `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
const norm = (v: string): string => v.toLowerCase().split(/\s+/).filter(Boolean).join(" ");

function overlapScore(qset: Set<string>, text: string): number {
  if (qset.size === 0) return 0;
  const tset = tokenSet(text);
  if (tset.size === 0) return 0;
  let n = 0;
  for (const t of qset) if (tset.has(t)) n++;
  return Math.round((n / qset.size) * 10000) / 10000;
}

export class Store {
  private db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 30000");
  }

  init(): void {
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  insertTurn(input: InsertTurnInput): string {
    const turnId = newId("turn");
    const text = input.messages
      .map((m) => `${m.role ?? ""}: ${m.content ?? ""}`.trim())
      .join("\n")
      .trim();
    this.db
      .prepare(
        `INSERT INTO turns (id, session_id, user_id, timestamp, messages, metadata, text, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        turnId,
        input.sessionId,
        input.userId,
        input.timestamp,
        JSON.stringify(input.messages),
        JSON.stringify(input.metadata),
        text,
        nowIso(),
      );
    return turnId;
  }

  /**
   * Persist an extracted memory with fact-evolution semantics.
   * - mutable slot: a different value supersedes the active one (active=0,
   *   supersedes -> old id); same value just bumps confidence/updated_at.
   * - additive slot: dedupe on (key, value); else insert.
   */
  addMemory(
    em: ExtractedMemory,
    ctx: { userId: string | null; sessionId: string; sourceTurn: string },
  ): string {
    const now = nowIso();
    const existing = this.db
      .prepare(
        "SELECT * FROM memories WHERE user_id IS ? AND key=? AND active=1 ORDER BY updated_at DESC",
      )
      .all(ctx.userId, em.key) as MemoryRow[];

    if (em.mutable) {
      const match = existing[0];
      if (match) {
        if (norm(match.value) === norm(em.value)) {
          this.db
            .prepare("UPDATE memories SET updated_at=?, confidence=MAX(confidence, ?) WHERE id=?")
            .run(now, em.confidence, match.id);
          return match.id;
        }
        this.db.prepare("UPDATE memories SET active=0, updated_at=? WHERE id=?").run(now, match.id);
        return this.insertMemory(em, ctx, now, match.id);
      }
    } else {
      for (const row of existing) {
        if (norm(row.value) === norm(em.value)) {
          this.db
            .prepare("UPDATE memories SET updated_at=?, confidence=MAX(confidence, ?) WHERE id=?")
            .run(now, em.confidence, row.id);
          return row.id;
        }
      }
    }
    return this.insertMemory(em, ctx, now, null);
  }

  private insertMemory(
    em: ExtractedMemory,
    ctx: { userId: string | null; sessionId: string; sourceTurn: string },
    now: string,
    supersedes: string | null,
  ): string {
    const id = newId("mem");
    this.db
      .prepare(
        `INSERT INTO memories (id, user_id, session_id, type, key, value, confidence,
           source_session, source_turn, created_at, updated_at, supersedes, active)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)`,
      )
      .run(
        id,
        ctx.userId,
        ctx.sessionId,
        em.type,
        em.key,
        em.value,
        em.confidence,
        ctx.sessionId,
        ctx.sourceTurn,
        now,
        now,
        supersedes,
      );
    return id;
  }

  listMemories(userId: string | null, activeOnly: boolean): MemoryRow[] {
    let q = "SELECT * FROM memories WHERE user_id IS ?";
    if (activeOnly) q += " AND active=1";
    q += " ORDER BY created_at ASC";
    return this.db.prepare(q).all(userId) as MemoryRow[];
  }

  supersededValues(userId: string | null, key: string): string[] {
    const rows = this.db
      .prepare(
        "SELECT value FROM memories WHERE user_id IS ? AND key=? AND active=0 ORDER BY updated_at DESC",
      )
      .all(userId, key) as Array<{ value: string }>;
    return rows.map((r) => r.value);
  }

  recentTurns(args: {
    sessionId: string | null;
    userId: string | null;
    limit?: number;
  }): TurnRecord[] {
    const limit = args.limit ?? 50;
    let rows: Array<Record<string, unknown>>;
    if (args.sessionId !== null) {
      rows = this.db
        .prepare("SELECT * FROM turns WHERE session_id = ? ORDER BY created_at DESC LIMIT ?")
        .all(args.sessionId, limit) as Array<Record<string, unknown>>;
    } else if (args.userId !== null) {
      rows = this.db
        .prepare("SELECT * FROM turns WHERE user_id IS ? ORDER BY created_at DESC LIMIT ?")
        .all(args.userId, limit) as Array<Record<string, unknown>>;
    } else {
      return [];
    }
    return rows.map((r) => ({
      id: r.id as string,
      session_id: r.session_id as string,
      user_id: (r.user_id as string) ?? null,
      timestamp: (r.timestamp as string) ?? null,
      text: (r.text as string) ?? "",
      metadata: JSON.parse((r.metadata as string) || "{}"),
    }));
  }

  search(
    query: string,
    args: { userId: string | null; sessionId: string | null; limit?: number },
  ): SearchHit[] {
    const limit = args.limit ?? 10;
    const qset = tokenSet(query);
    const hits: SearchHit[] = [];

    const memRows = (
      args.userId !== null
        ? this.db.prepare("SELECT * FROM memories WHERE active=1 AND user_id IS ?").all(args.userId)
        : this.db.prepare("SELECT * FROM memories WHERE active=1").all()
    ) as MemoryRow[];
    for (const r of memRows) {
      const content = `${r.key}: ${r.value}`;
      const score = overlapScore(qset, content);
      if (score > 0) {
        hits.push({
          content,
          score,
          session_id: r.session_id,
          timestamp: r.updated_at,
          metadata: { type: r.type, memory_id: r.id },
        });
      }
    }

    let turnRows: Array<Record<string, unknown>> = [];
    if (args.sessionId !== null) {
      turnRows = this.db
        .prepare("SELECT * FROM turns WHERE session_id = ?")
        .all(args.sessionId) as Array<Record<string, unknown>>;
    } else if (args.userId !== null) {
      turnRows = this.db
        .prepare("SELECT * FROM turns WHERE user_id IS ?")
        .all(args.userId) as Array<Record<string, unknown>>;
    }
    for (const r of turnRows) {
      const text = (r.text as string) ?? "";
      const score = overlapScore(qset, text);
      if (score > 0) {
        hits.push({
          content: text,
          score,
          session_id: (r.session_id as string) ?? null,
          timestamp: (r.timestamp as string) ?? null,
          metadata: JSON.parse((r.metadata as string) || "{}"),
        });
      }
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, Math.max(0, limit));
  }

  deleteSession(sessionId: string): void {
    this.db.prepare("DELETE FROM turns WHERE session_id=?").run(sessionId);
    this.db.prepare("DELETE FROM memories WHERE session_id=?").run(sessionId);
  }

  deleteUser(userId: string): void {
    this.db.prepare("DELETE FROM turns WHERE user_id IS ?").run(userId);
    this.db.prepare("DELETE FROM memories WHERE user_id IS ?").run(userId);
  }
}
