/**
 * Test helper: drive the REAL Vercel AI SDK `generateObject` against the
 * tolerant extraction schema, using an offline MockLanguageModelV1 that returns
 * a caller-supplied (realistic) object as its response text.
 *
 * This exercises the exact validation path production uses — the same schema, the
 * same repair function, the same "did the response match the schema" gate that
 * was throwing in benchmarking — so a regression to a stricter schema is caught.
 */

import { generateObject } from "ai";
import { MockLanguageModelV1 } from "ai/test";
import type { CandidateMemory } from "../src/extraction/schemas";
import { extractionResultSchema } from "../src/extraction/schemas";

/**
 * Run `generateObject` with the extraction schema over a mocked model whose raw
 * text is `rawObject` serialised (optionally wrapped to simulate Opus quirks).
 */
export async function extractCandidatesViaMock(
  rawObject: unknown,
  opts: { wrap?: "fence" | "preamble" } = {},
): Promise<CandidateMemory[]> {
  let text = JSON.stringify(rawObject);
  if (opts.wrap === "fence") text = `\`\`\`json\n${text}\n\`\`\``;
  if (opts.wrap === "preamble") text = `Here is the extraction:\n${text}`;

  const model = new MockLanguageModelV1({
    defaultObjectGenerationMode: "json",
    doGenerate: async () => ({
      rawCall: { rawPrompt: null, rawSettings: {} },
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 20 },
      text,
    }),
  });

  const { object } = await generateObject({
    model,
    schema: extractionResultSchema,
    prompt: "extract",
  });
  return object.memories;
}
