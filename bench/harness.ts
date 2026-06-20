/**
 * HTTP benchmark harness — score a running memory service and compare variants.
 *
 * Talks to the service over HTTP only (the contract), so it is implementation-
 * agnostic: point it at any branch/container and compare the numbers.
 *
 *   npm run bench -- --label baseline
 *   MEMORY_BASE=http://localhost:8081 npm run bench -- --label maxxed
 *   npm run bench -- --compare
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const RESULTS_DIR = join(REPO, "bench", "results");
const DEFAULT_SCENARIO = join(REPO, "fixtures", "basic.json");

interface RunResult {
  label: string;
  scenario: string;
  passed: number;
  total: number;
  recall_quality: number;
  avg_turn_ms: number;
  avg_recall_ms: number;
  misses: string[];
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}
const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);

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

function checkProbe(context: string, probe: any): boolean {
  const ctx = (context ?? "").toLowerCase();
  if (probe.expect_empty) return ctx.trim() === "";
  if (probe.expect_all) return probe.expect_all.every((t: string) => ctx.includes(t.toLowerCase()));
  if (probe.expect_any) return probe.expect_any.some((t: string) => ctx.includes(t.toLowerCase()));
  return false;
}

const avg = (xs: number[]): number =>
  xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : 0;

async function run(
  base: string,
  scenarioPath: string,
  label: string,
  token: string | undefined,
  reset: boolean,
): Promise<RunResult> {
  const data = JSON.parse(readFileSync(scenarioPath, "utf-8"));
  let passed = 0;
  let total = 0;
  const turnMs: number[] = [];
  const recallMs: number[] = [];
  const misses: string[] = [];

  for (const scenario of data.scenarios) {
    const userId = scenario.user_id;
    if (reset && userId) await req("DELETE", `${base}/users/${userId}`, undefined, token);

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

    for (const probe of scenario.probes) {
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

  const result: RunResult = {
    label,
    scenario: scenarioPath.split("/").pop() ?? scenarioPath,
    passed,
    total,
    recall_quality: total ? Math.round((passed / total) * 1000) / 1000 : 0,
    avg_turn_ms: avg(turnMs),
    avg_recall_ms: avg(recallMs),
    misses,
  };
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(join(RESULTS_DIR, `${label}.json`), JSON.stringify(result, null, 2));
  return result;
}

function printResult(r: RunResult): void {
  console.log(`\n== ${r.label} (${r.scenario}) ==`);
  console.log(`recall quality : ${r.passed}/${r.total} (${Math.round(r.recall_quality * 100)}%)`);
  console.log(`avg ingest     : ${r.avg_turn_ms} ms`);
  console.log(`avg recall     : ${r.avg_recall_ms} ms`);
  for (const m of r.misses) console.log(`  MISS: ${m}`);
}

function compare(): void {
  let files: string[];
  try {
    files = readdirSync(RESULTS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    files = [];
  }
  if (files.length === 0) {
    console.log("no results in bench/results/ yet — run a benchmark first.");
    return;
  }
  const rows: RunResult[] = files.map((f) =>
    JSON.parse(readFileSync(join(RESULTS_DIR, f), "utf-8")),
  );
  rows.sort((a, b) => b.recall_quality - a.recall_quality);
  console.log(
    `\n${"label".padEnd(22)}${"quality".padEnd(14)}${"ingest ms".padEnd(12)}${"recall ms"}`,
  );
  console.log("-".repeat(58));
  for (const r of rows) {
    const q = `${r.passed}/${r.total} (${Math.round(r.recall_quality * 100)}%)`;
    console.log(
      `${r.label.padEnd(22)}${q.padEnd(14)}${String(r.avg_turn_ms).padEnd(12)}${r.avg_recall_ms}`,
    );
  }
}

async function main(): Promise<void> {
  if (hasFlag("compare")) {
    compare();
    return;
  }
  const base = (
    arg("base-url", process.env.MEMORY_BASE ?? "http://localhost:8080") as string
  ).replace(/\/$/, "");
  const scenario = arg("scenario", DEFAULT_SCENARIO) as string;
  const label = arg("label", "run") as string;
  const token = arg("token", process.env.MEMORY_AUTH_TOKEN || undefined);
  const reset = !hasFlag("no-reset");

  const result = await run(base, scenario, label, token, reset);
  printResult(result);
  compare();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
