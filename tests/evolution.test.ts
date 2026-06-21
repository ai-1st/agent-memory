/**
 * Fact-evolution tests: supersession (UPDATE), reinforcement, and the
 * design-specific CONTRADICTION behaviour (link-don't-delete + recall narration).
 */

import { describe, expect, it } from "vitest";
import { client, makeTestApp } from "./helpers";

describe("fact evolution", () => {
  it("job change supersedes the old fact (history preserved, current returned)", async () => {
    const { app } = await makeTestApp();
    const c = client(app);
    await c.post("/turns", {
      session_id: "s1",
      user_id: "bob",
      messages: [{ role: "user", content: "I work at Stripe as an engineer." }],
      timestamp: "2025-01-10T12:00:00Z",
      metadata: {},
    });
    await c.post("/turns", {
      session_id: "s3",
      user_id: "bob",
      messages: [{ role: "user", content: "I just joined Notion as a PM." }],
      timestamp: "2025-03-20T12:00:00Z",
      metadata: {},
    });

    const mem = await c.get("/users/bob/memories");
    const employment = mem.body.memories.filter((m: any) => m.key === "employment");
    // both rows present (history preserved)
    expect(employment.length).toBe(2);
    const active = employment.filter((m: any) => m.active);
    const inactive = employment.filter((m: any) => !m.active);
    expect(active.length).toBe(1);
    expect(inactive.length).toBe(1);
    expect(active[0].value.toLowerCase()).toContain("notion");
    expect(inactive[0].value.toLowerCase()).toContain("stripe");
    // supersession chain recorded
    expect(active[0].supersedes).toBe(inactive[0].id);

    // recall returns current, not stale
    const r = await c.post("/recall", {
      query: "where does the user work now",
      user_id: "bob",
      session_id: "probe",
      max_tokens: 256,
    });
    expect(r.body.context.toLowerCase()).toContain("notion");
  });

  it("restating the same fact reinforces (no duplicate row)", async () => {
    const { app } = await makeTestApp();
    const c = client(app);
    for (let i = 0; i < 2; i++) {
      await c.post("/turns", {
        session_id: `s${i}`,
        user_id: "dee",
        messages: [{ role: "user", content: "I just moved to Berlin from NYC." }],
        timestamp: "2025-03-01T00:00:00Z",
        metadata: {},
      });
    }
    const mem = await c.get("/users/dee/memories");
    const locations = mem.body.memories.filter((m: any) => m.key === "location");
    expect(locations.length).toBe(1);
  });

  it("CONTRADICTION: oranges -> apples is linked (both kept) and narrated in recall", async () => {
    const { app } = await makeTestApp();
    const c = client(app);
    await c.post("/turns", {
      session_id: "c1",
      user_id: "carol",
      messages: [
        { role: "user", content: "Honestly I really like oranges, I eat them every morning." },
      ],
      timestamp: "2025-02-01T08:00:00Z",
      metadata: {},
    });
    await c.post("/turns", {
      session_id: "c2",
      user_id: "carol",
      messages: [
        { role: "user", content: "These days I prefer apples, oranges feel too acidic now." },
      ],
      timestamp: "2025-04-10T08:00:00Z",
      metadata: {},
    });

    const mem = await c.get("/users/carol/memories");
    const memories: any[] = mem.body.memories;
    const apples = memories.find((m) => /apple/i.test(m.value));
    const oranges = memories.find((m) => /orange/i.test(m.value));
    expect(apples).toBeTruthy();
    expect(oranges).toBeTruthy();
    // link-don't-delete: BOTH stay active
    expect(apples.active).toBe(true);
    expect(oranges.active).toBe(true);
    // two-way contradiction link present
    expect(apples.contradicts).toContain(oranges.id);
    expect(oranges.contradicts).toContain(apples.id);

    // recall follows the link and narrates the change (both fruits surface)
    const r = await c.post("/recall", {
      query: "what fruit does the user prefer",
      user_id: "carol",
      session_id: "probe",
      max_tokens: 400,
    });
    const ctx = r.body.context.toLowerCase();
    expect(ctx).toContain("apple");
    expect(ctx).toContain("orange");
    // narration cues
    expect(/chang|previous|reversed|used to|now/.test(ctx)).toBe(true);
  });

  it("recall always follows a contradiction link even when query only matches one side", async () => {
    const { app } = await makeTestApp();
    const c = client(app);
    await c.post("/turns", {
      session_id: "c1",
      user_id: "ed",
      messages: [{ role: "user", content: "I really like oranges." }],
      timestamp: "2025-02-01T08:00:00Z",
      metadata: {},
    });
    await c.post("/turns", {
      session_id: "c2",
      user_id: "ed",
      messages: [{ role: "user", content: "Actually I prefer apples now." }],
      timestamp: "2025-04-10T08:00:00Z",
      metadata: {},
    });
    // query mentions apples; oranges must still be pulled via the link
    const r = await c.post("/recall", {
      query: "tell me about apples for this user",
      user_id: "ed",
      session_id: "probe",
      max_tokens: 400,
    });
    const ctx = r.body.context.toLowerCase();
    expect(ctx).toContain("apple");
    expect(ctx).toContain("orange");
  });
});
