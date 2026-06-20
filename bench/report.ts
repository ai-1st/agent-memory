#!/usr/bin/env -S npx tsx
/**
 * Comparison report: runs the SAME shared benchmark against every implementation
 * and checks each against the assignment's formal requirements.
 *
 * Two parts (mirrors ASSIGNMENT.md §9):
 *   A. Formal requirements — static repo checks + live contract probing.
 *   B. Shared benchmark — one fixture, run identically against all services,
 *      scored by an LLM judge (Claude Opus 4.8) per capability category, plus
 *      deterministic secondary signals (must_include / abstain) + latency.
 *
 * Services must already be running at the configured URLs (see scripts/run-comparison.sh).
 * Emits bench/results/REPORT.md and bench/results/report.json.
 *
 * Usage: npx tsx bench/report.ts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const RESULTS = join(REPO, "bench", "results");
const FIXTURE = join(REPO, "bench", "scenarios", "comparison.json");

interface Impl {
  name: string;
  dir: string; // absolute
  url: string;
}

const IMPLS: Impl[] = [
  { name: "baseline", dir: REPO, url: process.env.URL_BASELINE ?? "http://localhost:8080" },
  {
    name: "opinionated",
    dir: join(REPO, "implementations/opinionated"),
    url: process.env.URL_OPINIONATED ?? "http://localhost:8091",
  },
  {
    name: "simple",
    dir: join(REPO, "implementations/simple"),
    url: process.env.URL_SIMPLE ?? "http://localhost:8092",
  },
  {
    name: "maxxed",
    dir: join(REPO, "implementations/maxxed"),
    url: process.env.URL_MAXXED ?? "http://localhost:8093",
  },
];

// --------------------------------------------------------------------------- //
// HTTP helpers
// --------------------------------------------------------------------------- //
async function http(
  method: string,
  url: string,
  body?: unknown,
  timeoutMs = 65000,
): Promise<{ status: number; body: any; ms: number }> {
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let parsed: any = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status: res.status, body: parsed, ms: performance.now() - t0 };
  } catch (e) {
    return { status: 0, body: { error: String(e) }, ms: performance.now() - t0 };
  }
}

// --------------------------------------------------------------------------- //
// A. Formal requirements
// --------------------------------------------------------------------------- //
interface Check {
  ok: boolean | "skip";
  detail?: string;
}

function staticChecks(dir: string): Record<string, Check> {
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf-8") : "");
  const has = (f: string) => existsSync(join(dir, f));
  const readme = read("README.md").toLowerCase();
  const sections = [
    "architecture",
    "backing store",
    "extraction",
    "recall",
    "fact evolution",
    "tradeoff",
    "failure mode",
  ];
  const compose = read("docker-compose.yml");
  const changelogEntries = (read("CHANGELOG.md").match(/^##\s+\S/gm) ?? []).length;
  return {
    "README.md": { ok: has("README.md") },
    "README sections": {
      ok: sections.every((s) => readme.includes(s)),
      detail: sections.filter((s) => !readme.includes(s)).join(", ") || "all present",
    },
    "CHANGELOG.md": { ok: changelogEntries >= 1, detail: `${changelogEntries} entries` },
    Dockerfile: { ok: has("Dockerfile") },
    "docker-compose.yml": { ok: has("docker-compose.yml") },
    "compose: port 8080": { ok: compose.includes("8080") },
    "compose: volume": { ok: compose.includes("volumes:") },
    ".env.example": { ok: has(".env.example") },
    "tests/": { ok: has("tests") || has("test") },
    "fixtures/": { ok: has("fixtures") },
  };
}

async function liveContractChecks(url: string): Promise<Record<string, Check>> {
  const out: Record<string, Check> = {};
  const health = await http("GET", `${url}/health`);
  out["GET /health -> 200"] = { ok: health.status === 200 };

  const turn = await http("POST", `${url}/turns`, {
    session_id: "fmt-s1",
    user_id: "fmt-u1",
    messages: [
      { role: "user", content: "I live in Berlin and work at Acme." },
      { role: "assistant", content: "Got it." },
    ],
    timestamp: "2025-03-15T10:30:00Z",
    metadata: {},
  });
  out["POST /turns -> 201 {id}"] = {
    ok: turn.status === 201 && typeof turn.body?.id === "string",
    detail: `status ${turn.status}`,
  };

  const recall = await http("POST", `${url}/recall`, {
    query: "Where does the user live?",
    session_id: "fmt-probe",
    user_id: "fmt-u1",
    max_tokens: 256,
  });
  out["POST /recall -> {context,citations}"] = {
    ok:
      recall.status === 200 &&
      typeof recall.body?.context === "string" &&
      Array.isArray(recall.body?.citations),
    detail: `status ${recall.status}`,
  };

  const search = await http("POST", `${url}/search`, {
    query: "Berlin",
    user_id: "fmt-u1",
    limit: 5,
  });
  out["POST /search -> {results[]}"] = {
    ok: search.status === 200 && Array.isArray(search.body?.results),
    detail: `status ${search.status}`,
  };

  const mem = await http("GET", `${url}/users/fmt-u1/memories`);
  const mems = mem.body?.memories;
  out["GET /users/:id/memories"] = {
    ok: mem.status === 200 && Array.isArray(mems),
    detail: Array.isArray(mems) ? `${mems.length} memories` : `status ${mem.status}`,
  };
  out["memories are structured (typed)"] = {
    ok:
      Array.isArray(mems) &&
      mems.length > 0 &&
      typeof mems[0]?.type === "string" &&
      "value" in (mems[0] ?? {}),
    detail: Array.isArray(mems) && mems[0] ? `type=${mems[0].type}` : "n/a",
  };

  const cold = await http("POST", `${url}/recall`, {
    query: "anything",
    session_id: "void",
    user_id: "void-user",
    max_tokens: 128,
  });
  out["cold recall -> 200 empty"] = {
    ok:
      cold.status === 200 &&
      (cold.body?.context === "" || (cold.body?.citations?.length ?? 0) === 0),
    detail: `status ${cold.status}`,
  };

  const bad = await http("POST", `${url}/turns`, undefined).then(() =>
    fetch(`${url}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{bad json",
    })
      .then((r) => ({ status: r.status }))
      .catch(() => ({ status: 0 })),
  );
  out["malformed -> 4xx (no crash)"] = {
    ok: bad.status >= 400 && bad.status < 500,
    detail: `status ${bad.status}`,
  };

  const delS = await http("DELETE", `${url}/sessions/fmt-s1`);
  out["DELETE /sessions/:id -> 204"] = { ok: delS.status === 204, detail: `status ${delS.status}` };
  const delU = await http("DELETE", `${url}/users/fmt-u1`);
  out["DELETE /users/:id -> 204"] = { ok: delU.status === 204, detail: `status ${delU.status}` };

  return out;
}

// --------------------------------------------------------------------------- //
// B. Benchmark + LLM judge
// --------------------------------------------------------------------------- //
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
function anthropicUrl(): string {
  const base = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
  return base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
}

interface Judgement {
  correct: boolean;
  score: number;
  abstained: boolean;
  note: string;
}

async function judge(
  query: string,
  expected: string,
  abstainExpected: boolean,
  context: string,
): Promise<Judgement> {
  const system =
    "You are a strict evaluator of an AI memory system. Given a QUESTION, the CONTEXT the memory system returned for it, and the EXPECTED answer, decide whether the CONTEXT would let a frozen LLM answer correctly. " +
    'Output ONLY compact JSON: {"correct":boolean,"score":number,"abstained":boolean,"note":string}. ' +
    "score is 0..1 (partial credit allowed). abstained=true means the context provides no usable info / says nothing is known. " +
    "If ABSTAIN_EXPECTED is true, correct=true ONLY if the context is empty or clearly conveys that nothing relevant is known; it must NOT volunteer unrelated facts or invent an answer. " +
    "If ABSTAIN_EXPECTED is false, correct=true only if the needed answer is present and current (not stale/contradicted).";
  const user = `QUESTION: ${query}\nEXPECTED: ${expected}\nABSTAIN_EXPECTED: ${abstainExpected}\n\nCONTEXT:\n${context || "(empty)"}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(anthropicUrl(), {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: 400,
        system,
        messages: [{ role: "user", content: user }],
      }),
      signal: AbortSignal.timeout(60000),
    }).catch((e) => ({ ok: false, _err: String(e) }) as any);

    if (res?.ok) {
      const data: any = await res.json();
      const text = (data.content ?? [])
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("");
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          const j = JSON.parse(m[0]);
          return {
            correct: Boolean(j.correct),
            score: typeof j.score === "number" ? j.score : j.correct ? 1 : 0,
            abstained: Boolean(j.abstained),
            note: String(j.note ?? "").slice(0, 200),
          };
        } catch {
          /* retry */
        }
      }
    }
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  return { correct: false, score: 0, abstained: false, note: "JUDGE_ERROR" };
}

