/**
 * HTTP helper, latency percentiles, token estimate, and the LLM judge
 * (Claude Opus 4.8) shared by the suite runner.
 */

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
    return { status: res.status, body: parsed, ms: performance.now() - t0 };
  } catch (e) {
    return { status: 0, body: { error: String(e) }, ms: performance.now() - t0 };
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

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
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
    const res: any = await fetch(anthropicUrl(), {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4-8",
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
