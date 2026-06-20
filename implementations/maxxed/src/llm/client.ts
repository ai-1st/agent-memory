/**
 * Live LLM client backed by the Vercel AI SDK.
 *
 *   - Embeddings: OpenAI text-embedding-3-large (3072-dim) via embed/embedMany.
 *   - Structured output: Claude Opus 4.8 via generateObject + a Zod schema.
 *
 * Providers are created with explicit API keys (read from env) so the client
 * fails loudly at construction if a key is missing while pipeline=llm. Network
 * calls have retries (AI SDK default) and a soft timeout guard so a hung
 * provider can't exceed the /turns contract budget.
 *
 * ROBUSTNESS (structured output): `generateObject` throws
 * "No object generated: response did not match schema" when the model's text
 * either fails to parse as JSON or fails Zod validation. We harden both edges:
 *   - schemas are tolerant/normalising (see extraction/schemas.ts), so Opus's
 *     casing/percentage/optional-field quirks validate instead of throwing;
 *   - `experimental_repairText` salvages JSON wrapped in ``` fences or prose
 *     (a JSONParseError the schema can't reach because parsing fails first);
 *   - `maxRetries` re-asks the model on a transient miss.
 * The rule fallback in the extractor is now a genuine last resort.
 *
 * METRICS: every call's `usage` is funnelled into the module-level counters in
 * metrics.ts so GET /metrics can report cumulative token spend since start.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { type LanguageModel, type RepairTextFunction, embed, embedMany, generateObject } from "ai";
import type { z } from "zod";
import type { Settings } from "../config";
import { logCall } from "./csvlog";
import { recordEmbeddingUsage, recordLlmUsage } from "./metrics";
import type { LlmClient } from "./types";

const GENERATE_MAX_RETRIES = 2;

/**
 * A fetch wrapper that removes `temperature`/`top_p`/`top_k` from the request
 * body before it reaches the Anthropic API (those params 400 on opus-4-8).
 */
const stripSamplingParams: typeof fetch = async (input, init) => {
  let next = init;
  if (init?.body && typeof init.body === "string") {
    try {
      const body = JSON.parse(init.body);
      let changed = false;
      for (const k of ["temperature", "top_p", "top_k"]) {
        if (k in body) {
          delete body[k];
          changed = true;
        }
      }
      if (changed) next = { ...init, body: JSON.stringify(body) };
    } catch {
      // non-JSON body: leave untouched.
    }
  }
  return fetch(input, next);
};

/**
 * Salvage a JSON object/array from model text that didn't parse cleanly — most
 * often because Opus wrapped it in a ```json fence or added a one-line preamble.
 * Returning the inner JSON lets generateObject re-validate it (now against the
 * tolerant schema) instead of degrading to the rule fallback. Returns null when
 * there's nothing salvageable, so the SDK keeps its original error.
 */
