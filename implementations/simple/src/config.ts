/**
 * Runtime configuration, read once from the environment.
 *
 * The only knob with real behavioural weight is the provider selection: with no
 * API keys (or MEMORY_PROVIDER=mock) we use a deterministic offline provider so
 * the whole test suite runs without a network. Real keys flip on Claude + OpenAI.
 */

export interface Settings {
  /** Directory pglite persists into (mounted on a Docker volume). */
  dataDir: string;
  /** Optional bearer token; empty string disables auth. */
  authToken: string;
  /** HTTP port. */
  port: number;
  /** "live" (real keys) or "mock" (deterministic, offline). */
  provider: "live" | "mock";
  /** Whether the optional LLM compaction step in /recall is enabled. */
  compaction: boolean;
  openaiApiKey: string;
  anthropicApiKey: string;
}

export function loadSettings(overrides: Partial<Settings> = {}): Settings {
  const openaiApiKey = process.env.OPENAI_API_KEY ?? "";
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY ?? "";

  // Default to mock unless BOTH keys are present and the operator hasn't forced
  // mock. Embeddings (OpenAI) and extraction (Anthropic) are both needed for the
  // live path, so partial keys fall back to the deterministic provider.
  const forced = (process.env.MEMORY_PROVIDER ?? "").toLowerCase();
  let provider: "live" | "mock";
  if (forced === "mock") provider = "mock";
  else if (forced === "live") provider = "live";
  else provider = openaiApiKey && anthropicApiKey ? "live" : "mock";

  return {
    dataDir: process.env.MEMORY_DATA_DIR ?? "/data/pgdata",
    authToken: process.env.MEMORY_AUTH_TOKEN ?? "",
    port: Number.parseInt(process.env.PORT ?? "8080", 10) || 8080,
    provider,
    compaction: (process.env.MEMORY_COMPACTION ?? "on").toLowerCase() !== "off",
    openaiApiKey,
    anthropicApiKey,
    ...overrides,
  };
}
