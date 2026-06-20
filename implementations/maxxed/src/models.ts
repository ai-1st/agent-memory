/**
 * Zod request schemas + response types matching the HTTP contract (§3).
 *
 * Lenient on inputs (unknown keys stripped, roles free-form, missing content
 * tolerated) so the service is resilient to odd-but-valid payloads, while strict
 * enough that genuinely malformed requests fail validation (-> 422) rather than
 * crashing. Shapes are kept byte-compatible with the root baseline so the same
 * eval harness scores every implementation.
 */

import { z } from "zod";

export const messageSchema = z.object({
  role: z.string(),
  content: z.string().nullable().optional().default(""),
  name: z.string().nullable().optional(),
});

export const turnRequestSchema = z.object({
  session_id: z.string().min(1),
  user_id: z.string().nullable().optional(),
  messages: z.array(messageSchema).min(1),
  timestamp: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional().default({}),
});

export const recallRequestSchema = z.object({
  query: z.string(),
  session_id: z.string().nullable().optional(),
  user_id: z.string().nullable().optional(),
  // "as of" temporal scoping: optional, defaults to now. Time-correct recall.
  as_of: z.string().nullable().optional(),
  max_tokens: z.number().int().positive().default(1024),
});

export const searchRequestSchema = z.object({
  query: z.string(),
  session_id: z.string().nullable().optional(),
  user_id: z.string().nullable().optional(),
  limit: z.number().int().positive().default(10),
});

export type Message = z.infer<typeof messageSchema>;
export type TurnRequest = z.infer<typeof turnRequestSchema>;
export type RecallRequest = z.infer<typeof recallRequestSchema>;
export type SearchRequest = z.infer<typeof searchRequestSchema>;

/** Citation echoed back from /recall (turn-level provenance for each line). */
export interface Citation {
  turn_id: string;
  score: number;
  snippet: string;
}

/** A structured search result row from /search. */
export interface SearchHit {
  content: string;
  score: number;
  session_id: string | null;
  timestamp: string | null;
  metadata: Record<string, unknown>;
}