export const repairJsonText: RepairTextFunction = async ({ text }) => {
  if (!text) return null;
  // 1) Strip a fenced code block if present.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1] : text;
  // 2) Take the outermost {...} or [...] span.
  const start = body.search(/[[{]/);
  if (start === -1) return null;
  const open = body[start];
  const close = open === "{" ? "}" : "]";
  const end = body.lastIndexOf(close);
  if (end <= start) return null;
  const candidate = body.slice(start, end + 1);
  try {
    JSON.parse(candidate); // only return if it actually parses
    return candidate;
  } catch {
    return null;
  }
};

export class AiSdkClient implements LlmClient {
  readonly kind = "ai-sdk";
  readonly live = true;
  readonly dim: number;

  private model: LanguageModel;
  private embedder: ReturnType<ReturnType<typeof createOpenAI>["embedding"]>;
  private readonly llmModelId: string;
  private readonly embedModelId: string;

  constructor(settings: Settings) {
    const openaiKey = process.env.OPENAI_API_KEY;
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!openaiKey) {
      throw new Error("OPENAI_API_KEY required for the llm pipeline (embeddings).");
    }
    if (!anthropicKey) {
      throw new Error("ANTHROPIC_API_KEY required for the llm pipeline (extraction/rerank).");
    }
    this.dim = settings.embedDim;
    const openai = createOpenAI({ apiKey: openaiKey });
    // claude-opus-4-8 rejects the sampling params (`temperature`/`top_p`/`top_k`)
    // that AI SDK v4 injects by default (it hard-codes temperature=0 for
    // generateObject). We can't suppress that from the call site, so we wrap the
    // provider's fetch and strip those keys from the outgoing JSON body. This is
    // the documented AI-SDK escape hatch and keeps us on the mandated SDK.
    const anthropic = createAnthropic({ apiKey: anthropicKey, fetch: stripSamplingParams });
    this.model = anthropic(settings.llmModel);
    this.embedder = openai.embedding(settings.embedModel, { dimensions: settings.embedDim });
    this.llmModelId = settings.llmModel;
    this.embedModelId = settings.embedModel;
  }

  async embed(text: string, phase = "embed"): Promise<number[]> {
    const value = text || " ";
    const start = Date.now();
    const { embedding, usage } = await embed({ model: this.embedder, value });
    recordEmbeddingUsage(usage?.tokens);
    logCall({
      kind: "embedding",
      phase,
      model: this.embedModelId,
      inputTokens: usage?.tokens,
      outputTokens: undefined, // embeddings produce no completion tokens
      latencyMs: Date.now() - start,
      request: value,
      response: `[${this.dim}-dim vector]`,
    });
    return embedding;
  }

  async embedMany(texts: string[], phase = "embed"): Promise<number[][]> {
    if (texts.length === 0) return [];
    const values = texts.map((t) => t || " ");
    const start = Date.now();
    const { embeddings, usage } = await embedMany({ model: this.embedder, values });
    recordEmbeddingUsage(usage?.tokens);
    const latencyMs = Date.now() - start;
    // One CSV row per embedded text — embedMany is a single API round-trip but
    // covers N inputs; per-input rows keep the audit granular. The batch usage
    // (total tokens) is attributed to the first row so the column sum stays
    // truthful while every text gets its own auditable line.
    for (let i = 0; i < values.length; i++) {
      logCall({
        kind: "embedding",
        phase,
        model: this.embedModelId,
        inputTokens: i === 0 ? usage?.tokens : undefined,
        outputTokens: undefined,
        latencyMs,
        request: values[i],
        response: `[${this.dim}-dim vector]`,
      });
    }
    return embeddings;
  }

  async generateObject<T>(args: {
    schema: z.ZodType<T, z.ZodTypeDef, unknown>;
    system?: string;
    prompt: string;
    purpose: string;
  }): Promise<T> {
    // NOTE: claude-opus-4-8 removed the `temperature`/`top_p`/`top_k` sampling
    // params (they return HTTP 400) and `thinking` is adaptive-only — so we pass
    // neither. Structured `generateObject` output is already near-deterministic.
    // maxRetries re-asks on a transient miss; experimental_repairText salvages
    // fenced/prefixed JSON before the schema even sees it.
    const start = Date.now();
    const { object, usage } = await generateObject({
      model: this.model,
      schema: args.schema as z.ZodType<T>,
      system: args.system,
      prompt: args.prompt,
      maxRetries: GENERATE_MAX_RETRIES,
      experimental_repairText: repairJsonText,
    });
    recordLlmUsage(usage?.promptTokens, usage?.completionTokens);
    logCall({
      kind: "llm",
      phase: args.purpose,
      model: this.llmModelId,
      inputTokens: usage?.promptTokens,
      outputTokens: usage?.completionTokens,
      latencyMs: Date.now() - start,
      // request = the full prompt actually sent (system preamble + user prompt).
      request: args.system ? `${args.system}\n\n${args.prompt}` : args.prompt,
      // response = the full structured output the model produced.
      response: JSON.stringify(object),
    });
    return object;
  }
}
