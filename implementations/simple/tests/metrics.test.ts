/**
 * Token-spend metrics: GET /metrics shape compliance + counters increase after
 * a turn. Runs offline (mock provider) — the mock records calls with zero token
 * spend, so call counters tick while token totals stay honest at 0.
 *
 * Counters are module-level and cumulative for the whole process, so this test
 * never asserts absolute values — only the exact wire SHAPE and that a turn
 * strictly increases the counters relative to a snapshot taken just before it.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TestApp, makeApp, offlineSettings, rmDir, tempDataDir } from "./helpers";

describe("metrics", () => {
  let dir: string;
  let t: TestApp;

  beforeAll(async () => {
    dir = tempDataDir();
    t = await makeApp(offlineSettings({ dataDir: dir }));
  });

  afterAll(async () => {
    await t.store.close();
    rmDir(dir);
  });

  it("GET /metrics returns 200 with the exact shape", async () => {
    const r = await t.get("/metrics");
    expect(r.status).toBe(200);

    // Top-level keys EXACTLY: llm, embedding.
    expect(Object.keys(r.body).sort()).toEqual(["embedding", "llm"]);

    // llm: { calls, input_tokens, output_tokens } — all integers.
    expect(Object.keys(r.body.llm).sort()).toEqual(["calls", "input_tokens", "output_tokens"]);
    expect(Number.isInteger(r.body.llm.calls)).toBe(true);
    expect(Number.isInteger(r.body.llm.input_tokens)).toBe(true);
    expect(Number.isInteger(r.body.llm.output_tokens)).toBe(true);

    // embedding: { calls, tokens } — all integers.
    expect(Object.keys(r.body.embedding).sort()).toEqual(["calls", "tokens"]);
    expect(Number.isInteger(r.body.embedding.calls)).toBe(true);
    expect(Number.isInteger(r.body.embedding.tokens)).toBe(true);
  });

  it("counters increase after a turn", async () => {
    const before = (await t.get("/metrics")).body;

    const turn = await t.post("/turns", {
      session_id: "m1",
      user_id: "u_metrics",
      messages: [
        { role: "user", content: "My name is Dana and I just moved to Berlin." },
        { role: "assistant", content: "Nice to meet you, Dana!" },
      ],
      timestamp: "2026-06-20T12:00:00Z",
      metadata: {},
    });
    expect(turn.status).toBe(201);

    const after = (await t.get("/metrics")).body;

    // A turn embeds (turn text + per-memory) and runs one extraction pass, so
    // both call counters strictly increase. Token totals are >= before (0 under
    // the mock, real spend under the live provider — never negative).
    expect(after.llm.calls).toBeGreaterThan(before.llm.calls);
    expect(after.embedding.calls).toBeGreaterThan(before.embedding.calls);
    expect(after.llm.input_tokens).toBeGreaterThanOrEqual(before.llm.input_tokens);
    expect(after.llm.output_tokens).toBeGreaterThanOrEqual(before.llm.output_tokens);
    expect(after.embedding.tokens).toBeGreaterThanOrEqual(before.embedding.tokens);
  });
});
