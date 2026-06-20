/**
 * Entrypoint. Builds the app over the configured pglite data dir and serves it.
 * Run with: npm start  (tsx src/server.ts)
 */

import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { loadSettings } from "./config";

const settings = loadSettings();

const { app } = await createApp(settings);

serve({ fetch: app.fetch, port: settings.port, hostname: "0.0.0.0" }, (info) => {
  console.log(
    `[simple] memory-service on :${info.port}  provider=${settings.provider}  dataDir=${settings.dataDir}  compaction=${settings.compaction}`,
  );
});
