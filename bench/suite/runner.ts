/**
 * Suite runner: ingest a benchmark's scenarios into a running service over the
 * HTTP contract, probe /recall, judge each answer, and compute the mem0
 * three-axis card (accuracy-by-category / tokens-per-recall / p50-p95 latency).
 */

import { http, estTokens, fetchMetrics, judge, mean, pctl } from "./judge";
import type { Card, Cost, ProbeResult, Scenario, Stat } from "./types";

const stat = (xs: number[]): Stat => ({ mean: mean(xs), p50: pctl(xs, 50), p95: pctl(xs, 95) });

// Approximate USD per 1M tokens — adjust as provider pricing changes.
const PRICE = { llmIn: 15, llmOut: 75, embed: 0.13 };
const round = (n: number, d: number): number => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

export async function runScenarios(
  url: string,
  scenarios: Scenario[],
  adapter: string,
  label: string,
): Promise<Card> {
  const ingestMs: number[] = [];
  const recallMs: number[] = [];
  const ctxTokens: number[] = [];
  const results: ProbeResult[] = [];

  const m0 = await fetchMetrics(url);

  // Ingest (synchronous per contract). Reset each user first for idempotent reruns.
  for (const sc of scenarios) {
    await http("DELETE", `${url}/users/${encodeURIComponent(sc.user_id)}`);
    for (const t of sc.turns) {
      const r = await http("POST", `${url}/turns`, {
        session_id: t.session_id,
        user_id: sc.user_id,
        messages: t.messages,
        timestamp: t.timestamp ?? null,
        metadata: {},
      });
      ingestMs.push(r.ms);
    }
  }

  // Probe + judge.
  for (const sc of scenarios) {
    for (const p of sc.probes) {
      const r = await http("POST", `${url}/recall`, {
        query: p.query,
        session_id: p.session_id ?? null,
        user_id: p.user_id ?? sc.user_id,
        max_tokens: p.max_tokens ?? 1024,
      });
      const ctx: string = r.status === 200 ? (r.body?.context ?? "") : "";
      const j = await judge(p.query, p.expected ?? "", Boolean(p.abstain), ctx);
      const toks = estTokens(ctx);
      recallMs.push(r.ms);
      ctxTokens.push(toks);
      results.push({
        id: p.id,
        category: p.category,
        correct: j.correct,
        score: j.score,
        abstained: j.abstained,
        recallMs: Math.round(r.ms),
        ctxTokens: toks,
        note: j.note,
      });
    }
  }

  const m1 = await fetchMetrics(url);
  const cost: Cost = {
    llm_calls: m1.llmCalls - m0.llmCalls,
    llm_input_tokens: m1.llmIn - m0.llmIn,
    llm_output_tokens: m1.llmOut - m0.llmOut,
    embedding_calls: m1.embCalls - m0.embCalls,
    embedding_tokens: m1.embTok - m0.embTok,
    est_usd: round(
      ((m1.llmIn - m0.llmIn) / 1e6) * PRICE.llmIn +
        ((m1.llmOut - m0.llmOut) / 1e6) * PRICE.llmOut +
        ((m1.embTok - m0.embTok) / 1e6) * PRICE.embed,
      4,
    ),
  };

  const byCat: Record<string, { pass: number; total: number }> = {};
  for (const r of results) {
    if (!byCat[r.category]) byCat[r.category] = { pass: 0, total: 0 };
    const c = byCat[r.category];
    c.total++;
    if (r.correct) c.pass++;
  }
  const passed = results.filter((r) => r.correct).length;

  return {
    adapter,
    label,
    url,
    scenarios: scenarios.length,
    probes: results.length,
    accuracy: results.length ? Math.round((passed / results.length) * 1000) / 1000 : 0,
    accuracyByCategory: byCat,
    tokensPerRecall: stat(ctxTokens),
    recallLatencyMs: stat(recallMs),
    ingestLatencyMs: stat(ingestMs),
    cost,
    judgeErrors: results.filter((r) => r.note === "JUDGE_ERROR").length,
    results,
  };
}

export function printCard(card: Card): void {
  const cats = Object.keys(card.accuracyByCategory).sort();
  process.stderr.write(`\n== ${card.adapter} / ${card.label} (${card.url}) ==\n`);
  process.stderr.write(
    `accuracy: ${Math.round(card.accuracy * 100)}%  (${card.probes} probes, ${card.scenarios} scenarios)\n`,
  );
  for (const c of cats) {
    const v = card.accuracyByCategory[c];
    if (v) process.stderr.write(`  ${c}: ${v.pass}/${v.total}\n`);
  }
  process.stderr.write(
    `tokens/recall: mean ${card.tokensPerRecall.mean} (p50 ${card.tokensPerRecall.p50} / p95 ${card.tokensPerRecall.p95})\n`,
  );
  process.stderr.write(
    `recall ms: mean ${card.recallLatencyMs.mean} (p50 ${card.recallLatencyMs.p50} / p95 ${card.recallLatencyMs.p95})\n`,
  );
  process.stderr.write(
    `ingest ms: mean ${card.ingestLatencyMs.mean} (p50 ${card.ingestLatencyMs.p50} / p95 ${card.ingestLatencyMs.p95})\n`,
  );
  process.stderr.write(
    `cost: ~$${card.cost.est_usd}  (llm ${card.cost.llm_input_tokens}in/${card.cost.llm_output_tokens}out tok in ${card.cost.llm_calls} calls; embed ${card.cost.embedding_tokens} tok)\n`,
  );
  if (card.judgeErrors) process.stderr.write(`judge errors: ${card.judgeErrors}\n`);
}
