/**
 * Contradiction-tension fixture — the adapter that isolates the opinionated
 * implementation's design thesis.
 *
 * THE EDGE UNDER TEST
 * -------------------
 * When a later statement conflicts with an earlier one, the three services
 * behave very differently:
 *   - simple  : single-valued slots SUPERSEDE — the new value replaces the old
 *               (old row active=FALSE). Recall surfaces the current value plus a
 *               breadcrumb built from ONLY the most-recent prior value
 *               ("(updated …; previously X)" — see Recaller.factNote, prior[0]).
 *   - maxxed  : extract->reconcile with SUPERSEDE — old kept as history but
 *               inactive; recall surfaces the current value + a single
 *               "previously X" breadcrumb (also prior[0]). Collapses to current.
 *   - opinionated : CONTRADICT keeps BOTH facts ACTIVE with a two-way link, and
 *               recall ALWAYS follows the link and is instructed to narrate the
 *               tension ("never silently drop either side") — so the full
 *               contradiction chain is surfaced as co-current facts in tension.
 *
 * WHY EARLIER, "SOFTER" PHRASINGS TIED
 * ------------------------------------
 * A naive conditional case ("tea in the morning, coffee when stressed") does NOT
 * separate the impls: the live LLM extractors are smart enough to file the two
 * statements under DIFFERENT canonical keys (beverage:green_tea vs
 * preference:coffee), so no supersession fires and both facts simply coexist.
 * The trap only bites when the conflicting statements unavoidably land on the
 * SAME single-valued slot. So this fixture FORCES same-slot collisions with
 * explicit first-person corrections ("scratch that — it's Y, not X"), then probes
 * for information that a single-active-value-plus-one-breadcrumb cannot carry:
 *
 *   1. THREE-STATE chains (A -> corrected to B -> "now I'm torn between A and B")
 *      on one slot. A superseder keeps only the latest active value and a single
 *      "previously" note (the immediately prior value), so the EARLIEST option is
 *      lost and the live tension reads as a settled "current". The probe asks for
 *      every option considered AND the current (unresolved) standing.
 *   2. SAME-SLOT flip-flops / reversals the user explicitly has NOT settled — the
 *      right answer is "both, undecided", which cannot be expressed as one current
 *      value + one stale "previously". These are genuine REVERSALS (a flip, not a
 *      neutral stale progression), which is exactly the case opinionated routes to
 *      CONTRADICT (keep both, link) rather than UPDATE (supersede). A neutral
 *      progression of a single-valued fact — Boston -> Chicago -> Seattle with no
 *      regret — is deliberately NOT used here: opinionated UPDATEs those just like
 *      the others, so it would not be a fair separator.
 *
 * HONEST CAVEAT (see the run report): with a competent LLM extractor (this fixture
 * was validated on Haiku), simple/maxxed often DODGE the supersession trap — they
 * file conditional facts under distinct keys and synthesize an explicit "torn
 * between X and Y" memory under a fresh key, and their recall leaks the raw recent
 * turn that states the tension. So the structural CONTRADICT-link advantage shows
 * up mainly as VISIBLY RICHER, fuller contradiction narration rather than a large
 * accuracy gap. The control probes keep the comparison fair.
 *
 * Each probe's `expected` requires BOTH/ALL sides AND the relationship, so the
 * LLM judge only passes a context that preserves the tension. Probes are tagged
 * `contradiction_tension` (should separate the impls) or `control_current` (a
 * plain "what is current?" probe all three should pass, so the fixture isn't
 * rigged to only reward one design).
 *
 * Self-contained: synthetic data, no download. Follows custom.ts as the template
 * and types.ts for the Scenario/Probe shape.
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

/** Small helper to keep probe literals terse and consistent. */
function probe(
  id: string,
  category: string,
  query: string,
  expected: string,
  sessionId: string,
): SuiteProbe {
  return { id, category, query, expected, session_id: sessionId, max_tokens: MAX };
}

