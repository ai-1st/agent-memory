/**
 * The LLM + embedding seam — the ONE place the service talks to the outside
 * world, and the ONE thing tests swap out.
 *
 * `Provider` is a 3-method interface:
 *   - extract():  one structured LLM pass turning a turn's messages into typed
 *                 memories (the heart of "extraction, not storage").
 *   - embed():    text -> 3072-dim vector for semantic recall.
 *   - compact():  optional final prose tidy-up to fit a tight token budget.
 *
 * Two implementations ship:
 *   - LiveProvider  — Claude Opus 4.8 + OpenAI text-embedding-3-large via the
 *                     Vercel AI SDK. structured output via generateObject + Zod.
 *   - MockProvider  — deterministic, offline. A small rule-based extractor and a
 *                     cheap hashing embedder, so the entire suite runs in CI with
 *                     no keys and no flakiness. It is intentionally good enough to
 *                     exercise the real pipeline and the quality fixture.
 *
 * Both honour the SAME schema, so swapping providers changes quality, never shape.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { embed, embedMany, generateObject } from "ai";
import { z } from "zod";
import type { Settings } from "./config";
import { logInference } from "./llmlog";
import { recordEmbedding, recordLlm } from "./metrics";
import type { Message } from "./models";

// 3072 is the native width of text-embedding-3-large. The mock matches it so the
// pglite `vector(N)` column width is identical on both paths.
export const EMBED_DIM = 3072;

// Model ids, declared once so the metrics counters, the CSV audit log and the
// actual SDK calls can never drift apart.
const LLM_MODEL = process.env.MEMORY_LLM_MODEL ?? "claude-opus-4-8";
const EMBED_MODEL = "text-embedding-3-large";

// Placeholder written to the CSV `response` column for embeddings: we never log
// the raw 3072-dim vector (huge, useless), just a marker that one was produced.
const EMBED_RESPONSE = `[${EMBED_DIM}-dim vector]`;

/** The memory categories we extract. Mirrors the contract's `type` field. */
export const MEMORY_TYPES = ["fact", "preference", "opinion", "event"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/**
 * A single extracted memory, pre-persistence. `key` is a canonical slot so the
 * supersession rule can find the prior value ("employment", "location",
 * "pet:biscuit"). `mutable` distinguishes single-valued slots (a new job
 * supersedes the old) from additive ones (multiple allergies coexist).
 */
export interface ExtractedMemory {
  type: MemoryType;
  key: string;
  value: string;
  confidence: number; // 0..1
  mutable: boolean;
  snippet: string; // source text the memory was derived from (provenance)
}

// Zod schema handed to the LLM for structured output. Kept flat and obvious.
const extractionSchema = z.object({
  memories: z
    .array(
      z.object({
        type: z.enum(MEMORY_TYPES),
        key: z
          .string()
          .describe(
            "canonical lowercase slot key, e.g. 'employment', 'location', 'pet:biscuit', 'allergy:shellfish', 'preference:typescript'",
          ),
        value: z.string().describe("concise human-readable statement of the fact"),
        confidence: z.number().min(0).max(1),
        mutable: z
          .boolean()
          .describe(
            "true for single-valued slots that a later statement should replace (job, location); false for additive slots that coexist (allergies, multiple pets)",
          ),
      }),
    )
    .describe("structured memories about the USER only; [] if nothing durable was said"),
});

export interface Provider {
  readonly name: string;
  extract(messages: Message[], timestamp: string | null): Promise<ExtractedMemory[]>;
  /** `phase` is the CSV audit call-site label (embed_query, embed_memory, ...). */
  embed(text: string, phase?: string): Promise<number[]>;
  embedBatch(texts: string[], phase?: string): Promise<number[][]>;
  /** Tidy `context` to fit ~maxTokens. May return the input unchanged. */
  compact(context: string, query: string, maxTokens: number): Promise<string>;
}

// --------------------------------------------------------------------------
// Live provider: Claude Opus 4.8 + OpenAI text-embedding-3-large.
// --------------------------------------------------------------------------

const EXTRACTION_SYSTEM = `You extract durable, structured memories about the USER from a conversation turn.

Rules:
- Only record facts about the user themselves (their job, home, family, pets, preferences, opinions, plans). Ignore facts about the world or the assistant.
- Capture implicit facts: "walking Biscuit this morning" => the user has a pet named Biscuit.
- Capture corrections: "actually I meant Berlin, not Munich" => location is Berlin.
- Use stable canonical keys so a later contradicting statement maps to the same slot (employment, location, name, family:wife, pet:<name>, allergy:<thing>, diet, preference:<topic>).
- type: fact (objective), preference (likes/dislikes/habits), opinion (subjective stance that may evolve), event (a dated happening).
- mutable=true when a newer statement should replace the old value (job, location, current opinion). mutable=false for additive facts that accumulate (allergies, distinct pets, distinct family members).
- confidence: 0.9+ for explicit first-person statements, ~0.6 for implicit/inferred.
- DATES: the turn's timestamp is given below. Resolve every relative time expression to an absolute date using it — "last Saturday", "three weeks ago", "yesterday", "this morning" => an explicit YYYY-MM-DD. For event facts, put the absolute date IN the value (e.g. "User went hiking on 2023-05-13", not "User went hiking last Saturday"). Never store a bare relative expression; a later reader has no access to the turn timestamp.
- Prefer precision. If nothing durable was said, return an empty list.`;
// NOTE: an "extract exhaustively" coverage rule was tried here and MEASURED to
// regress LoCoMo (30% -> 24%): simple dumps a budget-capped context with no
// reranker, so more facts crowd out the needle. Coverage is the right lever for
// builds WITH a reranker (opinionated/maxxed), not for simple. Reverted.

/**
 * Resolve a provider base URL. If the env var is unset, use `fallback` (the SDK
 * default). If it's set but missing the trailing "/v1" version segment, append
 * it — guards against the `https://api.anthropic.com` (no /v1) misconfiguration.
 */
function ensureV1(envValue: string | undefined, fallback: string): string {
  if (!envValue) return fallback;
  const trimmed = envValue.replace(/\/+$/, "");
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

export class LiveProvider implements Provider {
  readonly name = "live";
  private anthropic: ReturnType<typeof createAnthropic>;
  private openai: ReturnType<typeof createOpenAI>;

  constructor(settings: Settings) {
    // Both AI-SDK providers default to the correct ".../v1" base URL. But a
    // common environment misconfiguration is exporting ANTHROPIC_BASE_URL /
    // OPENAI_BASE_URL without the "/v1" suffix, which the SDK uses verbatim and
    // then 404s ("/messages" instead of "/v1/messages"). Normalize defensively
    // so the live path is robust to that, without forcing a custom endpoint.
    this.anthropic = createAnthropic({
      apiKey: settings.anthropicApiKey,
      baseURL: ensureV1(process.env.ANTHROPIC_BASE_URL, "https://api.anthropic.com/v1"),
    });
    this.openai = createOpenAI({
      apiKey: settings.openaiApiKey,
      baseURL: ensureV1(process.env.OPENAI_BASE_URL, "https://api.openai.com/v1"),
    });
  }

  async extract(messages: Message[], timestamp: string | null): Promise<ExtractedMemory[]> {
    const transcript = messages
      .map((m) => `${m.role}${m.name ? `(${m.name})` : ""}: ${m.content}`)
      .join("\n");
    if (!transcript.trim()) return [];

    const when = timestamp ? `Turn timestamp: ${timestamp}\n\n` : "Turn timestamp: (unknown)\n\n";
    const prompt = `${when}Conversation turn:\n${transcript}`;
    const started = Date.now();
    const { object, usage } = await generateObject({
      model: this.anthropic(LLM_MODEL),
      schema: extractionSchema,
      system: EXTRACTION_SYSTEM,
      prompt,
    });
    const { input, output } = recordLlm(usage);
    logInference({
      kind: "llm",
      phase: "extract",
      model: LLM_MODEL,
      inputTokens: input,
      outputTokens: output,
      latencyMs: Date.now() - started,
      request: `${EXTRACTION_SYSTEM}\n\n${prompt}`,
      response: JSON.stringify(object),
    });
    return object.memories.map((m) => ({ ...m, snippet: transcript.slice(0, 280) }));
  }

  async embed(text: string, phase = "embed"): Promise<number[]> {
    const started = Date.now();
    const { embedding, usage } = await embed({
      model: this.openai.textEmbeddingModel(EMBED_MODEL),
      value: text || " ",
    });
    const tokens = recordEmbedding(usage?.tokens);
    logInference({
      kind: "embedding",
      phase,
      model: EMBED_MODEL,
      inputTokens: tokens,
      outputTokens: undefined,
      latencyMs: Date.now() - started,
      request: text,
      response: EMBED_RESPONSE,
    });
    return embedding;
  }

  async embedBatch(texts: string[], phase = "embed_batch"): Promise<number[][]> {
    if (texts.length === 0) return [];
    const started = Date.now();
    const { embeddings, usage } = await embedMany({
      model: this.openai.textEmbeddingModel(EMBED_MODEL),
      values: texts.map((t) => t || " "),
    });
    const tokens = recordEmbedding(usage?.tokens);
    // One row per batch call (batch tokens are billed/reported as a whole). The
    // request column carries the batched texts so the audit stays self-contained.
    logInference({
      kind: "embedding",
      phase,
      model: EMBED_MODEL,
      inputTokens: tokens,
      outputTokens: undefined,
      latencyMs: Date.now() - started,
      request: texts.join("\n---\n"),
      response: `${embeddings.length}x ${EMBED_RESPONSE}`,
    });
    return embeddings;
  }

  async compact(context: string, query: string, maxTokens: number): Promise<string> {
    const system =
      "You compress an agent's memory context so it fits a token budget. Keep the markdown headers and the highest-value facts for answering the query. Drop low-value lines. Never invent facts. Preserve dates and supersession notes.";
    const prompt = `Query: ${query}\nBudget: ~${maxTokens} tokens.\n\nContext to compress:\n${context}`;
    const started = Date.now();
    const { object, usage } = await generateObject({
      model: this.anthropic(LLM_MODEL),
      schema: z.object({ context: z.string() }),
      system,
      prompt,
    });
    const { input, output } = recordLlm(usage);
    logInference({
      kind: "llm",
      phase: "compaction",
      model: LLM_MODEL,
      inputTokens: input,
      outputTokens: output,
      latencyMs: Date.now() - started,
      request: `${system}\n\n${prompt}`,
      response: object.context,
    });
    return object.context;
  }
}

// --------------------------------------------------------------------------
// Mock provider: deterministic, offline. Real enough to exercise the pipeline.
// --------------------------------------------------------------------------

/** Hash-based pseudo-embedding: deterministic, semantic-ish via token hashing. */
function hashEmbed(text: string): number[] {
  const vec = new Float64Array(EMBED_DIM);
  const toks = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(Boolean);
  for (const tok of toks) {
    // Two independent hashes per token spread signal across the vector.
    let h1 = 2166136261;
    for (let i = 0; i < tok.length; i++) {
      h1 ^= tok.charCodeAt(i);
      h1 = Math.imul(h1, 16777619);
    }
    const idx = Math.abs(h1) % EMBED_DIM;
    vec[idx] += 1;
    const idx2 = Math.abs(Math.imul(h1, 48271)) % EMBED_DIM;
    vec[idx2] += 0.5;
  }
  // L2 normalise so cosine distance behaves.
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return Array.from(vec, (v) => v / norm);
}

// A compact rule set covering the spec's named categories. This is NOT the
// product extractor — it is the offline stand-in so CI has no network. The live
// LLM extractor is the real thing.
const RULES: Array<{
  re: RegExp;
  build: (m: RegExpExecArray) => Omit<ExtractedMemory, "snippet">;
}> = [
  {
    // Leading keywords match either case (sentence-initial capitals) while the
    // captured name stays uppercase-initial. Same idea throughout this rule set.
    re: /\b[Mm]y name is\s+(\p{Lu}[\p{L}'-]+)/u,
    build: (m) => ({ type: "fact", key: "name", value: m[1], confidence: 0.95, mutable: true }),
  },
  {
    re: /\b[Ii](?:'m| am)?\s+(?:now\s+)?(?:work(?:ing)?\s+(?:at|for)|just\s+(?:joined|started(?:\s+(?:at|working\s+at))?)|joined|got\s+a\s+job\s+at)\s+(\p{Lu}[\p{L}\p{N}&.'\- ]*?[\p{L}\p{N}])(?:\s+as\s+(?:an?\s+)?([\p{L} \-]+?))?(?:[.,!?]|$)/u,
    build: (m) => ({
      type: "fact",
      key: "employment",
      value: m[2] ? `${m[1].trim()} as a ${m[2].trim()}` : m[1].trim(),
      confidence: 0.9,
      mutable: true,
    }),
  },
  {
    // PLACE = one or more Capitalized words ("Berlin", "San Francisco", "Zürich").
    // The capitalized-word boundary stops cleanly before emoji/lowercase trailers.
    re: /\b[Ii]\s+(?:just\s+|recently\s+)?moved\s+to\s+(\p{Lu}[\p{L}'-]*(?:[ ]\p{Lu}[\p{L}'-]*)*)(?:\s+from\s+(\p{Lu}[\p{L}'-]*(?:[ ]\p{Lu}[\p{L}'-]*)*))?/u,
    build: (m) => ({
      type: "fact",
      key: "location",
      value: m[1].trim(),
      confidence: 0.9,
      mutable: true,
    }),
  },
  {
    re: /\b[Ii](?:'m| am)?\s+(?:live|living|based|located)\s+in\s+(\p{Lu}[\p{L}'-]*(?:[ ]\p{Lu}[\p{L}'-]*)*)/u,
    build: (m) => ({
      type: "fact",
      key: "location",
      value: m[1].trim(),
      confidence: 0.85,
      mutable: true,
    }),
  },
  {
    re: /\b(?:[Mm]y|[Oo]ur)\s+(dog|cat|puppy|kitten|bird|hamster|rabbit)\s+(?:is\s+)?(?:named|called)\s+([A-Z][\w]+)/,
    build: (m) => ({
      type: "fact",
      key: `pet:${m[2].toLowerCase()}`,
      value: `has a ${m[1].toLowerCase()} named ${m[2]}`,
      confidence: 0.9,
      mutable: false,
    }),
  },
  {
    re: /\b[Ww]alking\s+(?:my\s+)?(?:dog\s+|cat\s+)?([A-Z][\w]+)/,
    build: (m) => ({
      type: "fact",
      key: `pet:${m[1].toLowerCase()}`,
      value: `has a pet named ${m[1]}`,
      confidence: 0.6,
      mutable: false,
    }),
  },
  {
    re: /\bI(?:'m| am)?\s+(?:a\s+)?(vegetarian|vegan|pescatarian)\b/i,
    build: (m) => ({
      type: "preference",
      key: "diet",
      value: m[1].toLowerCase(),
      confidence: 0.9,
      mutable: true,
    }),
  },
  {
    re: /\ballergic\s+to\s+([A-Za-z][\w'\- ]*?[A-Za-z])(?:[.,!?]|$)/i,
    build: (m) => ({
      type: "fact",
      key: `allergy:${m[1].trim().toLowerCase()}`,
      value: `allergic to ${m[1].trim().toLowerCase()}`,
      confidence: 0.9,
      mutable: false,
    }),
  },
  {
    re: /\bmy\s+(wife|husband|partner|son|daughter|mother|father|brother|sister)\b(?:\s+(?:is\s+|named\s+|called\s+)([A-Z][\w]+))?/i,
    build: (m) => ({
      type: "fact",
      key: `family:${m[1].toLowerCase()}`,
      value: m[2] ? `${m[1].toLowerCase()} named ${m[2]}` : `has a ${m[1].toLowerCase()}`,
      confidence: 0.8,
      mutable: Boolean(m[2]),
    }),
  },
  {
    re: /\bI\s+(love|really like|like|enjoy|prefer|hate|dislike|can't stand|don't like)\s+([A-Za-z][\w'\-+# ]*?)(?:[.,!?]|$)/i,
    build: (m) => {
      const topic = m[2].trim();
      return {
        type: "opinion",
        key: `preference:${topic.toLowerCase().replace(/\s+/g, "_")}`,
        value: `${m[1].toLowerCase()} ${topic}`,
        confidence: 0.65,
        mutable: true,
      };
    },
  },
];

export class MockProvider implements Provider {
  readonly name = "mock";

  async extract(messages: Message[], _timestamp: string | null): Promise<ExtractedMemory[]> {
    // Offline: no tokens are actually spent. Record the call with zero usage so
    // the /metrics call counters still tick (the harness/tests can observe a
    // turn happened) without inventing token spend.
    const started = Date.now();
    const transcript = messages
      .map((m) => `${m.role}${m.name ? `(${m.name})` : ""}: ${m.content}`)
      .join("\n");
    recordLlm();
    const out: ExtractedMemory[] = [];
    const seen = new Set<string>();
    for (const msg of messages) {
      // Mine first-person USER statements only; assistant/tool text describes the
      // world, not the user — a precision trap.
      if ((msg.role ?? "").toLowerCase() !== "user") continue;
      const text = (msg.content ?? "").trim();
      if (!text) continue;
      // Split on Latin and CJK sentence enders so mixed-script turns segment well.
      for (const sentence of text.split(/(?<=[.!?。！？])\s*|\n+/)) {
        const s = sentence.trim();
        if (!s) continue;
        for (const rule of RULES) {
          const m = rule.re.exec(s);
          if (!m) continue;
          const base = rule.build(m);
          if (!base.value || base.value.length > 80) continue;
          const sig = `${base.key}=${base.value.toLowerCase()}`;
          if (seen.has(sig)) continue;
          seen.add(sig);
          out.push({ ...base, snippet: s.slice(0, 280) });
        }
      }
    }
    logInference({
      kind: "llm",
      phase: "extract",
      model: this.name,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Date.now() - started,
      request: transcript,
      response: JSON.stringify({ memories: out.map(({ snippet: _s, ...m }) => m) }),
    });
    return out;
  }

  async embed(text: string, phase = "embed"): Promise<number[]> {
    const started = Date.now();
    recordEmbedding();
    const v = hashEmbed(text);
    logInference({
      kind: "embedding",
      phase,
      model: this.name,
      inputTokens: 0,
      outputTokens: undefined,
      latencyMs: Date.now() - started,
      request: text,
      response: EMBED_RESPONSE,
    });
    return v;
  }

  async embedBatch(texts: string[], phase = "embed_batch"): Promise<number[][]> {
    const started = Date.now();
    recordEmbedding();
    const v = texts.map(hashEmbed);
    logInference({
      kind: "embedding",
      phase,
      model: this.name,
      inputTokens: 0,
      outputTokens: undefined,
      latencyMs: Date.now() - started,
      request: texts.join("\n---\n"),
      response: `${v.length}x ${EMBED_RESPONSE}`,
    });
    return v;
  }

  async compact(context: string, query: string, maxTokens: number): Promise<string> {
    const started = Date.now();
    recordLlm();
    // Deterministic offline compaction: drop trailing lines until it fits.
    const budgetChars = maxTokens * 4;
    const lines = context.split("\n");
    if (context.length > budgetChars) {
      while (lines.length > 1 && lines.join("\n").length > budgetChars) lines.pop();
    }
    const result = lines.join("\n");
    logInference({
      kind: "llm",
      phase: "compaction",
      model: this.name,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Date.now() - started,
      request: `Query: ${query}\nBudget: ~${maxTokens} tokens.\n\nContext to compress:\n${context}`,
      response: result,
    });
    return result;
  }
}

export function buildProvider(settings: Settings): Provider {
  return settings.provider === "live" ? new LiveProvider(settings) : new MockProvider();
}
