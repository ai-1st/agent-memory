import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, ingest, makeHarness, recall } from "./helpers";

describe("cross-session & cross-user scoping", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await makeHarness();
    // Two different users.
    await ingest(h, { session_id: "u1-s1", user_id: "user-1", text: "I live in Berlin." });
    await ingest(h, { session_id: "u2-s1", user_id: "user-2", text: "I live in Tokyo." });
    // Same user, two sessions — knowledge SHOULD be shared per-user by design.
    await ingest(h, { session_id: "u1-s2", user_id: "user-1", text: "I have a dog named Rex." });
  });
  afterAll(async () => {
    await h.close();
  });

  it("different users do not bleed", async () => {
    const r1 = await recall(h, { query: "where does the user live", user_id: "user-1" });
    expect(r1.context.toLowerCase()).toContain("berlin");
    expect(r1.context.toLowerCase()).not.toContain("tokyo");

    const r2 = await recall(h, { query: "where does the user live", user_id: "user-2" });
    expect(r2.context.toLowerCase()).toContain("tokyo");
    expect(r2.context.toLowerCase()).not.toContain("berlin");
  });

  it("same user shares knowledge across sessions (intentional, documented)", async () => {
    // Probe from a brand-new session id — should still see facts from u1-s1/u1-s2.
    const r = await recall(h, {
      query: "what pet does the user have and where do they live",
      user_id: "user-1",
      session_id: "u1-fresh-probe",
    });
    expect(r.context.toLowerCase()).toContain("rex");
    expect(r.context.toLowerCase()).toContain("berlin");
  });

  it("deleting one user leaves the other intact", async () => {
    await h.request("DELETE", "/users/user-2");
    const r1 = await recall(h, { query: "where does the user live", user_id: "user-1" });
    expect(r1.context.toLowerCase()).toContain("berlin");
    const mems2: any = await (await h.request("GET", "/users/user-2/memories")).json();
    expect(mems2.memories).toEqual([]);
  });
});
