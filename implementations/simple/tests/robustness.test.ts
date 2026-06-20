/**
 * Robustness: malformed JSON, missing fields, unicode, oversized-ish payloads.
 * The service must answer 4xx (not crash) and stay up.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TestApp, makeApp, offlineSettings, postRaw, rmDir, tempDataDir } from "./helpers";

describe("robustness", () => {
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

  it("malformed JSON -> 422, not a crash", async () => {
    const r = await postRaw(t.app, "/turns", "{not valid json");
    expect(r.status).toBe(422);
  });

  it("missing required fields -> 422", async () => {
    const r = await t.post("/turns", { user_id: "x" }); // no session_id, no messages
    expect(r.status).toBe(422);
  });

  it("empty messages array -> 422", async () => {
    const r = await t.post("/turns", {
      session_id: "s",
      user_id: "x",
      messages: [],
      timestamp: "2026-01-01T00:00:00Z",
    });
    expect(r.status).toBe(422);
  });

  it("unicode + emoji content is ingested and recallable", async () => {
    const turn = await t.post("/turns", {
      session_id: "uni1",
      user_id: "u_unicode",
      messages: [
        { role: "user", content: "私の名前は太郎です。 I moved to Zürich 🇨🇭 last week. café ☕" },
        { role: "assistant", content: "Willkommen in Zürich! 🎉" },
      ],
      timestamp: "2026-04-01T00:00:00Z",
      metadata: { tags: ["emoji-✓"] },
    });
    expect(turn.status).toBe(201);

    const r = await t.post("/recall", {
      query: "Where did the user move?",
      session_id: "uni_probe",
      user_id: "u_unicode",
      max_tokens: 256,
    });
    expect(r.status).toBe(200);
    expect(r.body.context).toContain("Zürich");
  });

  it("null user_id is accepted (session-only turn)", async () => {
    const turn = await t.post("/turns", {
      session_id: "anon1",
      user_id: null,
      messages: [{ role: "user", content: "Just a passing thought about the weather." }],
      timestamp: "2026-04-01T00:00:00Z",
      metadata: {},
    });
    expect(turn.status).toBe(201);
    // Recall on a null-user session must not crash.
    const r = await t.post("/recall", {
      query: "weather",
      session_id: "anon1",
      user_id: null,
      max_tokens: 128,
    });
    expect(r.status).toBe(200);
  });

  it("oversized payload is handled (no crash, valid 201/4xx)", async () => {
    const big = "I really like coffee. ".repeat(5000);
    const turn = await t.post("/turns", {
      session_id: "big1",
      user_id: "u_big",
      messages: [{ role: "user", content: big }],
      timestamp: "2026-04-01T00:00:00Z",
      metadata: {},
    });
    expect([201, 413, 422]).toContain(turn.status);
    // Service still alive.
    const h = await t.get("/health");
    expect(h.status).toBe(200);
  });

  it("recall with empty query string -> 200 (no crash)", async () => {
    const r = await t.post("/recall", {
      query: "",
      session_id: "s",
      user_id: "u_big",
      max_tokens: 128,
    });
    expect(r.status).toBe(200);
  });

  it("sentence-initial capitalization is extracted (My/I at start of sentence)", async () => {
    // Regression: leading keywords must match either case, not just lowercase.
    await t.post("/turns", {
      session_id: "cap1",
      user_id: "u_cap",
      messages: [{ role: "user", content: "My dog is named Biscuit." }],
      timestamp: "2026-04-01T00:00:00Z",
      metadata: {},
    });
    const mems = await t.get("/users/u_cap/memories");
    expect(mems.body.memories.some((m: any) => m.value.includes("Biscuit"))).toBe(true);
  });
});
