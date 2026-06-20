/**
 * Live end-to-end smoke test.
 *
 * Boots the app over a TEMP pglite dir with the LIVE provider (real Anthropic +
 * OpenAI), ingests a few turns including a CONTRADICTION (likes oranges -> now
 * prefers apples), then exercises /recall and /users/:id/memories and prints the
 * results so we can eyeball enriched facts, the contradiction link + narration,
 * and citations.
 *
 * Run:
 *   set -a; . ../../.env; set +a
 *   MEMORY_LLM=live PORT=8091 npx tsx scripts/smoke.ts
 *
 * Requires OPENAI_API_KEY and ANTHROPIC_API_KEY in the environment.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";

const USER = `smoke-${Date.now()}`;

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "opinionated-smoke-"));
  const bundle = createApp({
    dataDir: join(dir, "pg"),
    settings: { llmMode: "live", embeddingDim: 3072 },
  });
  await bundle.ready;
  const app = bundle.app;

  const post = async (path: string, body: unknown): Promise<{ status: number; body: any }> => {
    const res = await app.fetch(
      new Request(`http://smoke${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const get = async (path: string): Promise<{ status: number; body: any }> => {
    const res = await app.fetch(new Request(`http://smoke${path}`));
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  console.log(`\n=== LIVE SMOKE (user=${USER}) ===\n`);

  const turns = [
    {
      session_id: "s1",
      timestamp: "2025-03-01T10:00:00Z",
      messages: [
        { role: "user", content: "I just moved to Berlin from NYC last month. Loving it so far." },
        { role: "assistant", content: "Berlin is great! How are you settling in?" },
      ],
    },
    {
      session_id: "s2",
      timestamp: "2025-03-05T09:00:00Z",
      messages: [
        { role: "user", content: "Took the morning off — was walking Biscuit by the canal." },
        { role: "assistant", content: "Sounds lovely. Biscuit is lucky!" },
      ],
    },
    {
      session_id: "s3",
      timestamp: "2025-03-10T08:00:00Z",
      messages: [
        { role: "user", content: "Honestly I really like oranges, I eat one every morning." },
        { role: "assistant", content: "Citrus is a great start to the day." },
      ],
    },
    {
      session_id: "s4",
      timestamp: "2025-04-12T08:00:00Z",
      messages: [
        {
          role: "user",
          content: "These days I actually prefer apples — oranges feel too acidic now.",
        },
        { role: "assistant", content: "Apples are a solid choice." },
      ],
    },
  ];

  for (const t of turns) {
    const r = await post("/turns", { ...t, user_id: USER, metadata: {} });
    console.log(`POST /turns ${t.session_id} -> ${r.status} id=${r.body?.id}`);
  }

  console.log("\n--- /users/:id/memories ---");
  const mem = await get(`/users/${USER}/memories`);
  for (const m of mem.body?.memories ?? []) {
    const links = (m.contradicts ?? []).length
      ? ` CONTRADICTS=${JSON.stringify(m.contradicts)}`
      : "";
    console.log(
      `  [${m.type}] ${m.key} = "${m.value}" (active=${m.active}, conf=${m.confidence}, supersedes=${m.supersedes ?? "-"})${links}`,
    );
  }

  const probes = [
    "Where does this user live now?",
    "What is the user's dog's name?",
    "What city does the user with the dog named Biscuit live in?",
    "Which fruit does the user prefer, and has that changed?",
    "What is the user's favourite programming language?",
  ];
  for (const q of probes) {
    const r = await post("/recall", {
      query: q,
      user_id: USER,
      session_id: "probe",
      max_tokens: 400,
    });
    console.log(`\n--- /recall: "${q}" ---`);
    console.log(r.body?.context || "(empty)");
    console.log(`citations: ${JSON.stringify(r.body?.citations ?? [])}`);
  }

  await bundle.store.close();
  rmSync(dir, { recursive: true, force: true });
  console.log("\n=== SMOKE DONE ===");
}

main().catch((e) => {
  console.error("smoke failed:", e);
  process.exit(1);
});
