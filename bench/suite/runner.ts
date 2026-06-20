/**
 * Suite runner: ingest a benchmark's scenarios into a running service over the
 * HTTP contract, probe /recall, judge each answer, and compute the mem0
 * three-axis card (accuracy-by-category / tokens-per-recall / p50-p95 latency)
 * plus a model-aware cost axis.
 *
 * ROBUSTNESS (so a multi-hour run survives a kill):
 *  - Every completed ingest + judged probe is appended to a JSONL journal as it
 *    happens. On `resume`, finished work is loaded from the journal and skipped,
 *    so a relaunch continues instead of restarting. The journal also IS the
 *    progress log. A partial card can be assembled from it at any time.
 *  - Ingestion runs concurrently across scenarios (independent users), probes run
 *    concurrently — both under a concurrency cap to stay under LLM rate limits.
 *    Turns WITHIN a scenario stay sequential (supersession order matters).
 *  - Transient failures (429/529/network) retry with backoff (see httpRetry).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type MetricsSnapshot, fetchMetrics, httpRetry, judge, mean, pctl } from "./judge";
import type { Card, Cost, ProbeResult, Scenario, Stat } from "./types";

const stat = (xs: number[]): Stat => ({ mean: mean(xs), p50: pctl(xs, 50), p95: pctl(xs, 95) });

// A probe passes the strict floor only if the judge scored it >= this AND marked
// it correct. The judge's binary `correct` is set independently of `score`, so
// this catches "barely conveyed" passes (e.g. score 0.7) that inflate accuracy.
export const STRICT_FLOOR = 0.8;

// Approximate USD per 1M tokens, per model tier — adjust as provider pricing
// changes. Embedding is text-embedding-3-large regardless of the chat model.
// IMPORTANT: cost must be priced at the model the service actually used. Pricing
// every card at Opus rates (the old behavior) overstated Haiku runs ~10-15x.
const EMBED_PRICE = 0.13;
type Rates = { llmIn: number; llmOut: number; embed: number };
const PRICES: Record<string, Rates> = {
  opus: { llmIn: 15, llmOut: 75, embed: EMBED_PRICE },
  sonnet: { llmIn: 3, llmOut: 15, embed: EMBED_PRICE },
  haiku: { llmIn: 1, llmOut: 5, embed: EMBED_PRICE },
};

/** Pick a price tier from the model id the container was run with. */
export function priceFor(model: string): { tier: string; rates: Rates } {
  const m = model.toLowerCase();
  if (m.includes("haiku")) return { tier: "haiku", rates: PRICES.haiku };
  if (m.includes("sonnet")) return { tier: "sonnet", rates: PRICES.sonnet };
  return { tier: "opus", rates: PRICES.opus };
}

const round = (n: number, d: number): number => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

/** Concurrency-limited map. Preserves input order; `concurrency` workers pull. */
async function pMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const n = Math.max(1, Math.min(concurrency, items.length));
  const workers = Array.from({ length: n }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return out;
}

// --- journal (resume + progress) ---------------------------------------------

interface IngestEvent {
  type: "ingest";
  user_id: string;
  ms: number[];
}
interface ProbeEvent {
  type: "probe";
  result: ProbeResult;
}
interface StartEvent {
  type: "start";
  ts: string;
  metrics: MetricsSnapshot;
}
type JournalEvent = IngestEvent | ProbeEvent | StartEvent;

interface Journal {
  start: MetricsSnapshot | null;
  ingest: Map<string, number[]>; // user_id -> per-turn latencies
  probes: Map<string, ProbeResult>; // probe id -> result
}

function readJournal(path: string): Journal {
  const j: Journal = { start: null, ingest: new Map(), probes: new Map() };
  if (!existsSync(path)) return j;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e: JournalEvent;
    try {
      e = JSON.parse(line) as JournalEvent;
    } catch {
      continue; // tolerate a torn final line from a hard kill
    }
    if (e.type === "start") j.start = e.metrics;
    else if (e.type === "ingest") j.ingest.set(e.user_id, e.ms);
    else if (e.type === "probe") j.probes.set(e.result.id, e.result);
  }
  return j;
}

