/**
 * Recall-quality fixture runner — the iteration loop. Ingests each scenario's
 * turns, runs the probe queries against /recall, and reports "X of Y expected
 * facts appeared in context" (plus negative noise probes). Runs offline against
 * the deterministic mock provider.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TestApp, makeApp, offlineSettings, rmDir, tempDataDir } from "./helpers";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "quality.json");

interface Probe {
  query: string;
  session_id: string;
  expect_any: string[];
  expect_not: string[];
}
interface Scenario {
  name: string;
  user_id: string;
  turns: Array<{
    session_id: string;
    timestamp: string;
    messages: Array<{ role: string; content: string }>;
  }>;
  probes: Probe[];
}

const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as { scenarios: Scenario[] };

describe("recall quality fixture", () => {
  let dir: string;
  let t: TestApp;
  const results: Array<{ scenario: string; probe: string; pass: boolean }> = [];

  beforeAll(async () => {
    dir = tempDataDir();
    t = await makeApp(offlineSettings({ dataDir: dir }));
    for (const sc of fixture.scenarios) {
      for (const turn of sc.turns) {
        await t.post("/turns", {
          session_id: turn.session_id,
          user_id: sc.user_id,
          messages: turn.messages,
          timestamp: turn.timestamp,
          metadata: {},
        });
      }
    }
  });

  afterAll(async () => {
    const passed = results.filter((r) => r.pass).length;
    // Visible quality metric in the test output.
    console.log(`\n[quality] ${passed}/${results.length} probes passed`);
    for (const r of results) console.log(`  ${r.pass ? "✓" : "✗"} ${r.scenario}: ${r.probe}`);
    await t.store.close();
    rmDir(dir);
  });

  for (const sc of fixture.scenarios) {
    for (const probe of sc.probes) {
      it(`${sc.name}: ${probe.query}`, async () => {
        const r = await t.post("/recall", {
          query: probe.query,
          session_id: probe.session_id,
          user_id: sc.user_id,
          max_tokens: 512,
        });
        expect(r.status).toBe(200);
        const ctx: string = r.body.context;

        let pass = true;
        // Positive expectations: at least one expected term must appear.
        if (probe.expect_any.length > 0) {
          const hit = probe.expect_any.some((term) =>
            ctx.toLowerCase().includes(term.toLowerCase()),
          );
          if (!hit) pass = false;
          expect(hit, `expected one of ${JSON.stringify(probe.expect_any)} in: ${ctx}`).toBe(true);
        }
        // Negative expectations: none of these terms may appear (noise resistance).
        for (const term of probe.expect_not) {
          const present = ctx.toLowerCase().includes(term.toLowerCase());
          if (present) pass = false;
          expect(present, `did NOT expect "${term}" in: ${ctx}`).toBe(false);
        }
        results.push({ scenario: sc.name, probe: probe.query, pass });
      });
    }
  }

  it("aggregate: all probes pass", () => {
    const passed = results.filter((r) => r.pass).length;
    expect(passed).toBe(results.length);
  });
});
