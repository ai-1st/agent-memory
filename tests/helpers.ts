/**
 * Test helpers: build an app over an ephemeral in-memory pglite store with the
 * deterministic mock provider, and a tiny fetch wrapper over app.fetch.
 */

import { createApp } from "../src/app";
import { createMockProvider } from "../src/llm/mock";

export async function makeTestApp() {
  const bundle = createApp({
    dataDir: "memory://",
    llm: createMockProvider(),
    settings: { embeddingDim: 256, authToken: "" },
  });
  await bundle.ready;
  return bundle;
}

export interface Resp {
  status: number;
  body: any;
}

export function client(app: { fetch: (req: Request) => Response | Promise<Response> }) {
  async function call(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<Resp> {
    const init: RequestInit = {
      method,
      headers: { "content-type": "application/json", ...headers },
    };
    if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
    const res = await app.fetch(new Request(`http://test${path}`, init));
    const text = await res.text();
    let parsed: any = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
    }
    return { status: res.status, body: parsed };
  }
  return {
    get: (p: string, h?: Record<string, string>) => call("GET", p, undefined, h),
    post: (p: string, b?: unknown, h?: Record<string, string>) => call("POST", p, b, h),
    del: (p: string, h?: Record<string, string>) => call("DELETE", p, undefined, h),
    raw: call,
  };
}
