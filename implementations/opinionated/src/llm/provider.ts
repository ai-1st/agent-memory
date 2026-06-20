/**
 * The LLM provider seam.
 *
 * Everything the pipeline needs from "the model layer" goes through this single
 * interface so the whole service runs OFFLINE in tests against a deterministic
 * mock (no network, no keys). Live operation wires this to the Vercel AI SDK
 * (`generateObject` with Claude Opus 4.8, `embedMany` with OpenAI
 * text-embedding-3-large). All structured decisions are Zod-typed.
 */

import type { z } from "zod";

export interface LLMProvider {
  readonly name: string;
  /** Embed a batch of texts. Returned vectors share a fixed dimension. */
  embed(texts: string[]): Promise<number[][]>;
  /**
   * Structured generation: prompt -> object validated against `schema`.
   * Resolves to the schema's OUTPUT type (defaults applied), not its input.
   */
  generate<S extends z.ZodTypeAny>(args: {
    schema: S;
    system: string;
    prompt: string;
    /** Free-form label used by the mock to route deterministic responses. */
    task: string;
  }): Promise<z.infer<S>>;
}
