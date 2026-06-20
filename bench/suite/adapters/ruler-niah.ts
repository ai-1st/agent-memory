/**
 * RULER / NIAH-style adapter: a deterministic, length-scalable synthetic
 * benchmark for the memory service. Inspired by NVIDIA's RULER (Apache-2.0) and
 * the original needle-in-a-haystack (NIAH) probe, but it GENERATES its own data
 * rather than downloading any corpus.
 *
 * Idea: plant "needle" facts (e.g. "The access code for project Falcon is
 * 7Q-XK42.") inside a long "haystack" of plausible-but-empty distractor
 * conversation turns, then ask the memory service to recall the needle. The
 * haystack length is the stress knob: more distractor turns => more volume/noise
 * the recall layer has to cut through.
 *
 * Scenario kinds (mapped onto our rubric):
 *   - single-needle  -> category "recall"            : one needle, find the value.
 *   - multi-needle    -> category "multihop"          : two needles must be combined.
 *   - absent / noise  -> category "noise_abstention"  : needle never planted; must abstain.
 *
 * Determinism: a tiny seeded LCG drives every random choice (needle placement,
 * distractor selection, slot ordering). Same seed + same haystack length =>
 * byte-identical scenarios across runs and machines. The seed is fixed in code;
 * the haystack length is configurable via the RULER_HAYSTACK env var.
 *
 * Env knobs (documented):
 *   RULER_HAYSTACK   distractor turns per scenario (default 50; "haystack depth").
 *   RULER_SEED       PRNG seed (default 1337) for reproducible-but-resamplable sets.
 *
 * The `load()` call also caches the generated scenarios under
 * `dataDir`/generated.json for inspection / reproducibility.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Adapter, Scenario, SuiteProbe, SuiteTurn } from "../types";

/** Minimal seeded PRNG (numerical-recipes LCG) — reproducible across machines. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // LCG: state = (a*state + c) mod 2^32, then normalize to [0,1).
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const randInt = (rng: () => number, n: number): number => Math.floor(rng() * n);
const pick = <T>(rng: () => number, xs: readonly T[]): T => xs[randInt(rng, xs.length)] as T;

function shuffled<T>(rng: () => number, xs: readonly T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(rng, i + 1);
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

/** Building blocks for needle values (kept token-distinctive so they stand out). */
const PROJECTS = ["Falcon", "Mercury", "Aurora", "Tungsten", "Cobalt", "Vesper"] as const;
const CODE_PREFIX = ["7Q", "K3", "ZP", "M8", "X5", "R2"] as const;
const CODE_SUFFIX = ["XK42", "TL09", "QW77", "BV13", "NH28", "PD61"] as const;
const CITIES = ["Reykjavik", "Montevideo", "Tashkent", "Gaborone", "Ljubljana", "Da Nang"] as const;
const PEOPLE = [
  "Priya Nair",
  "Tomas Halloran",
  "Wen Li",
  "Adaeze Okafor",
  "Sven Bergqvist",
] as const;
const ROLES = ["site lead", "on-call SRE", "regional director", "field engineer"] as const;

/** Plausible distractor turns that contain NO needle-bearing fact. */
const DISTRACTOR_TOPICS = [
  "Reminder to refill the office coffee next week — we're almost out of the dark roast.",
  "The standup got moved to 10:15 because the room was double-booked.",
  "I finally tried that pour-over recipe; medium grind worked better than I expected.",
  "Traffic on the bridge was brutal this morning, took 40 minutes longer than usual.",
  "Can you forward me the agenda template? I lost the link in my inbox.",
  "The new monitor arm is great but the cable management is still a mess.",
  "Lunch options near the office are getting repetitive, open to suggestions.",
  "I'm reading a book on systems thinking, slow but interesting so far.",
  "The printer on the 3rd floor is jammed again, IT has been notified.",
  "Weekend hike got rained out, we rescheduled for the following Saturday.",
  "Anyone know a good keyboard for long typing sessions? My wrists are sore.",
  "The conference Wi-Fi was flaky so the demo lagged a bit.",
  "I switched my notes app again, still not happy with any of them.",
  "The plant by the window is finally getting new leaves.",
  "Quarter-end paperwork is piling up, going to block off Friday for it.",
  "Tried a new podcast on urban planning, recommend it if you're into that.",
] as const;

