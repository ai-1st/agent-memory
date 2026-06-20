/**
 * Runtime configuration, read from the environment.
 *
 * The pipeline selector lets the same binary run two modes:
 *   - "llm":  full LLM extract->reconcile + embeddings + hybrid recall + rerank
 *             (the production path; needs OPENAI_API_KEY + ANTHROPIC_API_KEY).
 *   - "rule": fully offline rule-based extraction + deterministic mock embeddings,
 *             used by the contract test-suite so CI never touches the network.
 *
 * Everything that talks to the network lives behind the injectable LLM client
 * (src/llm), so tests construct the app with a mock client and exercise the same
 * code paths offline.
 */

export type Pipeline = "llm" | "rule";

export interface Settings {
  dbDir: string;
  authToken: string;
  pipeline: Pipeline;
  llmModel: string;
  embedModel: string;
  embedDim: number;
  port: number;
}

export function loadSettings(overrides: Partial<Settings> = {}): Settings {
  const pipeline = (process.env.MEMORY_PIPELINE ?? "llm").toLowerCase() === "rule" ? "rule" : "llm";
  return {
    dbDir: process.env.MEMORY_DB_DIR ?? "/data/pgdata",
    authToken: process.env.MEMORY_AUTH_TOKEN ?? "",
    pipeline,
    llmModel: process.env.MEMORY_LLM_MODEL ?? "claude-opus-4-8",
    embedModel: process.env.MEMORY_EMBED_MODEL ?? "text-embedding-3-large",
    embedDim: Number.parseInt(process.env.MEMORY_EMBED_DIM ?? "3072", 10) || 3072,
    port: Number.parseInt(process.env.PORT ?? "8080", 10) || 8080,
    ...overrides,
  };
}
