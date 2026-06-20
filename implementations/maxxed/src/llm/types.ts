/**
 * The injectable LLM/embedding seam.
 *
 * Everything in the pipeline that would otherwise hit the network goes through
 * this interface. The live implementation (client.ts) wraps the Vercel AI SDK;
 * the mock (mock.ts) is deterministic and offline so the whole contract suite
 * runs in CI without keys. A `LlmClient` exposes exactly three capabilities:
 *   - embed / embedMany : OpenAI text-embedding-3-large (3072-dim)
 *   - generateObject    : Claude Opus 4.8 structured output via a Zod schema
 *
 * Keeping the surface this small means the extraction reconciler and the recall
 * reranker are testable in isolation and swappable per environment.
 */

import type { z } from "zod";

export interface LlmClient {
  /** Stable identifier for logging ("ai-sdk", "mock", ...). */
  readonly kind: string;
  /** Embedding dimensionality this client produces. */
  readonly dim: number;
  /** Whether this client can reach a real model (false for the mock). */
  readonly live: boolean;

  /**
   * Embed one text. `phase` is a free-form call-site label used only for the
   * per-call cost audit log (e.g. "embed_query", "embed_memory"); it never
   * affects the embedding itself and defaults to a generic label.
   */
  embed(text: string, phase?: string): Promise<number[]>;
  embedMany(texts: string[], phase?: string): Promise<number[][]>;

  /**
   * Structured generation constrained to a Zod schema.
   *
   * The schema type allows a differing input type (`z.ZodType<T, _, unknown>`)
   * so tolerant/normalising schemas built with `z.preprocess` (whose parse input
   * is `unknown` but output is `T`) still infer `T` correctly at call sites.
   */
  generateObject<T>(args: {
    schema: z.ZodType<T, z.ZodTypeDef, unknown>;
    system?: string;
    prompt: string;
    /** Free-form label for logs / tracing. */
    purpose: string;
  }): Promise<T>;
}
