import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, makeHarness } from "./helpers";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "quality.json");

interface Probe {
  query: string;
  session_id?: string;
  expect_any?: string[];
  expect_all?: string[];
  expect_empty?: boolean;
}

function checkProbe(context: string, probe: Probe): boolean {
  const ctx = (context ?? "").toLowerCase();
  if (probe.expect_empty) return ctx.trim() === "";
  const all = probe.expect_all
    ? probe.expect_all.every((t) => ctx.includes(t.toLowerCase()))
    : true;
  const any = probe.expect_any ? probe.expect_any.some((t) => ctx.includes(t.toLowerCase())) : true;
  return all && any;
}

describe("recall quality fixture (offline, mock LLM)", () => {
  let h: Harness;
  const data = JSON.parse(readFileSync(FIXTURE, "utf-8"));

  beforeAll(async () => {
    h = await makeHarness();
    for (const scenario of data.scenarios) {
      for (const t of scenario.turns) {
        const res = await h.request("POST", "/turns", {
          session_id: t.session_id,
          user_id: scenario.user_id,
          messages: t.messages,
          timestamp: t.timestamp ?? null,
          metadata: {},
        });
        expect(res.status).toBe(201);
      }
    }
  });
  afterAll(async () => {
    await h.close();
  });

  it("passes a strong majority of probes and reports the score", async () => {
    let passed = 0;
    let total = 0;
    const misses: string[] = [];
    for (const scenario of data.scenarios) {
      for (const probe of scenario.probes as Probe[]) {
        total++;
        const res = await h.request("POST", "/recall", {
          query: probe.query,
          session_id: probe.session_id ?? null,
          user_id: scenario.user_id,
          max_tokens: 512,
        });
        const body: any = await res.json();
        if (checkProbe(body.context, probe)) passed++;
        else misses.push(`[${scenario.name}] ${probe.query}`);
      }
    }
    // Visible in test output — this is the iteration metric.
    console.log(`\nrecall-quality fixture: ${passed}/${total} probes passed`);
    for (const m of misses) console.log(`  MISS: ${m}`);

    // The offline mock pipeline should clear a high bar on the deterministic set.
    expect(passed / total).toBeGreaterThanOrEqual(0.85);
  });
});
