import { describe, expect, it } from "vitest";
import { client } from "./helpers";

function jobTurn(sessionId: string, value: string) {
  return {
    session_id: sessionId,
    user_id: "bob",
    messages: [{ role: "user", content: value }],
    timestamp: "2025-01-01T00:00:00Z",
    metadata: {},
  };
}

describe("fact evolution", () => {
  it("a job change supersedes the old fact (history preserved)", async () => {
    const { c } = client();
    await c.post("/turns", jobTurn("bob-s1", "I work at Stripe as an engineer."));
    await c.post("/turns", jobTurn("bob-s3", "I just joined Notion as a PM."));

    const mems = (await c.get("/users/bob/memories")).body.memories;
    const employment = mems.filter((m: any) => m.key === "employment");
    expect(employment.length).toBe(2); // old + new

    const active = employment.filter((m: any) => m.active);
    const superseded = employment.filter((m: any) => !m.active);
    expect(active.length).toBe(1);
    expect(active[0].value.toLowerCase()).toContain("notion");
    expect(superseded.length).toBe(1);
    expect(superseded[0].value.toLowerCase()).toContain("stripe");
    expect(active[0].supersedes).toBe(superseded[0].id);
  });

  it("recall returns the current job", async () => {
    const { c } = client();
    await c.post("/turns", jobTurn("bob-s1", "I work at Stripe as an engineer."));
    await c.post("/turns", jobTurn("bob-s3", "I just joined Notion as a PM."));
    const ctx = (
      await c.post("/recall", {
        query: "Where does the user work now?",
        session_id: "p",
        user_id: "bob",
        max_tokens: 512,
      })
    ).body.context.toLowerCase();
    expect(ctx).toContain("notion");
  });
});
