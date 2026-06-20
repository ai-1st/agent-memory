/**
 * Extraction interface + the structured-memory value object.
 *
 * An extractor turns raw messages into typed, queryable memories — the line
 * between a memory service and a message log. The maxxed pipeline enriches each
 * candidate with `entities` (for graph linking / multi-hop) on top of the
 * baseline's type/key/value/confidence/mutable.
 */

import type { Message } from "../models";

export const MEMORY_TYPES = ["fact", "preference", "opinion", "event"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface ExtractedMemory {
  type: string; // one of MEMORY_TYPES
  key: string; // canonical slot, e.g. "employment", "location", "pet:biscuit"
  value: string; // human-readable, e.g. "Notion as a PM"
  confidence: number;
  snippet: string; // source text the memory was derived from
  // mutable == single-valued slot: a new value supersedes the old one.
  // additive (mutable=false): multiple coexisting values (e.g. several allergies).
  mutable: boolean;
  // canonical entity tokens for graph linking & multi-hop (e.g. ["biscuit","alice"]).
  entities?: string[];
}

export interface ExtractContext {
  userId: string | null;
  sessionId: string;
  turnId: string;
  timestamp: string | null;
}

export interface Extractor {
  name: string;
  extract(messages: Message[], ctx: ExtractContext): Promise<ExtractedMemory[]>;
}
