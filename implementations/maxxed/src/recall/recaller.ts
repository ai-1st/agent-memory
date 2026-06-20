/**
 * The /recall pipeline — the primary scored signal.
 *
 * End to end:
 *   1. QUERY REWRITE/EXPANSION (LLM): synonyms + multi-hop sub-questions + the
 *      entities the query names.
 *   2. HYBRID RETRIEVAL: dense vector kNN + lexical FTS over memories AND turns,
 *      run for the query and each expansion, fused with Reciprocal Rank Fusion.
 *   3. GRAPH EXPANSION: one-hop over the entity-link graph from the top fused
 *      memories, plus direct entity-match seeding — this is what makes multi-hop
 *      ("city of the user whose dog is Biscuit") resolve without naive top-k.
 *   4. LLM RERANK of the fused+expanded candidate set.
 *   5. TEMPORAL "as of" filtering + recency weighting.
 *   6. BUDGET-AWARE TIERED ASSEMBLY: stable facts -> query-relevant -> recent,
 *      rank-then-truncate, with LLM compaction if the assembled context is still
 *      over budget.
 *
 * Stable user facts are surfaced even when only loosely query-relevant, because
 * they are low-volume, high-value, and frequently the thing a follow-up depends
 * on (and they make multi-hop work). Recent chatter is cut first — it is the
 * most recoverable.
 */

import type { LlmClient } from "../llm/types";
import type { Citation } from "../models";
import type { Store } from "../store";
import type { MemoryRow, TurnRecord } from "../store/types";
import { dateOf } from "../util/ids";
import { round4, snippet, tokenize } from "../util/text";
import { estimateTokens } from "../util/tokens";
import { rrf } from "./fusion";
import {
  COMPACT_SYSTEM,
  type QueryRewrite,
  RERANK_SYSTEM,
  REWRITE_SYSTEM,
  buildCompactPrompt,
  buildRerankPrompt,
  buildRewritePrompt,
  compactSchema,
  queryRewriteSchema,
  rerankSchema,
} from "./schemas";
import type { RecallArgs, RecallResult, Recaller } from "./types";

const STABLE_TYPES = new Set(["fact", "preference"]);
const HEADER_FACTS = "## Known facts about this user";
const HEADER_RELEVANT = "## Relevant memories";
const HEADER_RECENT = "## Relevant from recent conversations";
const RETRIEVE_K = 20;
// Minimum rerank relevance for a memory to count as "the query is on-topic".
const RELEVANCE_FLOOR = 0.15;

// Maps query-intent words to the vocabulary memories use, so "where do they
// live" matches a "location" slot even with no shared surface tokens. This is a
// small deterministic safety net under the LLM rerank — not a replacement for it.
const INTENT_SYNONYMS: Record<string, string[]> = {
  live: ["location", "lives", "city", "based"],
  living: ["location", "city"],
  city: ["location"],
  located: ["location"],
  work: ["employment", "job", "company", "employer"],
  works: ["employment", "job", "employer"],
  job: ["employment", "employer", "company"],
  employer: ["employment", "company"],
  company: ["employment"],
  dog: ["pet"],
  cat: ["pet"],
  pet: ["pet", "dog", "cat"],
  eat: ["diet", "vegetarian", "vegan"],
  diet: ["vegetarian", "vegan", "pescatarian"],
  dietary: ["diet", "vegetarian", "vegan", "pescatarian"],
  restrictions: ["diet", "allergy", "allergic", "vegetarian"],
  restriction: ["diet", "allergy", "allergic"],
  allergic: ["allergy"],
  allergy: ["allergic"],
  allergies: ["allergy", "allergic"],
  hobby: ["hobbies", "enjoys", "hiking", "running"],
  hobbies: ["enjoys"],
  name: ["name"],
  partner: ["family", "wife", "husband"],
  family: ["wife", "husband", "son", "daughter"],
};

