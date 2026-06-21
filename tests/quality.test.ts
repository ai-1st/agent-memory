/**
 * Recall-quality fixture test — the iteration loop.
 *
 * Ingests the scripted conversations in fixtures/basic.json, runs each probe
 * against /recall, and reports "X of Y expected facts appeared in context" using
 * the same expect_any / expect_all / expect_empty matching as the bench harness.
 * Runs fully offline via the mock provider; the live model only does better.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { client, makeTestApp } from "./helpers";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "basic.json");

function checkProbe(context: string, probe: any): boolean {
  const ctx = (context ?? "").toLowerCase();
  if (probe.expect_empty) return ctx.trim() === "";
  if (probe.expect_all) return probe.expect_all.every((t: string) => ctx.includes(t.toLowerCase()));
  if (probe.expect_any) return probe.expect_any.some((t: string) => ctx.includes(t.toLowerCase()));
  return false;
}

describe("recall quality fixture", () => {
  it("passes the scripted probes (offline mock)", async () => {
    const data = JSON.parse(readFileSync(FIXTURE, "utf-8"));
    const { app } = await makeTestApp();
    const c = client(app);

    let passed = 0;
    let total = 0;
    const misses: string[] = [];

    for (const scenario of data.scenarios) {
      for (const t of scenario.turns) {
        const r = await c.post("/turns", {
          session_id: t.session_id,
          user_id: scenario.user_id,
          messages: t.messages,
          timestamp: t.timestamp ?? null,
          metadata: t.metadata ?? {},
        });
        expect(r.status).toBe(201);
      }
      for (const probe of scenario.probes) {
        total++;
        const r = await c.post("/recall", {
          query: probe.query,
          session_id: probe.session_id ?? null,
          user_id: scenario.user_id,
          max_tokens: probe.max_tokens ?? 512,
        });
        const ok = r.status === 200 && checkProbe(r.body.context, probe);
        if (ok) passed++;
        else misses.push(`[${scenario.name}] ${probe.query}`);
      }
    }

    // Report for the iteration loop.
    console.log(`\nrecall quality (mock): ${passed}/${total}`);
    for (const m of misses) console.log(`  MISS: ${m}`);

    // The deterministic mock should clear every fixture probe.
    expect(passed).toBe(total);
  });
});
