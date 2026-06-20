/**
 * Per-call CSV audit log (src/llm/csvlog.ts).
 *
 * The cost-audit log is gated entirely on the `MEMORY_LLM_LOG` env var:
 *   - unset  -> every call is a no-op (offline tests must be unaffected);
 *   - set    -> ONE quoted CSV row per call, header written when file is empty,
 *               with the exact fixed column order shared across implementations.
 * These assertions pin the format so the cross-impl audit stays parseable.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { logCall } from "../src/llm/csvlog";

const HEADER =
  '"ts","impl","kind","phase","model","input_tokens","output_tokens","latency_ms","request","response"';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mx-csvlog-"));
  file = join(dir, "log.csv");
});

afterEach(() => {
  process.env.MEMORY_LLM_LOG = undefined;
  // biome-ignore lint/performance/noDelete: env vars must be truly absent, not "undefined".
  delete process.env.MEMORY_LLM_LOG;
  rmSync(dir, { recursive: true, force: true });
});

describe("csvlog", () => {
  it("is a no-op when MEMORY_LLM_LOG is unset", () => {
    // biome-ignore lint/performance/noDelete: ensure truly unset.
    delete process.env.MEMORY_LLM_LOG;
    logCall({
      kind: "llm",
      phase: "extract",
      model: "claude-opus-4-8",
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 42,
      request: "hi",
      response: "{}",
    });
    expect(() => readFileSync(file)).toThrow(); // file never created
  });

  it("writes a header then one quoted row per call, in fixed column order", () => {
    process.env.MEMORY_LLM_LOG = file;
    logCall({
      kind: "llm",
      phase: "reconcile",
      model: "claude-opus-4-8",
      inputTokens: 100,
      outputTokens: 25,
      latencyMs: 1234,
      request: 'a "quoted" prompt,\nwith comma',
      response: '{"decision":"ADD"}',
    });
    logCall({
      kind: "embedding",
      phase: "embed_query",
      model: "text-embedding-3-large",
      inputTokens: 8,
      outputTokens: undefined, // embeddings: blank
      latencyMs: 12,
      request: "what is my name",
      response: "[3072-dim vector]",
    });

    const text = readFileSync(file, "utf8");
    const lines = text.trimEnd().split("\n");
    // Header + 2 rows. (Embedded newline in request stays inside one quoted field,
    // so it does NOT split into an extra line at the CSV-record level — but a naive
    // \n split sees it; assert the header + presence of both phases instead.)
    expect(lines[0]).toBe(HEADER);
    expect(text).toContain('"llm","reconcile","claude-opus-4-8","100","25","1234"');
    expect(text).toContain('"embedding","embed_query","text-embedding-3-large","8",""');
    // Every field double-quoted; embedded quotes doubled.
    expect(text).toContain('"a ""quoted"" prompt,');
    // output_tokens blank for embeddings -> empty quoted field.
    expect(text).toContain('"[3072-dim vector]"');
  });

  it("does not rewrite the header when appending to a non-empty file", () => {
    writeFileSync(file, `${HEADER}\n`);
    process.env.MEMORY_LLM_LOG = file;
    logCall({
      kind: "llm",
      phase: "rerank",
      model: "claude-opus-4-8",
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 1,
      request: "q",
      response: "{}",
    });
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    expect(lines.filter((l) => l === HEADER)).toHaveLength(1);
    expect(lines).toHaveLength(2);
  });
});
