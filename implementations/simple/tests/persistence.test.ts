/**
 * Persistence across "restart": write turns, close the store, build a NEW app
 * over the SAME pglite data dir, and confirm memories + recall survive. This is
 * exactly what `docker compose down && up` does (the volume is the data dir).
 */

import { afterAll, describe, expect, it } from "vitest";
import { makeApp, offlineSettings, rmDir, tempDataDir } from "./helpers";

describe("persistence across restart", () => {
  const dir = tempDataDir();

  afterAll(() => rmDir(dir));

  it("memories written before restart are recallable after restart", async () => {
    // --- "session before restart" ---
    const a = await makeApp(offlineSettings({ dataDir: dir }));
    const turn = await a.post("/turns", {
      session_id: "p1",
      user_id: "u_persist",
      messages: [{ role: "user", content: "I work at Stripe as an engineer." }],
      timestamp: "2026-01-15T09:00:00Z",
      metadata: {},
    });
    expect(turn.status).toBe(201);
    await a.store.close();

    // --- "restart": new app, same directory ---
    const b = await makeApp(offlineSettings({ dataDir: dir }));
    const mems = await b.get("/users/u_persist/memories");
    expect(mems.body.memories.some((m: any) => m.value.includes("Stripe"))).toBe(true);

    const recall = await b.post("/recall", {
      query: "Where does the user work?",
      session_id: "p2",
      user_id: "u_persist",
      max_tokens: 512,
    });
    expect(recall.body.context).toContain("Stripe");
    await b.store.close();
  });
});
