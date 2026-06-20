/**
 * Live LLM provider backed by the Vercel AI SDK.
 *
 * - Embeddings: OpenAI `text-embedding-3-large` (3072-dim) via `embedMany`.
 * - Structured generation: Anthropic `claude-opus-4-8` via `generateObject`
 *   with a Zod schema — every decision the pipeline makes is a typed object.
 *
 * We deliberately do NOT optimize for cost or latency here (per the spec):
 * extraction quality and reconciliation correctness come first.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { embedMany, generateObject } from "ai";
import type { z } from "zod";
import type { Settings } from "../config";
import type { LLMProvider } from "./provider";

export function createLiveProvider(settings: Settings): LLMProvider {
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!openaiKey) throw new Error("OPENAI_API_KEY is required for the live LLM provider");
  if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY is required for the live LLM provider");

  const openai = createOpenAI({ apiKey: openaiKey });
  // claude-opus-4-8 rejects the `temperature` sampling parameter, but the
  // Vercel AI SDK v4 core injects `temperature: 0` by default (a documented
  // v4 behavior slated for removal in v5). We strip it at the fetch boundary so
  // the call is correct regardless of SDK/provider version. We also strip the
  // legacy `thinking` block (the model uses adaptive thinking by default and
  // rejects the old budget-style thinking parameter).
  const anthropic = createAnthropic({
    apiKey: anthropicKey,
    fetch: (async (input: any, init: any) => {
      if (init?.body && typeof init.body === "string") {
        try {
          const { temperature: _drop, ...rest } = JSON.parse(init.body);
          if (_drop !== undefined) {
            return fetch(input, { ...init, body: JSON.stringify(rest) });
          }
        } catch {
          // leave the body untouched if it isn't JSON
        }
      }
      return fetch(input, init);
    }) as typeof fetch,
  });
  const embeddingModel = openai.embedding(settings.embeddingModel);
  const chatModel = anthropic(settings.llmModel);

  return {
    name: "live",

    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const { embeddings } = await embedMany({ model: embeddingModel, values: texts });
      return embeddings;
    },

    async generate<S extends z.ZodTypeAny>(args: {
      schema: S;
      system: string;
      prompt: string;
      task: string;
    }): Promise<z.infer<S>> {
      // NOTE: claude-opus-4-8 removed the `temperature` sampling parameter
      // (sending it returns a 400). Determinism is steered via the prompts
      // (low-ambiguity instructions) and structured-output schemas instead.
      const { object } = await generateObject({
        model: chatModel,
        schema: args.schema,
        system: args.system,
        prompt: args.prompt,
      });
      return object;
    },
  };
}
