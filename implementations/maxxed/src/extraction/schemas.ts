/**
 * Zod schemas for the LLM structured-output steps of the extraction pipeline.
 * These define the contract between the prompt and generateObject, and double as
 * the validation the mock client must satisfy.
 */

import { z } from "zod";
import { MEMORY_TYPES } from "./types";

export const candidateMemorySchema = z.object({
  type: z.enum(MEMORY_TYPES),
  key: z
    .string()
    .describe("canonical slot slug, e.g. 'employment', 'location', 'pet:biscuit', 'diet'"),
  value: z.string().describe("concise human-readable statement, e.g. 'Notion as a PM'"),
  confidence: z.number().min(0).max(1),
  mutable: z
    .boolean()
    .describe("true if a single-valued slot (new value supersedes old); false if additive"),
  snippet: z.string().describe("the source phrase this was derived from"),
  entities: z
    .array(z.string())
    .describe("lowercase canonical entity tokens for graph linking, e.g. ['biscuit','corgi']"),
});

export const extractionResultSchema = z.object({
  memories: z.array(candidateMemorySchema),
});

export type CandidateMemory = z.infer<typeof candidateMemorySchema>;

export const reconcileDecisionSchema = z.object({
  decision: z
    .enum(["ADD", "UPDATE", "SUPERSEDE", "NOOP"])
    .describe(
      "ADD new memory; UPDATE existing in place (refinement, same fact); SUPERSEDE existing (contradiction/correction, keep history); NOOP if duplicate or noise",
    ),
  target_id: z
    .string()
    .nullable()
    .describe("id of the existing memory to update/supersede, or null for ADD/NOOP"),
  reason: z.string().describe("one short clause explaining the decision"),
});

export type ReconcileDecision = z.infer<typeof reconcileDecisionSchema>;
