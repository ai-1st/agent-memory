/**
 * Reciprocal Rank Fusion (RRF).
 *
 * Fuses several ranked lists (dense vector, lexical FTS, graph-expansion, ...)
 * into one ranking using rank position, not raw scores — which makes it robust
 * to the wildly different score scales of cosine similarity vs ts_rank. The
 * classic formula: score(d) = Σ_lists 1 / (k + rank_list(d)), k=60.
 */

const K = 60;

export interface RankedList<T> {
  /** Stable id for a candidate (memory id / turn id). */
  id: string;
  item: T;
}

export interface FusedResult<T> {
  id: string;
  item: T;
  score: number;
  /** which retrievers contributed, for explainability. */
  sources: string[];
}

export function rrf<T>(
  lists: Array<{ name: string; ranked: RankedList<T>[] }>,
  k = K,
): FusedResult<T>[] {
  const acc = new Map<string, FusedResult<T>>();
  for (const { name, ranked } of lists) {
    ranked.forEach((entry, idx) => {
      const contribution = 1 / (k + idx + 1);
      const cur = acc.get(entry.id);
      if (cur) {
        cur.score += contribution;
        if (!cur.sources.includes(name)) cur.sources.push(name);
      } else {
        acc.set(entry.id, {
          id: entry.id,
          item: entry.item,
          score: contribution,
          sources: [name],
        });
      }
    });
  }
  return [...acc.values()].sort((a, b) => b.score - a.score);
}
