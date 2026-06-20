/** Zod schemas + prompts for the LLM steps of recall (rewrite, rerank, compact). */

import { z } from "zod";

export const queryRewriteSchema = z.object({
  expanded: z
    .array(z.string())
    .describe("1-3 reformulations of the query (synonyms, decomposed sub-questions)"),
  entities: z.array(z.string()).describe("lowercase entity tokens mentioned in the query"),
});
export type QueryRewrite = z.infer<typeof queryRewriteSchema>;

export const rerankSchema = z.object({
  ranking: z.array(
    z.object({
      id: z.string(),
      relevance: z.number().min(0).max(1).describe("how well this memory answers the query"),
    }),
  ),
});
export type Rerank = z.infer<typeof rerankSchema>;

export const compactSchema = z.object({
  text: z.string().describe("the compacted context, preserving every concrete fact"),
});

export const REWRITE_SYSTEM = `You expand a recall query for a memory retrieval system.
Produce 1-3 short reformulations that would match how facts are phrased in memory
(e.g. "where do they live" -> ["user location", "city user lives in"]).
For multi-hop questions, also emit the intermediate sub-question
(e.g. "what city does the owner of the dog Biscuit live in" -> include "who owns Biscuit", "user location").
List the concrete entities (names/places/things) the query references.`;

export function buildRewritePrompt(query: string): string {
  return `<QUERY>\n${query}\n</QUERY>`;
}

export const RERANK_SYSTEM = `You re-rank candidate memories by how directly they help answer the query.
Score each 0..1. Reward memories that contain the specific entity/answer the query asks for;
penalize off-topic memories. Return every candidate with a score.`;

export function buildRerankPrompt(payload: {
  query: string;
  candidates: Array<{ id: string; text: string }>;
}): string {
  return `<JSON>\n${JSON.stringify(payload)}\n</JSON>`;
}

export const COMPACT_SYSTEM = `You compress a list of memory bullet points to fit a tight token budget.
Preserve EVERY concrete fact (names, places, dates, numbers). Merge related bullets,
drop filler words. Keep the markdown bullet structure. Never invent facts.`;

export function buildCompactPrompt(content: string, maxTokens: number): string {
  return `Compress to roughly ${maxTokens} tokens.\n<CONTENT>\n${content}\n</CONTENT>`;
}
