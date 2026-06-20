import { describe, expect, it } from "vitest";
import { client, newDbPath } from "./helpers";

describe("persistence", () => {
  it("data survives a restart (new app over the same DB file)", async () => {
    const dbPath = newDbPath();

    const first = client(dbPath).c;
    const r = await first.post("/turns", {
      session_id: "s1",
      user_id: "u1",
      messages: [{ role: "user", content: "I live in Lisbon." }],
      timestamp: "2025-04-01T00:00:00Z",
      metadata: {},
    });
    expect(r.status).toBe(201);

    // New app instance over the same db_path == a container restart.
    const second = client(dbPath).c;
    const mems = (await second.get("/users/u1/memories")).body.memories;
    expect(mems.some((m: any) => m.value.toLowerCase().includes("lisbon"))).toBe(true);

    const ctx = (
      await second.post("/recall", {
        query: "where does the user live",
        session_id: "p",
        user_id: "u1",
        max_tokens: 256,
      })
    ).body.context.toLowerCase();
    expect(ctx).toContain("lisbon");
  });
});
