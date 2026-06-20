/**
 * LongMemEval adapter (Wu et al., ICLR 2025) — "Benchmarking Chat Assistants on
 * Long-Term Interactive Memory". Each instance is a question over a multi-session
 * chat history ("haystack"); we normalize one instance -> one `Scenario`:
 *   - user_id  = question_id (each question gets its own isolated user)
 *   - turns    = the haystack sessions (one SuiteTurn per session, dates preserved)
 *   - probes   = exactly one probe (the question + gold answer)
 *
 * DATASET (real, downloaded — NOT synthetic): the `longmemeval_oracle` variant
 * (oracle = only the evidence sessions, no distractors -> small & tractable to
 * ingest). Source: HuggingFace `xiaowu0162/longmemeval-cleaned` (the maintainer's
 * cleaned release of the ICLR'25 data). Place `longmemeval_oracle.json` (or
 * `longmemeval_s_cleaned.json` / `longmemeval_s.json`) under bench/data/longmemeval/.
 * See bench/suite/adapters/longmemeval.download.ts for the fetch command.
 *
 * Instance JSON schema (per item):
 *   question_id, question_type, question, answer, question_date,
 *   haystack_dates[], haystack_session_ids[], haystack_sessions[][{role,content,has_answer?}],
 *   answer_session_ids[]
 *
 * Question-type -> our rubric category:
 *   single-session-user / -assistant / -preference -> recall
 *   multi-session                                   -> multihop
 *   temporal-reasoning                              -> temporal
 *   knowledge-update                                -> fact_evolution
 *   ANY abstention question (question_id ends "_abs", regardless of base type)
 *                                                   -> noise_abstention (+ abstain:true)
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Adapter, Scenario, SuiteMessage, SuiteProbe, SuiteTurn } from "../types";

// Bound per-instance ingestion so a huge haystack (e.g. the `longmemeval_s`
// variant, ~500 sessions/item) can't blow up the run. The oracle variant tops
// out around 6 sessions / 72 turns, so these caps are no-ops there.
const MAX_SESSIONS_PER_INSTANCE = 60;
const MAX_TURNS_PER_SESSION = 60;

interface RawTurn {
  role: string;
  content?: string;
  has_answer?: boolean;
}

interface RawInstance {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date?: string;
  haystack_dates?: string[];
  haystack_session_ids?: string[];
  haystack_sessions: RawTurn[][];
  answer_session_ids?: string[];
}

// Preferred filenames, in priority order. Oracle first (smallest), then the
// medium "s" variants. Anything else *.json in dataDir is used as a fallback.
const PREFERRED_FILES = [
  "longmemeval_oracle.json",
  "longmemeval_oracle_cleaned.json",
  "longmemeval_s_cleaned.json",
  "longmemeval_s.json",
  "longmemeval_m.json",
];

function resolveDataFile(dataDir: string): string {
  for (const f of PREFERRED_FILES) {
    const p = join(dataDir, f);
    if (existsSync(p)) return p;
  }
  if (existsSync(dataDir)) {
    const jsons = readdirSync(dataDir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    if (jsons.length > 0) return join(dataDir, jsons[0] as string);
  }
  throw new Error(
    `longmemeval: no dataset found in ${dataDir}. Expected one of ${PREFERRED_FILES.join(", ")}. Run: npx tsx bench/suite/adapters/longmemeval.download.ts`,
  );
}

function categoryFor(inst: RawInstance): { category: string; abstain: boolean } {
  // Abstention questions carry an "_abs" suffix on the question_id (and sometimes
  // on the question_type). Treat them all as noise_abstention regardless of base
  // type — the correct behavior is to NOT volunteer an answer.
  const isAbs = inst.question_id.endsWith("_abs") || inst.question_type.endsWith("_abs");
  if (isAbs) return { category: "noise_abstention", abstain: true };

  const base = inst.question_type;
  if (base.startsWith("single-session")) return { category: "recall", abstain: false };
  if (base === "multi-session") return { category: "multihop", abstain: false };
  if (base === "temporal-reasoning") return { category: "temporal", abstain: false };
  if (base === "knowledge-update") return { category: "fact_evolution", abstain: false };
  // Unknown future type: default to recall rather than dropping the instance.
  return { category: "recall", abstain: false };
}

function toTurns(inst: RawInstance): SuiteTurn[] {
  const sessions = inst.haystack_sessions.slice(0, MAX_SESSIONS_PER_INSTANCE);
  const turns: SuiteTurn[] = [];
  for (let i = 0; i < sessions.length; i++) {
    const raw = (sessions[i] ?? []).slice(0, MAX_TURNS_PER_SESSION);
    const messages: SuiteMessage[] = raw.map((m) => ({
      role: m.role,
      content: m.content ?? "",
    }));
    if (messages.length === 0) continue;
    const session_id = inst.haystack_session_ids?.[i] ?? `${inst.question_id}_sess_${i}`;
    const timestamp = inst.haystack_dates?.[i] ?? null;
    turns.push({ session_id, timestamp, messages });
  }
  return turns;
}

function toScenario(inst: RawInstance): Scenario {
  const { category, abstain } = categoryFor(inst);
  const probe: SuiteProbe = {
    id: inst.question_id,
    category,
    query: inst.question,
    session_id: null, // recall must search across all the user's sessions
    user_id: null, // defaults to scenario.user_id (= question_id)
    max_tokens: 1024,
    expected: inst.answer ?? "",
    abstain,
  };
  return {
    name: `longmemeval:${inst.question_type}:${inst.question_id}`,
    user_id: inst.question_id,
    turns: toTurns(inst),
    probes: [probe],
  };
}

const adapter: Adapter = {
  name: "longmemeval",
  describe:
    "LongMemEval (Wu et al., ICLR 2025) oracle variant: one question per multi-session haystack.",
  async load({ limit, dataDir }) {
    const file = resolveDataFile(dataDir);
    const raw = JSON.parse(readFileSync(file, "utf-8")) as RawInstance[];
    if (!Array.isArray(raw)) {
      throw new Error(`longmemeval: ${file} is not a JSON array of instances`);
    }
    // Each instance contributes exactly one probe, so `limit` caps instances.
    const slice = typeof limit === "number" && limit > 0 ? raw.slice(0, limit) : raw;
    return slice.map(toScenario);
  },
};

export default adapter;
