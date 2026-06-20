/**
 * Entrypoint. Builds the app and serves it.
 * Run with: npm start  (tsx src/server.ts)
 */

import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { loadSettings } from "./config";

const settings = loadSettings();
const { app, store } = createApp();

// Await store readiness BEFORE serving. pglite's async init settles a promise
// during startup; if we enter the event loop without having awaited it, a
// rejection there surfaces as a fatal UnhandledPromiseRejection (Node's default)
// even though the store would have been usable. Awaiting here both prevents that
// and guarantees /health is truthful the moment we accept connections.
async function main(): Promise<void> {
  await store.whenReady();
  serve({ fetch: app.fetch, port: settings.port, hostname: "0.0.0.0" }, (info) => {
    console.log(
      `maxxed memory-service listening on :${info.port} ` +
        `(pipeline=${settings.pipeline}, db=${settings.dbDir})`,
    );
  });
}

main().catch((err) => {
  console.error("failed to start memory-service:", err);
  process.exit(1);
});
