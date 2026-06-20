/**
 * Regression tests for:
 *
 *  1. The recall/ingest 500 bug. During a RULER/NIAH-style live run, POST /turns
 *     intermittently returned HTTP 500 with
 *       "TypeError: Cannot read properties of undefined (reading 'value')"
 *     whose stack was entirely inside node:internal/util/inspect. ROOT CAUSE:
 *     an underlying model-SDK error thrown during ingest was passed straight to
 *     `console.warn(..., err)` inside the catch block; Node's `util.inspect`
 *     THREW while formatting that error object, and because the throw happened
 *     inside the catch's own logging it ESCAPED the catch and reached
 *     app.onError -> 500. The fix logs via `errStr` (a string), never the raw
 *     object, so logging can never throw and the "extraction failure must not
 *     fail the write" guarantee holds. Recall is additionally hardened so a
 *     malformed/undefined candidate can never 500 it.
 *
 *     We simulate the production failure with a provider that throws an error
 *     whose `.message` access itself throws the SAME TypeError — the exact thing
 *     that defeats naive logging — and assert the endpoints never 500.
 *
 *  2. Token-spend metrics: GET /metrics shape + counters increasing after a turn.
 */

import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createMockProvider } from "../src/llm/mock";
import type { LLMProvider } from "../src/llm/provider";
import { errStr } from "../src/logging";
import { client } from "./helpers";

/** An error whose `.message` (and inspection) throws the exact production
 *  TypeError — i.e. logging it the naive way (`${err}` / console.warn(msg, err))
 *  re-throws and would escape a catch block. */
class NastyError extends Error {
  constructor() {
    super();
    this.name = "NastyError";
    // Define `message` as an OWN throwing accessor so naive access/inspection
    // re-throws the exact production TypeError. (A plain getter on the prototype
    // would be shadowed by Error's own `message` data property.)
    Object.defineProperty(this, "message", {
      configurable: true,
      enumerable: true,
      get(): string {
        throw new TypeError("Cannot read properties of undefined (reading 'value')");
      },
    });
  }
}

/** Provider that throws a hostile error on a chosen task; delegates the rest to
 *  the mock so the surrounding pipeline behaves normally. */
function throwingProvider(opts: {
  onExtract?: boolean;
  onEmbed?: boolean;
  onRecall?: boolean;
}): LLMProvider {
  const mock = createMockProvider();
  return {
    name: "throwing",
    async embed(texts) {
      if (opts.onEmbed) throw new NastyError();
      return mock.embed(texts);
    },
    async generate(args) {
      if (opts.onExtract && args.task === "extract") throw new NastyError();
      if (opts.onRecall && args.task === "recall") throw new NastyError();
      return mock.generate(args);
    },
  };
}

describe("errStr never throws on hostile errors", () => {
  it("survives an error whose message access throws", () => {
    const e = new NastyError();
    // The naive path that caused the production 500:
    expect(() => `${e.message}`).toThrow(/reading 'value'/);
    // The fix:
    let s = "";
    expect(() => {
      s = errStr(e);
    }).not.toThrow();
    expect(s).toContain("NastyError");
  });
});

describe("regression: ingest never 500s even when logging the error would throw", () => {
  it("POST /turns still returns 201 when extraction throws a hostile error", async () => {
    const bundle = createApp({
      dataDir: "memory://",
      llm: throwingProvider({ onExtract: true }),
      settings: { embeddingDim: 256, authToken: "" },
    });
    await bundle.ready;
    const c = client(bundle.app);
    const r = await c.post("/turns", {
      session_id: "s1",
      user_id: "u1",
      messages: [{ role: "user", content: "I just moved to Berlin from NYC." }],
      timestamp: "2025-03-15T10:30:00Z",
      metadata: {},
    });
    // Raw turn is persisted first; a hostile extraction error must NOT fail the write.
    expect(r.status).toBe(201);
    expect(typeof r.body.id).toBe("string");
    await bundle.store.close();
  });
});

