/**
 * Zod schemas for the LLM structured-output steps of the extraction pipeline.
 * These define the contract between the prompt and generateObject, and double as
 * the validation the mock client must satisfy.
 *
 * Design note — TOLERANT BY DESIGN. `generateObject` throws
 * "No object generated: response did not match schema" whenever the model's JSON
 * parses but fails Zod validation. Claude Opus 4.8 conforms to the *shape* almost
 * always, but reliably trips strict field constraints on the margins:
 *   - `type` cased/pluralised differently ("Fact", "facts", "belief");
 *   - `confidence` as a percentage (85) or a string ("0.9"), or omitted;
 *   - `mutable` as the string "true"/"false", or omitted;
 *   - `entities`/`snippet` omitted when there's nothing clean to put there, or
 *     emitted as non-strings.
 * Rather than fail the whole turn (and silently fall back to the rule extractor),
 * we coerce/normalise these into the canonical shape and supply sane defaults.
 * The downstream code still receives exactly the same `CandidateMemory` shape.
 */

import { z } from "zod";
import { MEMORY_TYPES, type MemoryType } from "./types";

const MEMORY_TYPE_SET = new Set<string>(MEMORY_TYPES);

/** Map common Opus variants of the type label onto the canonical enum. */
function normalizeType(input: unknown): MemoryType {
  const raw = String(input ?? "")
    .trim()
    .toLowerCase()
    .replace(/s$/, ""); // "facts" -> "fact", "events" -> "event"
  if (MEMORY_TYPE_SET.has(raw)) return raw as MemoryType;
  // Sensible aliases the model occasionally reaches for.
  if (raw === "belief" || raw === "view" || raw === "stance") return "opinion";
  if (raw === "like" || raw === "dislike" || raw === "habit") return "preference";
  if (raw === "experience" || raw === "activity") return "event";
  return "fact"; // safest default: a durable statement about the user
}

/** Coerce confidence into 0..1, accepting percentages and strings. */
function normalizeConfidence(input: unknown): number {
  let n = typeof input === "string" ? Number.parseFloat(input) : Number(input);
  if (!Number.isFinite(n)) return 0.7; // default for an absent/garbage value
  if (n > 1) n = n / 100; // model emitted a percentage (e.g. 85)
  return Math.min(1, Math.max(0, n));
}

/** Coerce mutable into a boolean, accepting "true"/"false"/"yes"/0/1. */
function normalizeBool(input: unknown, fallback: boolean): boolean {
  if (typeof input === "boolean") return input;
  if (typeof input === "number") return input !== 0;
  if (typeof input === "string") {
    const s = input.trim().toLowerCase();
    if (["true", "yes", "y", "1"].includes(s)) return true;
    if (["false", "no", "n", "0"].includes(s)) return false;
  }
  return fallback;
}

/** Coerce entities into a clean lowercase string[] (drops objects/empties). */
function normalizeEntities(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const e of input) {
    if (typeof e === "string") {
      const t = e.trim().toLowerCase();
      if (t) out.push(t);
    } else if (e && typeof e === "object") {
      // Occasionally the model emits {name: "biscuit"} or {value: "..."}.
      const v = (e as Record<string, unknown>).name ?? (e as Record<string, unknown>).value;
      if (typeof v === "string" && v.trim()) out.push(v.trim().toLowerCase());
    }
  }
  return out;
}

function asString(input: unknown): string {
  if (typeof input === "string") return input;
  if (input == null) return "";
  return String(input);
}

/**
 * Pre-normalise one raw memory object before strict validation. Runs as a Zod
 * preprocess so coercion happens inside the schema (and so the mock/offline path
 * is exercised identically).
 */
const normalizeCandidate = (raw: unknown): unknown => {
  if (!raw || typeof raw !== "object") return raw;
  const r = raw as Record<string, unknown>;
  const key = asString(r.key).trim();
  const value = asString(r.value).trim();
  return {
    type: normalizeType(r.type),
    key,
    value,
    confidence: normalizeConfidence(r.confidence),
    mutable: normalizeBool(r.mutable, true),
    // Fall back to the value when the model omits a source snippet.
    snippet: asString(r.snippet ?? r.source ?? value).trim() || value,
    entities: normalizeEntities(r.entities),
  };
};

export const candidateMemorySchema = z.preprocess(
  normalizeCandidate,
  z.object({
    type: z.enum(MEMORY_TYPES),
    key: z
      .string()
      .min(1)
      .describe("canonical slot slug, e.g. 'employment', 'location', 'pet:biscuit', 'diet'"),
    value: z.string().min(1).describe("concise human-readable statement, e.g. 'Notion as a PM'"),
    confidence: z.number().min(0).max(1),
    mutable: z
      .boolean()
      .describe("true if a single-valued slot (new value supersedes old); false if additive"),
    snippet: z.string().describe("the source phrase this was derived from"),
    entities: z
      .array(z.string())
      .describe("lowercase canonical entity tokens for graph linking, e.g. ['biscuit','corgi']"),
  }),
);

export const extractionResultSchema = z.preprocess(
  (raw) => {
    // Accept either {memories:[...]} or a bare array, and drop empty rows so a
    // single malformed entry can't sink the whole turn.
    if (Array.isArray(raw)) return { memories: raw };
    if (raw && typeof raw === "object") {
      const r = raw as Record<string, unknown>;
      const list = r.memories ?? r.results ?? r.items;
      if (Array.isArray(list)) return { memories: list };
    }
    return { memories: [] };
  },
  z.object({
    memories: z.array(candidateMemorySchema),
  }),
);

// The CandidateMemory type is the *output* (post-normalisation) shape, so the
// rest of the pipeline keeps its strict, canonical contract.
export type CandidateMemory = z.output<typeof candidateMemorySchema>;

const normalizeDecision = (raw: unknown): unknown => {
  if (!raw || typeof raw !== "object") return raw;
  const r = raw as Record<string, unknown>;
  const decision = String(r.decision ?? "")
    .trim()
    .toUpperCase();
  const valid = ["ADD", "UPDATE", "SUPERSEDE", "NOOP"];
  // target_id: normalise "", "null", "none" -> null.
  let target = r.target_id ?? r.targetId ?? null;
  if (typeof target === "string") {
    const t = target.trim();
    target = t && !["null", "none", "n/a"].includes(t.toLowerCase()) ? t : null;
  }
  return {
    decision: valid.includes(decision) ? decision : "ADD",
    target_id: target,
    reason: asString(r.reason).trim() || "no reason given",
  };
};

export const reconcileDecisionSchema = z.preprocess(
  normalizeDecision,
  z.object({
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
  }),
);

export type ReconcileDecision = z.output<typeof reconcileDecisionSchema>;
