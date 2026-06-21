import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { client } from "./helpers";

const QUALITY_THRESHOLD = 0.8;

function checkProbe(context: string, probe: any): boolean {
  const ctx = context.toLowerCase();
  if (probe.expect_empty) return ctx.trim() === "";
  if (probe.expect_all) return probe.expect_all.every((t: string) => ctx.includes(t.toLowerCase()));
  if (probe.expect_any) return probe.expect_any.some((t: string) => ctx.includes(t.toLowerCase()));
  return false;
}

describe("recall quality (self-eval fixture)", () => {
  it("meets the recall-quality threshold", async () => {
    const { c } = client();
    const data = JSON.parse(readFileSync(join(process.cwd(), "fixtures/basic.json"), "utf-8"));
    let passed = 0;
    let total = 0;
    const misses: string[] = [];

    for (const scenario of data.scenarios) {
      const userId = scenario.user_id;
      for (const t of scenario.turns) {
        const r = await c.post("/turns", {
          session_id: t.session_id,
          user_id: userId,
          messages: t.messages,
          timestamp: t.timestamp ?? null,
          metadata: t.metadata ?? {},
        });
        expect(r.status).toBe(201);
      }
      for (const probe of scenario.probes) {
        total++;
        const ctx = (
          await c.post("/recall", {
            query: probe.query,
            session_id: probe.session_id ?? null,
            user_id: userId,
            max_tokens: probe.max_tokens ?? 512,
          })
        ).body.context as string;
        if (checkProbe(ctx, probe)) passed++;
        else misses.push(`[${scenario.name}] ${probe.query}`);
      }
    }

    const score = total ? passed / total : 0;
    console.log(`\nRecall quality: ${passed}/${total} probes passed (${Math.round(score * 100)}%)`);
    for (const m of misses) console.log(`  MISS: ${m}`);
    expect(score).toBeGreaterThanOrEqual(QUALITY_THRESHOLD);
  });
});
