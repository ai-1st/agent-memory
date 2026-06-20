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

/** The mem0 three-axis scorecard: accuracy-by-category / tokens-per-recall / latency. */
export interface Card {
  adapter: string;
  label: string;
  url: string;
  scenarios: number;
  probes: number;
  accuracy: number; // overall judge pass rate
  accuracyByCategory: Record<string, { pass: number; total: number }>;
  tokensPerRecall: Stat;
  recallLatencyMs: Stat;
  ingestLatencyMs: Stat;
  judgeErrors: number;
  results: ProbeResult[];
}
