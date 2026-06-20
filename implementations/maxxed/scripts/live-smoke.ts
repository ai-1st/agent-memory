/**
 * Live end-to-end smoke test against the REAL models (Claude Opus 4.8 +
 * text-embedding-3-large). Boots the service in-process with the llm pipeline,
 * exercises the fancy paths — contradiction/supersession, multi-hop, temporal
 * "as of" — and prints the results. Opt-in: requires OPENAI_API_KEY +
 * ANTHROPIC_API_KEY in the environment.
 *
 *   set -a; . ../../.env; set +a
 *   npm run smoke:live
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY || !process.env.ANTHROPIC_API_KEY) {
    console.error("live smoke requires OPENAI_API_KEY and ANTHROPIC_API_KEY in env.");
    console.error("load them with: set -a; . ../../.env; set +a");
    process.exit(2);
  }

  const dir = mkdtempSync(join(tmpdir(), "maxxed-live-"));
  const { app, store, llm } = createApp({
    settings: { pipeline: "llm", dbDir: dir, authToken: "" },
  });
  await store.whenReady();
  console.log(`live smoke: pipeline=llm, llm=${llm.kind}, dim=${llm.dim}\n`);

  const req = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  const turn = async (session: string, ts: string, text: string) => {
    const r = await req("POST", "/turns", {
      session_id: session,
      user_id: "live_alice",
      messages: [{ role: "user", content: text }],
      timestamp: ts,
      metadata: {},
    });
    console.log(`  turn[${session}] -> ${r.status}`);
  };
  const recall = async (label: string, query: string, asOf?: string) => {
    const r = await req("POST", "/recall", {
      query,
      session_id: "probe",
      user_id: "live_alice",
      max_tokens: 400,
      as_of: asOf,
    });
    const b = (await r.json()) as { context: string };
    console.log(`\n[${label}] Q: ${query}${asOf ? ` (as_of ${asOf})` : ""}`);
    console.log(b.context.replace(/^/gm, "    "));
  };

  console.log("ingesting scripted conversation…");
  await turn(
    "s1",
    "2026-01-10T09:00:00Z",
    "Hi, I'm Alice. I live in Berlin and work at Stripe as a backend engineer.",
  );
  await turn("s1", "2026-01-10T09:01:00Z", "I have a dog named Biscuit, a corgi.");
  await turn(
    "s3",
    "2026-03-20T11:00:00Z",
    "Big news — I left Stripe and joined Notion! And I'm moving from Berlin to New York City.",
  );
  await turn("s4", "2026-04-25T08:00:00Z", "Settled into NYC. Biscuit loves Central Park.");

  await recall("recall", "Where does Alice live now?");
  await recall("fact-evolution", "Where does Alice work?");
  await recall("multi-hop", "What city does the owner of the dog named Biscuit live in?");
  await recall("temporal", "Where did Alice work in February 2026?", "2026-02-15T00:00:00Z");
  await recall("noise/abstain", "What is Alice's favorite programming language?");

  console.log("\n--- structured memories ---");
  const mems = (await (await req("GET", "/users/live_alice/memories")).json()) as {
    memories: any[];
  };
  for (const m of mems.memories) {
    const sup = m.supersedes ? `  (supersedes ${m.supersedes})` : "";
    console.log(`  ${m.active ? "*" : " "} [${m.type}] ${m.key} = ${m.value}${sup}`);
  }

  await req("DELETE", "/users/live_alice");
  await store.close();
  console.log("\nlive smoke complete.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
