/**
 * Hono application implementing the memory-service HTTP contract (§3).
 *
 * createApp(opts) builds the app over a Store + LlmClient. Tests inject a temp
 * dbDir + the mock client so the whole pipeline runs offline; production uses a
 * persisted pglite dir + the AI SDK client. Endpoints are synchronous by
 * contract: when POST /turns returns, extraction + embedding + indexing have all
 * been awaited and committed, so memories are immediately queryable.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { makeAuth } from "./auth";
import { type Settings, loadSettings } from "./config";
import { buildExtractor } from "./extraction";
import { buildLlmClient } from "./llm";
import type { LlmClient } from "./llm/types";
import { recallRequestSchema, searchRequestSchema, turnRequestSchema } from "./models";
import { buildRecaller } from "./recall";
import { search } from "./search";
import { Store } from "./store";

export interface AppBundle {
  app: Hono;
  store: Store;
  llm: LlmClient;
}

export interface CreateAppOptions {
  settings?: Partial<Settings>;
  store?: Store;
  llm?: LlmClient;
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

export function createApp(opts: CreateAppOptions = {}): AppBundle {
  const settings = loadSettings(opts.settings);
  const llm = opts.llm ?? buildLlmClient(settings);
  const store = opts.store ?? new Store(settings.dbDir, llm.dim);

  const extractor = buildExtractor(store, llm);
  const recaller = buildRecaller(store, llm);

  const app = new Hono();
  app.use("*", makeAuth(settings.authToken));

  app.onError((err, c) => {
    console.error("unhandled error:", err);
    return c.json({ error: "internal error" }, 500);
  });

  app.get("/health", async (c) => {
    try {
      await store.whenReady();
      return c.json({ status: "ok", pipeline: settings.pipeline, llm: llm.kind });
    } catch {
      return c.json({ status: "starting" }, 503);
    }
  });

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

    // Embed the whole turn so /recall and /search vector search work on turns too.
    const turnText = messages
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n")
      .trim();
    let turnEmbedding: number[] | null = null;
    try {
      turnEmbedding = await llm.embed(turnText);
    } catch (err) {
      console.warn("turn embed failed:", (err as Error).message);
    }

    const turnId = await store.insertTurn({
      sessionId: req.session_id,
      userId: req.user_id ?? null,
      messages,
      timestamp: req.timestamp ?? null,
      metadata: req.metadata ?? {},
      embedding: turnEmbedding,
    });

    try {
      await extractor.extract(req.messages, {
        userId: req.user_id ?? null,
        sessionId: req.session_id,
        turnId,
        timestamp: req.timestamp ?? null,
      });
    } catch (err) {
      // Persistence already succeeded; extraction failure must not fail the write.
      console.warn(`extraction error on turn ${turnId}:`, (err as Error).message);
    }

    return c.json({ id: turnId }, 201);
  });

  app.post("/recall", async (c) => {
    const parsed = recallRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return c.json({ error: "invalid request", detail: parsed.error.issues }, 422);
    }
    const req = parsed.data;
    const r = await recaller.recall({
      query: req.query,
      userId: req.user_id ?? null,
      sessionId: req.session_id ?? null,
      asOf: req.as_of ?? null,
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
    const results = await search(store, llm, {
      query: req.query,
      userId: req.user_id ?? null,
      sessionId: req.session_id ?? null,
      limit: req.limit,
    });
    return c.json({ results });
  });

  app.get("/users/:user_id/memories", async (c) => {
    const rows = await store.listMemories(c.req.param("user_id"), false);
    const memories = rows.map((r) => ({
      id: r.id,
      type: r.type,
      key: r.key,
      value: r.value,
      confidence: r.confidence,
      importance: r.importance,
      entities: r.entities,
      source_session: r.source_session,
      source_turn: r.source_turn,
      valid_from: r.valid_from,
      valid_to: r.valid_to,
      created_at: r.created_at,
      updated_at: r.updated_at,
      supersedes: r.supersedes,
      active: r.active,
    }));
    return c.json({ memories });
  });

  // Bonus inspection endpoints (admin) — handy for the human review, off-contract.
  app.get("/users/:user_id/history", async (c) => {
    const history = await store.historyForUser(c.req.param("user_id"));
    return c.json({ history });
  });
  app.get("/users/:user_id/graph", async (c) => {
    const links = await store.getLinks(c.req.param("user_id"));
    return c.json({ links });
  });

  app.delete("/sessions/:session_id", async (c) => {
    await store.deleteSession(c.req.param("session_id"));
    return c.body(null, 204);
  });

  app.delete("/users/:user_id", async (c) => {
    await store.deleteUser(c.req.param("user_id"));
    return c.body(null, 204);
  });

  return { app, store, llm };
}
