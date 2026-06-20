/**
 * Shared types for the benchmark suite. Every adapter (LongMemEval, LoCoMo,
 * RULER/NIAH, custom) normalizes its dataset into `Scenario[]`, and the runner
 * scores any service over the HTTP contract on the mem0 three-axis card.
 */

export interface SuiteMessage {
  role: string;
  content: string;
  name?: string | null;
}

export interface SuiteTurn {
  session_id: string;
  timestamp?: string | null;
  messages: SuiteMessage[];
}

export interface SuiteProbe {
  id: string;
  category: string; // mapped onto our rubric (recall, fact_evolution, multihop, temporal, noise_abstention, ...)
  query: string;
  session_id?: string | null;
  user_id?: string | null; // defaults to scenario.user_id
  max_tokens?: number;
  expected: string; // natural-language reference answer for the judge
  abstain?: boolean; // true => correct behavior is to return nothing / "unknown"
}

export interface Scenario {
  name: string;
  user_id: string;
  turns: SuiteTurn[];
  probes: SuiteProbe[];
}

export interface AdapterOptions {
  limit?: number; // cap probes (or dataset items) for cost-bounded runs
  dataDir: string; // bench/data/<adapter>
}

export interface Adapter {
  name: string;
  describe?: string;
  load(opts: AdapterOptions): Promise<Scenario[]>;
}

export interface ProbeResult {
  id: string;
  category: string;
  correct: boolean;
  score: number;
  abstained: boolean;
  recallMs: number;
  ctxTokens: number;
  note: string;
}

export interface Stat {
  mean: number;
  p50: number;
  p95: number;
}

/** Token spend for one run (delta of the service's /metrics across the run). */
export interface Cost {
  llm_calls: number;
  llm_input_tokens: number;
  llm_output_tokens: number;
  embedding_calls: number;
  embedding_tokens: number;
  /** Model used to price est_usd (e.g. "claude-opus-4-8", "claude-haiku-4-5"). */
  pricing_model: string;
  /** $/1M input·output·embedding tokens used for est_usd (so the figure is auditable). */
  pricing_rates: { llmIn: number; llmOut: number; embed: number };
  est_usd: number;
}

/** The mem0 three-axis scorecard: accuracy-by-category / tokens-per-recall / latency. */
export interface Card {
  adapter: string;
  label: string;
  url: string;
  scenarios: number;
  probes: number;
  accuracy: number; // overall judge pass rate (judge's binary `correct`)
  /**
   * Stricter pass rate: counts a probe correct only if the judge ALSO scored it
   * >= STRICT_FLOOR (0.8). The judge sets `correct` independently of `score`, so
   * "barely conveyed" answers pass `accuracy` at score 0.7; accuracyStrict
   * surfaces those. lenientPasses = probes that pass accuracy but fail the floor.
   */
  accuracyStrict: number;
  lenientPasses: number;
  strictFloor: number;
  accuracyByCategory: Record<string, { pass: number; total: number }>;
  tokensPerRecall: Stat;
  recallLatencyMs: Stat;
  ingestLatencyMs: Stat;
  cost: Cost;
  judgeErrors: number;
  results: ProbeResult[];
}