function appendJournal(path: string, e: JournalEvent): void {
  appendFileSync(path, `${JSON.stringify(e)}\n`);
}

export interface RunOptions {
  resume?: boolean;
  concurrency?: number;
  journalPath?: string;
}

export async function runScenarios(
  url: string,
  scenarios: Scenario[],
  adapter: string,
  label: string,
  opts: RunOptions = {},
): Promise<Card> {
  const concurrency = opts.concurrency ?? Number(process.env.SUITE_CONCURRENCY ?? 5);
  const journalPath = opts.journalPath;
  const resume = Boolean(opts.resume && journalPath && existsSync(journalPath));

  if (journalPath) mkdirSync(dirname(journalPath), { recursive: true });
  const jrnl: Journal = resume
    ? readJournal(journalPath as string)
    : { start: null, ingest: new Map(), probes: new Map() };
  // Fresh run: truncate any stale journal so --resume later won't mix runs.
  if (journalPath && !resume) writeFileSync(journalPath, "");

  const log = (s: string): void => {
    process.stderr.write(`[${adapter}/${label}] ${s}\n`);
  };
  if (resume) {
    log(`RESUME: ${jrnl.ingest.size} users ingested, ${jrnl.probes.size} probes already judged`);
  }

  // m0 baseline for cost: from the journal on resume (so cost spans the whole
  // run), else snapshot now and record it.
  let m0 = jrnl.start;
  if (!m0) {
    m0 = await fetchMetrics(url);
    if (journalPath) appendJournal(journalPath, { type: "start", ts: nowIso(), metrics: m0 });
  }

  // --- ingest (parallel across scenarios; sequential turns within) ---
  const totalScenarios = scenarios.length;
  let ingestedCount = 0;
  await pMap(
    scenarios,
    async (sc) => {
      if (resume && jrnl.ingest.has(sc.user_id)) {
        const r = await httpRetry("GET", `${url}/users/${encodeURIComponent(sc.user_id)}/memories`);
        const has = Array.isArray(r.body?.memories) ? r.body.memories.length > 0 : r.status === 200;
        if (has) {
          ingestedCount++;
          return; // data still present -> skip re-ingest
        }
      }
      await httpRetry("DELETE", `${url}/users/${encodeURIComponent(sc.user_id)}`, undefined, {
        retryOn: [429, 529, 0],
      });
      const ms: number[] = [];
      for (const t of sc.turns) {
        const r = await httpRetry(
          "POST",
          `${url}/turns`,
          {
            session_id: t.session_id,
            user_id: sc.user_id,
            messages: t.messages,
            timestamp: t.timestamp ?? null,
            metadata: {},
          },
          { retryOn: [429, 529] }, // not network: avoid double-ingest on ambiguous failure
        );
        ms.push(r.ms);
      }
      if (journalPath) appendJournal(journalPath, { type: "ingest", user_id: sc.user_id, ms });
      jrnl.ingest.set(sc.user_id, ms);
      ingestedCount++;
      if (ingestedCount % 5 === 0 || ingestedCount === totalScenarios) {
        log(`ingest ${ingestedCount}/${totalScenarios} scenarios`);
      }
    },
    concurrency,
  );

  // --- probe + judge (parallel; skip already-judged on resume) ---
  const pairs: Array<{ sc: Scenario; p: Scenario["probes"][number] }> = [];
  for (const sc of scenarios) for (const p of sc.probes) pairs.push({ sc, p });
  const totalProbes = pairs.length;
  let probed = jrnl.probes.size;

  const probeResults = await pMap(
    pairs,
    async ({ sc, p }) => {
      const cached = jrnl.probes.get(p.id);
      if (cached) return cached;
      const r = await httpRetry(
        "POST",
        `${url}/recall`,
        {
          query: p.query,
          session_id: p.session_id ?? null,
          user_id: p.user_id ?? sc.user_id,
          max_tokens: p.max_tokens ?? 1024,
        },
        { retryOn: [429, 529, 0] },
      );
      const ctx: string = r.status === 200 ? (r.body?.context ?? "") : "";
      const j = await judge(p.query, p.expected ?? "", Boolean(p.abstain), ctx);
      const toks = estTokensLocal(ctx);
      const result: ProbeResult = {
        id: p.id,
        category: p.category,
        correct: j.correct,
        score: j.score,
        abstained: j.abstained,
        recallMs: Math.round(r.ms),
        ctxTokens: toks,
        note: j.note,
      };
      if (journalPath) appendJournal(journalPath, { type: "probe", result });
      probed++;
      if (probed % 10 === 0 || probed === totalProbes) log(`probe ${probed}/${totalProbes}`);
      return result;
    },
    concurrency,
  );

  // --- assemble card ---
  const m1 = await fetchMetrics(url);
  const model = process.env.MEMORY_LLM_MODEL ?? "claude-opus-4-8";
  const { rates } = priceFor(model);
  // Counter reset (service restarted between resume) -> use m1 as the delta.
  const reset = m1.llmCalls < m0.llmCalls;
  const d = (a: number, b: number): number => (reset ? a : a - b);
  const cost: Cost = {
    llm_calls: d(m1.llmCalls, m0.llmCalls),
    llm_input_tokens: d(m1.llmIn, m0.llmIn),
    llm_output_tokens: d(m1.llmOut, m0.llmOut),
    embedding_calls: d(m1.embCalls, m0.embCalls),
    embedding_tokens: d(m1.embTok, m0.embTok),
    pricing_model: model,
    pricing_rates: rates,
    est_usd: round(
      (d(m1.llmIn, m0.llmIn) / 1e6) * rates.llmIn +
        (d(m1.llmOut, m0.llmOut) / 1e6) * rates.llmOut +
        (d(m1.embTok, m0.embTok) / 1e6) * rates.embed,
      4,
    ),
  };

  const ingestMs = [...jrnl.ingest.values()].flat();
  const recallMs = probeResults.map((r) => r.recallMs);
  const ctxTokens = probeResults.map((r) => r.ctxTokens);

  const byCat: Record<string, { pass: number; total: number }> = {};
  for (const r of probeResults) {
    byCat[r.category] ??= { pass: 0, total: 0 };
    byCat[r.category].total++;
    if (r.correct) byCat[r.category].pass++;
  }
  const passed = probeResults.filter((r) => r.correct).length;
  const strictPassed = probeResults.filter((r) => r.correct && r.score >= STRICT_FLOOR).length;
  const rate = (n: number): number =>
    probeResults.length ? Math.round((n / probeResults.length) * 1000) / 1000 : 0;

  return {
    adapter,
    label,
    url,
    scenarios: scenarios.length,
    probes: probeResults.length,
    accuracy: rate(passed),
    accuracyStrict: rate(strictPassed),
    lenientPasses: passed - strictPassed,
    strictFloor: STRICT_FLOOR,
    accuracyByCategory: byCat,
    tokensPerRecall: stat(ctxTokens),
    recallLatencyMs: stat(recallMs),
    ingestLatencyMs: stat(ingestMs),
    cost,
    judgeErrors: probeResults.filter((r) => r.note === "JUDGE_ERROR").length,
    results: probeResults,
  };
}

const estTokensLocal = (s: string): number => Math.ceil((s?.length ?? 0) / 4);
function nowIso(): string {
  // Date.now()/new Date() are fine here (runner is not a resumable workflow script).
  return new Date().toISOString();
}

export function printCard(card: Card): void {
  const cats = Object.keys(card.accuracyByCategory).sort();
  process.stderr.write(`\n== ${card.adapter} / ${card.label} (${card.url}) ==\n`);
  process.stderr.write(
    `accuracy: ${Math.round(card.accuracy * 100)}%  (strict@${card.strictFloor}: ${Math.round(card.accuracyStrict * 100)}%, ${card.lenientPasses} lenient; ${card.probes} probes, ${card.scenarios} scenarios)\n`,
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
    `cost: ~$${card.cost.est_usd} @ ${card.cost.pricing_model}  (llm ${card.cost.llm_input_tokens}in/${card.cost.llm_output_tokens}out tok in ${card.cost.llm_calls} calls; embed ${card.cost.embedding_tokens} tok)\n`,
  );
  if (card.judgeErrors) process.stderr.write(`judge errors: ${card.judgeErrors}\n`);
}
