/**
 * Runtime configuration, read from the environment.
 *
 * The opinionated service is LLM-first: there is no "rule-based" fallback mode.
 * The only pipeline switch is the LLM PROVIDER seam (`live` vs `mock`) so the
 * test suite runs fully offline against a deterministic mock while production
 * uses real Anthropic + OpenAI models.
 */

export interface Settings {
  dataDir: string;
  authToken: string;
  port: number;
  /** "live" = real Anthropic/OpenAI; "mock" = deterministic offline provider. */
  llmMode: "live" | "mock";
  embeddingModel: string;
  llmModel: string;
  embeddingDim: number;
}

export function loadSettings(): Settings {
  const llmMode = (process.env.MEMORY_LLM ?? "live").toLowerCase() === "mock" ? "mock" : "live";
  return {
    dataDir: process.env.MEMORY_DATA_DIR ?? "/data/pg",
    authToken: process.env.MEMORY_AUTH_TOKEN ?? "",
    port: Number.parseInt(process.env.PORT ?? "8080", 10) || 8080,
    llmMode,
    embeddingModel: process.env.MEMORY_EMBED_MODEL ?? "text-embedding-3-large",
    llmModel: process.env.MEMORY_LLM_MODEL ?? "claude-opus-4-8",
    embeddingDim: Number.parseInt(process.env.MEMORY_EMBED_DIM ?? "3072", 10) || 3072,
  };
}
