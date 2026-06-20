/**
 * Deterministic, offline mock LLM client.
 *
 * The whole point of the injectable seam: the contract test-suite runs the SAME
 * pipeline code (extract -> reconcile -> embed -> hybrid recall -> rerank) with
 * zero network calls. To make the offline run meaningful rather than a no-op:
 *
 *   - embed(): a hashed bag-of-tokens vector. Shared tokens -> non-zero cosine,
 *     so semantically overlapping text actually clusters. Deterministic.
 *   - generateObject(): dispatches on `purpose`. Extraction reuses the
 *     rule-based extractor (so offline tests see real typed memories); the
 *     reconciler applies the same ADD/UPDATE/SUPERSEDE/NOOP heuristics the LLM
 *     would; the reranker falls back to lexical overlap; query rewrite echoes.
 *
 * This is intentionally a faithful *shadow* of the live behavior, not a stub
 * that returns canned junk — so a green offline suite is real evidence.
 */

import type { z } from "zod";
import { ruleExtract } from "../extraction/rules";
import { norm } from "../util/ids";
import { tokenize } from "../util/text";
import type { LlmClient } from "./types";

const DIM = 256; // small but enough to separate the fixture vocabulary

function hashToken(tok: string): number {
  let h = 2166136261;
  for (let i = 0; i < tok.length; i++) {
    h ^= tok.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/** Hashed bag-of-tokens embedding, L2-normalized. Deterministic + offline. */
export function mockEmbed(text: string, dim = DIM): number[] {
  const v = new Array<number>(dim).fill(0);
  const toks = tokenize(text, true);
  for (const tok of toks) {
    const h = hashToken(tok);
    v[h % dim] += 1;
    // a second bucket reduces collisions and adds a little structure
    v[((Math.floor(h / dim) % dim) + dim) % dim] += 0.5;
  }
  let mag = 0;
  for (const x of v) mag += x * x;
  mag = Math.sqrt(mag) || 1;
  return v.map((x) => x / mag);
}

export class MockLlmClient implements LlmClient {
  readonly kind = "mock";
  readonly live = false;
  readonly dim: number;

  constructor(dim = DIM) {
    this.dim = dim;
  }

  async embed(text: string): Promise<number[]> {
    return mockEmbed(text, this.dim);
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    return texts.map((t) => mockEmbed(t, this.dim));
  }

  async generateObject<T>(args: {
    schema: z.ZodType<T>;
    system?: string;
    prompt: string;
    purpose: string;
  }): Promise<T> {
    switch (args.purpose) {
      case "extract":
        return this.mockExtract(args.prompt) as T;
      case "reconcile":
        return this.mockReconcile(args.prompt) as T;
      case "rerank":
        return this.mockRerank(args.prompt) as T;
      case "query_rewrite":
        return this.mockQueryRewrite(args.prompt) as T;
      case "compact":
        return this.mockCompact(args.prompt) as T;
      default:
        // Validate against the schema so a bad mock surfaces in tests.
        return args.schema.parse({}) as T;
    }
  }

  // --- mock implementations keyed off the prompt payloads -------------------

  private mockExtract(prompt: string): unknown {
    // The extraction prompt embeds the raw user text after a marker line.
    const text = extractSection(prompt, "USER_TEXT");
    const mems = ruleExtract(text);
    return {
      memories: mems.map((m) => ({
        type: m.type,
        key: m.key,
        value: m.value,
        confidence: m.confidence,
        mutable: m.mutable,
        snippet: m.snippet,
        entities: m.entities ?? [],
      })),
    };
  }

  private mockReconcile(prompt: string): unknown {
    // Payload carries a JSON blob: { candidate, existing[] }.
    const data = parseJsonBlock<{
      candidate: { key: string; value: string; mutable: boolean };
      existing: Array<{ id: string; key: string; value: string }>;
    }>(prompt);
    if (!data) return { decision: "ADD", target_id: null, reason: "no payload" };
    const { candidate, existing } = data;
    const same = existing.find((e) => norm(e.value) === norm(candidate.value));
    if (same) return { decision: "NOOP", target_id: same.id, reason: "duplicate value" };
    if (candidate.mutable && existing.length > 0) {
      return {
        decision: "SUPERSEDE",
        target_id: existing[0].id,
        reason: "mutable slot changed value",
      };
    }
    return { decision: "ADD", target_id: null, reason: "new fact" };
  }

  private mockRerank(prompt: string): unknown {
    // Payload: { query, candidates: [{id, text}] }. Score by lexical overlap.
    const data = parseJsonBlock<{
      query: string;
      candidates: Array<{ id: string; text: string }>;
    }>(prompt);
    if (!data) return { ranking: [] };
    const q = new Set(tokenize(data.query));
    const scored = data.candidates.map((c) => {
      const t = new Set(tokenize(c.text));
      let hit = 0;
      for (const tok of q) if (t.has(tok)) hit++;
      return { id: c.id, relevance: q.size ? hit / q.size : 0 };
    });
    scored.sort((a, b) => b.relevance - a.relevance);
    return { ranking: scored };
  }

  private mockQueryRewrite(prompt: string): unknown {
    const q = extractSection(prompt, "QUERY");
    return { expanded: [q], entities: [] };
  }

  private mockCompact(prompt: string): unknown {
    // Echo the bullet list back, untouched (offline compaction is a no-op).
    return { text: extractSection(prompt, "CONTENT") };
  }
}

function extractSection(prompt: string, marker: string): string {
  const re = new RegExp(`<${marker}>([\\s\\S]*?)</${marker}>`);
  const m = re.exec(prompt);
  return m ? m[1].trim() : "";
}

function parseJsonBlock<T>(prompt: string): T | null {
  const m = /<JSON>([\s\S]*?)<\/JSON>/.exec(prompt);
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as T;
  } catch {
    return null;
  }
}
