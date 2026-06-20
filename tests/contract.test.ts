import { beforeEach, describe, expect, it } from "vitest";
import { type Client, client } from "./helpers";

function turn(
  sessionId = "s1",
  userId = "u1",
  content = "I just moved to Berlin from NYC last month.",
) {
  return {
    session_id: sessionId,
    user_id: userId,
    messages: [
      { role: "user", content },
      { role: "assistant", content: "Nice!" },
    ],
    timestamp: "2025-03-15T10:30:00Z",
    metadata: {},
  };
}

describe("contract", () => {
  let c: Client;
  beforeEach(() => {
    c = client().c;
  });

  it("GET /health -> 200 ok", async () => {
    const r = await c.get("/health");
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("ok");
  });

  it("POST /turns -> 201 with id", async () => {
    const r = await c.post("/turns", turn());
    expect(r.status).toBe(201);
    expect(typeof r.body.id).toBe("string");
    expect(r.body.id.length).toBeGreaterThan(0);
  });

  it("POST /recall -> shape + content roundtrip", async () => {
    await c.post("/turns", turn());
    const r = await c.post("/recall", {
      query: "Where does this user live?",
      session_id: "probe",
      user_id: "u1",
      max_tokens: 512,
    });
    expect(r.status).toBe(200);
    expect(typeof r.body.context).toBe("string");
    expect(Array.isArray(r.body.citations)).toBe(true);
    expect(r.body.context.toLowerCase()).toContain("berlin");
    for (const cit of r.body.citations) {
      expect(cit).toHaveProperty("turn_id");
      expect(cit).toHaveProperty("score");
      expect(cit).toHaveProperty("snippet");
    }
  });

  it("POST /search -> structured results", async () => {
    await c.post("/turns", turn("s1", "u1", "I work at Stripe as an engineer."));
    const r = await c.post("/search", { query: "Stripe", user_id: "u1", limit: 5 });
    expect(r.status).toBe(200);
    expect(r.body.results.length).toBeGreaterThan(0);
    const first = r.body.results[0];
    for (const k of ["content", "score", "session_id", "timestamp", "metadata"]) {
      expect(first).toHaveProperty(k);
    }
  });

  it("GET /users/:id/memories -> structured, typed memories", async () => {
    await c.post("/turns", turn("s1", "u1", "I work at Stripe as an engineer."));
    const r = await c.get("/users/u1/memories");
    expect(r.status).toBe(200);
    expect(r.body.memories.length).toBeGreaterThan(0);
    const m = r.body.memories[0];
    for (const k of [
      "id",
      "type",
      "key",
      "value",
      "confidence",
      "source_session",
      "source_turn",
      "created_at",
      "updated_at",
      "supersedes",
      "active",
    ]) {
      expect(m).toHaveProperty(k);
    }
    expect(["fact", "preference", "opinion", "event"]).toContain(m.type);
  });

  it("POST /recall on a cold session -> empty, not error", async () => {
    const r = await c.post("/recall", {
      query: "anything",
      session_id: "never",
      user_id: "never",
      max_tokens: 256,
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ context: "", citations: [] });
  });

  it("DELETE /sessions/:id -> 204", async () => {
    await c.post("/turns", turn());
    const r = await c.del("/sessions/s1");
    expect(r.status).toBe(204);
  });

  it("DELETE /users/:id -> 204 and removes memories", async () => {
    await c.post("/turns", turn("s1", "u1", "I work at Stripe as an engineer."));
    expect((await c.get("/users/u1/memories")).body.memories.length).toBeGreaterThan(0);
    const r = await c.del("/users/u1");
    expect(r.status).toBe(204);
    expect((await c.get("/users/u1/memories")).body.memories).toEqual([]);
  });
});
