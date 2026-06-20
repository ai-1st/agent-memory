/**
 * HTTP helper, latency percentiles, token estimate, and the LLM judge
 * (Claude Opus 4.8) shared by the suite runner.
 */

import { appendFileSync, existsSync, statSync } from "node:fs";

// Shared per-call CSV log (same columns the implementations use, so logs/*.csv
// can be reviewed/merged uniformly).
const CSV_HEADER =
  "ts,impl,kind,phase,model,input_tokens,output_tokens,latency_ms,request,response";
function csvCell(v: unknown): string {
  return `"${String(v ?? "").replace(/"/g, '""')}"`;
}
function appendCsv(file: string, row: unknown[]): void {
  if (!existsSync(file) || statSync(file).size === 0) appendFileSync(file, `${CSV_HEADER}\n`);
  appendFileSync(file, `${row.map(csvCell).join(",")}\n`);
}

// Optional verbatim request/response trace of the container traffic. Set
// SUITE_TRACE=<file> to capture every HTTP exchange (method, url, request body,
// status, response body). Judge calls go straight to Anthropic and are NOT traced
// — only the memory-service container's in/out.
function trace(
  method: string,
  url: string,
  body: unknown,
  status: number,
  ms: number,
  resp: unknown,
): void {
  const file = process.env.SUITE_TRACE;
  if (!file) return;
  const cap = (v: unknown): string => {
    const s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
    return s.length > 8000 ? `${s.slice(0, 8000)}\n…[truncated ${s.length - 8000} chars]` : s;
  };
  appendFileSync(
    file,
    `\n──────────────────────────────────────────────────────────\n→ ${method} ${url}\n${body === undefined ? "(no request body)" : cap(body)}\n← ${status}  (${Math.round(ms)} ms)\n${cap(resp)}\n`,
  );
}

export async function http(
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
    const ms = performance.now() - t0;
    trace(method, url, body, res.status, ms, parsed);
    return { status: res.status, body: parsed, ms };
  } catch (e) {
    const ms = performance.now() - t0;
    trace(method, url, body, 0, ms, { error: String(e) });
    return { status: 0, body: { error: String(e) }, ms };
  }
}

export function pctl(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return Math.round(s[idx] ?? 0);
}

export function mean(xs: number[]): number {
  return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0;
}

export const estTokens = (s: string): number => Math.ceil((s?.length ?? 0) / 4);

export interface MetricsSnapshot {
  llmCalls: number;
  llmIn: number;
  llmOut: number;
  embCalls: number;
  embTok: number;
}

/** Read a service's cumulative token counters (zeros if /metrics is absent). */
export async function fetchMetrics(url: string): Promise<MetricsSnapshot> {
  const r = await http("GET", `${url}/metrics`);
  const m = r.status === 200 ? r.body : null;
  return {
    llmCalls: m?.llm?.calls ?? 0,
    llmIn: m?.llm?.input_tokens ?? 0,
    llmOut: m?.llm?.output_tokens ?? 0,
    embCalls: m?.embedding?.calls ?? 0,
    embTok: m?.embedding?.tokens ?? 0,
  };
}

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const JUDGE_MODEL = process.env.SUITE_JUDGE_MODEL ?? "claude-opus-4-8";
function anthropicUrl(): string {
  const base = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
  return base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
}

export interface Judgement {
  correct: boolean;
  score: number;
  abstained: boolean;
  note: string;
}

const SYSTEM =
  "You are a strict evaluator of an AI memory system. Given a QUESTION, the CONTEXT the memory system returned for it, and the EXPECTED answer, decide whether the CONTEXT would let a frozen LLM answer correctly. " +
  'Output ONLY compact JSON: {"correct":boolean,"score":number,"abstained":boolean,"note":string}. ' +
  "score is 0..1 (partial credit allowed). abstained=true means the context provides no usable info / says nothing is known. " +
  "If ABSTAIN_EXPECTED is true, correct=true ONLY if the context is empty or clearly conveys nothing relevant is known; it must NOT volunteer unrelated facts or invent an answer. " +
  "If ABSTAIN_EXPECTED is false, correct=true only if the needed answer is present and current (not stale/contradicted).";

export async function judge(
  query: string,
  expected: string,
  abstainExpected: boolean,
  context: string,
): Promise<Judgement> {
  const user = `QUESTION: ${query}\nEXPECTED: ${expected}\nABSTAIN_EXPECTED: ${abstainExpected}\n\nCONTEXT:\n${context || "(empty)"}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const t0 = performance.now();
    const res: any = await fetch(anthropicUrl(), {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: JUDGE_MODEL,
        max_tokens: 400,
        system: SYSTEM,
        messages: [{ role: "user", content: user }],
      }),
      signal: AbortSignal.timeout(60000),
    }).catch((e: unknown) => ({ ok: false, _err: String(e) }));

    if (res?.ok) {
      const data: any = await res.json();
      const text = (data.content ?? [])
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("");
      if (process.env.SUITE_JUDGE_LOG) {
        const u = data.usage ?? {};
        appendCsv(process.env.SUITE_JUDGE_LOG, [
          new Date().toISOString(),
          "judge",
          "llm",
          "judge",
          JUDGE_MODEL,
          u.input_tokens ?? "",
          u.output_tokens ?? "",
          Math.round(performance.now() - t0),
          user,
          text,
        ]);
      }
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
