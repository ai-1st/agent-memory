/**
 * Entrypoint. Builds the app over the configured pglite dataDir + LLM provider
 * and serves it. Run with: npm start  (tsx src/server.ts)
 *
 * `ready` resolves once pglite has initialized the schema; we wait for it before
 * binding the port so /health only flips green when the store is truly ready.
 */

import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { loadSettings } from "./config";
import { errStr } from "./logging";

const settings = loadSettings();
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
