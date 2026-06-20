import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, ingest, makeHarness, recall } from "./helpers";

describe("fact evolution, contradiction & supersession", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await makeHarness();
    await ingest(h, {
      session_id: "ev-s1",
      user_id: "ev-user",
      text: "I work at Stripe as an engineer.",
      timestamp: "2025-01-10T12:00:00Z",
    });
    await ingest(h, {
      session_id: "ev-s3",
      user_id: "ev-user",
      text: "I just joined Notion as a PM.",
      timestamp: "2025-03-20T12:00:00Z",
    });
  });
  afterAll(async () => {
    await h.close();
  });

  it("returns the CURRENT fact from recall (Notion), not the stale one (Stripe)", async () => {
    const r = await recall(h, { query: "where does the user work", user_id: "ev-user" });
    expect(r.context.toLowerCase()).toContain("notion");
  });

  it("keeps the supersession chain inspectable via /users/:id/memories", async () => {
    const body: any = await (await h.request("GET", "/users/ev-user/memories")).json();
    const employment = body.memories.filter((m: any) => m.key === "employment");
    expect(employment.length).toBe(2);

    const active = employment.find((m: any) => m.active);
    const inactive = employment.find((m: any) => !m.active);
    expect(active.value.toLowerCase()).toContain("notion");
    expect(inactive.value.toLowerCase()).toContain("stripe");
    // The active row points back to the superseded row.
    expect(active.supersedes).toBe(inactive.id);
    // History preserves the old fact, not deletes it.
    expect(inactive.active).toBe(false);
  });

  it("records every decision in the audit history ledger", async () => {
    const body: any = await (await h.request("GET", "/users/ev-user/history")).json();
    expect(Array.isArray(body.history)).toBe(true);
    const decisions = body.history.map((x: any) => x.decision);
    expect(decisions).toContain("ADD");
    expect(decisions).toContain("SUPERSEDE");
  });

  it("recall surfaces the prior value as history context", async () => {
    const r = await recall(h, { query: "where does the user work", user_id: "ev-user" });
    // The assembled profile line notes the previous employer.
    expect(r.context.toLowerCase()).toContain("previously");
    expect(r.context.toLowerCase()).toContain("stripe");
  });

  it("deleting the contradicting session reverts the active fact", async () => {
    const h2 = await makeHarness();
    await ingest(h2, {
      session_id: "rv-s1",
      user_id: "rv-user",
      text: "I work at Stripe.",
      timestamp: "2025-01-10T12:00:00Z",
    });
    await ingest(h2, {
      session_id: "rv-s3",
      user_id: "rv-user",
      text: "I just joined Notion.",
      timestamp: "2025-03-20T12:00:00Z",
    });
    await h2.request("DELETE", "/sessions/rv-s3");
    const r = await recall(h2, { query: "where does the user work", user_id: "rv-user" });
    // Notion was only in s3; after deletion Stripe should be the visible employer.
    expect(r.context.toLowerCase()).not.toContain("notion");
    expect(r.context.toLowerCase()).toContain("stripe");
    await h2.close();
  });

  it("opinion arc: latest stance is active, prior preserved as history", async () => {
    const h3 = await makeHarness();
    await ingest(h3, {
      session_id: "op-s1",
      user_id: "op-user",
      text: "I love TypeScript.",
      timestamp: "2026-01-05T10:00:00Z",
    });
    await ingest(h3, {
      session_id: "op-s2",
      user_id: "op-user",
      text: "I dislike TypeScript now.",
      timestamp: "2026-03-05T10:00:00Z",
    });
    const body: any = await (await h3.request("GET", "/users/op-user/memories")).json();
    const ts = body.memories.filter((m: any) => m.key.includes("typescript"));
    expect(ts.length).toBeGreaterThanOrEqual(2);
    const active = ts.find((m: any) => m.active);
    expect(active.value.toLowerCase()).toContain("dislike");
    await h3.close();
  });
});
