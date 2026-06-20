/** Prefixed, URL-safe ids and time helpers. */

import { randomUUID } from "node:crypto";

export const newId = (prefix: string): string =>
  `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

export const nowIso = (): string => new Date().toISOString();

/** Normalize a value for cheap equality comparison (dedup / supersession). */
export const norm = (v: string): string =>
  v
    .toLowerCase()
    .replace(/[\s.,!?;:'"`]+/g, " ")
    .trim();

/** Date prefix (YYYY-MM-DD) of an ISO timestamp, or "" if null. */
export const dateOf = (ts: string | null | undefined): string => (ts ?? "").slice(0, 10);
