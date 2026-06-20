import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, ingest, makeHarness, recall } from "./helpers";

describe("multi-hop recall via entity-link graph", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await makeHarness();
    await ingest(h, {
      session_id: "mh-s1",
      user_id: "mh-user",
      text: "I have a dog named Biscuit, a corgi.",
      timestamp: "2026-01-10T09:00:00Z",
    });
    await ingest(h, {
      session_id: "mh-s2",
      user_id: "mh-user",
      text: "I live in New York City.",
      timestamp: "2026-01-11T09:00:00Z",
    });
  });
  afterAll(async () => {
    await h.close();
  });

  it("resolves 'city of the owner of the dog named Biscuit' (two-hop)", async () => {
    const r = await recall(h, {
      query: "What city does the owner of the dog named Biscuit live in?",
      user_id: "mh-user",
    });
    const ctx = r.context.toLowerCase();
    expect(ctx).toContain("biscuit");
    expect(ctx).toContain("new york");
  });

  it("builds entity links between co-referent memories", async () => {
    const body: any = await (await h.request("GET", "/users/mh-user/graph")).json();
    expect(Array.isArray(body.links)).toBe(true);
    expect(body.links.length).toBeGreaterThan(0);
  });
});

describe("temporal / as-of recall", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await makeHarness();
    await ingest(h, {
      session_id: "t-s1",
      user_id: "t-user",
      text: "I work at Stripe.",
      timestamp: "2026-01-10T12:00:00Z",
    });
    await ingest(h, {
      session_id: "t-s2",
      user_id: "t-user",
      text: "I just joined Notion.",
      timestamp: "2026-03-20T12:00:00Z",
    });
  });
  afterAll(async () => {
    await h.close();
  });

  it("default recall returns the current employer (Notion)", async () => {
    const r = await recall(h, { query: "where does the user work", user_id: "t-user" });
    expect(r.context.toLowerCase()).toContain("notion");
  });

  it("as_of before the job change returns the time-correct employer (Stripe)", async () => {
    const r = await recall(h, {
      query: "where does the user work",
      user_id: "t-user",
      as_of: "2026-02-01T00:00:00Z",
    });
    const ctx = r.context.toLowerCase();
    expect(ctx).toContain("stripe");
    expect(ctx).not.toContain("notion");
  });

  it("memories carry valid_from observed-time", async () => {
    const body: any = await (await h.request("GET", "/users/t-user/memories")).json();
    const withValid = body.memories.filter((m: any) => m.valid_from);
    expect(withValid.length).toBeGreaterThan(0);
  });
});
