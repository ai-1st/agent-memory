/**
 * Test helpers. Every test runs OFFLINE: provider forced to "mock", store in a
 * fresh temp directory. `makeClient` wraps the Hono app in a tiny fetch-style
 * client so contract tests read like HTTP calls.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { createApp } from "../src/app";
import { type Settings, loadSettings } from "../src/config";
import type { Store } from "../src/store";

export function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "simple-mem-"));
}

export function rmDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function offlineSettings(overrides: Partial<Settings> = {}): Settings {
  return loadSettings({
    provider: "mock",
    authToken: "",
    compaction: true,
    openaiApiKey: "",
    anthropicApiKey: "",
    ...overrides,
  });
}

export interface TestApp {
  app: Hono;
  store: Store;
  get(path: string): Promise<{ status: number; body: any }>;
  post(path: string, body: unknown): Promise<{ status: number; body: any }>;
  del(path: string): Promise<{ status: number; body: any }>;
}

export async function makeApp(settings: Settings): Promise<TestApp> {
  const { app, store } = await createApp(settings);

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
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
  };

  return {
    app,
    store,
    get: (p) => call("GET", p),
    post: (p, b) => call("POST", p, b),
    del: (p) => call("DELETE", p),
  };
}

/** Post a raw (possibly invalid) body to test malformed-input handling. */
export async function postRaw(app: Hono, path: string, raw: string) {
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw,
  });
  const text = await res.text();
  return { status: res.status, text };
}
