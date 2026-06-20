/**
 * Runtime configuration, read from the environment.
 *
 * Strategy selection (extractor/recaller) is env-driven so we can A/B different
 * pipelines against the same benchmark harness without code changes.
 */

export interface Settings {
  dbPath: string;
  authToken: string;
  extractor: string; // baseline | llm (branches add llm)
  recaller: string; // baseline
  port: number;
}

export function loadSettings(): Settings {
  return {
    dbPath: process.env.MEMORY_DB_PATH ?? "/data/memory.db",
    authToken: process.env.MEMORY_AUTH_TOKEN ?? "",
    extractor: (process.env.MEMORY_EXTRACTOR ?? "baseline").toLowerCase(),
    recaller: (process.env.MEMORY_RECALLER ?? "baseline").toLowerCase(),
    port: Number.parseInt(process.env.PORT ?? "8080", 10) || 8080,
  };
}
