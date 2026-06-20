/**
 * GET /metrics contract + counter behaviour.
 *
 * The benchmark harness diffs /metrics, so the SHAPE is load-bearing:
 *   { llm: { calls, input_tokens, output_tokens }, embedding: { calls, tokens } }
 * with cumulative-since-start integer counters. These tests assert the shape,
 * that an offline (mock) run reports honest zeros, and that a turn driven by a
 * usage-reporting client bumps the counters.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { createApp } from "../src/app";
import { MockLlmClient } from "../src/llm";
import { recordEmbeddingUsage, recordLlmUsage, resetMetrics } from "../src/llm/metrics";
import type { LlmClient } from "../src/llm/types";
import { Store } from "../src/store";

function expectMetricsShape(body: any): void {
  expect(body).toHaveProperty("llm");
  expect(body).toHaveProperty("embedding");
  expect(body.llm).toHaveProperty("calls");
  expect(body.llm).toHaveProperty("input_tokens");
  expect(body.llm).toHaveProperty("output_tokens");
  expect(body.embedding).toHaveProperty("calls");
  expect(body.embedding).toHaveProperty("tokens");
  for (const n of [
    body.llm.calls,
    body.llm.input_tokens,
    body.llm.output_tokens,
    body.embedding.calls,
    body.embedding.tokens,
  ]) {
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThanOrEqual(0);
  }
  // Exactly these keys — nothing extra (the harness diffs the object).
  expect(Object.keys(body).sort()).toEqual(["embedding", "llm"]);
  expect(Object.keys(body.llm).sort()).toEqual(["calls", "input_tokens", "output_tokens"]);
  expect(Object.keys(body.embedding).sort()).toEqual(["calls", "tokens"]);
}

/**
 * A mock client that, unlike the offline MockLlmClient, reports synthetic token
 * usage so we can assert the counters move — mirroring how the live AiSdkClient
 * funnels real `usage` into the metrics module.
 */
class UsageReportingClient implements LlmClient {
  readonly kind = "usage-mock";
  readonly live = false;
  readonly dim = 256;
  private inner = new MockLlmClient(256);

  async embed(text: string): Promise<number[]> {
    recordEmbeddingUsage(8);
    return this.inner.embed(text);
  }
  async embedMany(texts: string[]): Promise<number[][]> {
    recordEmbeddingUsage(texts.length * 8);
    return this.inner.embedMany(texts);
  }
  async generateObject<T>(args: {
    schema: z.ZodType<T, z.ZodTypeDef, unknown>;
    system?: string;
    prompt: string;
    purpose: string;
  }): Promise<T> {
    recordLlmUsage(50, 25);
    return this.inner.generateObject(args);
  }
}

describe("GET /metrics", () => {
  beforeEach(() => resetMetrics());

  it("returns 200 with the exact shape, zeros for an offline run", async () => {
    const llm = new MockLlmClient();
    const store = new Store(":memory:", llm.dim);
    await store.whenReady();
    const { app } = createApp({ settings: { pipeline: "rule", authToken: "" }, store, llm });

    const res = await app.request("/metrics");
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expectMetricsShape(body);
    // Mock client reports nothing -> honest zeros.
    expect(body.llm.calls).toBe(0);
    expect(body.embedding.calls).toBe(0);
    await store.close();
  });

  it("counters increase after a turn (usage-reporting client)", async () => {
    const llm = new UsageReportingClient();
    const store = new Store(":memory:", llm.dim);
    await store.whenReady();
    const { app } = createApp({ settings: { pipeline: "rule", authToken: "" }, store, llm });

    const before: any = await (await app.request("/metrics")).json();
    expect(before.llm.calls).toBe(0);
    expect(before.embedding.calls).toBe(0);

    const turn = await app.request("/turns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "m-s1",
        user_id: "m-user",
        messages: [{ role: "user", content: "I just joined Notion as a PM and I love hiking." }],
        metadata: {},
      }),
    });
    expect(turn.status).toBe(201);

    const after: any = await (await app.request("/metrics")).json();
    expectMetricsShape(after);
    // A turn embeds (turn text + candidate values) and runs reconcile/rerank etc.
    expect(after.embedding.calls).toBeGreaterThan(before.embedding.calls);
    expect(after.embedding.tokens).toBeGreaterThan(0);
    expect(after.llm.calls).toBeGreaterThan(before.llm.calls);
    expect(after.llm.input_tokens).toBeGreaterThan(0);
    expect(after.llm.output_tokens).toBeGreaterThan(0);
    await store.close();
  });
});
