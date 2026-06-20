/** Row + input shapes for the pglite store. */

export interface MemoryRow {
  id: string;
  user_id: string | null;
  session_id: string | null;
  type: string;
  key: string;
  value: string;
  confidence: number;
  importance: number;
  entities: string[];
  source_session: string | null;
  source_turn: string | null;
  valid_from: string | null;
  valid_to: string | null;
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

export interface HistoryRow {
  id: string;
  memory_id: string;
  user_id: string | null;
  decision: string;
  reason: string | null;
  value: string | null;
  target_id: string | null;
  source_turn: string | null;
  at: string;
}

export interface LinkRow {
  id: string;
  src: string;
  dst: string;
  relation: string;
  weight: number;
}

export interface InsertTurnInput {
  sessionId: string;
  userId: string | null;
  messages: Array<Record<string, unknown>>;
  timestamp: string | null;
  metadata: Record<string, unknown>;
  embedding: number[] | null;
}

/** A fully-resolved memory ready to write (post-reconcile). */
export interface MemoryWrite {
  type: string;
  key: string;
  value: string;
  confidence: number;
  importance: number;
  entities: string[];
  snippet: string;
  embedding: number[] | null;
  validFrom: string | null;
}

/** Hybrid retrieval candidate, before fusion. */
export interface ScoredRow {
  row: MemoryRow;
  score: number;
}
