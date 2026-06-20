import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";

// Hermetic + offline: force the deterministic baseline and clear any auth token
// before the app reads settings.
process.env.MEMORY_EXTRACTOR = "baseline";
process.env.MEMORY_RECALLER = "baseline";
process.env.MEMORY_AUTH_TOKEN = "";

const { createApp } = await import("../src/app");

export function newDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "memsvc-")), "memory.db");
}

export interface Res {
  status: number;
  body: any;
}

export class Client {
  constructor(private app: Hono) {}

  async get(path: string): Promise<Res> {
    return wrap(await this.app.request(path));
  }
  async post(path: string, body: unknown): Promise<Res> {
    return wrap(
      await this.app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }
  async postRaw(path: string, body: string): Promise<Res> {
    return wrap(
      await this.app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );
  }
  async del(path: string): Promise<Res> {
    return wrap(await this.app.request(path, { method: "DELETE" }));
  }
}

async function wrap(r: Response): Promise<Res> {
  const text = await r.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: r.status, body };
}

/** A client over a fresh temp DB (or a given path, to simulate restart). */
export function client(dbPath: string = newDbPath()): { c: Client; dbPath: string } {
  const { app } = createApp(dbPath);
  return { c: new Client(app), dbPath };
}
