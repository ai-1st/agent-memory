/**
 * Zod schemas for every structured LLM decision in the pipeline.
 *
 * These are the contract between the prompts and the rest of the system. They
 * are exported so the live provider validates real model output against them and
 * the mock provider produces values that satisfy them — same types both ways.
 */

import { z } from "zod";
import { MEMORY_TYPES } from "../models";

/** Stage 2: context-enriched fact extraction. */
export const extractedFactSchema = z.object({
  type: z.enum(MEMORY_TYPES),
  /**
   * Canonical slot for matching/supersession, e.g. "employment", "location",
   * "pet:biscuit", "preference:citrus_fruit". Lowercase, no spaces.
   */
  key: z.string().min(1),
  /**
   * Self-contained, context-enriched statement. MUST NOT contain dangling
   * pronouns/references — e.g. "User's dog is named Biscuit", never "it's named
   * Biscuit". Always phrased about the user.
   */
  value: z.string().min(1),
  /** Verbatim span from the raw turn this fact was derived from (for citation). */
  snippet: z.string().default(""),
  confidence: z.number().min(0).max(1).default(0.7),
  /**
   * mutable = single-valued slot (location, job): a new value supersedes the
   * old. additive (false) = multiple coexisting values (allergies, pets).
   */
  mutable: z.boolean().default(true),
});
export type ExtractedFact = z.infer<typeof extractedFactSchema>;

export const extractionSchema = z.object({
  facts: z.array(extractedFactSchema),
});
export type Extraction = z.infer<typeof extractionSchema>;

/**
 * Stage 3: per-fact reconciliation. Given one new fact + the similar existing
 * facts, the LLM returns a structured list of operations to apply.
 *
 *  - ADD       : genuinely new fact -> insert a new active row.
 *  - UPDATE    : same slot, value changed -> supersede the target, insert new.
 *  - REINFORCE : same fact restated -> bump confidence/updated_at, no new row.
 *  - CONTRADICT: new info conflicts with an existing fact -> insert new active
 *                row AND create a two-way link to the contradicted fact(s).
 *                Old fact is NOT deleted.
 *  - NOOP      : noise / already-known with nothing to change.
 */
export const reconcileOpSchema = z.object({
  /**
   * Chain-of-thought FIRST: the model writes a one-clause justification BEFORE
   * choosing `op`/`value`, so the reasoning actually conditions the decision
   * (a field placed after the decision is post-hoc and wasted). It is also
   * reused as the human-readable note on contradiction links and surfaced in
   * recall to narrate *why* a fact changed.
   */
  reason: z.string().default(""),
  op: z.enum(["ADD", "UPDATE", "REINFORCE", "CONTRADICT", "NOOP"]),
  /** Final, context-enriched value to store (for ADD/UPDATE/CONTRADICT). */
  value: z.string().default(""),
  /** Canonical slot for the stored fact. */
  key: z.string().default(""),
  type: z.enum(MEMORY_TYPES).default("fact"),
  confidence: z.number().min(0).max(1).default(0.7),
  mutable: z.boolean().default(true),
  /**
   * IDs of existing memories this op targets:
   *  - UPDATE/REINFORCE: the memory being superseded/reinforced.
   *  - CONTRADICT: the memory/memories the new fact conflicts with (linked).
   */
  target_ids: z.array(z.string()).default([]),
});
export type ReconcileOp = z.infer<typeof reconcileOpSchema>;

export const reconcileSchema = z.object({
  operations: z.array(reconcileOpSchema),
});
export type Reconcile = z.infer<typeof reconcileSchema>;

/**
 * Recall: the LLM reranks candidates and writes the compacted context.
 * It selects which candidate memories/turns to cite and produces the final
 * budgeted prose. `selected_ids` drive the citation list; `context` is the
 * formatted text injected into the agent's prompt.
 */
export const recallPlanSchema = z.object({
  /** IDs of candidate items the model chose to surface, best-first. */
  selected_ids: z.array(z.string()).default([]),
  /** Whether the model wants the full session fact set pulled (broaden). */
  want_session_facts: z.boolean().default(false),
  /** The final, budgeted, human-readable context block. */
  context: z.string().default(""),
});
export type RecallPlan = z.infer<typeof recallPlanSchema>;

/**
 * Multi-query retrieval (experimental, env-gated): given the query and the facts
 * the first retrieval round surfaced, the LLM proposes follow-up search queries
 * (bridge entities, sub-questions, related angles) to pull facts the single
 * first-round query missed. Each is embedded + searched and the results merged.
 */
export const queryExpansionSchema = z.object({
  queries: z.array(z.string()).default([]),
});
export type QueryExpansion = z.infer<typeof queryExpansionSchema>;
