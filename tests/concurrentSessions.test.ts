import { describe, expect, it } from "vitest";
import { type Client, client } from "./helpers";

function turn(sessionId: string, userId: string, content: string) {
  return {
    session_id: sessionId,
    user_id: userId,
    messages: [{ role: "user", content }],
    timestamp: "2025-05-01T00:00:00Z",
    metadata: {},
  };
}

describe("cross-session scoping", () => {
  it("two users' data does not bleed", async () => {
    const { c } = client();
    await c.post("/turns", turn("sess-a", "alice", "I live in Paris."));
    await c.post("/turns", turn("sess-b", "bob", "I live in Tokyo."));

    const a = (
      await c.post("/recall", {
        query: "where do they live",
        session_id: "sess-a",
        user_id: "alice",
        max_tokens: 256,
      })
    ).body.context.toLowerCase();
    const b = (
      await c.post("/recall", {
        query: "where do they live",
        session_id: "sess-b",
        user_id: "bob",
        max_tokens: 256,
      })
    ).body.context.toLowerCase();

    expect(a).toContain("paris");
    expect(a).not.toContain("tokyo");
    expect(b).toContain("tokyo");
    expect(b).not.toContain("paris");
  });

  it("user memories are scoped per user", async () => {
    const { c }: { c: Client } = client();
    await c.post("/turns", turn("sess-a", "alice", "I live in Paris."));
    await c.post("/turns", turn("sess-b", "bob", "I live in Tokyo."));
    const alice = (await c.get("/users/alice/memories")).body.memories;
    expect(alice.length).toBeGreaterThan(0);
    expect(alice.every((m: any) => !m.value.toLowerCase().includes("tokyo"))).toBe(true);
  });
});
