/**
 * Process-wide token-spend metrics.
 *
 * Module-level counters accumulate token usage across EVERY LLM and embedding
 * call for the lifetime of the process (since startup). The provider seam
 * (src/llm/*) records usage on every call; the HTTP layer exposes the totals via
 * GET /metrics and logs a concise per-turn line.
 *
 * The shape returned by `snapshot()` is the exact contract the benchmark harness
 * diffs:
 *   { llm:       { calls, input_tokens, output_tokens },
 *     embedding: { calls, tokens } }
 *
 * The mock/offline provider reports zeros for tokens (it does no real work) but
 * still increments `calls`, so offline tests can assert that counters move.
 */

import { appendFileSync, existsSync, statSync } from "node:fs";

export interface MetricsSnapshot {
  llm: { calls: number; input_tokens: number; output_tokens: number };
  embedding: { calls: number; tokens: number };
}

const counters: MetricsSnapshot = {
  llm: { calls: 0, input_tokens: 0, output_tokens: 0 },
  embedding: { calls: 0, tokens: 0 },
};

const n = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);

/** Record one LLM (generate*) call's token usage. Unknown fields count as 0. */
export function recordLlm(inputTokens?: number, outputTokens?: number): void {
  counters.llm.calls += 1;
  counters.llm.input_tokens += n(inputTokens);
  counters.llm.output_tokens += n(outputTokens);
}

/** Record one embedding (embed/embedMany) call's token usage. */
export function recordEmbedding(tokens?: number): void {
  counters.embedding.calls += 1;
  counters.embedding.tokens += n(tokens);
}

/** Immutable copy of the cumulative counters since process start. */
export function snapshot(): MetricsSnapshot {
  return {
    llm: { ...counters.llm },
    embedding: { ...counters.embedding },
  };
}

/** Reset all counters. Test-only; not used in production. */
export function resetMetrics(): void {
  counters.llm = { calls: 0, input_tokens: 0, output_tokens: 0 };
  counters.embedding = { calls: 0, tokens: 0 };
}

// --- per-call CSV inference log (cost audit) --------------------------------
//
// When `MEMORY_LLM_LOG` points at a file, EVERY LLM and embedding call appends
// one CSV row so spend can be reconciled call-by-call across implementations.
// When the env var is unset, this is a complete no-op (no I/O, no behaviour
// change) so the offline test suite is unaffected.
//
// Columns (EXACT order, shared across all implementations):
//   ts,impl,kind,phase,model,input_tokens,output_tokens,latency_ms,request,response
// Every field is double-quoted and internal quotes are doubled so multi-line
// JSON request/response cells stay valid CSV. Writes are synchronous appends.

const CSV_HEADER =
  "ts,impl,kind,phase,model,input_tokens,output_tokens,latency_ms,request,response\n";

const IMPL = "opinionated";

export interface InferenceLogEntry {
  kind: "llm" | "embedding";
  phase: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  request: string;
  response: string;
}

/** CSV-quote one field: wrap in double quotes, escaping internal quotes. */
function csvField(value: unknown): string {
  const s = value === undefined || value === null ? "" : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Append one CSV row describing an LLM or embedding call. No-op unless
 * `MEMORY_LLM_LOG` is set. Writes the header first if the file is new/empty.
 * Logging failures are swallowed — auditing must never break a real request.
 */
export function logInference(entry: InferenceLogEntry): void {
  const path = process.env.MEMORY_LLM_LOG;
  if (!path) return;
  try {
    const fresh = !existsSync(path) || statSync(path).size === 0;
    const row = [
      new Date().toISOString(),
      IMPL,
      entry.kind,
      entry.phase,
      entry.model,
      entry.inputTokens,
      entry.outputTokens,
      Math.round(entry.latencyMs),
      entry.request,
      entry.response,
    ]
      .map(csvField)
      .join(",");
    appendFileSync(path, `${fresh ? CSV_HEADER : ""}${row}\n`);
  } catch {
    // never let cost auditing surface as a request error
  }
}
