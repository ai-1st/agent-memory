/**
 * Hono application implementing the memory-service HTTP contract (§3).
 *
 * `createApp(dbPath?)` builds the app over a given database so tests can use a
 * temp file and so "restart" is just constructing a new app over the same file.
 * Endpoints are synchronous by contract: when POST /turns returns, extracted
 * memories are already committed and queryable.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { makeAuth } from "./auth";
import { loadSettings } from "./config";
import { buildExtractor } from "./extraction";
import { recallRequestSchema, searchRequestSchema, turnRequestSchema } from "./models";
import { buildRecaller } from "./recall";
import { Store } from "./store";

export interface AppBundle {
  app: Hono;
  store: Store;
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

export function createApp(dbPath?: string): AppBundle {
  const settings = loadSettings();
  if (dbPath) settings.dbPath = dbPath;

  const store = new Store(settings.dbPath);
  store.init();
  const extractor = buildExtractor(settings);
  const recaller = buildRecaller(settings, store);

  const app = new Hono();
  app.use("*", makeAuth(settings.authToken));

  // Robustness: never crash the process on an unexpected error.
  app.onError((err, c) => {
    console.error("unhandled error:", err);
    return c.json({ error: "internal error" }, 500);
  });

  app.get("/health", (c) => c.json({ status: "ok" }));

  // Token-spend metrics. The baseline uses no LLM/embeddings, so these are always
  // zero — exposed for parity with the LLM builds so the benchmark harness can
  // diff /metrics uniformly across implementations.
  app.get("/metrics", (c) =>
    c.json({
      llm: { calls: 0, input_tokens: 0, output_tokens: 0 },
      embedding: { calls: 0, tokens: 0 },
    }),
  );

  app.post("/turns", async (c) => {
    const parsed = turnRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return c.json({ error: "invalid request", detail: parsed.error.issues }, 422);
    }
    const req = parsed.data;
    const messages = req.messages.map((m) => ({
      role: m.role,
      content: m.content ?? "",
      name: m.name ?? null,
    }));
    const turnId = store.insertTurn({
      sessionId: req.session_id,
      userId: req.user_id ?? null,
      messages,
      timestamp: req.timestamp ?? null,
      metadata: req.metadata,
    });
    try {
      const extracted = extractor.extract(req.messages, {
        userId: req.user_id ?? null,
        sessionId: req.session_id,
        turnId,
        timestamp: req.timestamp ?? null,
      });
      for (const em of extracted) {
        store.addMemory(em, {
          userId: req.user_id ?? null,
          sessionId: req.session_id,
          sourceTurn: turnId,
        });
      }
    } catch (err) {
      // Persistence already succeeded; extraction failures must not fail the write.
      console.warn(`extraction error on turn ${turnId}:`, err);
    }
    return c.json({ id: turnId }, 201);
  });

  app.post("/recall", async (c) => {
    const parsed = recallRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return c.json({ error: "invalid request", detail: parsed.error.issues }, 422);
    }
    const req = parsed.data;
    const r = recaller.recall({
      query: req.query,
      userId: req.user_id ?? null,
      sessionId: req.session_id ?? null,
      maxTokens: req.max_tokens,
    });
    return c.json({ context: r.context, citations: r.citations });
  });

  app.post("/search", async (c) => {
    const parsed = searchRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return c.json({ error: "invalid request", detail: parsed.error.issues }, 422);
    }
    const req = parsed.data;
    const results = store.search(req.query, {
      userId: req.user_id ?? null,
      sessionId: req.session_id ?? null,
      limit: req.limit,
    });
    return c.json({ results });
  });

  app.get("/users/:user_id/memories", (c) => {
    const rows = store.listMemories(c.req.param("user_id"), false);
    const memories = rows.map((r) => ({
      id: r.id,
      type: r.type,
      key: r.key,
      value: r.value,
      confidence: r.confidence,
      source_session: r.source_session,
      source_turn: r.source_turn,
      created_at: r.created_at,
      updated_at: r.updated_at,
      supersedes: r.supersedes,
      active: Boolean(r.active),
    }));
    return c.json({ memories });
  });

  app.delete("/sessions/:session_id", (c) => {
    store.deleteSession(c.req.param("session_id"));
    return c.body(null, 204);
  });

  app.delete("/users/:user_id", (c) => {
    store.deleteUser(c.req.param("user_id"));
    return c.body(null, 204);
  });

  return { app, store };
}
