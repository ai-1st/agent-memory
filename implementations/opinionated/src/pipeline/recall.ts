/**
 * Recall pipeline (POST /recall) — LLM as reranker + compaction agent.
 *
 *   1. Gather candidates: semantic neighbours of the query (active memories) +
 *      ALL stable active facts (so multi-hop questions work) + recent turn
 *      snippets for the session/user.
 *   2. ALWAYS follow contradiction links: for any candidate fact that has a
 *      contradiction link, pull the contradicting fact(s) (full chain) so the
 *      model can narrate the tension.
 *   3. Optionally broaden: if the model asks (want_session_facts) or the query
 *      is session-scoped, include the session's fact set.
 *   4. The LLM reranks + compacts into budgeted prose and selects which
 *      candidates it used; we map those to citations against the RAW turns.
 *
 * Priority under tight budget (defended in README): stable facts the query
 * depends on first, then query-relevant memories, then recent context. The
 * model is instructed to drop least-useful first and stay within budget.
 */

import type { LLMProvider } from "../llm/provider";
import { errStr } from "../logging";
import type { Citation } from "../models";
import type { MemoryRow, Store } from "../store";
import { estimateTokens } from "../tokens";
import { RECALL_SYSTEM, recallPrompt } from "./prompts";
import { recallPlanSchema } from "./schemas";

// Wider candidate breadth for long multi-session histories (LoCoMo): the gating
// failure is "relevant fact not retrieved", so pull more neighbours + recent
// turns. The LLM reranker still triages down to the budget, so breadth costs
// recall tokens, not answer quality.
const SEMANTIC_LIMIT = 24;
const RECENT_TURN_LIMIT = 12;
const STABLE_TYPES = new Set(["fact", "preference", "opinion"]);

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

interface Candidate {
  id: string; // candidate id exposed to the LLM (mem_* or turn_*)
  kind: "memory" | "turn";
  content: string; // line shown to the LLM
  turnId: string; // source turn for citation
  score: number; // ranking score for citation
  snippet: string; // citation snippet
  date: string;
}

const dateOf = (ts: string | null): string => (ts ?? "").slice(0, 10);

export class RecallPipeline {
  constructor(
    private llm: LLMProvider,
    private store: Store,
  ) {}

