/**
 * HTTP benchmark harness — score a running maxxed service over the contract.
 *
 * Talks to the service over HTTP only, so it works against either the offline
 * (rule) or live (llm) pipeline, in-process or in Docker. Same probe format as
 * the root harness (expect_any / expect_all / expect_empty).
 *
 *   MEMORY_BASE=http://localhost:8093 npm run bench
 *   npm run bench -- --scenario fixtures/quality.json --label maxxed-live
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const RESULTS_DIR = join(ROOT, "bench", "results");
const DEFAULT_SCENARIO = join(ROOT, "fixtures", "quality.json");

interface Probe {
  query: string;
  session_id?: string;
  max_tokens?: number;
  expect_any?: string[];
  expect_all?: string[];
  expect_empty?: boolean;
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}

async function req(
  method: string,
  url: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = {};
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { error: text };
    }
  }
  return { status: res.status, body: parsed };
}

function checkProbe(context: string, probe: Probe): boolean {
  const ctx = (context ?? "").toLowerCase();
  if (probe.expect_empty) return ctx.trim() === "";
  const all = probe.expect_all
    ? probe.expect_all.every((t) => ctx.includes(t.toLowerCase()))
    : true;
  const any = probe.expect_any ? probe.expect_any.some((t) => ctx.includes(t.toLowerCase())) : true;
  return all && any;
}

const avg = (xs: number[]): number =>
  xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : 0;

async function main(): Promise<void> {
  const base = (
    arg("base-url", process.env.MEMORY_BASE ?? "http://localhost:8093") as string
  ).replace(/\/$/, "");
  const scenarioPath = arg("scenario", DEFAULT_SCENARIO) as string;
  const label = arg("label", "maxxed") as string;
  const token = arg("token", process.env.MEMORY_AUTH_TOKEN || undefined);

  const data = JSON.parse(readFileSync(scenarioPath, "utf-8"));
  let passed = 0;
  let total = 0;
  const turnMs: number[] = [];
  const recallMs: number[] = [];
  const misses: string[] = [];

  for (const scenario of data.scenarios) {
    const userId = scenario.user_id;
    if (userId) await req("DELETE", `${base}/users/${userId}`, undefined, token);

    for (const t of scenario.turns) {
      const t0 = performance.now();
      const r = await req(
        "POST",
        `${base}/turns`,
        {
          session_id: t.session_id,
          user_id: userId,
          messages: t.messages,
          timestamp: t.timestamp ?? null,
          metadata: t.metadata ?? {},
        },
        token,
      );
      turnMs.push(performance.now() - t0);
      if (r.status !== 201) misses.push(`[${scenario.name}] ingest failed: HTTP ${r.status}`);
    }

    for (const probe of scenario.probes as Probe[]) {
      total++;
      const t0 = performance.now();
      const r = await req(
        "POST",
        `${base}/recall`,
        {
          query: probe.query,
          session_id: probe.session_id ?? null,
          user_id: userId,
          max_tokens: probe.max_tokens ?? 512,
        },
        token,
      );
      recallMs.push(performance.now() - t0);
      const ctx = r.status === 200 ? (r.body.context ?? "") : "";
      if (checkProbe(ctx, probe)) passed++;
      else misses.push(`[${scenario.name}] ${probe.query}`);
    }
  }

  const result = {
    label,
    scenario: scenarioPath.split("/").pop(),
    passed,
    total,
    recall_quality: total ? Math.round((passed / total) * 1000) / 1000 : 0,
    avg_turn_ms: avg(turnMs),
    avg_recall_ms: avg(recallMs),
    misses,
  };
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(join(RESULTS_DIR, `${label}.json`), JSON.stringify(result, null, 2));

  console.log(`\n== ${label} (${result.scenario}) ==`);
  console.log(`recall quality : ${passed}/${total} (${Math.round(result.recall_quality * 100)}%)`);
  console.log(`avg ingest     : ${result.avg_turn_ms} ms`);
  console.log(`avg recall     : ${result.avg_recall_ms} ms`);
  for (const m of misses) console.log(`  MISS: ${m}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