const ASSISTANT_ACKS = [
  "Got it, thanks for the update.",
  "Noted — I'll keep that in mind.",
  "Sounds good, appreciate the heads up.",
  "Makes sense. Anything else on your end?",
  "Thanks for sharing that.",
  "Understood, no problem.",
] as const;

interface Needle {
  /** First-person user statement that plants the fact. */
  statement: string;
  /** Assistant acknowledgement (kept generic, no fact echo). */
  ack: string;
}

function codeNeedle(rng: () => number, project: string): { needle: Needle; value: string } {
  const value = `${pick(rng, CODE_PREFIX)}-${pick(rng, CODE_SUFFIX)}`;
  return {
    value,
    needle: {
      statement: `Please remember: the access code for project ${project} is ${value}.`,
      ack: "Stored. I'll keep that confidential.",
    },
  };
}

/**
 * Build distractor turns and splice needle turns into pseudo-random slots.
 * `needles` are inserted at distinct positions chosen by the seeded RNG so that
 * a needle can land anywhere (start/middle/end) of the haystack.
 */
function buildTurns(
  rng: () => number,
  sessionIds: string[],
  haystack: number,
  baseTs: number,
  needles: Needle[],
): SuiteTurn[] {
  const total = haystack + needles.length;
  // Choose distinct insertion slots for the needles across the timeline.
  const slots = shuffled(
    rng,
    Array.from({ length: total }, (_, i) => i),
  ).slice(0, needles.length);
  const needleAt = new Map<number, Needle>();
  needles.forEach((n, i) => needleAt.set(slots[i] as number, n));

  const turns: SuiteTurn[] = [];
  for (let i = 0; i < total; i++) {
    const session = sessionIds[randInt(rng, sessionIds.length)] as string;
    // baseTs is epoch-ms; space turns one hour apart for a plausible timeline.
    const ts = new Date(baseTs + i * 3600_000).toISOString();
    const planted = needleAt.get(i);
    if (planted) {
      turns.push({
        session_id: session,
        timestamp: ts,
        messages: [
          { role: "user", content: planted.statement },
          { role: "assistant", content: planted.ack },
        ],
      });
    } else {
      turns.push({
        session_id: session,
        timestamp: ts,
        messages: [
          { role: "user", content: pick(rng, DISTRACTOR_TOPICS) },
          { role: "assistant", content: pick(rng, ASSISTANT_ACKS) },
        ],
      });
    }
  }
  return turns;
}

function genSingleNeedle(rng: () => number, idx: number, haystack: number): Scenario {
  const userId = `niah-single-${idx}`;
  const project = pick(rng, PROJECTS);
  const { needle, value } = codeNeedle(rng, project);
  const sessionIds = [`${userId}-s1`, `${userId}-s2`];
  const turns = buildTurns(rng, sessionIds, haystack, Date.UTC(2026, 0, 1) + idx * 86_400_000, [
    needle,
  ]);
  const probes: SuiteProbe[] = [
    {
      id: `single-${idx}-code`,
      category: "recall",
      query: `What is the access code for project ${project}?`,
      // User-scoped (null): needles are spread across sessions, so recall must
      // search the whole user history, not a single session — true NIAH semantics.
      session_id: null,
      max_tokens: 512,
      expected: `The access code for project ${project} is ${value}.`,
      abstain: false,
    },
  ];
  return { name: `single_needle_${project.toLowerCase()}_${idx}`, user_id: userId, turns, probes };
}

function genMultiNeedle(rng: () => number, idx: number, haystack: number): Scenario {
  const userId = `niah-multi-${idx}`;
  // Needle A: the user is stationed in <city>. Needle B: the <role> for that city is <person>.
  // The probe requires chaining A -> B: "Who is the <role> for the city the user is stationed in?"
  const city = pick(rng, CITIES);
  const person = pick(rng, PEOPLE);
  const role = pick(rng, ROLES);
  const needleA: Needle = {
    statement: `For the record, I'm currently stationed in ${city} for this rotation.`,
    ack: "Noted your current posting.",
  };
  const needleB: Needle = {
    statement: `Also remember: the ${role} for ${city} is ${person}.`,
    ack: "Got it, I'll associate that contact.",
  };
  const sessionIds = [`${userId}-s1`, `${userId}-s2`];
  const turns = buildTurns(rng, sessionIds, haystack, Date.UTC(2026, 1, 1) + idx * 86_400_000, [
    needleA,
    needleB,
  ]);
  const probes: SuiteProbe[] = [
    {
      id: `multi-${idx}-hop`,
      category: "multihop",
      // Deliberately does NOT name the city — the model must first recall where
      // the user is stationed (needle A), then who the role-holder there is (needle B).
      query: `Who is the ${role} for the city I'm currently stationed in?`,
      session_id: null, // user-scoped: needles A/B may live in different sessions.
      max_tokens: 512,
      expected: `${person} (the ${role} for ${city}, where the user is stationed).`,
      abstain: false,
    },
  ];
  return {
    name: `multi_needle_${city.replace(/\s+/g, "").toLowerCase()}_${idx}`,
    user_id: userId,
    turns,
    probes,
  };
}

