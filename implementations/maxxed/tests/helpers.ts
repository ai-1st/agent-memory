/**
 * Shared test harness. Builds the full app over an offline store + mock LLM, so
 * the contract suite drives the real extract->reconcile->hybrid-recall pipeline
 * with zero network calls.
 */

import type { Hono } from "hono";
import { createApp } from "../src/app";
import { MockLlmClient } from "../src/llm";
import { Store } from "../src/store";

export interface Harness {
  app: Hono;
  store: Store;
  request: (method: string, path: string, body?: unknown) => Promise<Response>;
  json: <T = any>(res: Response) => Promise<T>;
  close: () => Promise<void>;
}

export async function makeHarness(dbDir = ":memory:"): Promise<Harness> {
  const llm = new MockLlmClient();
  const store = new Store(dbDir, llm.dim);
  await store.whenReady();
  const { app } = createApp({ settings: { pipeline: "rule", authToken: "" }, store, llm });

  const request = async (method: string, path: string, body?: unknown): Promise<Response> =>
    app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  return {
    app,
    store,
    request,
    json: <T = any>(res: Response): Promise<T> => res.json() as Promise<T>,
    close: () => store.close(),
  };
}

export interface TurnSpec {
  session_id: string;
  user_id: string | null;
  text?: string;
  messages?: Array<{ role: string; content: string; name?: string | null }>;
  timestamp?: string;
}

export async function ingest(h: Harness, t: TurnSpec): Promise<string> {
  const res = await h.request("POST", "/turns", {
    session_id: t.session_id,
    user_id: t.user_id,
    messages: t.messages ?? [{ role: "user", content: t.text ?? "" }],
    timestamp: t.timestamp ?? null,
    metadata: {},
  });
  const body = (await res.json()) as { id: string };
  return body.id;
}

export async function recall(
  h: Harness,
  args: {
    query: string;
    user_id?: string | null;
    session_id?: string | null;
    max_tokens?: number;
    as_of?: string;
  },
): Promise<{ context: string; citations: any[] }> {
  const res = await h.request("POST", "/recall", {
    query: args.query,
    user_id: args.user_id ?? null,
    session_id: args.session_id ?? null,
    max_tokens: args.max_tokens ?? 512,
    as_of: args.as_of,
  });
  return res.json() as Promise<{ context: string; citations: any[] }>;
}