const estTokens = (s: string): number => Math.ceil((s?.length ?? 0) / 4);

interface ProbeResult {
  id: string;
  category: string;
  judged: Judgement;
  mustIncludeOk: boolean | null;
  recallMs: number;
  ctxTokens: number;
}

async function benchmarkImpl(
  impl: Impl,
  fixture: any,
): Promise<{ probes: ProbeResult[]; avgIngestMs: number }> {
  const probes: ProbeResult[] = [];
  const ingestMs: number[] = [];

  for (const sc of fixture.scenarios) {
    await http("DELETE", `${impl.url}/users/${sc.user_id}`);
    for (const t of sc.turns) {
      const r = await http("POST", `${impl.url}/turns`, {
        session_id: t.session_id,
        user_id: sc.user_id,
        messages: t.messages,
        timestamp: t.timestamp ?? null,
        metadata: t.metadata ?? {},
      });
      ingestMs.push(r.ms);
    }
  }

  for (const sc of fixture.scenarios) {
    for (const p of sc.probes) {
      const r = await http("POST", `${impl.url}/recall`, {
        query: p.query,
        session_id: p.session_id ?? null,
        user_id: p.user_id ?? sc.user_id,
        max_tokens: p.max_tokens ?? 512,
      });
      const ctx: string = r.status === 200 ? (r.body?.context ?? "") : "";
      const j = await judge(p.query, p.expected ?? "", Boolean(p.abstain), ctx);
      let mustIncludeOk: boolean | null = null;
      if (Array.isArray(p.must_include)) {
        const lc = ctx.toLowerCase();
        mustIncludeOk = p.must_include.every((s: string) => lc.includes(s.toLowerCase()));
      }
      probes.push({
        id: p.id,
        category: p.category,
        judged: j,
        mustIncludeOk,
        recallMs: r.ms,
        ctxTokens: estTokens(ctx),
      });
    }
  }
  const avgIngestMs = ingestMs.length
    ? Math.round(ingestMs.reduce((a, b) => a + b, 0) / ingestMs.length)
    : 0;
  return { probes, avgIngestMs };
}