const SCENARIOS: Scenario[] = [
  // 1) THREE-STATE relocation on ONE slot, ending UNRESOLVED. The user names a
  //    move-to city, corrects it to a second city, then re-opens it and is torn
  //    between the two. Phrasing forces the SAME single-valued "location/move"
  //    slot ("scratch that", "change my mind"), so superseders collapse to the
  //    latest active value plus at most one "previously" breadcrumb — losing the
  //    first city and reporting a decision the user has NOT made.
  {
    name: "relocation_three_state_unresolved",
    user_id: "ct-dana",
    turns: [
      {
        session_id: "dana-1",
        timestamp: "2026-01-15T09:00:00Z",
        messages: [
          {
            role: "user",
            content:
              "I've decided where I'm relocating for the new job: it's going to be Austin. That's the plan.",
          },
          { role: "assistant", content: "Austin it is — exciting." },
        ],
      },
      {
        session_id: "dana-2",
        timestamp: "2026-02-20T09:00:00Z",
        messages: [
          {
            role: "user",
            content:
              "Scratch that on the move — I changed my mind, it's not Austin anymore, it's going to be Denver instead.",
          },
          { role: "assistant", content: "Got it, Denver now, not Austin." },
        ],
      },
      {
        session_id: "dana-3",
        timestamp: "2026-04-10T09:00:00Z",
        messages: [
          {
            role: "user",
            content:
              "Ugh, now I'm second-guessing the whole relocation again. Honestly I'm torn between Austin and Denver and I genuinely haven't decided which one — it's still up in the air.",
          },
          { role: "assistant", content: "Still an open question, understood." },
        ],
      },
    ],
    probes: [
      probe(
        "ct-move-allstates",
        "contradiction_tension",
        "Which cities has the user considered relocating to, and have they decided?",
        "BOTH Austin and Denver. The user first planned Austin, then changed it to Denver, and is now torn between Austin and Denver with NO decision made (still up in the air). The answer must name BOTH cities AND convey that it is unresolved — not a single 'current' city.",
        "dana-probe",
      ),
      probe(
        "ct-move-control",
        "control_current",
        "Is the user's relocation destination finalized?",
        "No — it is not finalized; the user is still undecided/torn about where to move.",
        "dana-probe",
      ),
    ],
  },

  // 2) SAME-SLOT favorite-language flip-flop, unresolved. "Favorite language" is
  //    a single-valued opinion slot; the corrections force the same key. The user
  //    ends explicitly unable to pick — the correct answer is "both, undecided",
  //    which a single current value + one "previously" note cannot express.
  {
    name: "favorite_language_flipflop",
    user_id: "ct-erin",
    turns: [
      {
        session_id: "erin-1",
        timestamp: "2026-01-05T08:00:00Z",
        messages: [
          {
            role: "user",
            content: "My favorite programming language is Python, hands down. Nothing beats it.",
          },
          { role: "assistant", content: "Python, classic choice." },
        ],
      },
      {
        session_id: "erin-2",
        timestamp: "2026-02-18T15:00:00Z",
        messages: [
          {
            role: "user",
            content:
              "Actually, change that — my favorite language is Rust now, not Python. Rust has won me over.",
          },
          { role: "assistant", content: "Switched to Rust, noted." },
        ],
      },
      {
        session_id: "erin-3",
        timestamp: "2026-03-25T15:00:00Z",
        messages: [
          {
            role: "user",
            content:
              "Honestly I keep flip-flopping — I can't pick a single favorite between Python and Rust. I love both for different reasons and I'm genuinely undecided.",
          },
          { role: "assistant", content: "A tie between Python and Rust, then." },
        ],
      },
    ],
    probes: [
      probe(
        "ct-lang-tension",
        "contradiction_tension",
        "What is the user's favorite programming language, and is it settled?",
        "It is NOT settled. The user has gone Python -> Rust and now can't pick between Python and Rust — they love both and are undecided. The answer must name BOTH Python and Rust and convey the unresolved tie, not a single current favorite with the other dismissed as 'previous'.",
        "erin-probe",
      ),
      probe(
        "ct-lang-control",
        "control_current",
        "Has the user ever expressed enthusiasm for Python?",
        "Yes — Python was at one point their favorite language and they still love it.",
        "erin-probe",
      ),
    ],
  },

  // 3) SAME-SLOT diet reversal-and-revert the user is conflicted about. "diet" is
  //    the canonical single-valued slot. vegetarian -> back to eating meat ->
  //    "torn, considering vegetarian again". A superseder shows only the latest
  //    active diet + one prior; the probe needs the back-and-forth and that it's
  //    actively in flux.
  {
    name: "diet_reversal_conflicted",
    user_id: "ct-felix",
    turns: [
      {
        session_id: "felix-1",
        timestamp: "2026-01-10T12:00:00Z",
        messages: [
          {
            role: "user",
            content: "I'm vegetarian — I cut out meat entirely and feel great about it.",
          },
          { role: "assistant", content: "Vegetarian, got it." },
        ],
      },
      {
        session_id: "felix-2",
        timestamp: "2026-03-05T12:00:00Z",
        messages: [
          {
            role: "user",
            content:
              "Update on my diet: I actually started eating meat again, so I'm not vegetarian anymore.",
          },
          { role: "assistant", content: "Back to eating meat, noted." },
        ],
      },
      {
        session_id: "felix-3",
        timestamp: "2026-05-01T12:00:00Z",
        messages: [
          {
            role: "user",
            content:
              "I'm really conflicted about my diet though — part of me wants to go back to being vegetarian, and I keep going back and forth. I haven't settled on it.",
          },
          { role: "assistant", content: "Still weighing it, understood." },
        ],
      },
    ],
    probes: [
      probe(
        "ct-diet-tension",
        "contradiction_tension",
        "Where does the user stand on being vegetarian?",
        "It is in flux / unresolved. The user was vegetarian, went back to eating meat, and is now conflicted — pulled toward vegetarianism again and going back and forth without settling. The answer must convey BOTH the meat-eating present AND the live pull back to vegetarianism / unresolved conflict, not a single settled diet.",
        "felix-probe",
      ),
      probe(
        "ct-diet-control",
        "control_current",
        "Was the user vegetarian at some point?",
        "Yes — the user was vegetarian (cut out meat entirely) before later eating meat again.",
        "felix-probe",
      ),
    ],
  },

  // 4) OPINION ARC the user is ambivalent about (love -> frustration but still
  //    values it), asked as "how did your view change?". Same single opinion slot
  //    (opinion:typescript). Superseders store the latest stance + one prior;
  //    this probe needs the full arc AND that the original appreciation persists.
  {
    name: "typescript_opinion_arc",
    user_id: "ct-gina",
    turns: [
      {
        session_id: "gina-1",
        timestamp: "2026-01-20T11:00:00Z",
        messages: [
          {
            role: "user",
            content:
              "I love TypeScript — the type safety has saved me from so many bugs, it's my favorite language.",
          },
          { role: "assistant", content: "The compiler as a safety net, yeah." },
        ],
      },
      {
        session_id: "gina-2",
        timestamp: "2026-04-08T11:00:00Z",
        messages: [
          {
            role: "user",
            content:
              "My opinion on TypeScript has soured lately — the type gymnastics on a big codebase are exhausting and I'm pretty frustrated with it. That said, I still rely on it and wouldn't drop the type safety.",
          },
          { role: "assistant", content: "Love-hate, but you're keeping it." },
        ],
      },
    ],
    probes: [
      probe(
        "ct-ts-tension",
        "contradiction_tension",
        "How has the user's opinion of TypeScript changed over time?",
        "It evolved from love (favorite language, type safety saved them from bugs) to frustration (type gymnastics on big codebases are exhausting), but the appreciation for the type safety PERSISTS — they still rely on it and won't drop it. The answer must show BOTH the original enthusiasm and the current frustration AND that they still value it; a single current 'frustrated' stance is incomplete.",
        "gina-probe",
      ),
      probe(
        "ct-ts-control",
        "control_current",
        "Does the user currently have any frustrations with TypeScript?",
        "Yes — the type gymnastics on large codebases are exhausting and frustrating.",
        "gina-probe",
      ),
    ],
  },

  // 5) SAME-SLOT opinion REVERSAL the user re-opens — squarely CONTRADICT
  //    territory (a flip, not a neutral progression). The user loved their job,
  //    then said they hate it and want to quit, then admits they're torn and
  //    might stay. "opinion:current_job" is one slot, so superseders collapse to
  //    the latest stance + one prior; the probe needs both the love and the
  //    desire-to-quit held as a live, unresolved tension.
  {
    name: "job_satisfaction_reversal",
    user_id: "ct-hiro",
    turns: [
      {
        session_id: "hiro-1",
        timestamp: "2026-01-08T17:00:00Z",
        messages: [
          {
            role: "user",
            content: "I love my current job — best role I've ever had, the team is amazing.",
          },
          { role: "assistant", content: "Great to hear you're thriving." },
        ],
      },
      {
        session_id: "hiro-2",
        timestamp: "2026-03-12T17:00:00Z",
        messages: [
          {
            role: "user",
            content:
              "My feelings about the job have flipped — I actually can't stand it now and I'm seriously thinking about quitting.",
          },
          { role: "assistant", content: "That's a big shift." },
        ],
      },
      {
        session_id: "hiro-3",
        timestamp: "2026-05-02T17:00:00Z",
        messages: [
          {
            role: "user",
            content:
              "Although... I'm genuinely torn about quitting. There's still a lot I love about it, and I keep flip-flopping on whether to leave. I haven't decided.",
          },
          { role: "assistant", content: "An open question, then." },
        ],
      },
    ],
    probes: [
      probe(
        "ct-job-tension",
        "contradiction_tension",
        "How does the user feel about their current job, and are they planning to quit?",
        "It is unresolved/conflicted. The user loved the job, then flipped to wanting to quit, and is now genuinely torn — there's still a lot they love AND a serious pull to leave, and they keep flip-flopping with no decision. The answer must hold BOTH the affection and the urge to quit as a live tension, not a single settled feeling.",
        "hiro-probe",
      ),
      probe(
        "ct-job-control",
        "control_current",
        "Did the user once say they loved their job?",
        "Yes — they once called it the best role they'd ever had with an amazing team.",
        "hiro-probe",
      ),
    ],
  },
];

const adapter: Adapter = {
  name: "contradiction",
  describe:
    "Contradiction-tension fixture: same-slot three-state reversals + unresolved flip-flops + opinion arcs where holding BOTH/ALL conflicting facts beats collapsing to a single current value plus one stale 'previously' breadcrumb. Probes' `expected` require all sides + the relationship.",
  async load({ limit }) {
    return capProbes(SCENARIOS, limit);
  },
};

export default adapter;