function expandIntent(tokens: Set<string>): Set<string> {
  const out = new Set(tokens);
  for (const t of tokens) {
    for (const syn of INTENT_SYNONYMS[t] ?? []) out.add(syn);
  }
  return out;
}

interface MemCandidate {
  row: MemoryRow;
  fused: number;
  sources: string[];
  rerank?: number;
}

interface TurnCandidate {
  turn: TurnRecord;
  score: number;
  sources: string[];
  lexical: boolean;
}

export class HybridRecaller implements Recaller {
  name = "hybrid-graph-rerank";

  constructor(
    private store: Store,
    private llm: LlmClient,
  ) {}

  async recall(args: RecallArgs): Promise<RecallResult> {
    const { query, userId, sessionId, maxTokens } = args;
    const asOf = args.asOf ?? null;
    const budget = Math.max(0, maxTokens);
    if (!userId && !sessionId) return { context: "", citations: [] };

    // 1) Query rewrite / expansion.
    const rewrite = await this.rewrite(query);
    const queries = unique([query, ...rewrite.expanded]).slice(0, 4);

    // 2) Hybrid retrieval (dense + lexical) for memories and turns, over all
    //    query variants, fused with RRF.
    const memCandidates = await this.retrieveMemories(queries, userId);
    const turnCandidates = await this.retrieveTurns(queries, userId, sessionId);

    // 3) Graph expansion: seed from query entities + one-hop from top memories.
    const expanded = await this.graphExpand(memCandidates, rewrite, userId);

    // 4) LLM rerank of the fused+expanded memory candidates.
    const ranked = await this.rerank(query, expanded);

    // 5) Temporal "as of": drop memories whose valid_from is after as_of, and
    //    re-activate the version valid at that time for mutable slots.
    const temporal = applyAsOf(ranked, asOf);

    // Noise resistance / abstention: if NOTHING is genuinely relevant we return
    // empty rather than dumping the profile. This is the deliberate gate that
    // lets the always-on core coexist with abstention — the core is surfaced
    // only when the query actually relates to the user. "Relevant" is a UNION of
    // signals so the gate is robust to any single retriever's blind spot:
    //   - a reranked memory above the floor,
    //   - an entity seed (query named a known entity),
    //   - a fused dense+lexical hit above the floor,
    //   - lexical overlap between the query and a memory/turn (intent match),
    //   - a matching turn.
    if (!this.hasRelevance(query, temporal, turnCandidates)) {
      return { context: "", citations: [] };
    }

    // 6) Budget-aware tiered assembly.
    return this.assemble(temporal, turnCandidates, { userId, budget, query, asOf });
  }

  /**
   * Robust abstention gate. Combines retrieval signals (rerank, fused, entity)
   * with intent/lexical overlap so a single retriever's blind spot can't cause a
   * false "empty", while a genuinely off-topic query still abstains.
   */
  private hasRelevance(query: string, memories: MemCandidate[], turns: TurnCandidate[]): boolean {
    // The reranker is the trusted precision signal for "is this on-topic". Raw
    // dense/fused scores are deliberately NOT used here — vector similarity alone
    // is too noisy to defeat abstention (it gives a small score to almost
    // everything), which is exactly the noise-resistance failure mode we guard.
    if (memories.some((c) => (c.rerank ?? 0) >= RELEVANCE_FLOOR)) return true;
    // The query explicitly names a known entity (e.g. "Biscuit") -> on-topic.
    if (memories.some((c) => c.sources.includes("entity"))) return true;
    // A *lexical* (FTS) turn hit -> on-topic. Dense turn hits don't count.
    if (turns.some((t) => t.lexical && t.score > 0)) return true;

    // Intent / lexical overlap: does the query share meaning with any memory?
    // (Safety net under the reranker for terse queries like "where do they live".)
    const qexpanded = expandIntent(new Set(tokenize(query)));
    for (const c of memories) {
      const mtok = new Set([...tokenize(`${c.row.key} ${c.row.value}`), ...c.row.entities]);
      for (const t of qexpanded) if (mtok.has(t)) return true;
    }
    return false;
  }

