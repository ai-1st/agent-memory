/**
 * Persistence: pglite (embedded Postgres) + the `vector` extension.
 *
 * Why pglite: it gives us real Postgres semantics — a `vector` column with cosine
 * distance for semantic search AND ordinary SQL/indexes for everything else — in
 * a single embedded process that persists to one directory on a Docker volume.
 * No external database container, no eventual-consistency gap: every write is
 * committed before the request returns, so reads-after-writes are correct.
 *
 * The schema is deliberately tiny: two tables (`turns`, `memories`). A memory
 * row carries its own provenance (source_turn, source_session), confidence, and
 * a `supersedes` pointer — so `/users/:id/memories` is a clean, inspectable audit
 * trail, and fact evolution is a single explainable UPDATE+INSERT (see addMemory).
 */

import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { EMBED_DIM, type ExtractedMemory } from "./provider";

const SCHEMA = `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS turns (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  user_id     TEXT,
  ts          TEXT,
  messages    JSONB NOT NULL,
  metadata    JSONB NOT NULL DEFAULT '{}',
  text        TEXT NOT NULL DEFAULT '',
  embedding   vector(${EMBED_DIM}),
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
  confidence     DOUBLE PRECISION NOT NULL DEFAULT 0.7,
  snippet        TEXT NOT NULL DEFAULT '',
  mutable        BOOLEAN NOT NULL DEFAULT TRUE,
  source_session TEXT,
  source_turn    TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  supersedes     TEXT,
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  embedding      vector(${EMBED_DIM})
);
CREATE INDEX IF NOT EXISTS idx_mem_user   ON memories(user_id);
CREATE INDEX IF NOT EXISTS idx_mem_active ON memories(user_id, active);
CREATE INDEX IF NOT EXISTS idx_mem_slot   ON memories(user_id, key, active);
`;

