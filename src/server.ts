/**
 * Entrypoint. Builds the app over the configured pglite dataDir + LLM provider
 * and serves it. Run with: npm start  (tsx src/server.ts)
 *
 * `ready` resolves once pglite has initialized the schema; we wait for it before
 * binding the port so /health only flips green when the store is truly ready.
 */

import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { type Settings, loadSettings } from "./config";
import { errStr } from "./logging";

/**
 * Fail fast with a CLEAR, actionable message when the live LLM provider has no
 * API keys — the single most common "clean machine" misconfiguration. Without
 * this the keys-required error throws deep inside provider construction and
 * surfaces as an opaque stack trace. Here we name exactly what's missing, say
 * where it comes from (.env), and how to fix it, then exit cleanly.
 */
function requireLiveKeys(settings: Settings): void {
  if (settings.llmMode !== "live") return; // mock provider needs no keys
  const required: Array<[string, string]> = [
    ["OPENAI_API_KEY", "embeddings (OpenAI text-embedding-3-large)"],
    ["ANTHROPIC_API_KEY", "extraction & recall (Anthropic Claude)"],
  ];
  const missing = required.filter(([k]) => !(process.env[k] ?? "").trim());
  if (missing.length === 0) return;

  const msg = [
    "",
    "  ✖ memory-service cannot start — missing required API key(s):",
    "",
    ...missing.map(([k, use]) => `      • ${k}  (${use})`),
    "",
    "  This service runs LLM-first (MEMORY_LLM=live) and needs both keys. They are",
    "  read from the environment — normally supplied via a .env file, which is",
    "  MISSING or incomplete.",
    "",
    "  Fix (local):   cp .env.example .env   then add your keys to .env",
    "  Fix (Docker):  create a .env next to docker-compose.yml (compose auto-loads",
    "                 it), or pass the keys through the environment.",
    "  See .env.example for the full list of options.",
    "",
    "  To run with NO models (offline — used by the tests): set MEMORY_LLM=mock",
    "",
  ].join("\n");
  console.error(msg);
  process.exit(1);
}

const settings = loadSettings();
requireLiveKeys(settings);
const { app, ready } = createApp();

ready
  .then(() => {
    serve({ fetch: app.fetch, port: settings.port, hostname: "0.0.0.0" }, (info) => {
      console.log(
        `memory-service (opinionated) listening on :${info.port} ` +
          `(dataDir=${settings.dataDir}, llm=${settings.llmMode}, model=${settings.llmModel})`,
      );
    });
  })
  .catch((err) => {
    console.error(`failed to initialize store: ${errStr(err)}`);
    process.exit(1);
  });
