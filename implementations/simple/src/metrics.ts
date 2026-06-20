/**
 * Token-spend metrics — cumulative LLM + embedding usage since process start.
 *
 * The benchmark harness GETs /metrics before and after a run and diffs the
 * counters, so the shape below is a contract: keep it EXACTLY as documented.
 *
 *   { "llm":       { "calls": int, "input_tokens": int, "output_tokens": int },
 *     "embedding": { "calls": int, "tokens": int } }
 *
 * State is module-level on purpose: there is one process, one provider, and one
 * meaningful notion of "spend since startup". The LiveProvider records into these
 * counters around every Vercel AI SDK call (generateObject/embed/embedMany); the
 * MockProvider records zeros, so offline tests never break and the counters stay
 * honest (mock spends no tokens).
 */

/** Cumulative LLM (generateObject/generateText) usage since startup. */
const llm = { calls: 0, input_tokens: 0, output_tokens: 0 };
/** Cumulative embedding (embed/embedMany) usage since startup. */
const embedding = { calls: 0, tokens: 0 };

export interface MetricsSnapshot {
  llm: { calls: number; input_tokens: number; output_tokens: number };
  embedding: { calls: number; tokens: number };
}

/**
 * Record one LLM call. `usage` is the AI SDK `LanguageModelUsage` (or any shape
 * with optional inputTokens/outputTokens); undefined fields count as 0 so a
 * provider that omits usage still bumps the call count without poisoning totals.
 */
export function recordLlm(usage?: {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}): { input: number; output: number } {
  const input = usage?.inputTokens ?? 0;
  const output = usage?.outputTokens ?? 0;
  llm.calls += 1;
  llm.input_tokens += input;
  llm.output_tokens += output;
  return { input, output };
}

/**
 * Record one embedding call. `tokens` is the AI SDK `EmbeddingModelUsage.tokens`
 * (single embed or batch); undefined counts as 0.
 */
export function recordEmbedding(tokens?: number | undefined): number {
  const t = tokens ?? 0;
  embedding.calls += 1;
  embedding.tokens += t;
  return t;
}

/** Immutable snapshot in the exact wire shape /metrics returns. */
export function snapshot(): MetricsSnapshot {
  return {
    llm: { ...llm },
    embedding: { ...embedding },
  };
}

/** Reset all counters. Test-only — there is no runtime caller. */
export function resetMetrics(): void {
  llm.calls = 0;
  llm.input_tokens = 0;
  llm.output_tokens = 0;
  embedding.calls = 0;
  embedding.tokens = 0;
}
