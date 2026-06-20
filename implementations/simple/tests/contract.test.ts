/**
 * Contract roundtrip + shape compliance for all seven endpoints (§3).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TestApp, makeApp, offlineSettings, rmDir, tempDataDir } from "./helpers";

describe("contract", () => {
  let dir: string;
  let t: TestApp;

  beforeAll(async () => {
    dir = tempDataDir();
    t = await makeApp(offlineSettings({ dataDir: dir }));
  });

  afterAll(async () => {
    await t.store.close();
    rmDir(dir);
  });

  it("GET /health returns 200", async () => {
    const r = await t.get("/health");
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("ok");
  });

  it("POST /turns -> 201 with an id, then /recall surfaces the fact", async () => {
    const turn = await t.post("/turns", {
      session_id: "c1",
      user_id: "u_contract",
      messages: [
        { role: "user", content: "I just moved to Berlin from NYC last month." },
        { role: "assistant", content: "Welcome to Berlin!" },
      ],
      timestamp: "2026-03-15T10:30:00Z",
      metadata: {},
    });
    expect(turn.status).toBe(201);
    expect(typeof turn.body.id).toBe("string");

    const recall = await t.post("/recall", {
      query: "Where does this user live?",
      session_id: "c2",
      user_id: "u_contract",
      max_tokens: 512,
    });
    expect(recall.status).toBe(200);
    expect(typeof recall.body.context).toBe("string");
    expect(Array.isArray(recall.body.citations)).toBe(true);
    expect(recall.body.context).toContain("Berlin");
    // Citation shape.
    const cit = recall.body.citations[0];
    expect(cit).toHaveProperty("turn_id");
    expect(cit).toHaveProperty("score");
    expect(cit).toHaveProperty("snippet");
  });

  it("GET /users/:id/memories returns structured, typed rows with provenance", async () => {
    const r = await t.get("/users/u_contract/memories");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.memories)).toBe(true);
    const m = r.body.memories.find((x: any) => x.key === "location");
    expect(m).toBeTruthy();
    expect(m.type).toBe("fact");
    expect(m.value).toContain("Berlin");
    expect(typeof m.confidence).toBe("number");
    expect(m).toHaveProperty("source_turn");
    expect(m).toHaveProperty("source_session");
    expect(m).toHaveProperty("created_at");
    expect(m).toHaveProperty("updated_at");
    expect(m).toHaveProperty("supersedes");
    expect(m.active).toBe(true);
  });

  it("POST /search returns structured results (different shape from recall)", async () => {
    const r = await t.post("/search", {
      query: "Berlin",
      user_id: "u_contract",
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

  it("cold /recall returns empty context, never errors", async () => {
    const r = await t.post("/recall", {
      query: "What is the user's favorite programming language?",
      session_id: "cold",
      user_id: "nobody_here",
      max_tokens: 512,
    });
    expect(r.status).toBe(200);
    expect(r.body.context).toBe("");
    expect(r.body.citations).toEqual([]);
  });

  it("DELETE /sessions/:id -> 204", async () => {
    const r = await t.del("/sessions/c1");
    expect(r.status).toBe(204);
  });

  it("DELETE /users/:id -> 204 and clears the user", async () => {
    const r = await t.del("/users/u_contract");
    expect(r.status).toBe(204);
    const after = await t.get("/users/u_contract/memories");
    expect(after.body.memories).toEqual([]);
  });
});