function genAbsent(rng: () => number, idx: number, haystack: number): Scenario {
  const userId = `niah-absent-${idx}`;
  // Plant ONE unrelated needle so the haystack isn't trivially empty, then ask
  // for a DIFFERENT project's code that was never planted -> must abstain.
  const plantedProject = pick(rng, PROJECTS);
  const askedProject = PROJECTS.filter((p) => p !== plantedProject)[
    randInt(rng, PROJECTS.length - 1)
  ] as string;
  const { needle } = codeNeedle(rng, plantedProject);
  const sessionIds = [`${userId}-s1`, `${userId}-s2`];
  const turns = buildTurns(rng, sessionIds, haystack, Date.UTC(2026, 2, 1) + idx * 86_400_000, [
    needle,
  ]);
  const probes: SuiteProbe[] = [
    {
      id: `absent-${idx}-noid`,
      category: "noise_abstention",
      query: `What is the access code for project ${askedProject}?`,
      session_id: null, // user-scoped: must search all of the user's memory and still find nothing.
      max_tokens: 512,
      expected: `Unknown — no access code for project ${askedProject} was ever provided.`,
      abstain: true,
    },
  ];
  return {
    name: `absent_needle_${askedProject.toLowerCase()}_${idx}`,
    user_id: userId,
    turns,
    probes,
  };
}

/**
 * Generate a deterministic, balanced set of scenarios. We round-robin the three
 * kinds so that even a small `limit` exercises recall, multihop, and abstention.
 */
function generate(haystack: number, seed: number, count: number): Scenario[] {
  const rng = makeRng(seed);
  const kinds = [genSingleNeedle, genMultiNeedle, genAbsent] as const;
  const scenarios: Scenario[] = [];
  for (let i = 0; i < count; i++) {
    const kind = kinds[i % kinds.length] as (typeof kinds)[number];
    scenarios.push(kind(rng, Math.floor(i / kinds.length), haystack));
  }
  return scenarios;
}

function capProbes(scenarios: Scenario[], limit?: number): Scenario[] {
  if (!limit) return scenarios;
  const out: Scenario[] = [];
  let n = 0;
  for (const s of scenarios) {
    if (n >= limit) break;
    const probes = s.probes.slice(0, Math.max(0, limit - n));
    if (probes.length === 0) continue;
    n += probes.length;
    out.push({ ...s, probes });
  }
  return out;
}

const adapter: Adapter = {
  name: "ruler-niah",
  describe:
    "Synthetic, length-scalable needle-in-a-haystack benchmark (RULER/NIAH-style): " +
    "single-needle recall, multi-needle multihop, and absent-needle abstention. " +
    "Deterministic (seeded LCG). Knobs: RULER_HAYSTACK (default 50), RULER_SEED (default 1337).",
  async load({ limit, dataDir }) {
    const haystack = Math.max(1, Number.parseInt(process.env.RULER_HAYSTACK ?? "50", 10) || 50);
    const seed = Number.parseInt(process.env.RULER_SEED ?? "1337", 10) || 1337;
    // Generate enough base scenarios to satisfy any reasonable limit (one probe
    // each here, so probe count == scenario count). Default to 12 (4 of each kind).
    const baseCount = limit ? Math.max(limit, 3) : 12;
    const all = generate(haystack, seed, baseCount);
    const scenarios = capProbes(all, limit);

    // Cache the generated copy for inspection / reproducibility.
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(
        join(dataDir, "generated.json"),
        JSON.stringify({ haystack, seed, scenarios }, null, 2),
      );
    } catch {
      // Caching is best-effort; never fail a run because the cache write failed.
    }
    return scenarios;
  },
};

export default adapter;
