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
