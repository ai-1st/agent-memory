/**
 * Persistence layer: pglite (embedded Postgres) + the `vector` extension.
 *
 * Why pglite: a single embedded Postgres process, persisted to a `dataDir` on
 * the Docker volume — real durability with zero external services. The `vector`
 * extension gives us in-database cosine similarity, so semantic search,
 * relational fact rows, the append-only history, and the contradiction-link
 * graph all live in ONE store with ONE consistency model. After `await`ing a
 * write the row is committed and immediately queryable — no eventual-consistency
 * window, which the contract requires.
 *
 * Tables:
 *  - turns        : raw verbatim turns. The source of truth we cite from.
 *  - memories     : context-enriched facts with embeddings, type/key/value,
 *                   confidence, provenance, and supersession (active/supersedes).
 *  - memory_links : two-way edges between facts. Contradictions are LINKED, not
 *                   deleted; recall follows these links to narrate conflicts.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";

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
  active: boolean;
}

export interface TurnRecord {
  id: string;
  session_id: string;
  user_id: string | null;
  timestamp: string | null;
  text: string;
  metadata: Record<string, unknown>;
  created_at: string;
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

export interface InsertMemoryInput {
  userId: string | null;
  sessionId: string;
  sourceTurn: string;
  type: string;
  key: string;
  value: string;
  confidence: number;
  embedding: number[];
  supersedes: string | null;
  active: boolean;
}

export interface SimilarMemory extends MemoryRow {
  similarity: number;
}

const nowIso = (): string => new Date().toISOString();
const newId = (prefix: string): string =>
  `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
const toVec = (v: number[]): string => `[${v.join(",")}]`;

export class Store {
  private db!: PGlite;
  private dim: number;
  private dataDir: string;

  constructor(dataDir: string, dim: number) {
    this.dataDir = dataDir;
    this.dim = dim;
  }

  async init(): Promise<void> {
    if (this.dataDir !== "memory://") {
      mkdirSync(this.dataDir, { recursive: true });
      this.db = new PGlite(this.dataDir, { extensions: { vector } });
    } else {
      this.db = new PGlite({ extensions: { vector } });
    }
    await this.db.exec("CREATE EXTENSION IF NOT EXISTS vector;");
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS turns (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL,
        user_id     TEXT,
        timestamp   TEXT,
        messages    JSONB NOT NULL,
        metadata    JSONB,
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
        active         BOOLEAN NOT NULL DEFAULT TRUE,
        embedding      vector(${this.dim})
      );
      CREATE INDEX IF NOT EXISTS idx_mem_user ON memories(user_id);
      CREATE INDEX IF NOT EXISTS idx_mem_key  ON memories(user_id, key, active);
      CREATE INDEX IF NOT EXISTS idx_mem_sess ON memories(session_id);

      CREATE TABLE IF NOT EXISTS memory_links (
        a_id     TEXT NOT NULL,
        b_id     TEXT NOT NULL,
        kind     TEXT NOT NULL DEFAULT 'contradiction',
        note     TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (a_id, b_id, kind)
      );
      CREATE INDEX IF NOT EXISTS idx_link_a ON memory_links(a_id);
      CREATE INDEX IF NOT EXISTS idx_link_b ON memory_links(b_id);
    `);
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  // -- turns -----------------------------------------------------------------

  async insertTurn(input: InsertTurnInput): Promise<string> {
    const turnId = newId("turn");
    const text = input.messages
      .map((m) => `${m.role ?? ""}: ${m.content ?? ""}`.trim())
      .join("\n")
      .trim();
    await this.db.query(
      `INSERT INTO turns (id, session_id, user_id, timestamp, messages, metadata, text, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        turnId,
        input.sessionId,
        input.userId,
        input.timestamp,
        JSON.stringify(input.messages),
        JSON.stringify(input.metadata),
        text,
        nowIso(),
      ],
    );
    return turnId;
  }

  async getTurn(id: string): Promise<TurnRecord | null> {
    const res = await this.db.query<any>("SELECT * FROM turns WHERE id = $1", [id]);
    const r = res.rows[0];
    return r ? this.mapTurn(r) : null;
  }

  async recentTurns(args: {
    sessionId: string | null;
    userId: string | null;
    limit?: number;
  }): Promise<TurnRecord[]> {
    const limit = args.limit ?? 50;
    let res: { rows: any[] };
    if (args.sessionId !== null) {
      res = await this.db.query<any>(
        "SELECT * FROM turns WHERE session_id = $1 ORDER BY created_at DESC LIMIT $2",
        [args.sessionId, limit],
      );
    } else if (args.userId !== null) {
      res = await this.db.query<any>(
        "SELECT * FROM turns WHERE user_id IS NOT DISTINCT FROM $1 ORDER BY created_at DESC LIMIT $2",
        [args.userId, limit],
      );
    } else {
      return [];
    }
    return res.rows.map((r) => this.mapTurn(r));
  }

  private mapTurn(r: any): TurnRecord {
    return {
      id: r.id,
      session_id: r.session_id,
      user_id: r.user_id ?? null,
      timestamp: r.timestamp ?? null,
      text: r.text ?? "",
      metadata:
        typeof r.metadata === "string" ? JSON.parse(r.metadata || "{}") : (r.metadata ?? {}),
      created_at: r.created_at,
    };
  }

  // -- memories --------------------------------------------------------------

  async insertMemory(input: InsertMemoryInput): Promise<string> {
    const id = newId("mem");
    const now = nowIso();
    await this.db.query(
      `INSERT INTO memories (id, user_id, session_id, type, key, value, confidence,
         source_session, source_turn, created_at, updated_at, supersedes, active, embedding)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        id,
        input.userId,
        input.sessionId,
        input.type,
        input.key,
        input.value,
        input.confidence,
        input.sessionId,
        input.sourceTurn,
        now,
        now,
        input.supersedes,
        input.active,
        toVec(input.embedding),
      ],
    );
    return id;
  }

  /** Mark a memory superseded (active=false). History is preserved. */
  async supersede(id: string): Promise<void> {
    await this.db.query("UPDATE memories SET active=FALSE, updated_at=$2 WHERE id=$1", [
      id,
      nowIso(),
    ]);
  }

  /** Bump confidence/updated_at without creating a new row (REINFORCE). */
  async reinforce(id: string, confidence: number): Promise<void> {
    await this.db.query(
      "UPDATE memories SET updated_at=$2, confidence=GREATEST(confidence,$3) WHERE id=$1",
      [id, nowIso(), confidence],
    );
  }

  async getMemory(id: string): Promise<MemoryRow | null> {
    const res = await this.db.query<any>("SELECT * FROM memories WHERE id=$1", [id]);
    const r = res.rows[0];
    return r ? this.mapMem(r) : null;
  }

  async listMemories(userId: string | null, activeOnly: boolean): Promise<MemoryRow[]> {
    let q = "SELECT * FROM memories WHERE user_id IS NOT DISTINCT FROM $1";
    if (activeOnly) q += " AND active=TRUE";
    q += " ORDER BY created_at ASC";
    const res = await this.db.query<any>(q, [userId]);
    return res.rows.map((r) => this.mapMem(r));
  }

  /** Active facts attached to a specific session (for "broaden to session"). */
  async sessionMemories(sessionId: string): Promise<MemoryRow[]> {
    const res = await this.db.query<any>(
      "SELECT * FROM memories WHERE session_id=$1 AND active=TRUE ORDER BY created_at ASC",
      [sessionId],
    );
    return res.rows.map((r) => this.mapMem(r));
  }

  /**
   * Semantic search over a user's ACTIVE memories via cosine distance.
   * Returns rows with a `similarity` in [0,1] (1 = identical).
   */
  async similarMemories(args: {
    userId: string | null;
    embedding: number[];
    limit: number;
    activeOnly?: boolean;
  }): Promise<SimilarMemory[]> {
    const activeClause = args.activeOnly === false ? "" : "AND active=TRUE";
    const res = await this.db.query<any>(
      `SELECT *, 1 - (embedding <=> $2) AS similarity
         FROM memories
        WHERE user_id IS NOT DISTINCT FROM $1 ${activeClause}
          AND embedding IS NOT NULL
        ORDER BY embedding <=> $2
        LIMIT $3`,
      [args.userId, toVec(args.embedding), args.limit],
    );
    return res.rows.map((r) => ({ ...this.mapMem(r), similarity: Number(r.similarity) }));
  }

  private mapMem(r: any): MemoryRow {
    return {
      id: r.id,
      user_id: r.user_id ?? null,
      session_id: r.session_id ?? null,
      type: r.type,
      key: r.key,
      value: r.value,
      confidence: Number(r.confidence),
      source_session: r.source_session ?? null,
      source_turn: r.source_turn ?? null,
      created_at: r.created_at,
      updated_at: r.updated_at,
      supersedes: r.supersedes ?? null,
      active: r.active === true || r.active === "t" || r.active === 1,
    };
  }

  // -- links (contradictions) ------------------------------------------------

  /** Create a two-way link between two memories (idempotent). */
  async linkMemories(aId: string, bId: string, kind: string, note: string): Promise<void> {
    if (aId === bId) return;
    const now = nowIso();
    await this.db.query(
      `INSERT INTO memory_links (a_id, b_id, kind, note, created_at)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [aId, bId, kind, note, now],
    );
    await this.db.query(
      `INSERT INTO memory_links (a_id, b_id, kind, note, created_at)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [bId, aId, kind, note, now],
    );
  }

  /** Direct links out of a memory. */
  async linksOf(id: string): Promise<Array<{ id: string; kind: string; note: string | null }>> {
    const res = await this.db.query<any>(
      "SELECT b_id, kind, note FROM memory_links WHERE a_id=$1",
      [id],
    );
    return res.rows.map((r) => ({ id: r.b_id, kind: r.kind, note: r.note ?? null }));
  }

  /**
   * Follow the full link chain from a set of seed memory IDs (BFS), returning
   * the linked memory rows (excluding the seeds). Used so recall always pulls
   * contradicting facts even if they didn't rank on their own.
   */
  async expandLinks(seedIds: string[]): Promise<MemoryRow[]> {
    const seen = new Set(seedIds);
    const queue = [...seedIds];
    const out: MemoryRow[] = [];
    while (queue.length > 0) {
      const cur = queue.shift() as string;
      const links = await this.linksOf(cur);
      for (const l of links) {
        if (seen.has(l.id)) continue;
        seen.add(l.id);
        const row = await this.getMemory(l.id);
        if (row) {
          out.push(row);
          queue.push(l.id);
        }
      }
    }
    return out;
  }

  // -- search (structured, /search endpoint) ---------------------------------

  /**
   * Hybrid structured search: semantic over memories (when an embedding is
   * given) blended with lexical overlap over memories and raw turns.
   */
  async search(args: {
    query: string;
    embedding: number[] | null;
    userId: string | null;
    sessionId: string | null;
    limit: number;
  }): Promise<SearchHit[]> {
    const hits: SearchHit[] = [];
    const qset = tokenSet(args.query);

    if (args.embedding) {
      const sims = await this.similarMemories({
        userId: args.userId,
        embedding: args.embedding,
        limit: Math.max(args.limit * 2, 10),
      });
      for (const m of sims) {
        hits.push({
          content: `${m.key}: ${m.value}`,
          score: round4(m.similarity),
          session_id: m.session_id,
          timestamp: m.updated_at,
          metadata: { type: m.type, memory_id: m.id, match: "semantic" },
        });
      }
    } else {
      const mems = await this.listMemories(args.userId, true);
      for (const m of mems) {
        const score = overlap(qset, `${m.key} ${m.value}`);
        if (score > 0) {
          hits.push({
            content: `${m.key}: ${m.value}`,
            score: round4(score),
            session_id: m.session_id,
            timestamp: m.updated_at,
            metadata: { type: m.type, memory_id: m.id, match: "lexical" },
          });
        }
      }
    }

    // Lexical over raw turns (so /search can surface source text too).
    let turnRows: any[] = [];
    if (args.sessionId !== null) {
      const res = await this.db.query<any>("SELECT * FROM turns WHERE session_id=$1", [
        args.sessionId,
      ]);
      turnRows = res.rows;
    } else if (args.userId !== null) {
      const res = await this.db.query<any>(
        "SELECT * FROM turns WHERE user_id IS NOT DISTINCT FROM $1",
        [args.userId],
      );
      turnRows = res.rows;
    }
    for (const r of turnRows) {
      const text = r.text ?? "";
      const score = overlap(qset, text);
      if (score > 0) {
        hits.push({
          content: text,
          score: round4(score),
          session_id: r.session_id ?? null,
          timestamp: r.timestamp ?? null,
          metadata:
            typeof r.metadata === "string" ? JSON.parse(r.metadata || "{}") : (r.metadata ?? {}),
        });
      }
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, Math.max(0, args.limit));
  }

  // -- deletes ---------------------------------------------------------------

  async deleteSession(sessionId: string): Promise<void> {
    const mems = await this.db.query<any>("SELECT id FROM memories WHERE session_id=$1", [
      sessionId,
    ]);
    const ids = mems.rows.map((r) => r.id as string);
    if (ids.length > 0) {
      await this.db.query("DELETE FROM memory_links WHERE a_id = ANY($1) OR b_id = ANY($1)", [ids]);
    }
    await this.db.query("DELETE FROM memories WHERE session_id=$1", [sessionId]);
    await this.db.query("DELETE FROM turns WHERE session_id=$1", [sessionId]);
  }

  async deleteUser(userId: string): Promise<void> {
    const mems = await this.db.query<any>(
      "SELECT id FROM memories WHERE user_id IS NOT DISTINCT FROM $1",
      [userId],
    );
    const ids = mems.rows.map((r) => r.id as string);
    if (ids.length > 0) {
      await this.db.query("DELETE FROM memory_links WHERE a_id = ANY($1) OR b_id = ANY($1)", [ids]);
    }
    await this.db.query("DELETE FROM memories WHERE user_id IS NOT DISTINCT FROM $1", [userId]);
    await this.db.query("DELETE FROM turns WHERE user_id IS NOT DISTINCT FROM $1", [userId]);
  }
}

// -- small lexical helpers (used by /search blend) ---------------------------

const STOP = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "to",
  "of",
  "in",
  "on",
  "at",
  "for",
  "and",
  "or",
  "with",
  "this",
  "that",
  "it",
  "i",
  "you",
  "do",
  "does",
  "what",
  "where",
  "who",
  "the",
  "user",
  "user's",
  "their",
  "they",
  "he",
  "she",
]);

export function tokenSet(text: string): Set<string> {
  return new Set(
    (text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s']/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1 && !STOP.has(t)),
  );
}

export function overlap(qset: Set<string>, text: string): number {
  if (qset.size === 0) return 0;
  const tset = tokenSet(text);
  if (tset.size === 0) return 0;
  let n = 0;
  for (const t of qset) if (tset.has(t)) n++;
  return n / qset.size;
}

const round4 = (x: number): number => Math.round(x * 10000) / 10000;
