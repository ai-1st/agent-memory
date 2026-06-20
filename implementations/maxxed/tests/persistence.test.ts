import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { MockLlmClient } from "../src/llm";
import { Store } from "../src/store";

describe("persistence across restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "maxxed-persist-"));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const build = async () => {
    const llm = new MockLlmClient();
    const store = new Store(dir, llm.dim);
    await store.whenReady();
    const { app } = createApp({ settings: { pipeline: "rule", authToken: "" }, store, llm });
    const request = (method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    return { store, request };
  };

  it("data written before a restart is recallable after (new Store, same dataDir)", async () => {
    // --- first boot: write some facts, then "shut down".
    const a = await build();
    const turn = await a.request("POST", "/turns", {
      session_id: "p-s1",
      user_id: "p-user",
      messages: [{ role: "user", content: "I live in Reykjavik and work at CCP Games." }],
      timestamp: "2026-04-01T10:00:00Z",
      metadata: {},
    });
    expect(turn.status).toBe(201);
    await a.store.close();

    // --- second boot: a fresh Store over the SAME directory.
    const b = await build();
    const recall = await b.request("POST", "/recall", {
      query: "where does the user live",
      user_id: "p-user",
      max_tokens: 256,
    });
    const body: any = await recall.json();
    expect(body.context.toLowerCase()).toContain("reykjavik");

    const mems: any = await (await b.request("GET", "/users/p-user/memories")).json();
    expect(mems.memories.length).toBeGreaterThan(0);
    await b.store.close();
  });
});