  // --- step 1 ---------------------------------------------------------------

  private async rewrite(query: string): Promise<QueryRewrite> {
    try {
      const r = await this.llm.generateObject({
        schema: queryRewriteSchema,
        system: REWRITE_SYSTEM,
        prompt: buildRewritePrompt(query),
        purpose: "query_rewrite",
      });
      return {
        expanded: r.expanded ?? [],
        entities: (r.entities ?? []).map((e) => e.toLowerCase()),
      };
    } catch {
      return { expanded: [], entities: tokenize(query) };
    }
  }

  // --- step 2 ---------------------------------------------------------------

  private async retrieveMemories(
    queries: string[],
    userId: string | null,
  ): Promise<MemCandidate[]> {
    const lists: Array<{ name: string; ranked: Array<{ id: string; item: MemoryRow }> }> = [];
    const embeds = await this.embedQueries(queries);
    for (let i = 0; i < queries.length; i++) {
      const q = queries[i];
      const lex = await this.store.lexicalMemories(q, { userId, limit: RETRIEVE_K });
      lists.push({
        name: `lex:${i}`,
        ranked: lex.map((h) => ({ id: h.row.id, item: h.row })),
      });
      const emb = embeds[i];
      if (emb) {
        const vecHits = await this.store.vectorMemories(emb, { userId, limit: RETRIEVE_K });
        lists.push({
          name: `vec:${i}`,
          ranked: vecHits.map((h) => ({ id: h.row.id, item: h.row })),
        });
      }
    }
    const fused = rrf(lists);
    return fused.map((f) => ({ row: f.item, fused: f.score, sources: f.sources }));
  }

  private async retrieveTurns(
    queries: string[],
    userId: string | null,
    sessionId: string | null,
  ): Promise<TurnCandidate[]> {
    const lists: Array<{ name: string; ranked: Array<{ id: string; item: TurnRecord }> }> = [];
    const embeds = await this.embedQueries(queries);
    const lexicalIds = new Set<string>();
    for (let i = 0; i < queries.length; i++) {
      const q = queries[i];
      const lex = await this.store.lexicalTurns(q, { sessionId, userId, limit: RETRIEVE_K });
      for (const h of lex) lexicalIds.add(h.turn.id);
      lists.push({ name: `lex:${i}`, ranked: lex.map((h) => ({ id: h.turn.id, item: h.turn })) });
      const emb = embeds[i];
      if (emb) {
        const v = await this.store.vectorTurns(emb, { sessionId, userId, limit: RETRIEVE_K });
        lists.push({ name: `vec:${i}`, ranked: v.map((h) => ({ id: h.turn.id, item: h.turn })) });
      }
    }
    const fused = rrf(lists);
    return fused.map((f) => ({
      turn: f.item,
      score: f.score,
      sources: f.sources,
      // A turn is "lexically relevant" only if FTS matched it — dense similarity
      // alone is too noisy to drive abstention or the recent-snippets tier.
      lexical: lexicalIds.has(f.id),
    }));
  }

  private async embedQueries(queries: string[]): Promise<Array<number[] | null>> {
    try {
      return await this.llm.embedMany(queries, "embed_query");
    } catch {
      return queries.map(() => null);
    }
  }

  // --- step 3 ---------------------------------------------------------------

