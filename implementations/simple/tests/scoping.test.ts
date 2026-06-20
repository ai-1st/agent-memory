/**
 * Cross-session / cross-user scoping. Two users' facts must not bleed. We DO
 * intentionally share knowledge across sessions for the SAME user (documented in
 * the README) — a follow-up in a new session still sees the profile.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TestApp, makeApp, offlineSettings, rmDir, tempDataDir } from "./helpers";

describe("scoping", () => {
  let dir: string;
  let t: TestApp;

  beforeAll(async () => {
    dir = tempDataDir();
    t = await makeApp(offlineSettings({ dataDir: dir }));
    await t.post("/turns", {
      session_id: "alice_s1",
      user_id: "alice",
      messages: [{ role: "user", content: "I live in Paris." }],
      timestamp: "2026-01-01T00:00:00Z",
      metadata: {},
    });
    await t.post("/turns", {
      session_id: "bob_s1",
      user_id: "bob",
      messages: [{ role: "user", content: "I live in Tokyo." }],
      timestamp: "2026-01-01T00:00:00Z",
      metadata: {},
    });
  });

  afterAll(async () => {
    await t.store.close();
    rmDir(dir);
  });

  it("different users do not bleed", async () => {
    const aliceMem = await t.get("/users/alice/memories");
    expect(aliceMem.body.memories.some((m: any) => m.value.includes("Paris"))).toBe(true);
    expect(aliceMem.body.memories.some((m: any) => m.value.includes("Tokyo"))).toBe(false);

    const r = await t.post("/recall", {
      query: "Where does the user live?",
      session_id: "alice_probe",
      user_id: "alice",
      max_tokens: 256,
    });
    expect(r.body.context).toContain("Paris");
    expect(r.body.context).not.toContain("Tokyo");
  });

  it("same user is shared across sessions (intentional)", async () => {
    // Recall in a brand-new session for alice still sees her profile.
    const r = await t.post("/recall", {
      query: "Where does the user live?",
      session_id: "alice_brand_new_session",
      user_id: "alice",
      max_tokens: 256,
    });
    expect(r.body.context).toContain("Paris");
  });
});
