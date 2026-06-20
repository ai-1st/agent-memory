import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, makeHarness, recall } from "./helpers";

describe("robustness — never crash, sensible errors", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await makeHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it("malformed JSON body -> 4xx, not a crash", async () => {
    const res = await h.app.request("/turns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not valid json ",
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("missing required fields -> 422", async () => {
    const res = await h.request("POST", "/turns", { user_id: "x" }); // no session_id, no messages
    expect(res.status).toBe(422);
  });

  it("empty messages array -> 422", async () => {
    const res = await h.request("POST", "/turns", {
      session_id: "s",
      user_id: "x",
      messages: [],
    });
    expect(res.status).toBe(422);
  });

  it("null user_id is accepted (anonymous session)", async () => {
    const res = await h.request("POST", "/turns", {
      session_id: "anon-s",
      user_id: null,
      messages: [{ role: "user", content: "Just chatting." }],
      timestamp: null,
      metadata: {},
    });
    expect(res.status).toBe(201);
  });

  it("unicode / emoji / RTL content is handled and recallable", async () => {
    const res = await h.request("POST", "/turns", {
      session_id: "uni-s",
      user_id: "uni-user",
      messages: [
        { role: "user", content: "I live in 東京 (Tokyo) 🗼 and my name is Łukasz. مرحبا" },
        { role: "assistant", content: "素晴らしい!" },
      ],
      timestamp: "2026-01-01T00:00:00Z",
      metadata: { note: "naïve café — 日本語 — 🎌" },
    });
    expect(res.status).toBe(201);
    const r = await recall(h, { query: "Where does the user live?", user_id: "uni-user" });
    expect(r.context.toLowerCase()).toContain("tokyo");
  });

  it("oversized payload does not crash the service", async () => {
    const huge = "word ".repeat(50000); // ~250KB of text
    const res = await h.request("POST", "/turns", {
      session_id: "big-s",
      user_id: "big-user",
      messages: [{ role: "user", content: `I live in Paris. ${huge}` }],
      timestamp: null,
      metadata: {},
    });
    expect(res.status).toBe(201);
    // Service still responsive afterward.
    const health = await h.request("GET", "/health");
    expect(health.status).toBe(200);
  });

  it("content as null on a message is tolerated", async () => {
    const res = await h.request("POST", "/turns", {
      session_id: "n-s",
      user_id: "n-user",
      messages: [{ role: "tool", name: "search", content: null }],
      timestamp: null,
      metadata: {},
    });
    expect(res.status).toBe(201);
  });

  it("recall with empty query string returns gracefully", async () => {
    const r = await recall(h, { query: "", user_id: "uni-user" });
    expect(typeof r.context).toBe("string");
  });
});
