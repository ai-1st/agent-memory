/**
 * Entrypoint. Builds the app over the configured database and serves it.
 * Run with: npm start  (tsx src/server.ts)
 */

import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { loadSettings } from "./config";

const settings = loadSettings();
const { app } = createApp();

serve({ fetch: app.fetch, port: settings.port, hostname: "0.0.0.0" }, (info) => {
  console.log(`memory-service listening on :${info.port} (db=${settings.dbPath})`);
});
