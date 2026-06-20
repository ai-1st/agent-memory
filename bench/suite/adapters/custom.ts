/**
 * Custom benchmark = the exact assignment scenarios (Berlin/NYC, Biscuit
 * multi-hop, Stripe->Notion, opinion arc, abstention, budget, cross-session).
 * Reuses bench/scenarios/comparison.json.
 *
 * Lifecycle (DELETE /sessions, /users) and restart-persistence are exercised by
 * each implementation's own test suite and scripts/run-comparison.sh; this
 * adapter scores recall quality on the three-axis card.
 *
 * This file is also the reference TEMPLATE for the other adapters: implement an
 * `Adapter` whose `load()` returns `Scenario[]` normalized to our types.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Adapter, Scenario } from "../types";

const FIXTURE = fileURLToPath(new URL("../../scenarios/comparison.json", import.meta.url));

function capProbes(scenarios: Scenario[], limit?: number): Scenario[] {
  if (!limit) return scenarios;
  const out: Scenario[] = [];
  let n = 0;
  for (const s of scenarios) {
    if (n >= limit) break;
    const probes = s.probes.slice(0, Math.max(0, limit - n));
    if (probes.length === 0) continue;
    n += probes.length;
    out.push({ ...s, probes });
  }
  return out;
}

const adapter: Adapter = {
  name: "custom",
  describe: "Assignment scenarios (reuses bench/scenarios/comparison.json).",
  async load({ limit }) {
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf-8"));
    const scenarios: Scenario[] = fixture.scenarios.map((s: any) => ({
      name: s.name,
      user_id: s.user_id,
      turns: s.turns,
      probes: s.probes.map((p: any) => ({
        id: p.id,
        category: p.category,
        query: p.query,
        session_id: p.session_id ?? null,
        user_id: p.user_id ?? null,
        max_tokens: p.max_tokens ?? 512,
        expected: p.expected ?? "",
        abstain: Boolean(p.abstain),
      })),
    }));
    return capProbes(scenarios, limit);
  },
};

export default adapter;
