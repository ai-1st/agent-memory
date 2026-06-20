/**
 * LoCoMo (Long Conversational Memory) adapter.
 *
 * Source: snap-research/locomo, dataset file data/locomo10.json -- 10 long
 * multi-session, two-speaker conversations, each with an annotated `qa` list.
 * License: CC BY-NC 4.0 (https://snap-research.github.io/locomo).
 * Place the file at bench/data/locomo/locomo10.json (download:
 *   curl -sSL https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json \
 *     -o bench/data/locomo/locomo10.json
 * see bench/data/locomo/locomo.download.ts).
 *
 * Schema notes (verified against the data + snap-research/locomo eval code in
 * task_eval/evaluation.py):
 *   - Each sample: { sample_id, conversation, qa, ... }.
 *   - `conversation` holds speaker_a / speaker_b plus, per session N,
 *     `session_N_date_time` (e.g. "1:56 pm on 8 May, 2023") and `session_N`
 *     (an array of utterances { speaker, dia_id, text, [img_url, blip_caption] }).
 *   - LoCoMo is two-speaker. We keep BOTH speakers as turns so every fact is
 *     ingested, and prefix the speaker name into the content ("Caroline: ...").
 *     Our contract only ingests role "user", so every utterance is mapped to a
 *     user message (the speaker name in the text disambiguates who said what).
 *   - `qa` entries: { question, answer, evidence, category }. Adversarial
 *     entries (category 5) carry no `answer`; they have `adversarial_answer`
 *     (a plausible-but-wrong distractor) and the correct behavior per the
 *     official eval is to say "no information available" / "not mentioned".
 *     We therefore mark them abstain:true with an explicit `expected`.
 *
 * Category mapping (canonical LoCoMo numbering, matching snap-research eval code
 * and the published mem0/Memori per-category breakdowns):
 *   1 = multi-hop    -> "multihop"
 *   2 = temporal     -> "temporal"
 *   3 = open-domain  -> "recall"   (preferences / commonsense reasoning)
 *   4 = single-hop   -> "recall"
 *   5 = adversarial  -> "noise_abstention" (abstain: true)
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Adapter, AdapterOptions, Scenario, SuiteProbe, SuiteTurn } from "../types";

const DATA_FILE = "locomo10.json";

/** Cap conversations ingested: LoCoMo samples have ~400-700 utterances each, so
 * ingesting all 10 is expensive. We keep at most this many for a tractable run.
 * `limit` (total-probe cap) is still applied on top. */
const MAX_CONVERSATIONS = 2;

const CATEGORY_MAP: Record<number, string> = {
  1: "multihop",
  2: "temporal",
  3: "recall",
  4: "recall",
  5: "noise_abstention",
};

interface LocomoUtterance {
  speaker?: string;
  dia_id?: string;
  text?: string;
}

interface LocomoQA {
  question?: string;
  answer?: string | number;
  adversarial_answer?: string;
  category?: number;
  evidence?: string[];
}

interface LocomoSample {
  sample_id?: string;
  conversation?: Record<string, unknown>;
  qa?: LocomoQA[];
}

function stringifyAnswer(a: string | number | undefined): string {
  if (a === undefined || a === null) return "";
  return typeof a === "number" ? String(a) : a;
}

/** Turn one LoCoMo sample's sessions into SuiteTurns (one per session). */
function sessionsToTurns(sampleId: string, conv: Record<string, unknown>): SuiteTurn[] {
  const turns: SuiteTurn[] = [];
  // Session numbers are not guaranteed contiguous across the file; scan keys.
  const sessionNums = Object.keys(conv)
    .map((k) => /^session_(\d+)$/.exec(k))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number.parseInt(m[1] as string, 10))
    .sort((a, b) => a - b);

  for (const n of sessionNums) {
    const utterances = conv[`session_${n}`];
    if (!Array.isArray(utterances)) continue;
    const dateTime = conv[`session_${n}_date_time`];
    const messages = (utterances as LocomoUtterance[])
      .filter((u) => typeof u?.text === "string" && u.text.length > 0)
      .map((u) => ({
        role: "user",
        content: `${u.speaker ?? "Speaker"}: ${u.text}`,
        name: u.speaker ?? null,
      }));
    if (messages.length === 0) continue;
    turns.push({
      session_id: `${sampleId}__session_${n}`,
      timestamp: typeof dateTime === "string" ? dateTime : null,
      messages,
    });
  }
  return turns;
}

function qaToProbes(sampleId: string, qa: LocomoQA[]): SuiteProbe[] {
  const probes: SuiteProbe[] = [];
  qa.forEach((entry, i) => {
    const query = entry.question ?? "";
    if (!query) return;
    const cat = entry.category ?? 0;
    const category = CATEGORY_MAP[cat] ?? "recall";
    const isAdversarial = cat === 5;
    const expected = isAdversarial
      ? "The conversation contains no information to answer this; the correct response is that it is not mentioned / no information is available."
      : stringifyAnswer(entry.answer);
    probes.push({
      id: `${sampleId}__qa_${i}__cat${cat}`,
      category,
      query,
      session_id: null,
      user_id: null,
      max_tokens: 1024,
      expected,
      abstain: isAdversarial,
    });
  });
  return probes;
}

const adapter: Adapter = {
  name: "locomo",
  describe:
    "LoCoMo long multi-session two-speaker conversations (snap-research/locomo, CC BY-NC 4.0). Capped to a couple of conversations for tractable ingestion.",
  async load({ limit, dataDir }: AdapterOptions): Promise<Scenario[]> {
    const path = join(dataDir, DATA_FILE);
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch {
      throw new Error(
        `LoCoMo dataset not found at ${path}. Download it with:\n` +
          `  curl -sSL https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json -o ${path}`,
      );
    }
    const samples = JSON.parse(raw) as LocomoSample[];

    const scenarios: Scenario[] = [];
    let probeBudget = limit ?? Number.POSITIVE_INFINITY;

    for (const sample of samples.slice(0, MAX_CONVERSATIONS)) {
      if (probeBudget <= 0) break;
      const sampleId = sample.sample_id ?? `locomo-${scenarios.length}`;
      const conv = sample.conversation ?? {};
      const turns = sessionsToTurns(sampleId, conv);
      let probes = qaToProbes(sampleId, sample.qa ?? []);
      if (probes.length === 0 || turns.length === 0) continue;
      if (probes.length > probeBudget) probes = probes.slice(0, probeBudget);
      probeBudget -= probes.length;
      scenarios.push({
        name: `locomo-${sampleId}`,
        user_id: sampleId,
        turns,
        probes,
      });
    }
    return scenarios;
  },
};

export default adapter;