  private async graphExpand(
    candidates: MemCandidate[],
    rewrite: QueryRewrite,
    userId: string | null,
  ): Promise<MemCandidate[]> {
    const byId = new Map<string, MemCandidate>();
    for (const c of candidates) byId.set(c.row.id, c);

    // Seed from query entities (direct entity match) — this connects the query
    // term "Biscuit" to the pet memory even if the question is about a city.
    if (rewrite.entities.length > 0) {
      const seeds = await this.store.memoriesByEntities(userId, rewrite.entities);
      for (const row of seeds) {
        if (!byId.has(row.id)) {
          byId.set(row.id, { row, fused: 0.01, sources: ["entity"] });
        }
      }
    }

    // One-hop expansion from the top fused memories.
    const topIds = candidates.slice(0, 6).map((c) => c.row.id);
    const seedIds = [
      ...new Set([...topIds, ...[...byId.values()].slice(0, 8).map((c) => c.row.id)]),
    ];
    const neighbours = await this.store.neighbours(seedIds);
    for (const n of neighbours) {
      const cur = byId.get(n.row.id);
      if (cur) {
        cur.fused += 0.02 * n.weight;
        if (!cur.sources.includes("graph")) cur.sources.push("graph");
      } else {
        byId.set(n.row.id, { row: n.row, fused: 0.015 * n.weight, sources: ["graph"] });
      }
    }
    return [...byId.values()].sort((a, b) => b.fused - a.fused);
  }

  // --- step 4 ---------------------------------------------------------------

  private async rerank(query: string, candidates: MemCandidate[]): Promise<MemCandidate[]> {
    const head = candidates.slice(0, RETRIEVE_K);
    if (head.length === 0) return head;
    try {
      const res = await this.llm.generateObject({
        schema: rerankSchema,
        system: RERANK_SYSTEM,
        prompt: buildRerankPrompt({
          query,
          candidates: head.map((c) => ({ id: c.row.id, text: `${c.row.key}: ${c.row.value}` })),
        }),
        purpose: "rerank",
      });
      const scoreById = new Map(res.ranking.map((r) => [r.id, r.relevance]));
      for (const c of head) c.rerank = scoreById.get(c.row.id) ?? 0;
      // Blend rerank with fused signal so a strong retriever isn't fully overridden.
      head.sort((a, b) => combined(b) - combined(a));
      return head;
    } catch {
      return head;
    }
  }

  // --- step 6 ---------------------------------------------------------------

