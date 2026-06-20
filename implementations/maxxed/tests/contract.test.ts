import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, ingest, makeHarness, recall } from "./helpers";

describe("HTTP contract", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await makeHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it("GET /health returns 200 ok", async () => {
    const res = await h.request("GET", "/health");
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.status).toBe("ok");
  });

  it("POST /turns -> 201 { id }, recallable immediately (sync correctness)", async () => {
    const res = await h.request("POST", "/turns", {
      session_id: "c-s1",
      user_id: "c-user",
      messages: [
        { role: "user", content: "I live in Lisbon and I have a cat named Mochi." },
        { role: "assistant", content: "Lisbon is lovely!" },
      ],
      timestamp: "2026-05-01T10:00:00Z",
      metadata: { channel: "web" },
    });
    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(typeof body.id).toBe("string");
    expect(body.id.length).toBeGreaterThan(0);

    // No eventual-consistency window: queryable right away.
    const r = await recall(h, { query: "Where does the user live?", user_id: "c-user" });
    expect(r.context.toLowerCase()).toContain("lisbon");
  });

  it("POST /recall returns { context, citations } with citation shape", async () => {
    const r = await recall(h, { query: "what pet does the user have?", user_id: "c-user" });
    expect(typeof r.context).toBe("string");
    expect(Array.isArray(r.citations)).toBe(true);
    if (r.citations.length > 0) {
      const cit = r.citations[0];
      expect(cit).toHaveProperty("turn_id");
      expect(cit).toHaveProperty("score");
      expect(cit).toHaveProperty("snippet");
      expect(typeof cit.score).toBe("number");
    }
  });

  it("POST /recall on a cold session returns empty, never errors", async () => {
    const r = await recall(h, { query: "anything", user_id: "no-such-user" });
    expect(r.context).toBe("");
    expect(r.citations).toEqual([]);
  });

  it("POST /search returns structured results with the contract shape", async () => {
    const res = await h.request("POST", "/search", {
      query: "Mochi",
      user_id: "c-user",
      session_id: null,
      limit: 5,
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results.length).toBeGreaterThan(0);
    const r = body.results[0];
    expect(r).toHaveProperty("content");
    expect(r).toHaveProperty("score");
    expect(r).toHaveProperty("session_id");
    expect(r).toHaveProperty("timestamp");
    expect(r).toHaveProperty("metadata");
  });

  it("GET /users/:id/memories returns typed structured memories (not raw text)", async () => {
    const res = await h.request("GET", "/users/c-user/memories");
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(Array.isArray(body.memories)).toBe(true);
    expect(body.memories.length).toBeGreaterThan(0);
    const m = body.memories[0];
    for (const k of ["id", "type", "key", "value", "confidence", "active", "created_at"]) {
      expect(m).toHaveProperty(k);
    }
    expect(["fact", "preference", "opinion", "event"]).toContain(m.type);
  });

  it("DELETE /sessions/:id returns 204 and removes session data", async () => {
    await ingest(h, { session_id: "del-s", user_id: "del-user", text: "I work at Acme." });
    const res = await h.request("DELETE", "/sessions/del-s");
    expect(res.status).toBe(204);
    const r = await recall(h, { query: "where does the user work", user_id: "del-user" });
    expect(r.context.toLowerCase()).not.toContain("acme");
  });

  it("DELETE /users/:id returns 204 and removes all user data", async () => {
    await ingest(h, { session_id: "du-s", user_id: "du-user", text: "I live in Oslo." });
    const res = await h.request("DELETE", "/users/du-user");
    expect(res.status).toBe(204);
    const mems: any = await (await h.request("GET", "/users/du-user/memories")).json();
    expect(mems.memories).toEqual([]);
  });
});
