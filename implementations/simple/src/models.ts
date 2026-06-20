/**
 * Zod request schemas + shared response types — the wire contract from §3.
 *
 * Inputs are lenient (unknown keys stripped, roles free-form, content defaults
 * to "") so the service is resilient to odd-but-valid payloads, yet strict
 * enough that genuinely malformed requests fail validation (-> 422) rather than
 * crashing the process.
 */

import { z } from "zod";

export const messageSchema = z.object({
  role: z.string(),
  content: z.string().default(""),
  name: z.string().nullable().optional(),
});

export const turnRequestSchema = z.object({
  session_id: z.string().min(1),
  user_id: z.string().nullable().optional(),
  messages: z.array(messageSchema).min(1),
  timestamp: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).default({}),
});

export const recallRequestSchema = z.object({
  query: z.string(),
  session_id: z.string().nullable().optional(),
  user_id: z.string().nullable().optional(),
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

/** One citation row in a /recall response. */
export interface Citation {
  turn_id: string;
  score: number;
  snippet: string;
}
