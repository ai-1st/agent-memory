/**
 * Adversarial adapter — DISCRIMINATING probes that separate the four memory
 * implementations (baseline, simple, maxxed, opinionated).
 *
 * WHY THIS EXISTS
 * ---------------
 * The probe-discrimination audit (research/probe-discrimination-audit.md)
 * found the standard suite near-saturated: the bulk of probes are easy single-
 * fact lookups any embedding store nails, so the good builds all read ~100% and
 * the headline can't rank them. Only a few cells (longmemeval temporal, ruler
 * multihop/abstention/recall) actually bite. This adapter implements the audit's
 * §4–6 "next steps" — deepen difficulty, add adversarial categories, harden
 * temporal — as self-contained synthetic probes designed so that a totally-broken
 * build scores ~0, a happy-path build scores in the middle, and only a build that
 * supersedes correctly / keeps history / abstains-under-pressure / chains hops
 * scores high.
 *
 * KNOWN MECHANISM WEAKNESSES EACH CATEGORY EXPLOITS (verified against the impls):
 *   - simple/maxxed recall surface ONLY the single most-recent prior value as a
 *     breadcrumb: `note += "; previously " + prior[0]` (simple/src/recall.ts:192,
 *     maxxed/src/recall/recaller.ts:392). A slot updated A->B->C therefore loses A
 *     entirely and reports C plus "previously B". This is the lever for stale_trap
 *     (must report the CURRENT value, not a stale one) and history_full (must
 *     report the WHOLE chain, which one breadcrumb cannot carry).
 *   - baseline has a near-empty store, so it "passes" abstention for free by
 *     returning nothing. abstain_distractor deliberately FILLS the store with
 *     lexically-near distractors so an empty-store free pass and a volunteer-the-
 *     near-miss build both fail, while only "retrieved and correctly suppressed"
 *     passes. (The control_present probes in the same scenario confirm the store
 *     is NOT empty — a build that abstains on those is just broken, not careful.)
 *   - the live LLM extractors dodge supersession by re-keying conflicting values
 *     under distinct slots. slot_collision forces values onto ONE canonical single-
 *     valued slot (employee ID, phone) with explicit corrections ("no wait, it's
 *     Y") so re-keying is impossible.
 *   - a build that just dumps the most-recent verbatim turn passes any probe whose
 *     answer sits in that turn. leak_control pairs probes whose answer is in an
 *     EARLY turn (or must be synthesized across turns) so a recent-turn dump fails
 *     while a real structured store passes.
 *   - multihop_decoy requires chaining 2-3 facts with a decoy that satisfies hop 1
 *     but breaks the chain.
 *   - temporal_* pushes the one already-discriminating category: ordering,
 *     durations, relative dates, and "what changed between A and B".
 *
 * JUDGE CONTRACT (bench/suite/judge.ts)
 * -------------------------------------
 * The judge is strict and binary-plus-score: correct=true only if the needed
 * answer is present and CURRENT (not stale/contradicted); for abstain:true,
 * correct=true ONLY if the context conveys nothing relevant is known and does NOT
 * volunteer an unrelated fact. So every `expected` below is written to name the
 * exact value(s) the strict judge must see, and stale/decoy alternatives are
 * named explicitly as WRONG so the judge fails a context that surfaces them.
 *
 * Self-contained: synthetic data, no download, no external files. Follows
 * contradiction.ts / custom.ts as the template and types.ts for the shape.
 */

import type { Adapter, Scenario, SuiteProbe } from "../types";

/** Cap total probes across scenarios for cost-bounded runs (mirrors custom.ts). */
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

const MAX = 512;

/** Terse probe literal. `abstain` defaults to false (the common case). */
function probe(
  id: string,
  category: string,
  query: string,
  expected: string,
  sessionId: string,
  abstain = false,
): SuiteProbe {
  return { id, category, query, expected, session_id: sessionId, max_tokens: MAX, abstain };
}

const u = (role: string, content: string) => ({ role, content });

