/**
 * Per-call CSV audit log for every LLM and embedding inference call.
 *
 * Opt-in: when the env var `MEMORY_LLM_LOG` points at a file path, every LLM and
 * embedding call appends ONE CSV row so spend can be audited per-call. When the
 * var is unset (the default, and all offline tests), this is a hard no-op — no
 * file is opened, no work is done.
 *
 * The column order is a cross-implementation contract — it MUST match the other
 * implementations exactly:
 *
 *   ts,impl,kind,phase,model,input_tokens,output_tokens,latency_ms,request,response
 *
 * CSV rules:
 *  - a header row is written when the file is new or empty;
 *  - EVERY field is quoted (double quotes), and embedded quotes are escaped `"`->`""`;
 *  - rows are appended synchronously so a crash mid-run never loses the tail.
 *
 * This complements src/metrics.ts (cumulative counters): metrics answer "how much
 * total", this answers "which call, with what prompt, costing what".
 */

import { appendFileSync, existsSync, statSync } from "node:fs";

const IMPL = "simple";

/** The exact, ordered column header — a cross-implementation contract. */
const HEADER = [
  "ts",
  "impl",
  "kind",
  "phase",
  "model",
  "input_tokens",
  "output_tokens",
  "latency_ms",
  "request",
  "response",
] as const;

export interface LlmLogEntry {
  kind: "llm" | "embedding";
  /** Short call-site label: extract, compaction, embed_query, embed_memory, ... */
  phase: string;
  model: string;
  /** Prompt token count (LLM) or embedded-text token count (embedding). */
  inputTokens?: number | undefined;
  /** Generated-output token count (LLM). Blank for embeddings. */
  outputTokens?: number | undefined;
  latencyMs: number;
  /** FULL input/prompt text (LLM) or the text embedded (embedding). */
  request: string;
  /** FULL model output (LLM). Blank or a vector placeholder for embeddings. */
  response: string;
}

/** Quote a single CSV field: wrap in double quotes, escape `"` -> `""`. */
function csvField(value: string | number | undefined): string {
  const s = value === undefined || value === null ? "" : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

function csvRow(fields: Array<string | number | undefined>): string {
  return `${fields.map(csvField).join(",")}\n`;
}

/**
 * Append one CSV row for an LLM/embedding call. No-op unless MEMORY_LLM_LOG is
 * set. Best-effort: a logging failure must never break an inference call, so all
 * errors are swallowed (with a one-line warning).
 */
export function logInference(entry: LlmLogEntry): void {
  const path = process.env.MEMORY_LLM_LOG;
  if (!path) return; // disabled -> hard no-op (offline tests stay green).

  try {
    // Header only when the file is new or empty.
    const needsHeader = !existsSync(path) || statSync(path).size === 0;
    let out = "";
    if (needsHeader) out += csvRow([...HEADER]);
    out += csvRow([
      new Date().toISOString(),
      IMPL,
      entry.kind,
      entry.phase,
      entry.model,
      entry.inputTokens,
      entry.outputTokens,
      Math.round(entry.latencyMs),
      entry.request,
      entry.response,
    ]);
    appendFileSync(path, out);
  } catch (err) {
    console.warn("MEMORY_LLM_LOG append failed (continuing):", err);
  }
}