export interface MemoryRow {
  id: string;
  user_id: string | null;
  session_id: string | null;
  type: string;
  key: string;
  value: string;
  confidence: number;
  snippet: string;
  mutable: boolean;
  source_session: string | null;
  source_turn: string | null;
  created_at: string;
  updated_at: string;
  supersedes: string | null;
  active: boolean;
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

/** A memory row plus the semantic similarity to the current query. */
export interface ScoredMemory extends MemoryRow {
  semantic: number; // cosine similarity in [0,1]
}

export interface InsertTurnInput {
  sessionId: string;
  userId: string | null;
  messages: Array<Record<string, unknown>>;
  timestamp: string | null;
  metadata: Record<string, unknown>;
  text: string;
  embedding: number[] | null;
}

export interface AddMemoryCtx {
  userId: string | null;
  sessionId: string;
  sourceTurn: string;
}

const nowIso = (): string => new Date().toISOString();
const newId = (prefix: string): string =>
  `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
const norm = (v: string): string => v.toLowerCase().split(/\s+/).filter(Boolean).join(" ");
const toVec = (e: number[]): string => `[${e.join(",")}]`;

export class Store {
  private db: PGlite;

  constructor(dataDir: string) {
    // ":memory:" is honoured by pglite for ephemeral test stores.
    this.db = new PGlite(dataDir === ":memory:" ? undefined : dataDir, {
      extensions: { vector },
    });
  }

  async init(): Promise<void> {
    await this.db.exec(SCHEMA);
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  async insertTurn(input: InsertTurnInput): Promise<string> {
    const turnId = newId("turn");
    await this.db.query(
      `INSERT INTO turns (id, session_id, user_id, ts, messages, metadata, text, embedding, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        turnId,
        input.sessionId,
        input.userId,
        input.timestamp,
        JSON.stringify(input.messages),
        JSON.stringify(input.metadata),
        input.text,
        input.embedding ? toVec(input.embedding) : null,
        nowIso(),
      ],
    );
    return turnId;
  }

  /**
   * Persist an extracted memory with the supersession rule — the whole of fact
   * evolution lives here, on purpose, so it is one place to read:
   *
   *   mutable slot (job, location, current opinion):
   *     - same value as the active row  -> bump confidence + updated_at (no churn)
   *     - different value               -> mark the active row active=FALSE and
   *                                         INSERT the new row with supersedes ->
   *                                         old id. "Current wins, history kept."
   *
   *   additive slot (allergies, distinct pets):
   *     - dedupe on (key, value); otherwise just INSERT (values coexist).
   */
  async addMemory(
    em: ExtractedMemory,
    ctx: AddMemoryCtx,
    embedding: number[] | null,
  ): Promise<string> {
    const now = nowIso();
    const existing = (
      await this.db.query<MemoryRow>(
        "SELECT * FROM memories WHERE user_id IS NOT DISTINCT FROM $1 AND key = $2 AND active = TRUE ORDER BY updated_at DESC",
        [ctx.userId, em.key],
      )
    ).rows;

    if (em.mutable) {
      const match = existing[0];
      if (match) {
        if (norm(match.value) === norm(em.value)) {
          await this.db.query(
            "UPDATE memories SET updated_at = $1, confidence = GREATEST(confidence, $2) WHERE id = $3",
            [now, em.confidence, match.id],
          );
          return match.id;
        }
        await this.db.query("UPDATE memories SET active = FALSE, updated_at = $1 WHERE id = $2", [
          now,
          match.id,
        ]);
        return this.insertMemory(em, ctx, now, match.id, embedding);
      }
    } else {
      for (const row of existing) {
        if (norm(row.value) === norm(em.value)) {
          await this.db.query(
            "UPDATE memories SET updated_at = $1, confidence = GREATEST(confidence, $2) WHERE id = $3",
            [now, em.confidence, row.id],
          );
          return row.id;
        }
      }
    }
    return this.insertMemory(em, ctx, now, null, embedding);
  }

  private async insertMemory(
    em: ExtractedMemory,
    ctx: AddMemoryCtx,
    now: string,
    supersedes: string | null,
    embedding: number[] | null,
  ): Promise<string> {
    const id = newId("mem");
    await this.db.query(
      `INSERT INTO memories
         (id, user_id, session_id, type, key, value, confidence, snippet, mutable,
          source_session, source_turn, created_at, updated_at, supersedes, active, embedding)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,TRUE,$15)`,
      [
        id,
        ctx.userId,
        ctx.sessionId,
        em.type,
        em.key,
        em.value,
        em.confidence,
        em.snippet,
        em.mutable,
        ctx.sessionId,
        ctx.sourceTurn,
        now,
        now,
        supersedes,
        embedding ? toVec(embedding) : null,
      ],
    );
    return id;
  }

  /** All memory rows for a user (full history incl. superseded), oldest first. */
  async listMemories(userId: string | null, activeOnly: boolean): Promise<MemoryRow[]> {
    const where = activeOnly
      ? "user_id IS NOT DISTINCT FROM $1 AND active = TRUE"
      : "user_id IS NOT DISTINCT FROM $1";
    return (
      await this.db.query<MemoryRow>(
        `SELECT * FROM memories WHERE ${where} ORDER BY created_at ASC`,
        [userId],
      )
    ).rows;
  }

  /** Prior (superseded) values for a slot, newest first — for "previously X" notes. */
  async supersededValues(userId: string | null, key: string): Promise<string[]> {
    const rows = (
      await this.db.query<{ value: string }>(
        "SELECT value FROM memories WHERE user_id IS NOT DISTINCT FROM $1 AND key = $2 AND active = FALSE ORDER BY updated_at DESC",
        [userId, key],
      )
    ).rows;
    return rows.map((r) => r.value);
  }

  /**
   * Active memories for a user, each scored by cosine similarity to the query
   * embedding. This is the semantic half of hybrid recall; the recaller fuses it
   * with keyword overlap. We score in SQL (one round-trip) and return everything
   * — the candidate set per user is small, so we rank in JS for clarity.
   */
  async semanticMemories(userId: string | null, queryEmbedding: number[]): Promise<ScoredMemory[]> {
    if (userId === null) return [];
    const rows = (
      await this.db.query<ScoredMemory>(
        `SELECT *,
                CASE WHEN embedding IS NULL THEN 0
                     ELSE 1 - (embedding <=> $2) END AS semantic
         FROM memories
         WHERE user_id IS NOT DISTINCT FROM $1 AND active = TRUE`,
        [userId, toVec(queryEmbedding)],
      )
    ).rows;
    return rows;
  }

  /** Recent turns scoped to a session (preferred) or user, newest first. */
  async recentTurns(args: {
    sessionId: string | null;
    userId: string | null;
    limit?: number;
  }): Promise<TurnRecord[]> {
    const limit = args.limit ?? 50;
    let rows: Array<Record<string, unknown>>;
    if (args.sessionId !== null) {
      rows = (
        await this.db.query(
          "SELECT * FROM turns WHERE session_id = $1 ORDER BY created_at DESC LIMIT $2",
          [args.sessionId, limit],
        )
      ).rows as Array<Record<string, unknown>>;
    } else if (args.userId !== null) {
      rows = (
        await this.db.query(
          "SELECT * FROM turns WHERE user_id IS NOT DISTINCT FROM $1 ORDER BY created_at DESC LIMIT $2",
          [args.userId, limit],
        )
      ).rows as Array<Record<string, unknown>>;
    } else {
      return [];
    }
    return rows.map(rowToTurn);
  }

  /**
   * /search backing: structured hits over both memories and turns, ranked by
   * semantic similarity fused with keyword overlap. Mirrors recall's signal but
   * returns structured rows instead of prose.
   */
  async search(
    query: string,
    queryEmbedding: number[],
    args: { userId: string | null; sessionId: string | null; limit?: number },
    keyword: (text: string) => number,
  ): Promise<SearchHit[]> {
    const limit = args.limit ?? 10;
    const hits: SearchHit[] = [];

    // Memories (semantic + keyword).
    if (args.userId !== null) {
      const mems = await this.semanticMemories(args.userId, queryEmbedding);
      for (const m of mems) {
        const content = `${m.key}: ${m.value}`;
        const score = 0.5 * m.semantic + 0.5 * keyword(content);
        if (score > 0)
          hits.push({
            content,
            score,
            session_id: m.session_id,
            timestamp: m.updated_at,
            metadata: { type: m.type, memory_id: m.id, semantic: m.semantic },
          });
      }
    }

    // Turns (semantic + keyword) scoped to session or user.
    let turnRows: Array<Record<string, unknown>> = [];
    if (args.sessionId !== null) {
      turnRows = (
        await this.db.query(
          `SELECT *, CASE WHEN embedding IS NULL THEN 0 ELSE 1 - (embedding <=> $2) END AS semantic
           FROM turns WHERE session_id = $1`,
          [args.sessionId, toVec(queryEmbedding)],
        )
      ).rows as Array<Record<string, unknown>>;
    } else if (args.userId !== null) {
      turnRows = (
        await this.db.query(
          `SELECT *, CASE WHEN embedding IS NULL THEN 0 ELSE 1 - (embedding <=> $2) END AS semantic
           FROM turns WHERE user_id IS NOT DISTINCT FROM $1`,
          [args.userId, toVec(queryEmbedding)],
        )
      ).rows as Array<Record<string, unknown>>;
    }
    for (const r of turnRows) {
      const text = (r.text as string) ?? "";
      const semantic = Number(r.semantic ?? 0);
      const score = 0.5 * semantic + 0.5 * keyword(text);
      if (score > 0)
        hits.push({
          content: text,
          score,
          session_id: (r.session_id as string) ?? null,
          timestamp: (r.ts as string) ?? null,
          metadata:
            typeof r.metadata === "string" ? JSON.parse(r.metadata || "{}") : (r.metadata ?? {}),
        });
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, Math.max(0, limit));
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.db.query("DELETE FROM turns WHERE session_id = $1", [sessionId]);
    await this.db.query("DELETE FROM memories WHERE session_id = $1", [sessionId]);
  }

  async deleteUser(userId: string): Promise<void> {
    await this.db.query("DELETE FROM turns WHERE user_id IS NOT DISTINCT FROM $1", [userId]);
    await this.db.query("DELETE FROM memories WHERE user_id IS NOT DISTINCT FROM $1", [userId]);
  }
}

function rowToTurn(r: Record<string, unknown>): TurnRecord {
  const meta = r.metadata;
  return {
    id: r.id as string,
    session_id: r.session_id as string,
    user_id: (r.user_id as string) ?? null,
    timestamp: (r.ts as string) ?? null,
    text: (r.text as string) ?? "",
    metadata:
      typeof meta === "string"
        ? JSON.parse(meta || "{}")
        : ((meta as Record<string, unknown>) ?? {}),
  };
}
