/**
 * pglite persistence layer for the maxxed memory store.
 *
 * Async (pglite is async) but linearized: each instance issues queries against a
 * single embedded Postgres, and the HTTP handlers await every write before
 * returning — so "after /turns returns, it's queryable" holds with no eventual
 * consistency. The store exposes a small method surface (turns, memories,
 * history, links, lexical search, vector search) that the extraction reconciler
 * and the hybrid recaller compose.
 */

import { mkdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { newId, nowIso } from "../util/ids";
import { buildSchema } from "./schema";
import type {
  HistoryRow,
  InsertTurnInput,
  LinkRow,
  MemoryRow,
  MemoryWrite,
  TurnRecord,
} from "./types";

/** Render a JS number[] as a pgvector literal: '[1,2,3]'. */
function vec(v: number[] | null): string | null {
  return v === null ? null : `[${v.join(",")}]`;
}

function parseRow(r: Record<string, unknown>): MemoryRow {
  return {
    id: r.id as string,
    user_id: (r.user_id as string) ?? null,
    session_id: (r.session_id as string) ?? null,
    type: r.type as string,
    key: r.key as string,
    value: r.value as string,
    confidence: Number(r.confidence ?? 0.7),
    importance: Number(r.importance ?? 0.5),
    entities: toArray(r.entities),
    source_session: (r.source_session as string) ?? null,
    source_turn: (r.source_turn as string) ?? null,
    valid_from: (r.valid_from as string) ?? null,
    valid_to: (r.valid_to as string) ?? null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
    supersedes: (r.supersedes as string) ?? null,
    active: Boolean(r.active),
  };
}

function toArray(v: unknown): string[] {
  if (Array.isArray(v)) return v as string[];
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

export class Store {
  private db!: PGlite;
  private ready: Promise<void>;

  constructor(
    private dbDir: string,
    private embedDim: number,
  ) {
    if (dbDir !== ":memory:" && !dbDir.startsWith("memory://")) {
      mkdirSync(dbDir, { recursive: true });
    }
    this.db = new PGlite(dbDir === ":memory:" ? "memory://" : dbDir, {
      extensions: { vector },
    });
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    await this.db.waitReady;
    await this.db.exec(buildSchema(this.embedDim));
  }

  async whenReady(): Promise<void> {
    return this.ready;
  }

  async close(): Promise<void> {
    await this.ready;
    await this.db.close();
  }

  // --- turns ----------------------------------------------------------------

  async insertTurn(input: InsertTurnInput): Promise<string> {
    await this.ready;
    const turnId = newId("turn");
    const text = input.messages
      .map((m) => `${m.role ?? ""}: ${m.content ?? ""}`.trim())
      .join("\n")
      .trim();
    await this.db.query(
      `INSERT INTO turns (id, session_id, user_id, timestamp, messages, metadata, text, tsv, embedding, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, to_tsvector('english', $7), $8, $9)`,
      [
        turnId,
        input.sessionId,
        input.userId,
        input.timestamp,
        JSON.stringify(input.messages),
        JSON.stringify(input.metadata ?? {}),
        text,
        vec(input.embedding),
        nowIso(),
      ],
    );
    return turnId;
  }

  async recentTurns(args: {
    sessionId: string | null;
    userId: string | null;
    limit?: number;
  }): Promise<TurnRecord[]> {
    await this.ready;
    const limit = args.limit ?? 50;
    let sql: string;
    let params: unknown[];
    if (args.sessionId !== null) {
      sql = "SELECT * FROM turns WHERE session_id = $1 ORDER BY created_at DESC LIMIT $2";
      params = [args.sessionId, limit];
    } else if (args.userId !== null) {
      sql =
        "SELECT * FROM turns WHERE user_id IS NOT DISTINCT FROM $1 ORDER BY created_at DESC LIMIT $2";
      params = [args.userId, limit];
    } else {
      return [];
    }
    const res = await this.db.query<Record<string, unknown>>(sql, params);
    return res.rows.map(turnRecord);
  }

  /** Lexical (FTS) search over turns. Returns turn + ts_rank score. */
  async lexicalTurns(
    query: string,
    args: { sessionId: string | null; userId: string | null; limit: number },
  ): Promise<Array<{ turn: TurnRecord; score: number }>> {
    await this.ready;
    if (!query.trim()) return [];
    let scope = "";
    const params: unknown[] = [query];
    if (args.sessionId !== null) {
      scope = "AND session_id = $2";
      params.push(args.sessionId);
    } else if (args.userId !== null) {
      scope = "AND user_id IS NOT DISTINCT FROM $2";
      params.push(args.userId);
    }
    params.push(args.limit);
    const limPlaceholder = `$${params.length}`;
    const res = await this.db.query<Record<string, unknown>>(
      `SELECT *, ts_rank(tsv, plainto_tsquery('english', $1)) AS rank
       FROM turns
       WHERE tsv @@ plainto_tsquery('english', $1) ${scope}
       ORDER BY rank DESC LIMIT ${limPlaceholder}`,
      params,
    );
    return res.rows.map((r) => ({ turn: turnRecord(r), score: Number(r.rank ?? 0) }));
  }

  /** Vector kNN over turns (cosine distance). */
  async vectorTurns(
    embedding: number[],
    args: { sessionId: string | null; userId: string | null; limit: number },
  ): Promise<Array<{ turn: TurnRecord; score: number }>> {
    await this.ready;
    let scope = "embedding IS NOT NULL";
    const params: unknown[] = [vec(embedding)];
    if (args.sessionId !== null) {
      scope += " AND session_id = $2";
      params.push(args.sessionId);
    } else if (args.userId !== null) {
      scope += " AND user_id IS NOT DISTINCT FROM $2";
      params.push(args.userId);
    }
    params.push(args.limit);
    const limPlaceholder = `$${params.length}`;
    const res = await this.db.query<Record<string, unknown>>(
      `SELECT *, 1 - (embedding <=> $1) AS sim
       FROM turns WHERE ${scope}
       ORDER BY embedding <=> $1 LIMIT ${limPlaceholder}`,
      params,
    );
    return res.rows.map((r) => ({ turn: turnRecord(r), score: Number(r.sim ?? 0) }));
  }

  // --- memories -------------------------------------------------------------

  /** Active memories for a slot key (most-recent first), for reconciliation. */
  async memoriesForKey(userId: string | null, key: string): Promise<MemoryRow[]> {
    await this.ready;
    const res = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM memories
       WHERE user_id IS NOT DISTINCT FROM $1 AND key = $2 AND active = true
       ORDER BY updated_at DESC`,
      [userId, key],
    );
    return res.rows.map(parseRow);
  }

  async insertMemory(
    write: MemoryWrite,
    ctx: { userId: string | null; sessionId: string; turnId: string },
    supersedes: string | null,
  ): Promise<string> {
    await this.ready;
    const id = newId("mem");
    const now = nowIso();
    await this.db.query(
      `INSERT INTO memories (id, user_id, session_id, type, key, value, confidence, importance,
         entities, source_session, source_turn, valid_from, valid_to, created_at, updated_at,
         supersedes, active, tsv, embedding)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,true,
         to_tsvector('english', $5 || ' ' || $6), $17)`,
      [
        id,
        ctx.userId,
        ctx.sessionId,
        write.type,
        write.key,
        write.value,
        write.confidence,
        write.importance,
        JSON.stringify(write.entities ?? []),
        ctx.sessionId,
        ctx.turnId,
        write.validFrom,
        null,
        now,
        now,
        supersedes,
        vec(write.embedding),
      ],
    );
    return id;
  }

  /** Mark a memory superseded: active=false, valid_to=now. Keeps the row. */
  async supersede(id: string, validTo: string): Promise<void> {
    await this.ready;
    await this.db.query(
      "UPDATE memories SET active=false, valid_to=$2, updated_at=$2 WHERE id=$1",
      [id, validTo],
    );
  }

  /** In-place refinement of an existing memory (UPDATE decision). */
  async updateMemory(
    id: string,
    fields: { value: string; confidence: number; embedding: number[] | null },
  ): Promise<void> {
    await this.ready;
    const now = nowIso();
    await this.db.query(
      `UPDATE memories
       SET value=$2, confidence=GREATEST(confidence,$3), updated_at=$4,
           tsv = to_tsvector('english', key || ' ' || $2), embedding=$5
       WHERE id=$1`,
      [id, fields.value, fields.confidence, now, vec(fields.embedding)],
    );
  }

  async bumpMemory(id: string, confidence: number): Promise<void> {
    await this.ready;
    await this.db.query(
      "UPDATE memories SET updated_at=$2, confidence=GREATEST(confidence,$3) WHERE id=$1",
      [id, nowIso(), confidence],
    );
  }

  /**
   * Point-in-time ("as of") view: for each slot, the memory whose validity
   * interval [valid_from, valid_to) contains `asOf`. Mutable slots collapse to
   * the single version valid then; additive slots keep all valid members.
   */
  async memoriesAsOf(userId: string | null, asOf: string): Promise<MemoryRow[]> {
    await this.ready;
    const res = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM memories
       WHERE user_id IS NOT DISTINCT FROM $1
         AND (valid_from IS NULL OR valid_from <= $2)
         AND (valid_to IS NULL OR valid_to > $2)
       ORDER BY updated_at DESC`,
      [userId, asOf],
    );
    return res.rows.map(parseRow);
  }

  async listMemories(userId: string | null, activeOnly: boolean): Promise<MemoryRow[]> {
    await this.ready;
    const res = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM memories WHERE user_id IS NOT DISTINCT FROM $1 ${
        activeOnly ? "AND active = true" : ""
      } ORDER BY created_at ASC`,
      [userId],
    );
    return res.rows.map(parseRow);
  }

  async getMemory(id: string): Promise<MemoryRow | null> {
    await this.ready;
    const res = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM memories WHERE id = $1",
      [id],
    );
    return res.rows.length ? parseRow(res.rows[0]) : null;
  }

  /** Superseded (history) values for a slot key, newest first. */
  async supersededValues(userId: string | null, key: string): Promise<string[]> {
    await this.ready;
    const res = await this.db.query<Record<string, unknown>>(
      `SELECT value FROM memories
       WHERE user_id IS NOT DISTINCT FROM $1 AND key = $2 AND active = false
       ORDER BY updated_at DESC`,
      [userId, key],
    );
    return res.rows.map((r) => r.value as string);
  }

  /** Lexical (FTS) search over active memories. */
  async lexicalMemories(
    query: string,
    args: { userId: string | null; limit: number },
  ): Promise<Array<{ row: MemoryRow; score: number }>> {
    await this.ready;
    if (!query.trim()) return [];
    const res = await this.db.query<Record<string, unknown>>(
      `SELECT *, ts_rank(tsv, plainto_tsquery('english', $1)) AS rank
       FROM memories
       WHERE active = true AND user_id IS NOT DISTINCT FROM $2
         AND tsv @@ plainto_tsquery('english', $1)
       ORDER BY rank DESC LIMIT $3`,
      [query, args.userId, args.limit],
    );
    return res.rows.map((r) => ({ row: parseRow(r), score: Number(r.rank ?? 0) }));
  }

  /** Vector kNN over active memories (cosine). */
  async vectorMemories(
    embedding: number[],
    args: { userId: string | null; limit: number },
  ): Promise<Array<{ row: MemoryRow; score: number }>> {
    await this.ready;
    const res = await this.db.query<Record<string, unknown>>(
      `SELECT *, 1 - (embedding <=> $1) AS sim
       FROM memories
       WHERE active = true AND embedding IS NOT NULL AND user_id IS NOT DISTINCT FROM $2
       ORDER BY embedding <=> $1 LIMIT $3`,
      [vec(embedding), args.userId, args.limit],
    );
    return res.rows.map((r) => ({ row: parseRow(r), score: Number(r.sim ?? 0) }));
  }

  // --- history ledger -------------------------------------------------------

  async recordHistory(h: Omit<HistoryRow, "id" | "at">): Promise<void> {
    await this.ready;
    await this.db.query(
      `INSERT INTO memory_history (id, memory_id, user_id, decision, reason, value, target_id, source_turn, at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        newId("hist"),
        h.memory_id,
        h.user_id,
        h.decision,
        h.reason,
        h.value,
        h.target_id,
        h.source_turn,
        nowIso(),
      ],
    );
  }

  async historyForUser(userId: string | null): Promise<HistoryRow[]> {
    await this.ready;
    const res = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM memory_history WHERE user_id IS NOT DISTINCT FROM $1 ORDER BY at ASC",
      [userId],
    );
    return res.rows.map((r) => ({
      id: r.id as string,
      memory_id: r.memory_id as string,
      user_id: (r.user_id as string) ?? null,
      decision: r.decision as string,
      reason: (r.reason as string) ?? null,
      value: (r.value as string) ?? null,
      target_id: (r.target_id as string) ?? null,
      source_turn: (r.source_turn as string) ?? null,
      at: r.at as string,
    }));
  }

  // --- entity-link graph ----------------------------------------------------

  async addLink(args: {
    userId: string | null;
    src: string;
    dst: string;
    relation: string;
    weight?: number;
  }): Promise<void> {
    await this.ready;
    if (args.src === args.dst) return;
    await this.db.query(
      `INSERT INTO memory_links (id, user_id, src, dst, relation, weight, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [newId("link"), args.userId, args.src, args.dst, args.relation, args.weight ?? 1.0, nowIso()],
    );
  }

  /** One-hop neighbours (active memories) of a set of seed memory ids. */
  async neighbours(ids: string[]): Promise<Array<{ row: MemoryRow; via: string; weight: number }>> {
    await this.ready;
    if (ids.length === 0) return [];
    const res = await this.db.query<Record<string, unknown>>(
      `SELECT m.*, l.src AS via, l.weight AS lweight
       FROM memory_links l
       JOIN memories m ON m.id = l.dst
       WHERE l.src = ANY($1) AND m.active = true
       UNION
       SELECT m.*, l.dst AS via, l.weight AS lweight
       FROM memory_links l
       JOIN memories m ON m.id = l.src
       WHERE l.dst = ANY($1) AND m.active = true`,
      [ids],
    );
    return res.rows.map((r) => ({
      row: parseRow(r),
      via: r.via as string,
      weight: Number(r.lweight ?? 1),
    }));
  }

  /** Active memories that share any entity token with `entities`. */
  async memoriesByEntities(userId: string | null, entities: string[]): Promise<MemoryRow[]> {
    await this.ready;
    if (entities.length === 0) return [];
    const res = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM memories
       WHERE active = true AND user_id IS NOT DISTINCT FROM $1
         AND entities ?| $2`,
      [userId, entities],
    );
    return res.rows.map(parseRow);
  }

  // --- deletes --------------------------------------------------------------

  async deleteSession(sessionId: string): Promise<void> {
    await this.ready;
    await this.db.query("DELETE FROM turns WHERE session_id=$1", [sessionId]);
    await this.db.query(
      "DELETE FROM memory_links WHERE src IN (SELECT id FROM memories WHERE session_id=$1) OR dst IN (SELECT id FROM memories WHERE session_id=$1)",
      [sessionId],
    );
    await this.db.query(
      "DELETE FROM memory_history WHERE memory_id IN (SELECT id FROM memories WHERE session_id=$1)",
      [sessionId],
    );
    await this.db.query("DELETE FROM memories WHERE session_id=$1", [sessionId]);
  }

  async deleteUser(userId: string): Promise<void> {
    await this.ready;
    await this.db.query("DELETE FROM turns WHERE user_id IS NOT DISTINCT FROM $1", [userId]);
    await this.db.query("DELETE FROM memory_links WHERE user_id IS NOT DISTINCT FROM $1", [userId]);
    await this.db.query("DELETE FROM memory_history WHERE user_id IS NOT DISTINCT FROM $1", [
      userId,
    ]);
    await this.db.query("DELETE FROM memories WHERE user_id IS NOT DISTINCT FROM $1", [userId]);
  }

  async getLinks(userId: string | null): Promise<LinkRow[]> {
    await this.ready;
    const res = await this.db.query<Record<string, unknown>>(
      "SELECT * FROM memory_links WHERE user_id IS NOT DISTINCT FROM $1",
      [userId],
    );
    return res.rows.map((r) => ({
      id: r.id as string,
      src: r.src as string,
      dst: r.dst as string,
      relation: r.relation as string,
      weight: Number(r.weight ?? 1),
    }));
  }
}

function turnRecord(r: Record<string, unknown>): TurnRecord {
  let metadata: Record<string, unknown> = {};
  const raw = r.metadata;
  if (raw && typeof raw === "object") metadata = raw as Record<string, unknown>;
  else if (typeof raw === "string") {
    try {
      metadata = JSON.parse(raw);
    } catch {
      metadata = {};
    }
  }
  return {
    id: r.id as string,
    session_id: r.session_id as string,
    user_id: (r.user_id as string) ?? null,
    timestamp: (r.timestamp as string) ?? null,
    text: (r.text as string) ?? "",
    metadata,
    created_at: r.created_at as string,
  };
}