  private async assemble(
    ranked: MemCandidate[],
    turns: TurnCandidate[],
    opts: { userId: string | null; budget: number; query: string; asOf: string | null },
  ): Promise<RecallResult> {
    const { userId, budget, query, asOf } = opts;
    const qexpanded = expandIntent(new Set(tokenize(query)));
    const lexRel = (m: MemoryRow): number => {
      const mtok = new Set([...tokenize(`${m.key} ${m.value}`), ...m.entities]);
      let hit = 0;
      for (const t of qexpanded) if (mtok.has(t)) hit++;
      return qexpanded.size ? hit / qexpanded.size : 0;
    };

    // Tier A: stable user facts (always-on profile). Surfaced regardless of
    // direct query relevance, ordered by combined relevance (rerank blended with
    // intent/lexical overlap) then importance then recency — so the fact the
    // query is about floats to the top of the profile block. When `as_of` is set
    // we use the point-in-time view so the profile reflects what was true then.
    const allActive = userId
      ? asOf
        ? await this.store.memoriesAsOf(userId, asOf)
        : await this.store.listMemories(userId, true)
      : [];
    const rankedIds = new Map(ranked.map((c) => [c.row.id, c]));
    const stable = allActive
      .filter((m) => STABLE_TYPES.has(m.type))
      .map((m) => ({ m, rel: rankedIds.get(m.id) }))
      .sort((a, b) => {
        const ra = Math.max(a.rel ? combined(a.rel) : 0, lexRel(a.m));
        const rb = Math.max(b.rel ? combined(b.rel) : 0, lexRel(b.m));
        if (rb !== ra) return rb - ra;
        if (b.m.importance !== a.m.importance) return b.m.importance - a.m.importance;
        return b.m.updated_at.localeCompare(a.m.updated_at);
      });

    // Tier B: query-relevant memories not already in the stable tier.
    const stableIds = new Set(stable.map((s) => s.m.id));
    const relevant = ranked.filter((c) => !stableIds.has(c.row.id) && (c.rerank ?? c.fused) > 0);

    const lines: string[] = [];
    const citations: Citation[] = [];
    let used = 0;
    const fits = (extra: string): boolean => used + estimateTokens(extra) <= budget;
    const emit = (line: string): boolean => {
      if (!fits(`${line}\n`)) return false;
      lines.push(line);
      used += estimateTokens(`${line}\n`);
      return true;
    };

    // Tier A render.
    if (stable.length > 0 && fits(`${HEADER_FACTS}\n`)) {
      let header = false;
      for (const { m } of stable) {
        const prior = await this.store.supersededValues(userId, m.key);
        let note = ` (updated ${dateOf(m.updated_at)}`;
        if (prior.length > 0) note += `; previously ${prior[0]}`;
        note += ")";
        const line = `- ${m.value}${note}`;
        if (!header) {
          if (!emit(HEADER_FACTS)) break;
          header = true;
        }
        if (emit(line)) {
          citations.push({
            turn_id: m.source_turn ?? "",
            score: round4(m.confidence),
            snippet: m.value,
          });
        }
      }
    }

    // Tier B render.
    if (relevant.length > 0 && fits(`${HEADER_RELEVANT}\n`)) {
      let header = false;
      for (const c of relevant) {
        const line = `- [${dateOf(c.row.updated_at)}] ${c.row.value}`;
        if (!header) {
          if (!emit(HEADER_RELEVANT)) break;
          header = true;
        }
        if (emit(line)) {
          citations.push({
            turn_id: c.row.source_turn ?? "",
            score: round4(c.rerank ?? c.fused),
            snippet: c.row.value,
          });
        }
      }
    }

    // Tier C: recent / relevant raw conversation snippets (most recoverable; cut
    // first). Under `as_of`, drop turns observed after the cutoff so the recent
    // block stays time-correct too.
    const relevantTurns = turns
      .filter((t) => t.lexical && t.score > 0)
      .filter((t) => !asOf || !t.turn.timestamp || t.turn.timestamp <= asOf)
      .slice(0, 8);
    if (relevantTurns.length > 0 && fits(`${HEADER_RECENT}\n`)) {
      let header = false;
      for (const { turn, score } of relevantTurns) {
        const snip = snippet(turn.text);
        const line = `- [${dateOf(turn.timestamp)}] ${snip}`;
        if (!header) {
          if (!emit(HEADER_RECENT)) break;
          header = true;
        }
        if (emit(line)) {
          citations.push({ turn_id: turn.id, score: round4(score), snippet: snip });
        }
      }
    }

    let context = lines.join("\n").trim();

    // If somehow over budget (long fact values), compact with the LLM.
    if (estimateTokens(context) > budget && context.length > 0) {
      context = await this.compact(context, budget);
    }
    return { context, citations };
  }

  private async compact(content: string, budget: number): Promise<string> {
    try {
      const r = await this.llm.generateObject({
        schema: compactSchema,
        system: COMPACT_SYSTEM,
        prompt: buildCompactPrompt(content, budget),
        purpose: "compact",
      });
      const out = r.text.trim();
      // Never let compaction overflow; hard-trim as a final guard.
      return estimateTokens(out) <= budget * 1.1 ? out : hardTrim(out, budget);
    } catch {
      return hardTrim(content, budget);
    }
  }
}

function combined(c: MemCandidate): number {
  // Blend LLM rerank (precision) with RRF fused rank (recall robustness).
  const r = c.rerank ?? 0;
  return 0.7 * r + 0.3 * Math.min(1, c.fused * 20);
}

function unique(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const t = x.trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
}

/** Temporal "as of": keep only memories observed at or before as_of. */
function applyAsOf(candidates: MemCandidate[], asOf: string | null): MemCandidate[] {
  if (!asOf) return candidates;
  return candidates.filter((c) => {
    const vf = c.row.valid_from;
    return !vf || vf <= asOf;
  });
}

function hardTrim(text: string, budget: number): string {
  const maxChars = budget * 4;
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastNl = cut.lastIndexOf("\n");
  return (lastNl > 0 ? cut.slice(0, lastNl) : cut).trim();
}
