import { describe, expect, it } from "vitest";
import { client } from "./helpers";

describe("robustness", () => {
  it("malformed JSON -> 422, process stays up", async () => {
    const { c } = client();
    const r = await c.postRaw("/turns", "{not valid json");
    expect(r.status).toBe(422);
    expect((await c.get("/health")).status).toBe(200);
  });

  it("missing required fields -> 422", async () => {
    const { c } = client();
    expect((await c.post("/turns", { user_id: "u1" })).status).toBe(422); // no session_id/messages
    expect((await c.post("/turns", { session_id: "s1", messages: [] })).status).toBe(422); // empty msgs
  });

  it("unicode does not crash", async () => {
    const { c } = client();
    const weird = "emoji 🧠🔥, RTL ‮ابجد‬, zero-width​, NUL-ish �, 𝓯𝓪𝓷𝓬𝔂";
    const r = await c.post("/turns", {
      session_id: "s-uni",
      user_id: "u-uni",
      messages: [{ role: "user", content: weird }],
      timestamp: "2025-06-01T00:00:00Z",
      metadata: { x: weird },
    });
    expect(r.status).toBe(201);
    expect((await c.get("/users/u-uni/memories")).status).toBe(200);
  });

  it("oversized payload does not crash", async () => {
    const { c } = client();
    const big = "I live in Berlin. ".repeat(20000); // ~360 KB
    const r = await c.post("/turns", {
      session_id: "s-big",
      user_id: "u-big",
      messages: [{ role: "user", content: big }],
      timestamp: "2025-06-01T00:00:00Z",
      metadata: {},
    });
    expect([201, 413]).toContain(r.status);
    expect((await c.get("/health")).status).toBe(200);
  });

  it("recall with missing query -> 422", async () => {
    const { c } = client();
    expect((await c.post("/recall", { session_id: "s", user_id: "u" })).status).toBe(422);
  });
});
