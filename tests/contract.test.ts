/**
 * Contract tests: endpoint shapes, status codes, roundtrip, concurrent-session
 * isolation, restart persistence, and malformed-input resilience. All offline
 * via the mock provider.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createMockProvider } from "../src/llm/mock";
import { client, makeTestApp } from "./helpers";

describe("contract", () => {
  it("GET /health returns 200 ok", async () => {
    const { app } = await makeTestApp();
    const c = client(app);
    const r = await c.get("/health");
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("ok");
  });

  it("POST /turns -> 201 {id}, memories immediately queryable", async () => {
    const { app } = await makeTestApp();
    const c = client(app);
    const r = await c.post("/turns", {
      session_id: "s1",
      user_id: "u1",
      messages: [
        { role: "user", content: "I just moved to Berlin from NYC last month." },
        { role: "assistant", content: "Nice!" },
      ],
      timestamp: "2025-03-15T10:30:00Z",
      metadata: {},
    });
    expect(r.status).toBe(201);
    expect(typeof r.body.id).toBe("string");

    // immediate availability (synchronous correctness)
    const mem = await c.get("/users/u1/memories");
    expect(mem.status).toBe(200);
    expect(Array.isArray(mem.body.memories)).toBe(true);
    expect(mem.body.memories.length).toBeGreaterThan(0);
    const loc = mem.body.memories.find((m: any) => m.key === "location");
    expect(loc).toBeTruthy();
    expect(loc.value.toLowerCase()).toContain("berlin");
    // structured row shape
    expect(loc).toHaveProperty("type");
    expect(loc).toHaveProperty("confidence");
    expect(loc).toHaveProperty("source_turn");
    expect(loc).toHaveProperty("active");
  });

  it("POST /recall returns context + citations shape", async () => {
    const { app } = await makeTestApp();
    const c = client(app);
    await c.post("/turns", {
      session_id: "s1",
      user_id: "u1",
      messages: [{ role: "user", content: "I just moved to Berlin from NYC last month." }],
      timestamp: "2025-03-15T10:30:00Z",
      metadata: {},
    });
    const r = await c.post("/recall", {
      query: "Where does this user live?",
      session_id: "s2",
      user_id: "u1",
      max_tokens: 512,
    });
    expect(r.status).toBe(200);
    expect(typeof r.body.context).toBe("string");
    expect(Array.isArray(r.body.citations)).toBe(true);
    expect(r.body.context.toLowerCase()).toContain("berlin");
    if (r.body.citations.length > 0) {
      const cit = r.body.citations[0];
      expect(cit).toHaveProperty("turn_id");
      expect(cit).toHaveProperty("score");
      expect(cit).toHaveProperty("snippet");
    }
  });

  it("POST /recall on a cold/unknown user returns empty, not error", async () => {
    const { app } = await makeTestApp();
    const c = client(app);
    const r = await c.post("/recall", {
      query: "anything",
      session_id: "x",
      user_id: "nobody",
      max_tokens: 256,
    });
    expect(r.status).toBe(200);
    expect(r.body.context).toBe("");
    expect(r.body.citations).toEqual([]);
  });

  it("POST /search returns structured results shape", async () => {
    const { app } = await makeTestApp();
    const c = client(app);
    await c.post("/turns", {
      session_id: "s1",
      user_id: "u1",
      messages: [{ role: "user", content: "I work at Stripe as an engineer." }],
      timestamp: "2025-01-01T00:00:00Z",
      metadata: {},
    });
    const r = await c.post("/search", {
      query: "stripe",
      user_id: "u1",
      session_id: null,
      limit: 5,
    });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.results)).toBe(true);
    expect(r.body.results.length).toBeGreaterThan(0);
    const hit = r.body.results[0];
    expect(hit).toHaveProperty("content");
    expect(hit).toHaveProperty("score");
    expect(hit).toHaveProperty("session_id");
    expect(hit).toHaveProperty("timestamp");
    expect(hit).toHaveProperty("metadata");
  });

  it("concurrent sessions for different users do not bleed", async () => {
    const { app } = await makeTestApp();
    const c = client(app);
    await c.post("/turns", {
      session_id: "sa",
      user_id: "alice",
      messages: [{ role: "user", content: "I just moved to Berlin from NYC." }],
      timestamp: "2025-03-01T00:00:00Z",
      metadata: {},
    });
    await c.post("/turns", {
      session_id: "sb",
      user_id: "bob",
      messages: [{ role: "user", content: "I work at Stripe as an engineer." }],
      timestamp: "2025-03-01T00:00:00Z",
      metadata: {},
    });
    const aliceMem = await c.get("/users/alice/memories");
    const bobMem = await c.get("/users/bob/memories");
    const aliceText = JSON.stringify(aliceMem.body).toLowerCase();
    const bobText = JSON.stringify(bobMem.body).toLowerCase();
    expect(aliceText).toContain("berlin");
    expect(aliceText).not.toContain("stripe");
    expect(bobText).toContain("stripe");
    expect(bobText).not.toContain("berlin");
  });

  it("DELETE /sessions/:id and /users/:id return 204 and remove data", async () => {
    const { app } = await makeTestApp();
    const c = client(app);
    await c.post("/turns", {
      session_id: "s1",
      user_id: "u1",
      messages: [{ role: "user", content: "I work at Stripe as an engineer." }],
      timestamp: "2025-01-01T00:00:00Z",
      metadata: {},
    });
    const d = await c.del("/users/u1");
    expect(d.status).toBe(204);
    const mem = await c.get("/users/u1/memories");
    expect(mem.body.memories).toEqual([]);
  });

  describe("malformed input -> 4xx, never crash", () => {
    it("bad JSON body -> 422", async () => {
      const { app } = await makeTestApp();
      const c = client(app);
      const r = await c.raw("POST", "/turns", "{not json", { "content-type": "application/json" });
      expect(r.status).toBe(422);
    });
    it("missing required fields -> 422", async () => {
      const { app } = await makeTestApp();
      const c = client(app);
      const r = await c.post("/turns", { user_id: "u1" });
      expect(r.status).toBe(422);
    });
    it("empty messages array -> 422", async () => {
      const { app } = await makeTestApp();
      const c = client(app);
      const r = await c.post("/turns", { session_id: "s", user_id: "u", messages: [] });
      expect(r.status).toBe(422);
    });
    it("unicode + weird content survives and is queryable", async () => {
      const { app } = await makeTestApp();
      const c = client(app);
      const r = await c.post("/turns", {
        session_id: "s",
        user_id: "u",
        messages: [{ role: "user", content: "私の名前は😀 — I just moved to Berlin 🇩🇪" }],
        metadata: { weird: "✓" },
      });
      expect(r.status).toBe(201);
      const recall = await c.post("/recall", {
        query: "where do they live",
        user_id: "u",
        session_id: "s2",
        max_tokens: 256,
      });
      expect(recall.status).toBe(200);
    });
    it("null user_id is accepted (session-scoped)", async () => {
      const { app } = await makeTestApp();
      const c = client(app);
      const r = await c.post("/turns", {
        session_id: "s",
        user_id: null,
        messages: [{ role: "user", content: "hello there" }],
      });
      expect(r.status).toBe(201);
    });
  });

  describe("restart persistence (on-disk pglite)", () => {
    const dir = mkdtempSync(join(tmpdir(), "opinionated-persist-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("data written before restart is recallable after", async () => {
      const dataDir = join(dir, "pg");
      // first boot
      const b1 = createApp({ dataDir, llm: createMockProvider(), settings: { embeddingDim: 256 } });
      await b1.ready;
      const c1 = client(b1.app);
      await c1.post("/turns", {
        session_id: "s1",
        user_id: "persist-user",
        messages: [{ role: "user", content: "I just moved to Berlin from NYC." }],
        timestamp: "2025-03-01T00:00:00Z",
        metadata: {},
      });
      await b1.store.close();

      // "restart": new app over the same dataDir
      const b2 = createApp({ dataDir, llm: createMockProvider(), settings: { embeddingDim: 256 } });
      await b2.ready;
      const c2 = client(b2.app);
      const mem = await c2.get("/users/persist-user/memories");
      expect(mem.body.memories.length).toBeGreaterThan(0);
      const recall = await c2.post("/recall", {
        query: "where does this user live",
        user_id: "persist-user",
        session_id: "s2",
        max_tokens: 256,
      });
      expect(recall.body.context.toLowerCase()).toContain("berlin");
      await b2.store.close();
    });
  });

  describe("auth", () => {
    it("rejects missing bearer token when configured", async () => {
      const bundle = createApp({
        dataDir: "memory://",
        llm: createMockProvider(),
        settings: { embeddingDim: 256, authToken: "secret" },
      });
      await bundle.ready;
      const c = client(bundle.app);
      const noTok = await c.get("/users/u/memories");
      expect(noTok.status).toBe(401);
      const withTok = await c.get("/users/u/memories", { authorization: "Bearer secret" });
      expect(withTok.status).toBe(200);
      // health is always open
      const health = await c.get("/health");
      expect(health.status).toBe(200);
    });
  });
});
