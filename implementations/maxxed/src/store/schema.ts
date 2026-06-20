/**
 * pglite (embedded Postgres) schema for the maxxed memory store.
 *
 * One relational database holds everything — turns, structured memories, dense
 * embeddings (pgvector), an append-only history ledger, and an entity-link graph
 * for multi-hop — so reads-after-writes are correct by construction (no
 * eventual-consistency window) and a single Docker volume = real persistence.
 *
 * The embedding column dimension is templated from settings (3072 for
 * text-embedding-3-large live; 256 for the offline mock) so the same schema
 * serves both pipelines. We use a plain vector column + ORDER BY distance
 * (exact search) rather than an ANN index: at the scale this service targets
 * (a few users, thousands of memories) exact search is fast and always correct,
 * and it sidesteps ANN index-build/recall tuning. Documented as a tradeoff.
 */

export function buildSchema(embedDim: number): string {
  return `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS turns (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  user_id     TEXT,
  timestamp   TEXT,
  messages    JSONB NOT NULL,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  text        TEXT NOT NULL DEFAULT '',
  tsv         tsvector,
  embedding   vector(${embedDim}),
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);
CREATE INDEX IF NOT EXISTS idx_turns_user    ON turns(user_id);
CREATE INDEX IF NOT EXISTS idx_turns_tsv     ON turns USING gin(tsv);

CREATE TABLE IF NOT EXISTS memories (
  id             TEXT PRIMARY KEY,
  user_id        TEXT,
  session_id     TEXT,
  type           TEXT NOT NULL,
  key            TEXT NOT NULL,
  value          TEXT NOT NULL,
  confidence     REAL NOT NULL DEFAULT 0.7,
  importance     REAL NOT NULL DEFAULT 0.5,
  entities       JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_session TEXT,
  source_turn    TEXT,
  -- valid-time (observed) vs transaction-time (created/updated): bi-temporal.
  valid_from     TEXT,
  valid_to       TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  supersedes     TEXT,
  active         BOOLEAN NOT NULL DEFAULT true,
  tsv            tsvector,
  embedding      vector(${embedDim})
);
CREATE INDEX IF NOT EXISTS idx_mem_user   ON memories(user_id);
CREATE INDEX IF NOT EXISTS idx_mem_key    ON memories(user_id, key, active);
CREATE INDEX IF NOT EXISTS idx_mem_active ON memories(user_id, active);
CREATE INDEX IF NOT EXISTS idx_mem_tsv    ON memories USING gin(tsv);

-- Append-only audit ledger: every ADD/UPDATE/SUPERSEDE/NOOP decision recorded.
CREATE TABLE IF NOT EXISTS memory_history (
  id          TEXT PRIMARY KEY,
  memory_id   TEXT NOT NULL,
  user_id     TEXT,
  decision    TEXT NOT NULL,
  reason      TEXT,
  value       TEXT,
  target_id   TEXT,
  source_turn TEXT,
  at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hist_mem  ON memory_history(memory_id);
CREATE INDEX IF NOT EXISTS idx_hist_user ON memory_history(user_id);

-- Entity-link graph for one-hop multi-hop expansion. Undirected pair of memories
-- that share an entity / co-reference / contradiction relation.
CREATE TABLE IF NOT EXISTS memory_links (
  id        TEXT PRIMARY KEY,
  user_id   TEXT,
  src       TEXT NOT NULL,
  dst       TEXT NOT NULL,
  relation  TEXT NOT NULL,
  weight    REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_links_src  ON memory_links(src);
CREATE INDEX IF NOT EXISTS idx_links_user ON memory_links(user_id);
`;
}
