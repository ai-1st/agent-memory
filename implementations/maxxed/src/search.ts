/**
 * /search — explicit, agent-invoked search. Structured rows (not prose).
 *
 * Reuses the same hybrid retrieval primitives as /recall (dense + lexical, RRF
 * fused) over memories and turns, but returns the raw fused list as structured
 * results rather than assembling budgeted prose. Honors the optional session /
 * user scope from the request.
 */

import type { LlmClient } from "./llm/types";
import type { SearchHit } from "./models";
import { rrf } from "./recall/fusion";
import type { Store } from "./store";
import type { MemoryRow, TurnRecord } from "./store/types";
import { round4 } from "./util/text";

export async function search(
  store: Store,
  llm: LlmClient,
  args: { query: string; userId: string | null; sessionId: string | null; limit: number },
): Promise<SearchHit[]> {
  const { query, userId, sessionId, limit } = args;
  if (!query.trim()) return [];

  let embedding: number[] | null = null;
  try {
    embedding = await llm.embed(query, "embed_query");
  } catch {
    embedding = null;
  }

  // Memories (scoped by user).
  const memLists: Array<{ name: string; ranked: Array<{ id: string; item: MemoryRow }> }> = [];
  const lexMem = await store.lexicalMemories(query, { userId, limit: limit * 2 });
  memLists.push({ name: "lex", ranked: lexMem.map((h) => ({ id: h.row.id, item: h.row })) });
  if (embedding) {
    const vMem = await store.vectorMemories(embedding, { userId, limit: limit * 2 });
    memLists.push({ name: "vec", ranked: vMem.map((h) => ({ id: h.row.id, item: h.row })) });
  }
  const fusedMem = rrf(memLists);

  // Turns (scoped by session if given, else user).
  const turnLists: Array<{ name: string; ranked: Array<{ id: string; item: TurnRecord }> }> = [];
  const lexTurn = await store.lexicalTurns(query, { sessionId, userId, limit: limit * 2 });
  turnLists.push({ name: "lex", ranked: lexTurn.map((h) => ({ id: h.turn.id, item: h.turn })) });
  if (embedding) {
    const vTurn = await store.vectorTurns(embedding, { sessionId, userId, limit: limit * 2 });
    turnLists.push({ name: "vec", ranked: vTurn.map((h) => ({ id: h.turn.id, item: h.turn })) });
  }
  const fusedTurn = rrf(turnLists);

  const hits: SearchHit[] = [];
  for (const f of fusedMem) {
    hits.push({
      content: `${f.item.key}: ${f.item.value}`,
      score: round4(f.score),
      session_id: f.item.session_id,
      timestamp: f.item.updated_at,
      metadata: { type: f.item.type, memory_id: f.item.id, sources: f.sources },
    });
  }
  for (const f of fusedTurn) {
    hits.push({
      content: f.item.text,
      score: round4(f.score),
      session_id: f.item.session_id,
      timestamp: f.item.timestamp,
      metadata: { ...f.item.metadata, turn_id: f.item.id, sources: f.sources },
    });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, Math.max(0, limit));
}
