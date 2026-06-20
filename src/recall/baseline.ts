/**
 * Baseline recall: keyword-overlap + recency + type priority, assembled under a
 * token budget with explicit triage.
 *
 * Ranking per item: relevance = |query ∩ item| / |query|, nudged by confidence
 * and recency. Vanilla cosine top-k is explicitly discouraged by the spec, so
 * even the baseline blends lexical overlap with structural priority and a
 * budget-aware assembler — the cheap, deterministic floor the branches beat.
 *
 * Priority under a tight budget (the design decision the spec asks us to defend):
 * stable user facts first, then query-relevant memories, then recent snippets.
 * Stable facts are low-volume, high-value, and frequently the thing a follow-up
 * depends on; recent chatter is the most recoverable if cut. We surface ALL
 * stable facts (budget permitting) rather than filtering by the query, which is
 * what makes multi-hop ("city of the user with the dog named Biscuit") work
 * without an explicit graph.
 */

import type { Citation } from "../models";
import type { MemoryRow, Store } from "../store";
import { overlap, tokenSet } from "../text";
import { estimateTokens } from "../tokens";
import type { RecallArgs, RecallResult, Recaller } from "./types";

const STABLE_TYPES = new Set(["fact", "preference"]);
const HEADER_FACTS = "## Known facts about this user";
const HEADER_RECENT = "## Relevant from recent conversations";

const dateOf = (ts: string | null): string => (ts ?? "").slice(0, 10);

export class BaselineRecaller implements Recaller {
  name = "baseline";

  constructor(private store: Store) {}

  recall({ query, userId, sessionId, maxTokens }: RecallArgs): RecallResult {
    const qset = tokenSet(query);
    const budget = Math.max(0, maxTokens);

    const memories = userId ? this.store.listMemories(userId, true) : [];
    const stable = memories.filter((m) => STABLE_TYPES.has(m.type));
    const episodic = memories.filter((m) => !STABLE_TYPES.has(m.type));

    // Stable facts: relevance-first, then confidence, then recency.
    stable.sort((a, b) => {
      const ra = overlap(qset, `${a.key} ${a.value}`);
      const rb = overlap(qset, `${b.key} ${b.value}`);
      if (rb !== ra) return rb - ra;
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return b.updated_at.localeCompare(a.updated_at);
    });

    const turns = this.store.recentTurns({ sessionId, userId, limit: 50 });
    const scoredTurns = turns
      .map((t) => ({ score: overlap(qset, t.text), t }))
      .sort((a, b) => b.score - a.score);
    const scoredEpisodic = episodic
      .map((m) => ({ score: overlap(qset, `${m.key} ${m.value}`), m }))
      .sort((a, b) => b.score - a.score);

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

    // 1) Stable facts (always-on profile context).
    const factLines: Array<{ line: string; m: MemoryRow }> = stable.map((m) => {
      const prior = this.store.supersededValues(userId, m.key);
      let note = ` (updated ${dateOf(m.updated_at)}`;
      if (prior.length > 0) note += `; previously ${prior[0]}`;
      note += ")";
      return { line: `- ${m.value}${note}`, m };
    });

    if (factLines.length > 0 && fits(`${HEADER_FACTS}\n`)) {
      let headerEmitted = false;
      for (const { line, m } of factLines) {
        if (!headerEmitted) {
          if (!emit(HEADER_FACTS)) break;
          headerEmitted = true;
        }
        if (emit(line)) {
          citations.push({
            turn_id: m.source_turn ?? "",
            score: Math.round(m.confidence * 10000) / 10000,
            snippet: m.value,
          });
        }
      }
    }

    // 2) Query-relevant episodic memories + recent conversation snippets.
    const recent: Array<{ score: number; line: string; cit: Citation }> = [];
    for (const { score, m } of scoredEpisodic) {
      if (score <= 0) continue;
      const line = `- [${dateOf(m.updated_at)}] ${m.value}`;
      recent.push({
        score,
        line,
        cit: { turn_id: m.source_turn ?? "", score: round4(score), snippet: m.value },
      });
    }
    for (const { score, t } of scoredTurns) {
      if (score <= 0) continue;
      let snippet = t.text.replace(/\n/g, " ");
      if (snippet.length > 240) snippet = `${snippet.slice(0, 240)}…`;
      const line = `- [${dateOf(t.timestamp)}] ${snippet}`;
      recent.push({ score, line, cit: { turn_id: t.id, score: round4(score), snippet } });
    }
    recent.sort((a, b) => b.score - a.score);

    if (recent.length > 0 && fits(`${HEADER_RECENT}\n`)) {
      let headerEmitted = false;
      for (const { line, cit } of recent) {
        if (!headerEmitted) {
          if (!emit(HEADER_RECENT)) break;
          headerEmitted = true;
        }
        if (emit(line)) citations.push(cit);
      }
    }

    return { context: lines.join("\n").trim(), citations };
  }
}

const round4 = (x: number): number => Math.round(x * 10000) / 10000;
