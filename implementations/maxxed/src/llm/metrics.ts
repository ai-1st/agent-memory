/**
 * Process-wide token-spend accounting.
 *
 * Every LLM and embedding call routed through the AI SDK reports a `usage`
 * object; the live client funnels those numbers here so we can expose cumulative
 * spend since process start via GET /metrics. Counters are module-level (one
 * process == one tally) and reset only on restart.
 *
 * The mock/offline client reports nothing, so an offline run shows all zeros —
 * which is the correct, honest answer (no real tokens were spent) and never
 * breaks the offline test-suite.
 */

export interface TokenMetrics {
  llm: { calls: number; input_tokens: number; output_tokens: number };
  embedding: { calls: number; tokens: number };
}

const counters: TokenMetrics = {
  llm: { calls: 0, input_tokens: 0, output_tokens: 0 },
  embedding: { calls: 0, tokens: 0 },
};

/** Record one LLM (generateObject/generateText) call's token usage. */
export function recordLlmUsage(input: number | undefined, output: number | undefined): void {
  counters.llm.calls += 1;
  counters.llm.input_tokens += safe(input);
  counters.llm.output_tokens += safe(output);
}

/** Record one embedding (embed/embedMany) call's token usage. */
export function recordEmbeddingUsage(tokens: number | undefined): void {
  counters.embedding.calls += 1;
  counters.embedding.tokens += safe(tokens);
}

/** A snapshot of cumulative usage since process start (safe to serialize). */
export function getMetrics(): TokenMetrics {
  return {
    llm: { ...counters.llm },
    embedding: { ...counters.embedding },
  };
}

/** Reset all counters. Test-only; keeps unit tests independent of order. */
export function resetMetrics(): void {
  counters.llm = { calls: 0, input_tokens: 0, output_tokens: 0 };
  counters.embedding = { calls: 0, tokens: 0 };
}

/** Concise one-line summary for per-turn logging. */
export function metricsLine(): string {
  const m = counters;
  return (
    `tokens[cumulative] llm: ${m.llm.calls} calls, ${m.llm.input_tokens} in / ${m.llm.output_tokens} out` +
    ` | embedding: ${m.embedding.calls} calls, ${m.embedding.tokens} tokens`
  );
}

function safe(n: number | undefined): number {
  return Number.isFinite(n) ? (n as number) : 0;
}
