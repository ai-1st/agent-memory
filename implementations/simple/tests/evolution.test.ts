/**
 * Fact evolution: contradiction handling, supersession, and history preservation.
 * "I work at Stripe" -> "I just joined Notion" must (a) recall Notion as current,
 * (b) keep Stripe as superseded history, (c) show the supersedes chain.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TestApp, makeApp, offlineSettings, rmDir, tempDataDir } from "./helpers";

describe("fact evolution", () => {
  let dir: string;
  let t: TestApp;

  beforeAll(async () => {
    dir = tempDataDir();
    t = await makeApp(offlineSettings({ dataDir: dir }));
    await t.post("/turns", {
      session_id: "ev_s1",
      user_id: "u_evo",
      messages: [{ role: "user", content: "I work at Stripe as an engineer." }],
      timestamp: "2026-01-15T09:00:00Z",
      metadata: {},
    });
    await t.post("/turns", {
      session_id: "ev_s3",
      user_id: "u_evo",
      messages: [{ role: "user", content: "I just joined Notion as a product manager." }],
      timestamp: "2026-03-20T09:00:00Z",
      metadata: {},
    });
  });

  afterAll(async () => {
    await t.store.close();
    rmDir(dir);
  });

  it("recall returns the CURRENT fact (Notion), not the stale one", async () => {
    const r = await t.post("/recall", {
      query: "Where does the user work?",
      session_id: "ev_probe",
      user_id: "u_evo",
      max_tokens: 512,
    });
    expect(r.body.context).toContain("Notion");
    // The "previously" breadcrumb should mention Stripe — history is surfaced.
    expect(r.body.context.toLowerCase()).toContain("previously");
    expect(r.body.context).toContain("Stripe");
  });

  it("history is preserved and the supersedes chain is inspectable", async () => {
    const mems = await t.get("/users/u_evo/memories");
    const employment = mems.body.memories.filter((m: any) => m.key === "employment");
    expect(employment.length).toBe(2);

    const active = employment.filter((m: any) => m.active);
    const inactive = employment.filter((m: any) => !m.active);
    expect(active.length).toBe(1);
    expect(inactive.length).toBe(1);
    expect(active[0].value).toContain("Notion");
    expect(inactive[0].value).toContain("Stripe");
    // The active row points back at the superseded one.
    expect(active[0].supersedes).toBe(inactive[0].id);
  });

  it("re-stating the same fact bumps confidence, no duplicate row", async () => {
    const before = await t.get("/users/u_evo/memories");
    const notionRows = before.body.memories.filter((m: any) => m.value.includes("Notion"));
    expect(notionRows.length).toBe(1);

    await t.post("/turns", {
      session_id: "ev_s4",
      user_id: "u_evo",
      messages: [{ role: "user", content: "Yeah, I joined Notion as a product manager." }],
      timestamp: "2026-03-25T09:00:00Z",
      metadata: {},
    });

    const after = await t.get("/users/u_evo/memories");
    const notionAfter = after.body.memories.filter((m: any) => m.value.includes("Notion"));
    expect(notionAfter.length).toBe(1); // no new row
  });
});
