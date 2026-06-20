/**
 * Per-call CSV audit log for every LLM + embedding inference call.
 *
 * When the env var `MEMORY_LLM_LOG` points at a file path, each live inference
 * call appends ONE CSV row so the exact cost of a run can be audited offline.
 * When the var is unset, every function here is a no-op — so the offline test
 * suite (which never sets it) is completely unaffected.
 *
 * COLUMN ORDER is fixed and MUST match across implementations:
 *   ts,impl,kind,phase,model,input_tokens,output_tokens,latency_ms,request,response
 *
 *   - ts             ISO-8601 timestamp of when the row is written
 *   - impl           always "maxxed"
 *   - kind           "llm" | "embedding"
 *   - phase          short call-site label (extract, reconcile, rerank,
 *                    query_rewrite, compact, embed_query, embed_memory, ...)
 *   - model          model id
 *   - input_tokens   prompt tokens (LLM) / token count (embedding)
 *   - output_tokens  completion tokens (LLM) / blank (embedding)
 *   - latency_ms     wall-clock duration of the call
 *   - request        FULL prompt / embedded text
 *   - response       FULL generated text (LLM) / "[<dim>-dim vector]" (embedding)
 *
 * CSV rules: a header row is written when the file is new/empty; EVERY field is
 * double-quoted with embedded quotes escaped as ""; appends are synchronous so a
 * crash mid-run still leaves a complete, ordered log.
 */

import { appendFileSync, existsSync, statSync } from "node:fs";

const IMPL = "maxxed";

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

export interface CallLogRow {
  kind: "llm" | "embedding";
  phase: string;
  model: string;
  inputTokens: number | undefined;
  /** Blank for embeddings. */
  outputTokens: number | undefined;
  latencyMs: number;
  request: string;
  response: string;
}

/** Destination path, or undefined when logging is disabled. Read each call so
 *  tests / smokes can toggle the env var without re-importing the module. */
function logPath(): string | undefined {
  const p = process.env.MEMORY_LLM_LOG;
  return p?.trim() ? p : undefined;
}

/** Quote a single CSV field: wrap in double quotes, escape `"` as `""`. */
function csvField(value: string | number | undefined): string {
  const s = value === undefined || value === null ? "" : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

function csvRow(fields: Array<string | number | undefined>): string {
  return `${fields.map(csvField).join(",")}\n`;
}

/**
 * Append one CSV row describing a single inference call. No-op when
 * `MEMORY_LLM_LOG` is unset. Never throws into the call path: a logging failure
 * must not break a turn, so errors are swallowed (and reported once on stderr).
 */
export function logCall(row: CallLogRow): void {
  const path = logPath();
  if (!path) return;
  try {
    let needHeader = true;
    if (existsSync(path)) {
      needHeader = statSync(path).size === 0;
    }
    const header = needHeader ? csvRow([...HEADER]) : "";
    const line = csvRow([
      new Date().toISOString(),
      IMPL,
      row.kind,
      row.phase,
      row.model,
      row.inputTokens,
      row.outputTokens,
      row.latencyMs,
      row.request,
      row.response,
    ]);
    appendFileSync(path, header + line);
  } catch (err) {
    // Logging is best-effort; never fail the inference call because of it.
    console.warn("MEMORY_LLM_LOG write failed:", (err as Error).message);
  }
}