  async run({ query, userId, sessionId, maxTokens }: RecallArgs): Promise<RecallResult> {
    const budget = Math.max(0, maxTokens);

    // --- gather memory candidates ---
    const byId = new Map<string, MemoryRow>();
    const simScore = new Map<string, number>();

    if (query.trim()) {
      try {
        const [qEmb] = await this.llm.embed([query], "embed_query");
        if (qEmb) {
          const sims = await this.store.similarMemories({
            userId,
            embedding: qEmb,
            limit: SEMANTIC_LIMIT,
          });
          for (const m of sims) {
            if (!m) continue;
            byId.set(m.id, m);
            simScore.set(m.id, m.similarity);
          }
        }
      } catch (err) {
        // Embedding/search is best-effort: a transient model error must not 500
        // recall. We still proceed with stable facts + recent turns below.
        console.warn(`recall semantic search failed, continuing with facts/turns: ${errStr(err)}`);
      }
    }

    // Always include stable active facts (multi-hop + always-on profile).
    const allActive = userId ? await this.store.listMemories(userId, true) : [];
    for (const m of allActive) {
      if (STABLE_TYPES.has(m.type) && !byId.has(m.id)) byId.set(m.id, m);
    }

    // Follow contradiction links over everything we have so far.
    const linked = await this.store.expandLinks([...byId.keys()]);
    for (const m of linked) {
      if (!m) continue;
      byId.set(m.id, m);
    }

    // For each memory, capture its contradiction partner(s) WITH the link note
    // (the reconcile `reason`), so recall can narrate *why* two facts conflict,
    // not just that they do.
    const contradictions = new Map<string, Array<{ value: string; note: string }>>();
    for (const id of byId.keys()) {
      const links = await this.store.linksOf(id);
      for (const l of links) {
        if (l.kind !== "contradiction") continue;
        const partner = byId.get(l.id);
        if (!partner || typeof partner.value !== "string") continue;
        const arr = contradictions.get(id) ?? [];
        arr.push({ value: partner.value, note: l.note ?? "" });
        contradictions.set(id, arr);
      }
    }

    // --- candidate lines for memories ---
    const candidates: Candidate[] = [];
    for (const m of byId.values()) {
      // Defensive: a malformed/undefined candidate (e.g. a row that lost its
      // value, or an undefined slipped in from a link/rerank lookup) must never
      // crash recall. Skip it rather than read `.value` off undefined.
      if (!m || typeof m.value !== "string") continue;
      const prior = m.supersedes ? await this.priorValue(m.supersedes) : null;
      const sim = simScore.get(m.id);
      let line = `[${m.type}]`;
      if (sim !== undefined) line += ` [sim=${sim.toFixed(2)}]`;
      line += ` ${m.value}`;
      if (prior) line += ` (current; previously: ${prior})`;
      const conflicts = contradictions.get(m.id);
      if (conflicts && conflicts.length > 0) {
        const parts = conflicts.map((c) => (c.note ? `"${c.value}" — ${c.note}` : `"${c.value}"`));
        line += ` [CONTRADICTS ${parts.join("; ")}]`;
      }
      candidates.push({
        id: m.id,
        kind: "memory",
        content: line,
        turnId: m.source_turn ?? "",
        score: round4(simScore.get(m.id) ?? m.confidence),
        snippet: m.value,
        date: dateOf(m.updated_at),
      });
    }

    // --- recent raw-turn snippets (episodic context) ---
    const turns = await this.store.recentTurns({ sessionId, userId, limit: RECENT_TURN_LIMIT });
    for (const t of turns) {
      let snippet = t.text.replace(/\n/g, " ");
      if (snippet.length > 220) snippet = `${snippet.slice(0, 220)}…`;
      candidates.push({
        id: t.id,
        kind: "turn",
        content: `[${dateOf(t.timestamp)}] ${snippet}`,
        turnId: t.id,
        score: 0.3,
        snippet,
        date: dateOf(t.timestamp),
      });
    }

    if (candidates.length === 0) return { context: "", citations: [] };

    // --- LLM rerank + compaction ---
    const candidateBlock = candidates.map((c) => `${c.id} :: ${c.content}`).join("\n");

    let plan: { selected_ids: string[]; want_session_facts: boolean; context: string };
    try {
      plan = await this.llm.generate({
        schema: recallPlanSchema,
        system: RECALL_SYSTEM,
        prompt: recallPrompt({ query, budgetTokens: budget, candidates: candidateBlock }),
        task: "recall",
      });
    } catch (err) {
      // Degrade gracefully: deterministic assembly if the LLM call fails.
      console.warn(`recall LLM failed, falling back to deterministic assembly: ${errStr(err)}`);
      return this.fallback(candidates, budget);
    }

    // Optional broaden: pull the whole session's facts and re-run once.
    if (plan.want_session_facts && sessionId) {
      const extra = await this.store.sessionMemories(sessionId);
      let added = false;
      for (const m of extra) {
        if (!m || typeof m.value !== "string") continue;
        if (!byId.has(m.id)) {
          byId.set(m.id, m);
          added = true;
          candidates.push({
            id: m.id,
            kind: "memory",
            content: `[${m.type}] ${m.value}`,
            turnId: m.source_turn ?? "",
            score: round4(m.confidence),
            snippet: m.value,
            date: dateOf(m.updated_at),
          });
        }
      }
      if (added) {
        const block2 = candidates.map((c) => `${c.id} :: ${c.content}`).join("\n");
        try {
          plan = await this.llm.generate({
            schema: recallPlanSchema,
            system: RECALL_SYSTEM,
            prompt: recallPrompt({ query, budgetTokens: budget, candidates: block2 }),
            task: "recall",
          });
        } catch {
          /* keep first plan */
        }
      }
    }

    let context = (plan.context ?? "").trim();
    // Hard budget guard: never blow past 2x. Trim by lines if needed.
    context = enforceBudget(context, budget);

    const selected = new Set(plan.selected_ids);
    const citations: Citation[] = [];
    const seen = new Set<string>();
    for (const c of candidates) {
      if (!selected.has(c.id)) continue;
      const turnId = c.turnId || c.id;
      if (!turnId || seen.has(turnId)) continue;
      seen.add(turnId);
      citations.push({ turn_id: turnId, score: c.score, snippet: c.snippet });
    }

    if (!context) return { context: "", citations: [] };
    return { context, citations };
  }

  private async priorValue(supersededId: string): Promise<string | null> {
    const row = await this.store.getMemory(supersededId);
    return row ? row.value : null;
  }

  /** Deterministic fallback so /recall never fails when the LLM is unavailable. */
  private fallback(candidates: Candidate[], budget: number): RecallResult {
    const mems = candidates.filter((c) => c.kind === "memory");
    const turns = candidates.filter((c) => c.kind === "turn");
    const lines: string[] = [];
    const citations: Citation[] = [];
    let used = 0;
    const emit = (line: string): boolean => {
      const cost = estimateTokens(`${line}\n`);
      if (used + cost > budget) return false;
      lines.push(line);
      used += cost;
      return true;
    };
    if (mems.length > 0) {
      emit("## Known facts about this user");
      for (const c of mems) {
        if (emit(`- ${c.content.replace(/^\[[a-z]+\]\s*/, "")}`)) {
          citations.push({ turn_id: c.turnId || c.id, score: c.score, snippet: c.snippet });
        }
      }
    }
    if (turns.length > 0) {
      emit("## Relevant from recent conversations");
      for (const c of turns) {
        if (emit(`- ${c.content}`)) {
          citations.push({ turn_id: c.turnId || c.id, score: c.score, snippet: c.snippet });
        }
      }
    }
    return { context: lines.join("\n").trim(), citations };
  }
}

function enforceBudget(text: string, budget: number): string {
  const cap = budget * 2; // contract: don't exceed ~2x
  if (estimateTokens(text) <= cap) return text;
  const lines = text.split("\n");
  const kept: string[] = [];
  let used = 0;
  for (const l of lines) {
    const cost = estimateTokens(`${l}\n`);
    if (used + cost > cap) break;
    kept.push(l);
    used += cost;
  }
  return kept.join("\n").trim();
}

const round4 = (x: number): number => Math.round(x * 10000) / 10000;