const SCENARIOS: Scenario[] = [
  // ──────────────────────────────────────────────────────────────────────────
  // 1) STALE-FACT TRAP + FULL-HISTORY on a single-valued JOB slot, updated 3x.
  //    Acme -> Globex -> Initech (neutral progression, all genuine UPDATEs so
  //    opinionated supersedes too — fair across builds). simple/maxxed keep only
  //    "previously Globex", losing Acme. The CURRENT probe punishes any build that
  //    surfaces a stale employer; the HISTORY probe punishes collapse-to-current.
  // ──────────────────────────────────────────────────────────────────────────
  {
    name: "employer_three_updates",
    user_id: "adv-noor",
    turns: [
      {
        session_id: "noor-1",
        timestamp: "2025-02-01T09:00:00Z",
        messages: [
          u("user", "I just started a new job — I'm a software engineer at Acme Corp."),
          u("assistant", "Congrats on Acme."),
        ],
      },
      {
        session_id: "noor-2",
        timestamp: "2025-08-01T09:00:00Z",
        messages: [
          u("user", "I left Acme. I now work at Globex as a senior engineer."),
          u("assistant", "Globex now, noted."),
        ],
      },
      {
        session_id: "noor-3",
        timestamp: "2026-03-01T09:00:00Z",
        messages: [
          u("user", "Update: I moved on from Globex. I'm at Initech now, as a staff engineer."),
          u("assistant", "Initech, got it."),
        ],
      },
    ],
    probes: [
      probe(
        "adv-job-current",
        "stale_trap",
        "Where does the user work right now?",
        "Initech. This is the CURRENT employer. Acme and Globex are former employers and are WRONG answers to 'right now'.",
        "noor-probe",
      ),
      probe(
        "adv-job-history",
        "history_full",
        "List every company the user has worked at, in order, oldest first.",
        "All THREE in order: Acme Corp, then Globex, then Initech. A build that omits Acme (the earliest, lost when only one prior breadcrumb is kept) is WRONG; the full sequence is required.",
        "noor-probe",
      ),
      probe(
        // A SECOND single-valued slot (job title) updated in lockstep, so the
        // current-title trap is independent of the employer trap: SWE -> senior
        // engineer -> staff engineer. Stale answer = an earlier title.
        "adv-title-current",
        "stale_trap",
        "What is the user's current job title?",
        "Staff engineer (at Initech). 'Software engineer' and 'senior engineer' are former titles and are WRONG answers to 'current'.",
        "noor-probe",
      ),
    ],
  },

  // ──────────────────────────────────────────────────────────────────────────
  // 2) STALE-FACT TRAP on CITY, updated 3x, with a leak_control twist: the most
  //    recent turn states the city only obliquely ("the move to the coast"), so a
  //    recent-turn dump cannot name the city — only a store that resolved the slot
  //    can. Also a history probe.
  // ──────────────────────────────────────────────────────────────────────────
  {
    name: "city_three_updates_leak",
    user_id: "adv-priya",
    turns: [
      {
        session_id: "priya-1",
        timestamp: "2025-01-10T09:00:00Z",
        messages: [u("user", "I live in Boston."), u("assistant", "Boston, nice.")],
      },
      {
        session_id: "priya-2",
        timestamp: "2025-06-15T09:00:00Z",
        messages: [
          u("user", "I moved — I live in Chicago now, not Boston."),
          u("assistant", "Chicago now."),
        ],
      },
      {
        session_id: "priya-3",
        timestamp: "2026-02-20T09:00:00Z",
        messages: [
          u("user", "I relocated again, to Seattle this time."),
          u("assistant", "Seattle, congrats."),
        ],
      },
      {
        session_id: "priya-4",
        timestamp: "2026-05-01T09:00:00Z",
        messages: [
          // Most-recent turn does NOT name the city — a recent-turn dump fails the
          // "where do they live now" probe; only a resolved slot answers Seattle.
          u("user", "Settling into the new place by the water has been great, loving it here."),
          u("assistant", "Glad the move worked out."),
        ],
      },
    ],
    probes: [
      probe(
        "adv-city-current",
        "leak_control",
        "What city does the user live in now?",
        "Seattle. The most recent message only alludes to 'the new place by the water' and never names a city, so the answer must come from the resolved location slot. Boston and Chicago are former cities and are WRONG.",
        "priya-probe",
      ),
      probe(
        "adv-city-history",
        "history_full",
        "Which cities has the user lived in over time, earliest to latest?",
        "All THREE in order: Boston, then Chicago, then Seattle. Omitting Boston (the earliest) is WRONG.",
        "priya-probe",
      ),
      probe(
        // Stale-trap phrased as a yes/no on an OLD value: a build that surfaces the
        // stale Boston row as current answers 'yes' (wrong).
        "adv-city-stale",
        "stale_trap",
        "Does the user currently live in Boston?",
        "No. Boston is a former city; the user now lives in Seattle (via Chicago). Answering 'yes' (treating the stale Boston row as current) is WRONG.",
        "priya-probe",
      ),
    ],
  },

  // ──────────────────────────────────────────────────────────────────────────
  // 3) SLOT COLLISION the extractor cannot re-key: a single-valued PHONE NUMBER
  //    corrected twice in one breath ("no wait... actually..."). Numbers are
  //    unambiguously one slot, so smart extractors can't dodge by filing under a
  //    different key. The CURRENT probe wants the last number; a stale or first
  //    number is the plausible wrong answer.
  // ──────────────────────────────────────────────────────────────────────────
  {
    name: "phone_same_slot_collision",
    user_id: "adv-raj",
    turns: [
      {
        session_id: "raj-1",
        timestamp: "2026-01-12T10:00:00Z",
        messages: [
          u(
            "user",
            "Let me give you my number: it's 555-0142. No wait, that's my old one — it's actually 555-0188. Ugh, I keep mixing them up: the current one is 555-0173.",
          ),
          u("assistant", "Saved your current number as 555-0173."),
        ],
      },
    ],
    probes: [
      probe(
        "adv-phone-current",
        "slot_collision",
        "What is the user's current phone number?",
        "555-0173. That is the final, current number after the user corrected themselves twice. 555-0142 and 555-0188 are explicitly old/wrong numbers and are NOT acceptable answers.",
        "raj-probe",
      ),
      probe(
        // History variant of the same-slot collision: the answer must be EXACTLY
        // the current number and explicitly NOT one of the two retracted ones.
        // A build that surfaces a stale number (or all three undifferentiated)
        // fails — separates clean supersession from a row dump.
        "adv-phone-nostale",
        "slot_collision",
        "If I want to call the user today, which number should I use, and which numbers are no longer valid?",
        "Use 555-0173 (current). 555-0142 and 555-0188 are no longer valid (retracted by the user). The answer must single out 555-0173 as the one to call and must NOT present a stale number as usable.",
        "raj-probe",
      ),
    ],
  },

  // ──────────────────────────────────────────────────────────────────────────
  // 4) SLOT COLLISION on EMPLOYEE ID across two sessions (the audit's own example:
  //    numeric single-valued fact, "no, it's Y"). Forces genuine supersession on
  //    one canonical slot. Pairs a current probe with a leak_control: the second
  //    session corrects it, so a build dumping only the FIRST session's turn (or
  //    only the latest) must have actually superseded to answer correctly.
  // ──────────────────────────────────────────────────────────────────────────
  {
    name: "employee_id_collision",
    user_id: "adv-sam",
    turns: [
      {
        session_id: "sam-1",
        timestamp: "2026-02-01T10:00:00Z",
        messages: [
          u("user", "For the records, my employee ID is E-4471."),
          u("assistant", "Noted, E-4471."),
        ],
      },
      {
        session_id: "sam-2",
        timestamp: "2026-02-03T10:00:00Z",
        messages: [
          u(
            "user",
            "Correction on my employee ID — it's not E-4471, that was a typo. It's E-4417.",
          ),
          u("assistant", "Updated to E-4417."),
        ],
      },
    ],
    probes: [
      probe(
        "adv-empid-current",
        "slot_collision",
        "What is the user's employee ID?",
        "E-4417. The user corrected the earlier E-4471 (a typo) to E-4417. E-4471 is the stale/wrong value.",
        "sam-probe",
      ),
      probe(
        // leak_control on the SAME slot: the correction is in session 2 while the
        // original is in session 1. A build that retrieves only session 1 (or
        // dumps an unresolved row) returns the typo E-4471; only a store that
        // superseded across sessions returns E-4417.
        "adv-empid-leak",
        "leak_control",
        "Confirm the employee ID the user wants on file.",
        "E-4417. The original E-4471 (session 1) was explicitly retracted as a typo in a later session; surfacing E-4471 is WRONG.",
        "sam-probe",
      ),
    ],
  },

  // ──────────────────────────────────────────────────────────────────────────
  // 5) ABSTENTION UNDER PRESSURE — store is FULL of related-but-wrong facts. The
  //    user states their SISTER's birthday, their own anniversary, and a friend's
  //    birthday, but NEVER their own birthday. The probe asks for the user's own
  //    birthday — correct behavior is to abstain. A near-empty store and a real
  //    store both have the distractors here, so abstain isn't a free pass; a build
  //    that volunteers the sister's or friend's date fails. Paired with a
  //    control_present probe proving the store is non-empty.
  // ──────────────────────────────────────────────────────────────────────────
  {
    name: "birthday_distractors",
    user_id: "adv-tess",
    turns: [
      {
        session_id: "tess-1",
        timestamp: "2026-01-05T10:00:00Z",
        messages: [
          u(
            "user",
            "My sister's birthday is March 14th, and my wedding anniversary is on June 2nd.",
          ),
          u("assistant", "I'll remember your sister's birthday and your anniversary."),
        ],
      },
      {
        session_id: "tess-2",
        timestamp: "2026-01-20T10:00:00Z",
        messages: [
          u("user", "My best friend Dana's birthday is coming up on September 9th."),
          u("assistant", "Noted Dana's birthday."),
        ],
      },
    ],
    probes: [
      probe(
        "adv-bday-abstain",
        "abstain_distractor",
        "When is the user's own birthday?",
        "Unknown — the user never stated their OWN birthday. The store contains a sister's birthday (March 14), an anniversary (June 2), and a friend's birthday (September 9); volunteering ANY of those as the user's birthday is WRONG. Correct behavior is to indicate the user's own birthday is not known.",
        "tess-probe",
        true,
      ),
      probe(
        "adv-bday-control",
        "abstain_distractor",
        "When is the user's wedding anniversary?",
        "June 2nd. (Control proving the store is non-empty: this fact WAS stated, so abstaining here is wrong.)",
        "tess-probe",
      ),
    ],
  },

  // ──────────────────────────────────────────────────────────────────────────
  // 6) ABSTENTION UNDER PRESSURE on PETS — user mentions a dog (Rex) and a
  //    neighbor's cat, but never says they own a cat. Probe asks the name of the
  //    user's CAT. Lexically the store is dense with pet/cat tokens; a build that
  //    grabs the nearest cat name (the neighbor's) fails. Plus a control.
  // ──────────────────────────────────────────────────────────────────────────
  {
    name: "pet_name_distractors",
    user_id: "adv-uma",
    turns: [
      {
        session_id: "uma-1",
        timestamp: "2026-03-01T10:00:00Z",
        messages: [
          u(
            "user",
            "I have a dog named Rex — golden retriever, full of energy. My neighbor has a cat called Mochi that wanders into my yard.",
          ),
          u("assistant", "Rex the retriever and Mochi the visiting cat, got it."),
        ],
      },
    ],
    probes: [
      probe(
        "adv-cat-abstain",
        "abstain_distractor",
        "What is the name of the user's cat?",
        "Unknown — the user does NOT own a cat. The only cat mentioned (Mochi) belongs to the neighbor, so answering 'Mochi' is WRONG. Correct behavior is to indicate the user has no cat / it is not known.",
        "uma-probe",
        true,
      ),
      probe(
        "adv-dog-control",
        "abstain_distractor",
        "What is the name of the user's dog?",
        "Rex. (Control: the user's dog WAS named, so abstaining here is wrong.)",
        "uma-probe",
      ),
    ],
  },

  // ──────────────────────────────────────────────────────────────────────────
  // 7) MULTI-HOP WITH DECOY — chain: user's manager is Lena -> Lena's team is the
  //    Payments team -> the Payments team uses Kafka. Decoy: a DIFFERENT person
  //    (Omar) also has a team (the Search team, uses Redis) that satisfies "a
  //    team uses X" but is NOT the manager's team. Probe requires chaining all
  //    three hops; a build that grabs the decoy stack answers Redis (wrong).
  // ──────────────────────────────────────────────────────────────────────────
  {
    name: "manager_team_stack_multihop",
    user_id: "adv-vik",
    turns: [
      {
        session_id: "vik-1",
        timestamp: "2026-04-01T10:00:00Z",
        messages: [
          u("user", "My manager is Lena. Lena runs the Payments team."),
          u("assistant", "Lena, Payments team."),
        ],
      },
      {
        session_id: "vik-2",
        timestamp: "2026-04-02T10:00:00Z",
        messages: [
          u(
            "user",
            "The Payments team's main message bus is Kafka. By the way, Omar runs the Search team, and the Search team is built on Redis.",
          ),
          u("assistant", "Payments on Kafka; Search (Omar) on Redis."),
        ],
      },
    ],
    probes: [
      probe(
        "adv-mh-stack",
        "multihop_decoy",
        "What message bus / data store does the user's manager's team use?",
        "Kafka. Chain: manager = Lena -> Lena's team = Payments -> Payments uses Kafka. Redis is the DECOY (it belongs to Omar's Search team, not the manager's team) and is WRONG.",
        "vik-probe",
      ),
      probe(
        "adv-mh-control",
        "multihop_decoy",
        "Who is the user's manager?",
        "Lena. (First-hop control: this single fact should be easy for any working build.)",
        "vik-probe",
      ),
    ],
  },

  // ──────────────────────────────────────────────────────────────────────────
  // 8) MULTI-HOP WITH DECOY — chain across the user's car: user drives a Subaru ->
  //    the Subaru is the blue one -> the blue car is parked in spot B2. Decoy: a
  //    red car (a rental) is in spot A1. Probe asks where the user's car is
  //    parked; a build that anchors on the wrong color answers A1.
  // ──────────────────────────────────────────────────────────────────────────
  {
    name: "car_color_spot_multihop",
    user_id: "adv-wen",
    turns: [
      {
        session_id: "wen-1",
        timestamp: "2026-04-10T10:00:00Z",
        messages: [
          u("user", "I drive a Subaru. It's the blue one."),
          u("assistant", "Blue Subaru, noted."),
        ],
      },
      {
        session_id: "wen-2",
        timestamp: "2026-04-11T10:00:00Z",
        messages: [
          u("user", "The blue car is parked in spot B2. The red rental is over in spot A1."),
          u("assistant", "Blue in B2, red rental in A1."),
        ],
      },
    ],
    probes: [
      probe(
        "adv-car-spot",
        "multihop_decoy",
        "Which parking spot is the user's own car in?",
        "B2. Chain: user's car = Subaru -> the Subaru is blue -> the blue car is in spot B2. A1 is the DECOY (it holds the red rental, not the user's car) and is WRONG.",
        "wen-probe",
      ),
      probe(
        // Abstention layered on the same decoy-rich store: the user never said who
        // owns the red rental. A build that grabs the nearest plausible owner
        // fails; the store IS non-empty (the car probe proves it), so this is
        // abstain-under-pressure, not an empty-store free pass.
        "adv-car-abstain",
        "abstain_distractor",
        "Who owns the red rental car?",
        "Unknown — the user mentioned a red rental in spot A1 but never said who owns it. Volunteering the user, Lena, Omar, or any named person is WRONG; correct behavior is to indicate the owner is not known.",
        "wen-probe",
        true,
      ),
      probe(
        "adv-car-control",
        "multihop_decoy",
        "What make of car does the user drive?",
        "Subaru. (First-hop control: a single stated fact any working build should recall.)",
        "wen-probe",
      ),
    ],
  },

  // ──────────────────────────────────────────────────────────────────────────
  // 9) HARDER TEMPORAL — ordering + duration. Job timeline with explicit dates the
  //    build must COMPARE, not look up: started Acme Jan 2023, left for Globex
  //    Sep 2024, left Globex for Initech Jan 2026. Probes: which came first (an
  //    ordering Q), and how long at the middle job (a duration the build must
  //    compute from two dates).
  // ──────────────────────────────────────────────────────────────────────────
  {
    name: "career_timeline_temporal",
    user_id: "adv-xan",
    turns: [
      {
        session_id: "xan-1",
        timestamp: "2023-01-15T10:00:00Z",
        messages: [
          u("user", "I started at Acme in January 2023."),
          u("assistant", "Acme since Jan 2023."),
        ],
      },
      {
        session_id: "xan-2",
        timestamp: "2024-09-15T10:00:00Z",
        messages: [
          u("user", "I left Acme and joined Globex this month, September 2024."),
          u("assistant", "Globex since Sep 2024."),
        ],
      },
      {
        session_id: "xan-3",
        timestamp: "2026-01-15T10:00:00Z",
        messages: [
          u("user", "As of this month, January 2026, I've moved from Globex to Initech."),
          u("assistant", "Initech since Jan 2026."),
        ],
      },
    ],
    probes: [
      probe(
        "adv-temp-order",
        "temporal_order",
        "Which job did the user hold first, Globex or Initech?",
        "Globex came first (joined Sep 2024); Initech came later (Jan 2026). Answering Initech is WRONG.",
        "xan-probe",
      ),
      probe(
        "adv-temp-duration",
        "temporal_duration",
        "Roughly how long did the user work at Globex?",
        "About 16 months (from September 2024 to January 2026 — roughly a year and a third). Any answer in the 15-17 month / 'about 1.3 years' range is acceptable; the dates Sep 2024 and Jan 2026 must both be reflected.",
        "xan-probe",
      ),
      probe(
        // Ordering across all THREE jobs, requiring the earliest (Acme) which the
        // single-breadcrumb builds drop — combines temporal ordering with the
        // history-loss weakness.
        "adv-temp-firstjob",
        "temporal_order",
        "What was the user's very first job of the three mentioned, and in what year did it start?",
        "Acme, started January 2023. Globex (Sep 2024) and Initech (Jan 2026) came later. A build that names Globex as the first job (because Acme was dropped) is WRONG.",
        "xan-probe",
      ),
    ],
  },

  // ──────────────────────────────────────────────────────────────────────────
  // 10) HARDER TEMPORAL — relative dates + "what changed between A and B". A diet
  //     log across three dated check-ins (vegetarian, then added fish, then fully
  //     vegan). Probes: the relative-date Q ("what was the diet in spring 2025")
  //     and the diff Q ("what changed between the Feb and Nov check-ins").
  // ──────────────────────────────────────────────────────────────────────────
  {
    name: "diet_log_temporal_diff",
    user_id: "adv-yara",
    turns: [
      {
        session_id: "yara-1",
        timestamp: "2025-02-10T10:00:00Z",
        messages: [
          u("user", "Diet check-in: I'm vegetarian — no meat, but I still eat dairy and eggs."),
          u("assistant", "Vegetarian as of Feb 2025."),
        ],
      },
      {
        session_id: "yara-2",
        timestamp: "2025-05-12T10:00:00Z",
        messages: [
          u("user", "Update: I added fish back in, so I'm pescatarian now."),
          u("assistant", "Pescatarian as of May 2025."),
        ],
      },
      {
        session_id: "yara-3",
        timestamp: "2025-11-08T10:00:00Z",
        messages: [
          u("user", "Big change: I cut out all animal products. I'm fully vegan now."),
          u("assistant", "Vegan as of Nov 2025."),
        ],
      },
    ],
    probes: [
      probe(
        "adv-temp-relative",
        "temporal_order",
        "What was the user eating in the spring of 2025 (around May)?",
        "Pescatarian — they had added fish back by May 2025. 'Vegetarian' (the Feb stance) and 'vegan' (the Nov stance) are the wrong time periods.",
        "yara-probe",
      ),
      probe(
        "adv-temp-diff",
        "temporal_duration",
        "What changed in the user's diet between the February and November 2025 check-ins?",
        "They went from vegetarian (Feb: no meat but still dairy/eggs) to fully vegan (Nov: no animal products at all), passing through pescatarian in May. The answer must convey the start (vegetarian) and end (vegan) states and that animal products were dropped.",
        "yara-probe",
      ),
      probe(
        // Full-history on the SAME slot updated 3x: requires the MIDDLE state
        // (pescatarian) that a single 'previously' breadcrumb drops — separates
        // keep-all-history from collapse-to-current-plus-one.
        "adv-diet-history",
        "history_full",
        "List every diet the user has followed, in order.",
        "All THREE in order: vegetarian, then pescatarian, then vegan. Omitting the middle stage (pescatarian) — which a single most-recent breadcrumb loses — is WRONG.",
        "yara-probe",
      ),
    ],
  },

  // ──────────────────────────────────────────────────────────────────────────
  // 11) RAW-TURN-LEAK CONTROL — the answer lives in an EARLY turn and is buried
  //     under many later, topically-similar turns, so a recent-turn dump (or a
  //     shallow recency window) misses it; only a real store recalls it. Also an
  //     easy control so a broken build scores ~0 here while a good one passes.
  // ──────────────────────────────────────────────────────────────────────────
  {
    name: "early_fact_buried_leak",
    user_id: "adv-zane",
    turns: [
      {
        session_id: "zane-1",
        timestamp: "2026-01-02T09:00:00Z",
        messages: [
          u(
            "user",
            "Important detail for later: the wifi password at my cabin is 'cedar-lake-77'.",
          ),
          u("assistant", "Got it, cabin wifi is cedar-lake-77."),
        ],
      },
      {
        session_id: "zane-2",
        timestamp: "2026-01-09T09:00:00Z",
        messages: [
          u("user", "The cabin has a wood stove and the drive up takes about three hours."),
          u("assistant", "Wood stove, three-hour drive."),
        ],
      },
      {
        session_id: "zane-3",
        timestamp: "2026-01-16T09:00:00Z",
        messages: [
          u("user", "We usually go to the cabin in summer; the lake is great for kayaking."),
          u("assistant", "Summer kayaking at the lake."),
        ],
      },
      {
        session_id: "zane-4",
        timestamp: "2026-01-23T09:00:00Z",
        messages: [
          u("user", "The nearest town to the cabin is about twenty minutes away."),
          u("assistant", "Town is twenty minutes out."),
        ],
      },
    ],
    probes: [
      probe(
        "adv-leak-buried",
        "leak_control",
        "What is the wifi password at the user's cabin?",
        "cedar-lake-77. It was stated only in the FIRST session and never repeated, so a build that surfaces only recent turns will miss it. The exact string 'cedar-lake-77' is required.",
        "zane-probe",
      ),
      probe(
        "adv-leak-control",
        "leak_control",
        "How long is the drive to the user's cabin?",
        "About three hours. (Easy control: a working store recalls this; a totally broken one returns nothing.)",
        "zane-probe",
      ),
    ],
  },

  // ──────────────────────────────────────────────────────────────────────────
  // 12) EASY CONTROLS — a couple of trivially-recoverable single facts so the
  //     adapter is NOT all-hard: a totally-broken build scores ~0 overall but a
  //     basic working store clears these, keeping the dynamic range honest (a
  //     good build won't score 100, a broken one won't score 0 by luck).
  // ──────────────────────────────────────────────────────────────────────────
  {
    name: "easy_controls",
    user_id: "adv-amir",
    turns: [
      {
        session_id: "amir-1",
        timestamp: "2026-03-15T10:00:00Z",
        messages: [
          u("user", "My name is Amir and I'm a graphic designer based in Lisbon."),
          u("assistant", "Hi Amir, graphic designer in Lisbon."),
        ],
      },
      {
        session_id: "amir-2",
        timestamp: "2026-03-16T10:00:00Z",
        messages: [
          u("user", "My favorite hobby is rock climbing on weekends."),
          u("assistant", "Rock climbing on weekends, nice."),
        ],
      },
    ],
    probes: [
      probe(
        "adv-easy-job",
        "control_easy",
        "What does the user do for a living?",
        "Graphic designer (based in Lisbon). A single stated fact, no supersession.",
        "amir-probe",
      ),
      probe(
        "adv-easy-hobby",
        "control_easy",
        "What is the user's favorite hobby?",
        "Rock climbing (on weekends).",
        "amir-probe",
      ),
      probe(
        // Easy abstention: the store has name/job/city/hobby but no age. Any
        // careful build abstains; only a build that fabricates fails. Keeps the
        // abstain category from being dominated by the hard distractor cases.
        "adv-easy-abstain",
        "abstain_distractor",
        "How old is the user?",
        "Unknown — the user never stated their age. Inventing a number is WRONG; correct behavior is to indicate the age is not known.",
        "amir-probe",
        true,
      ),
    ],
  },
];

const adapter: Adapter = {
  name: "adversarial",
  describe:
    "Adversarial discriminating probes (audit §4-6): stale-fact traps + full-history, abstention under pressure with lexical distractors, same-slot collisions the extractor can't re-key, multi-hop with decoys, raw-turn-leak controls, and hardened temporal (ordering/duration/relative/diff). Mixed with easy controls so a broken build scores ~0 and a good build doesn't saturate.",
  async load({ limit }) {
    return capProbes(SCENARIOS, limit);
  },
};

export default adapter;
