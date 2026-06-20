/**
 * Hono application implementing the memory-service HTTP contract (§3).
 *
 * `createApp(opts)` builds the app over a given pglite dataDir and LLM provider
 * so tests can use an in-memory store + a mock provider, and "restart" is just
 * constructing a new app over the same dataDir.
 *
 * Endpoints are synchronous by contract: when POST /turns returns, extracted
 * memories are already committed (pglite writes are awaited) and queryable.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { makeAuth } from "./auth";
import { type Settings, loadSettings } from "./config";
import { type LLMProvider, buildProvider } from "./llm";
import { recallRequestSchema, searchRequestSchema, turnRequestSchema } from "./models";
import { IngestPipeline } from "./pipeline/ingest";
import { RecallPipeline } from "./pipeline/recall";
import { Store } from "./store";

export interface AppBundle {
  app: Hono;
  store: Store;
  llm: LLMProvider;
  ready: Promise<void>;
}

export interface CreateAppOptions {
  settings?: Partial<Settings>;
  /** Inject a provider directly (tests). Overrides settings.llmMode. */
  llm?: LLMProvider;
  /** Override the pglite dataDir ("memory://" for an ephemeral store). */
  dataDir?: string;
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

export function createApp(opts: CreateAppOptions = {}): AppBundle {
  const settings = { ...loadSettings(), ...opts.settings };
  if (opts.dataDir) settings.dataDir = opts.dataDir;

  const llm = opts.llm ?? buildProvider(settings);
  const store = new Store(settings.dataDir, settings.embeddingDim);
  const ingest = new IngestPipeline(llm, store);
  const recall = new RecallPipeline(llm, store);

  const ready = store.init();

  const app = new Hono();
  app.use("*", makeAuth(settings.authToken));

  // Robustness: never crash the process on an unexpected error.
  app.onError((err, c) => {
    console.error("unhandled error:", err);
    return c.json({ error: "internal error" }, 500);
  });

  app.get("/health", (c) => c.json({ status: "ok" }));

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

    // 1) Persist the raw turn verbatim FIRST — it is the source of truth and
    //    must be citable even if extraction later fails.
    const turnId = await store.insertTurn({
      sessionId: req.session_id,
      userId: req.user_id ?? null,
      messages,
      timestamp: req.timestamp ?? null,
      metadata: req.metadata,
    });

    // 2-4) Synchronous extract -> per-fact reconcile -> apply (incl. links).
    try {
      await ingest.run(messages, {
        userId: req.user_id ?? null,
        sessionId: req.session_id,
        turnId,
        timestamp: req.timestamp ?? null,
      });
    } catch (err) {
      // Raw turn already persisted; extraction failure must not fail the write.
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
    const r = await recall.run({
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
    let embedding: number[] | null = null;
    if (req.query.trim()) {
      try {
        const [emb] = await llm.embed([req.query]);
        embedding = emb ?? null;
      } catch (err) {
        console.warn("search embed failed, falling back to lexical:", err);
      }
    }
    const results = await store.search({
      query: req.query,
      embedding,
      userId: req.user_id ?? null,
      sessionId: req.session_id ?? null,
      limit: req.limit,
    });
    return c.json({ results });
  });

  app.get("/users/:user_id/memories", async (c) => {
    const rows = await store.listMemories(c.req.param("user_id"), false);
    const ids = rows.map((r) => r.id);
    const linkMap = new Map<string, string[]>();
    for (const id of ids) {
      const links = await store.linksOf(id);
      const contradicts = links.filter((l) => l.kind === "contradiction").map((l) => l.id);
      if (contradicts.length > 0) linkMap.set(id, contradicts);
    }
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
      active: r.active,
      // extension over the reference shape: surface the contradiction graph.
      contradicts: linkMap.get(r.id) ?? [],
    }));
    return c.json({ memories });
  });

  app.delete("/sessions/:session_id", async (c) => {
    await store.deleteSession(c.req.param("session_id"));
    return c.body(null, 204);
  });

  app.delete("/users/:user_id", async (c) => {
    await store.deleteUser(c.req.param("user_id"));
    return c.body(null, 204);
  });

  return { app, store, llm, ready };
}
