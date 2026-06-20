/**
 * Recall: a clear hybrid (semantic + keyword), simply fused, then a
 * budget-bounded assembler that mirrors the baseline's prose format.
 *
 * One read of this file should explain the whole ranking story:
 *
 *  1. Score every active memory by  score = α·semantic + (1-α)·keyword.
 *     - semantic  = cosine similarity (pglite vector) — handles paraphrase.
 *     - keyword   = |q ∩ text| / |q| — rescues exact-token queries that
 *                   embeddings fumble ("what's the dog's name?").
 *     Fixed-weight fusion (α = 0.6) beats either signal alone and is trivial to
 *     reason about — no learned reranker, no RRF tuning. That is the point.
 *
 *  2. Assemble under the token budget with EXPLICIT triage priority:
 *       (a) stable user facts  — low-volume, high-value, the thing a follow-up
 *           usually depends on. We surface ALL of them (budget permitting),
 *           query-relevant first. Surfacing every stable fact is what makes
 *           multi-hop work ("city of the user with the dog Biscuit") without a
 *           graph: both facts are simply present.
 *       (b) query-relevant opinions/events + recent conversation snippets —
 *           ranked by the fused score, only included if they clear a relevance
 *           floor (keeps cold/off-topic queries empty -> noise resistance).
 *     Recent chatter is cut first because it is the most recoverable.
 *
 *  3. (Optional) LLM compaction: if the assembled context still overflows the
 *     budget, ask the provider to compress. Disable with MEMORY_COMPACTION=off
 *     for a fully deterministic, traceable path. The deterministic assembler
 *     already respects the budget, so compaction is a quality nicety, not a
 *     correctness crutch.
 */

import type { Citation } from "./models";
import type { Provider } from "./provider";
import type { MemoryRow, ScoredMemory, Store } from "./store";
import { keywordOverlap, tokenSet } from "./text";
import { estimateTokens } from "./tokens";

const ALPHA = 0.6; // weight on the semantic signal in the fused score.
const RELEVANCE_FLOOR = 0.12; // fused-score gate for episodic/recent items (noise resistance).
const STABLE_TYPES = new Set(["fact", "preference"]);
const HEADER_FACTS = "## Known facts about this user";
const HEADER_RECENT = "## Relevant from recent conversations";

const dateOf = (ts: string | null): string => (ts ?? "").slice(0, 10);
const round4 = (x: number): number => Math.round(x * 10000) / 10000;

export interface RecallArgs {
  query: string;
  userId: string | null;
  sessionId: string | null;
  maxTokens: number;
}

export interface RecallResult {
  context: string;
  citations: Citation[];
}

export class Recaller {
  constructor(
    private store: Store,
    private provider: Provider,
    private compactionEnabled: boolean,
  ) {}

  async recall({ query, userId, sessionId, maxTokens }: RecallArgs): Promise<RecallResult> {
    const budget = Math.max(0, maxTokens);
    const qset = tokenSet(query);
    const kw = (text: string): number => keywordOverlap(qset, text);

    // Semantic scores for all active memories (one embed + one SQL round-trip).
    const queryEmbedding = await this.provider.embed(query, "embed_query");
    const scored: ScoredMemory[] = userId
      ? await this.store.semanticMemories(userId, queryEmbedding)
      : [];

    // Fuse semantic + keyword into a single score per memory.
    const fused = scored.map((m) => ({
      m,
      score: ALPHA * m.semantic + (1 - ALPHA) * kw(`${m.key} ${m.value}`),
    }));

    const stable = fused.filter((x) => STABLE_TYPES.has(x.m.type));
    const episodic = fused.filter((x) => !STABLE_TYPES.has(x.m.type));

    // Stable facts: most query-relevant first, then confidence, then recency.
    stable.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.m.confidence !== a.m.confidence) return b.m.confidence - a.m.confidence;
      return b.m.updated_at.localeCompare(a.m.updated_at);
    });

    // Recent conversation turns, scored the same way (semantic + keyword).
    const turns = await this.store.recentTurns({ sessionId, userId, limit: 50 });
    const turnEmbeds = await this.provider.embedBatch(
      turns.map((t) => t.text),
      "embed_recent_turns",
    );
    const scoredTurns = turns
      .map((t, i) => {
        const semantic = cosine(queryEmbedding, turnEmbeds[i]);
        return { t, score: ALPHA * semantic + (1 - ALPHA) * kw(t.text) };
      })
      .sort((a, b) => b.score - a.score);

    // --- Budget-bounded assembly with explicit triage. ---
    const lines: string[] = [];
    const citations: Citation[] = [];
    let used = 0;
    const fits = (extra: string): boolean => used + estimateTokens(`${extra}\n`) <= budget;
    const emit = (line: string): boolean => {
      if (!fits(line)) return false;
      lines.push(line);
      used += estimateTokens(`${line}\n`);
      return true;
    };

    // (a) Stable facts — always-on profile context.
    if (stable.length > 0 && fits(HEADER_FACTS)) {
      let headerEmitted = false;
      for (const { m } of stable) {
        const note = await this.factNote(userId, m);
        const line = `- ${m.value}${note}`;
        if (!headerEmitted) {
          if (!emit(HEADER_FACTS)) break;
          headerEmitted = true;
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

    // (b) Query-relevant opinions/events + recent snippets, above the floor.
    const recent: Array<{ score: number; line: string; cit: Citation }> = [];
    for (const { m, score } of episodic) {
      if (score < RELEVANCE_FLOOR) continue;
      const line = `- [${dateOf(m.updated_at)}] ${m.value}`;
      recent.push({
        score,
        line,
        cit: { turn_id: m.source_turn ?? "", score: round4(score), snippet: m.value },
      });
    }
    for (const { t, score } of scoredTurns) {
      if (score < RELEVANCE_FLOOR) continue;
      let snippet = t.text.replace(/\s+/g, " ").trim();
      if (snippet.length > 240) snippet = `${snippet.slice(0, 240)}…`;
      recent.push({
        score,
        line: `- [${dateOf(t.timestamp)}] ${snippet}`,
        cit: { turn_id: t.id, score: round4(score), snippet },
      });
    }
    recent.sort((a, b) => b.score - a.score);

    if (recent.length > 0 && fits(HEADER_RECENT)) {
      let headerEmitted = false;
      for (const { line, cit } of recent) {
        if (!headerEmitted) {
          if (!emit(HEADER_RECENT)) break;
          headerEmitted = true;
        }
        if (emit(line)) citations.push(cit);
      }
    }

    let context = lines.join("\n").trim();

    // (c) Optional LLM compaction if we somehow still overflow (e.g. very long
    // fact values). Cheap insurance, fully skippable.
    if (this.compactionEnabled && estimateTokens(context) > budget && context) {
      try {
        const compacted = await this.provider.compact(context, query, budget);
        if (compacted.trim()) context = compacted.trim();
      } catch {
        // Compaction is best-effort; the deterministic context already fits-ish.
      }
    }

    return { context, citations };
  }

  /** "(updated 2025-03-15; previously Stripe; before that Acme)" — the full
   *  supersession breadcrumb. Keeping ALL priors (not just the most recent) lets
   *  recall answer "what were the earlier values" on an A->B->C history. */
  private async factNote(userId: string | null, m: MemoryRow): Promise<string> {
    let note = ` (updated ${dateOf(m.updated_at)}`;
    const prior = await this.store.supersededValues(userId, m.key);
    if (prior.length > 0) note += `; previously ${prior.join("; before that ")}`;
    note += ")";
    return note;
  }
}

/** Cosine similarity for two equal-length vectors (turn scoring path). */
function cosine(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}