describe("regression: recall always returns 200 (RULER/NIAH failure shape)", () => {
  it("recall returns 200/empty when the embed step throws a hostile error", async () => {
    const bundle = createApp({
      dataDir: "memory://",
      llm: throwingProvider({ onEmbed: true }),
      settings: { embeddingDim: 256, authToken: "" },
    });
    await bundle.ready;
    const c = client(bundle.app);
    const r = await c.post("/recall", {
      query: "What is the access code for project Falcon?",
      user_id: "niah-user",
      session_id: null,
      max_tokens: 512,
    });
    expect(r.status).toBe(200);
    expect(typeof r.body.context).toBe("string");
    expect(Array.isArray(r.body.citations)).toBe(true);
    await bundle.store.close();
  });

  it("recall returns 200 when the rerank LLM step throws (degrades to fallback)", async () => {
    // Ingest with a normal mock first, then recall with a provider whose recall
    // generate throws — exercises the graceful-degradation path end-to-end.
    const bundle = createApp({
      dataDir: "memory://",
      llm: throwingProvider({ onRecall: true }),
      settings: { embeddingDim: 256, authToken: "" },
    });
    await bundle.ready;
    const c = client(bundle.app);
    await c.post("/turns", {
      session_id: "s1",
      user_id: "u1",
      messages: [{ role: "user", content: "I just moved to Berlin from NYC." }],
      timestamp: "2025-03-15T10:30:00Z",
      metadata: {},
    });
    const r = await c.post("/recall", {
      query: "where does the user live",
      user_id: "u1",
      session_id: null,
      max_tokens: 512,
    });
    expect(r.status).toBe(200);
    // Deterministic fallback still surfaces the stored fact.
    expect(r.body.context.toLowerCase()).toContain("berlin");
    await bundle.store.close();
  });

  it("RULER-shaped haystack (40 distractors + needles) recalls without 500", async () => {
    const bundle = createApp({
      dataDir: "memory://",
      llm: createMockProvider(),
      settings: { embeddingDim: 256, authToken: "" },
    });
    await bundle.ready;
    const c = client(bundle.app);
    const userId = "niah-0";
    // Needles spread across two sessions (true NIAH semantics).
    const needles = [
      "My name is Marcus and I work at Notion as a product manager.",
      "I really like oranges.",
      "Actually I prefer apples now instead of oranges.",
    ];
    const distractor = "The standup got moved to 10:15 because the room was double-booked.";
    let ni = 0;
    for (let i = 0; i < 43; i++) {
      const isNeedle = i === 7 || i === 21 || i === 39;
      const content = isNeedle ? (needles[ni++] as string) : distractor;
      const r = await c.post("/turns", {
        session_id: i % 2 === 0 ? `${userId}-s1` : `${userId}-s2`,
        user_id: userId,
        messages: [
          { role: "user", content },
          { role: "assistant", content: "Noted." },
        ],
        timestamp: `2026-01-${String((i % 27) + 1).padStart(2, "0")}T10:00:00Z`,
        metadata: {},
      });
      expect(r.status).toBe(201);
    }
    // user-scoped recall (session_id: null) — exactly the RULER probe shape.
    for (const query of [
      "What is the user's name and where do they work?",
      "What fruit does the user prefer?",
      "What is the access code for project Falcon?", // absent -> must not 500
    ]) {
      const r = await c.post("/recall", {
        query,
        user_id: userId,
        session_id: null,
        max_tokens: 512,
      });
      expect(r.status).toBe(200);
    }
    await bundle.store.close();
  });
});

describe("token-spend metrics", () => {
  it("GET /metrics returns 200 with the exact shape and counters increase after a turn", async () => {
    const bundle = createApp({
      dataDir: "memory://",
      llm: createMockProvider(),
      settings: { embeddingDim: 256, authToken: "" },
    });
    await bundle.ready;
    const c = client(bundle.app);

    const before = await c.get("/metrics");
    expect(before.status).toBe(200);
    // exact shape (the benchmark harness diffs this)
    expect(before.body).toEqual({
      llm: {
        calls: expect.any(Number),
        input_tokens: expect.any(Number),
        output_tokens: expect.any(Number),
      },
      embedding: { calls: expect.any(Number), tokens: expect.any(Number) },
    });

    // a turn drives extraction (generate) + embedding (embed) + reconcile (generate)
    const t = await c.post("/turns", {
      session_id: "s1",
      user_id: "u1",
      messages: [{ role: "user", content: "I just moved to Berlin from NYC." }],
      timestamp: "2025-03-15T10:30:00Z",
      metadata: {},
    });
    expect(t.status).toBe(201);

    const after = await c.get("/metrics");
    expect(after.status).toBe(200);
    // cumulative counters strictly increase
    expect(after.body.llm.calls).toBeGreaterThan(before.body.llm.calls);
    expect(after.body.embedding.calls).toBeGreaterThan(before.body.embedding.calls);
    // tokens accumulate (mock reports synthetic non-zero usage)
    expect(after.body.llm.input_tokens).toBeGreaterThan(before.body.llm.input_tokens);
    expect(after.body.llm.output_tokens).toBeGreaterThan(before.body.llm.output_tokens);
    expect(after.body.embedding.tokens).toBeGreaterThan(before.body.embedding.tokens);

    await bundle.store.close();
  });
});