// --------------------------------------------------------------------------- //
// Reporting
// --------------------------------------------------------------------------- //
const pct = (n: number, d: number): string => (d ? `${Math.round((n / d) * 100)}%` : "—");
const mark = (c: Check): string => (c.ok === "skip" ? "•" : c.ok ? "✓" : "✗");

async function main(): Promise<void> {
  mkdirSync(RESULTS, { recursive: true });
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf-8"));

  const data: Record<string, any> = {};
  for (const impl of IMPLS) {
    process.stderr.write(`\n### ${impl.name} (${impl.url})\n`);
    const stat = staticChecks(impl.dir);
    const health = await http("GET", `${impl.url}/health`);
    const live = health.status === 200 ? await liveContractChecks(impl.url) : null;
    let bench: { probes: ProbeResult[]; avgIngestMs: number } | null = null;
    if (health.status === 200) {
      process.stderr.write(`  running benchmark (${fixture.scenarios.length} scenarios)…\n`);
      bench = await benchmarkImpl(impl, fixture);
    } else {
      process.stderr.write("  service unreachable — skipping live checks & benchmark\n");
    }
    data[impl.name] = { stat, live, bench };
  }

  // ---- assemble REPORT.md ----
  const categories = [
    ...new Set(fixture.scenarios.flatMap((s: any) => s.probes.map((p: any) => p.category))),
  ].sort();
  const L: string[] = [];
  L.push("# Implementation comparison report");
  L.push("");
  L.push(
    `Generated by \`bench/report.ts\` against the shared fixture \`bench/scenarios/comparison.json\` (${fixture.scenarios.length} scenarios, ${fixture.scenarios.reduce((n: number, s: any) => n + s.probes.length, 0)} probes). Benchmark probes scored by an LLM judge (Claude Opus 4.8). The four implementations run the SAME fixture over the SAME HTTP contract.`,
  );
  L.push("");

  // A. Formal requirements
  L.push("## A. Formal requirements (ASSIGNMENT.md §3/§5/§6)");
  L.push("");
  const statKeys = Object.keys(data.baseline.stat);
  const liveKeys = data.baseline.live ? Object.keys(data.baseline.live) : [];
  L.push(`| Requirement | ${IMPLS.map((i) => i.name).join(" | ")} |`);
  L.push(`|---|${IMPLS.map(() => "---").join("|")}|`);
  for (const k of statKeys) {
    L.push(`| ${k} | ${IMPLS.map((i) => mark(data[i.name].stat[k])).join(" | ")} |`);
  }
  for (const k of liveKeys) {
    L.push(
      `| ${k} | ${IMPLS.map((i) => (data[i.name].live ? mark(data[i.name].live[k]) : "•")).join(" | ")} |`,
    );
  }
  L.push("");
  L.push(
    "> Static checks read each folder; live checks probe the running service. `•` = service not running at report time. Persistence-across-restart and `docker compose up` are verified per-implementation in their own test suites/CHANGELOGs (not re-run here).",
  );
  L.push("");

  // B. Benchmark — overall
  L.push("## B. Shared benchmark (LLM-judged)");
  L.push("");
  L.push(
    "| Implementation | Judge pass | Avg score | must_include | Avg recall ms | Avg ingest ms | Avg ctx tokens |",
  );
  L.push("|---|---|---|---|---|---|---|");
  for (const impl of IMPLS) {
    const b = data[impl.name].bench;
    if (!b) {
      L.push(`| ${impl.name} | — (not run) | — | — | — | — | — |`);
      continue;
    }
    const ps: ProbeResult[] = b.probes;
    const pass = ps.filter((p) => p.judged.correct).length;
    const avgScore = ps.reduce((a, p) => a + p.judged.score, 0) / ps.length;
    const mi = ps.filter((p) => p.mustIncludeOk !== null);
    const miPass = mi.filter((p) => p.mustIncludeOk).length;
    const avgRecall = Math.round(ps.reduce((a, p) => a + p.recallMs, 0) / ps.length);
    const avgCtx = Math.round(ps.reduce((a, p) => a + p.ctxTokens, 0) / ps.length);
    L.push(
      `| ${impl.name} | ${pass}/${ps.length} (${pct(pass, ps.length)}) | ${avgScore.toFixed(2)} | ${pct(miPass, mi.length)} | ${avgRecall} | ${b.avgIngestMs} | ${avgCtx} |`,
    );
  }
  L.push("");

  // B. Per-category judge pass rate
  L.push("### Per-category judge pass rate");
  L.push("");
  L.push(`| Category | ${IMPLS.map((i) => i.name).join(" | ")} |`);
  L.push(`|---|${IMPLS.map(() => "---").join("|")}|`);
  for (const cat of categories) {
    const cells = IMPLS.map((impl) => {
      const b = data[impl.name].bench;
      if (!b) return "—";
      const ps = b.probes.filter((p: ProbeResult) => p.category === cat);
      if (!ps.length) return "—";
      const pass = ps.filter((p: ProbeResult) => p.judged.correct).length;
      return `${pass}/${ps.length}`;
    });
    L.push(`| ${cat} | ${cells.join(" | ")} |`);
  }
  L.push("");

  // B. Per-probe detail
  L.push("### Per-probe detail (judge verdict)");
  L.push("");
  const allProbeIds = fixture.scenarios.flatMap((s: any) =>
    s.probes.map((p: any) => ({ id: p.id, category: p.category, query: p.query })),
  );
  L.push(`| Probe | Category | ${IMPLS.map((i) => i.name).join(" | ")} |`);
  L.push(`|---|---|${IMPLS.map(() => "---").join("|")}|`);
  for (const probe of allProbeIds) {
    const cells = IMPLS.map((impl) => {
      const b = data[impl.name].bench;
      if (!b) return "—";
      const pr = b.probes.find((p: ProbeResult) => p.id === probe.id);
      if (!pr) return "—";
      return `${pr.judged.correct ? "✓" : "✗"} ${pr.judged.score.toFixed(1)}`;
    });
    L.push(`| \`${probe.id}\` ${probe.query} | ${probe.category} | ${cells.join(" | ")} |`);
  }
  L.push("");
  L.push("## C. Analysis");
  L.push("");
  L.push("_(filled in by hand after reviewing the numbers above)_");
  L.push("");

  writeFileSync(join(RESULTS, "REPORT.md"), `${L.join("\n")}\n`);
  writeFileSync(join(RESULTS, "report.json"), JSON.stringify(data, null, 2));
  process.stderr.write(`\nWrote ${join(RESULTS, "REPORT.md")}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
