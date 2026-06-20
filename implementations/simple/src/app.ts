/**
 * The Hono app — the whole HTTP contract (§3) in one readable file.
 *
 * `createApp(settings)` builds the app over a store + provider so tests can use a
 * temp data dir and a mock provider; "restart" is just constructing a new app
 * over the same directory. Endpoints are synchronous by contract: when
 * POST /turns returns, the extracted memories are already committed and queryable.
 *
 * The ingestion pipeline is intentionally linear (no async orchestration):
 *   persist turn -> one LLM extraction pass -> embed each memory -> upsert with
 *   the supersession rule. Extraction/embedding failures never fail the write.
 */

import type { Context } from "hono";
import { Hono } from "hono";
import { makeAuth } from "./auth";
import type { Settings } from "./config";
import { snapshot as metricsSnapshot } from "./metrics";
import { recallRequestSchema, searchRequestSchema, turnRequestSchema } from "./models";
import type { Provider } from "./provider";
import { Recaller } from "./recall";
import { Store } from "./store";
import { keywordOverlap, tokenSet } from "./text";

export interface AppBundle {
  app: Hono;
  store: Store;
  provider: Provider;
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

const turnText = (
  messages: Array<{ role: string; content: string; name?: string | null }>,
): string =>
  messages
    .map((m) => `${m.role}: ${m.content ?? ""}`.trim())
    .join("\n")
    .trim();

/**
 * Build the app. Pass an explicit store/provider in tests; otherwise they are
 * constructed from settings. The caller MUST await `store.init()` (done here).
 */
export async function createApp(
  settings: Settings,
  deps?: { store?: Store; provider?: Provider },
): Promise<AppBundle> {
  const store = deps?.store ?? new Store(settings.dataDir);
  await store.init();
  const provider = deps?.provider ?? (await import("./provider")).buildProvider(settings);
  const recaller = new Recaller(store, provider, settings.compaction);

  const app = new Hono();
  app.use("*", makeAuth(settings.authToken));

  // Robustness: never crash the process on an unexpected error.
  app.onError((err, c) => {
    console.error("unhandled error:", err);
    return c.json({ error: "internal error" }, 500);
  });

  app.get("/health", (c) => c.json({ status: "ok" }));

  // Cumulative token spend since process start, in the exact shape the benchmark
  // harness diffs across a run:
  //   { llm: { calls, input_tokens, output_tokens },
  //     embedding: { calls, tokens } }
  app.get("/metrics", (c) => c.json(metricsSnapshot()));

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

    // Snapshot token counters so we can log THIS turn's spend (the delta) once
    // the embed + extract + per-memory embed work below has run.
    const before = metricsSnapshot();

    const text = turnText(messages);
    let turnEmbedding: number[] | null = null;
    try {
      turnEmbedding = await provider.embed(text, "embed_turn");
    } catch (err) {
      console.warn("turn embed failed (continuing):", err);
    }

    const turnId = await store.insertTurn({
      sessionId: req.session_id,
      userId: req.user_id ?? null,
      messages,
      timestamp: req.timestamp ?? null,
      metadata: req.metadata,
      text,
      embedding: turnEmbedding,
    });

    // Extraction + per-memory embedding. Failures must not fail the write — the
    // turn is already persisted and recoverable via /search and recent turns.
    try {
      const extracted = await provider.extract(req.messages, req.timestamp ?? null);
      for (const em of extracted) {
        let memEmbedding: number[] | null = null;
        try {
          memEmbedding = await provider.embed(`${em.key} ${em.value}`, "embed_memory");
        } catch {
          memEmbedding = null;
        }
        await store.addMemory(
          em,
          { userId: req.user_id ?? null, sessionId: req.session_id, sourceTurn: turnId },
          memEmbedding,
        );
      }
    } catch (err) {
      console.warn(`extraction error on turn ${turnId}:`, err);
    }

    // Concise per-turn token line: this turn's LLM + embedding spend (the delta
    // from the snapshot above). Mock provider reports zero tokens.
    const after = metricsSnapshot();
    console.log(
      `[turn ${turnId}] llm_calls=${after.llm.calls - before.llm.calls} ` +
        `in=${after.llm.input_tokens - before.llm.input_tokens} ` +
        `out=${after.llm.output_tokens - before.llm.output_tokens} ` +
        `embed_calls=${after.embedding.calls - before.embedding.calls} ` +
        `embed_tokens=${after.embedding.tokens - before.embedding.tokens}`,
    );

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
    const qset = tokenSet(req.query);
    const queryEmbedding = await provider.embed(req.query, "embed_query");
    const results = await store.search(
      req.query,
      queryEmbedding,
      { userId: req.user_id ?? null, sessionId: req.session_id ?? null, limit: req.limit },
      (text) => keywordOverlap(qset, text),
    );
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
      source_session: r.source_session,
      source_turn: r.source_turn,
      created_at: r.created_at,
      updated_at: r.updated_at,
      supersedes: r.supersedes,
      active: r.active,
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

  return { app, store, provider };
}
