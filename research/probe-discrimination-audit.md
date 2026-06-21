# Probe-discrimination audit

_Read-only audit of the benchmark suite's ability to tell the four memory-service
implementations apart. No servers run, no LLM/embedding calls, no commits — this is
a desk analysis of the already-generated cards in `bench/results/suite/*.json`, the
adapters in `bench/suite/adapters/`, `bench/suite/judge.ts`, and `bench/suite/runner.ts`._

Cards analyzed: **29 "real" cards** (excluding `*-smoke`, `*-validate`, `*-gen`,
`*-trace`, `custom__gen`). Impls = {baseline, simple, maxxed, opinionated}; adapters =
{custom, longmemeval, locomo, ruler-niah, contradiction}; models = {opus, haiku}.

---

## TL;DR verdict

**Partly — and for three different reasons that need three different fixes.**

The good builds are *not* near-100% because they are uniformly excellent. They are
near-100% because the suite is dominated by **easy/saturated single-fact probes** and
by **single-digit-N cells** that can't distinguish "100% true rate" from "could be 60%."
Where the suite *does* push (longmemeval `temporal`, ruler `multihop`/`abstention`,
locomo on realistic data), the builds visibly diverge and even fail. The judge is a
secondary contributor — its binary `correct` flag is genuinely lenient (4.7% of all
passes would flip to fail under a `score≥0.8` floor) but it is *not* the main reason
scores are high. The single biggest structural issue is **N**, not difficulty or
leniency.

One-line reason: **the discriminating probes already exist (temporal, multihop,
abstention-under-noise, locomo) — they're just outnumbered by easy ones and starved of
sample size, so the saturated easy probes set the headline.**

---

## Where we stand

### 1. Headline: 90.5% of good-build probes pass, but the failures cluster

Across all good builds (simple/maxxed/opinionated), **239/264 probes pass (90.5%)**.
The 25 failures are not noise — they concentrate in exactly three places:

| Where the good builds fail | count | what it tells us |
|---|---|---|
| `longmemeval / temporal` | 7 | the one category that bites on every impl & model |
| `ruler-niah / multihop` | 4 | second needle not chained; only visible at higher N |
| `ruler-niah / noise_abstention` | 4 | maxxed volunteers an unrelated code as the answer |
| `ruler-niah / recall` | 5 | **opinionated/haiku** lost 5 needles to empty context |
| `custom / fact_evolution` | 1 | maxxed/haiku dropped a role detail |
| `contradiction / control_current` | 1 | opinionated over-narrated "Denver finalized" |

11 distinct good-build fails carry an explicit "contradicted / volunteered / lost"
judge note — these are real recall failures the suite caught, not judge churn.

### 2. Saturation map (good builds only: simple / maxxed / opinionated)

Pass/total, aggregated across the three good builds, split by model. **N is the larger
of the two model columns** and decides whether a 100% means "easy" or "can't tell."

| adapter | category | Opus s/m/o | Haiku s/m/o | agg rate (larger N) | N | flag |
|---|---|---|---|---|---|---|
| contradiction | contradiction_tension | 5/5 5/5 5/5 | — | 100% | 15 | **SATURATED — but metric is broken (see §metric)** |
| contradiction | control_current | 5/5 5/5 4/5 | — | 93% | 15 | near-sat (the 1 fail is opinionated's design backfire) |
| custom | budget | 1/1 1/1 1/1 | 1/1 1/1 1/1 | 100% | 3 | LOW-N |
| custom | fact_evolution | 2/2 2/2 2/2 | 2/2 1/2 2/2 | 92% | 6 | LOW-N |
| custom | implicit | 1/1 1/1 1/1 | 1/1 1/1 1/1 | 100% | 3 | LOW-N |
| custom | multihop | 1/1 1/1 1/1 | 1/1 1/1 1/1 | 100% | 3 | LOW-N |
| custom | noise_abstention | 2/2 2/2 2/2 | 2/2 2/2 2/2 | 100% | 6 | LOW-N |
| custom | opinion_arc | 1/1 1/1 1/1 | 1/1 1/1 1/1 | 100% | 3 | LOW-N |
| custom | paraphrase_semantic | 1/1 1/1 1/1 | 1/1 1/1 1/1 | 100% | 3 | LOW-N |
| custom | recall | 2/2 2/2 2/2 | 2/2 2/2 2/2 | 100% | 6 | LOW-N |
| custom | temporal | 1/1 1/1 1/1 | 1/1 1/1 1/1 | 100% | 3 | LOW-N |
| longmemeval | **temporal** | 3/3 2/3 2/3 | 14/15 11/15 13/15 | **84%** | 45 | **DISCRIMINATING** |
| ruler-niah | **multihop** | 2/2 0/2 2/2 | 10/10 8/10 9/10 | 90% | 30 | near-sat / discriminating |
| ruler-niah | **noise_abstention** | 2/2 2/2 2/2 | 10/10 6/10 10/10 | **87%** | 30 | **DISCRIMINATING** (maxxed 60%) |
| ruler-niah | **recall** | 2/2 2/2 2/2 | 10/10 10/10 5/10 | **83%** | 30 | **DISCRIMINATING** (opinionated 50%) |

**Reading the map:**

- **The entire `custom` benchmark is LOW-N** (1–6 probes per category per build).
  Every cell is at-or-near 100% but no cell has the N to mean anything. This is the
  single largest source of "looks saturated" — it is mostly "too few probes to tell."
- **Only four (benchmark × category) pairs are genuinely informative**, and all four
  are exactly where good builds spread or fail: longmemeval temporal, ruler
  multihop/abstention/recall.
- **`contradiction_tension` reads as saturated but is a false 100%** — see the metric
  section; the probe can't separate the impls by construction.

### 3. The "easy vs too-few" split, quantified

- 21 good-build (adapter × impl × model) cells. **11 (52%) are exactly 100%.**
- Of those 11 perfect cells, **3 have N<10** (longmemeval/ruler Opus cells at N=3–6) —
  a perfect score that carries essentially no information.
- Binomial reality check (Wilson 95% lower bound on the *true* pass rate, given a
  perfect run):

  | observed | true rate could be as low as |
  |---|---|
  | 3/3 | 44% |
  | 6/6 | 61% |
  | 12/12 | 76% |
  | 15/15 | 80% |
  | 30/30 | 89% |

  So "longmemeval simple = 100% (N=3)" is statistically consistent with a real rate of
  44%. The Opus standard-benchmark cells (N=3–6) are ranking hints, not measurements.

### 4. Fail inventory — good builds (the discriminating signal)

Full list of the 25 good-build failures (baseline's 192 floor-fails omitted; they are
the intended low floor — locomo 10–15%, longmemeval 37–50%):

| adapter | impl | model | category | id | score | note (abbrev) |
|---|---|---|---|---|---|---|
| contradiction | opinionated | opus | control_current | ct-move-control | 0.1 | context claims "Denver finalized" — opinionated's keep-both narration backfired |
| custom | maxxed | haiku | fact_evolution | fe-2 | 0.4 | left Stripe but omits the backend-engineer role |
| longmemeval | maxxed | haiku | temporal | 2a1811e2 | 0 | has Holi date but no Sunday-mass date; can't compute diff |
| longmemeval | maxxed | haiku | temporal | gpt4_0b2f1d21 | 0.2 | no timeline for coffee-maker vs mixer |
| longmemeval | maxxed | haiku | temporal | gpt4_2655b836 | 0.3 | GPS replaced 3/22 but ordering unclear |
| longmemeval | maxxed | haiku | temporal | gpt4_6ed717ea | 0.2 | dog-bed timing but no training-pad date |
| longmemeval | maxxed | opus | temporal | gpt4_76048e76 | 0.3 | bike repair mid-Feb but car checkup undated |
| longmemeval | opinionated | haiku | temporal | gpt4_2487a7cb | 0 | context claims workshop first; gold = webinar first |
| longmemeval | opinionated | haiku | temporal | gpt4_70e84552 | 0 | empty context |
| longmemeval | opinionated | opus | temporal | gpt4_2655b836 | 0 | context says "no issue documented"; missed GPS |
| longmemeval | simple | haiku | temporal | bbf86515 | 0.3 | event dates present but Turbocharged-Tuesdays unidentified |
| ruler-niah | maxxed | haiku | multihop | multi-1-hop | 0.2 | confirms station, no role-holder name |
| ruler-niah | maxxed | haiku | multihop | multi-6-hop | 0 | confirms Gaborone, no Tomas Halloran |
| ruler-niah | maxxed | haiku | noise_abstention | absent-1/5/7/9-noid | 0.2–0.3 | surfaces an unrelated code, risks volunteering it |
| ruler-niah | maxxed | opus | multihop | multi-0/1-hop | 0–0.2 | first needle found, second absent |
| ruler-niah | opinionated | haiku | multihop | multi-4-hop | 0.3 | station found, SRE name absent |
| ruler-niah | opinionated | haiku | recall | single-2/3/4/5/7-code | 0 | **empty context — 5 needles simply not retrieved** |

The two stories the inventory tells:

1. **`temporal` is the universal weakness** — every good build fails it, on both models.
   It's the only category that requires *reasoning over dates*, not lookup.
2. **Small N hid real failures** (the established finding, re-confirmed numerically):
   ruler at N=6 (Opus) showed maxxed 67% / others 100%; the *same* generator at N=30
   (Haiku) exposed maxxed 60% abstention, opinionated **50% recall** (5 dropped
   needles), and multihop misses across all builds. The 6-probe run was hiding a
   ~40-point recall hole in opinionated.

---

## Root-cause breakdown of "near-100%"

Decomposing why the good builds look saturated (good-build probes; N=264, 25 fails):

| bucket | est. share | evidence |
|---|---|---|
| **Small-N / can't-tell** | largest single factor | All 10 `custom` categories are N≤6/cell; 3 of the 11 perfect cells are N<10; a 3/3 is consistent with a true 44% rate. The `custom` benchmark alone is 79 of the 264 good-build probes, almost all single-fact lookups at N=1–2 per category. |
| **Saturated-easy probe (genuinely easy lookup)** | large | ruler single-needle recall is exact-token match; the judge notes are "Context is empty" or perfect echoes. `custom` recall/implicit/paraphrase are one-fact retrievals an embedding store nails. These are real passes but on probes a keyword index would also pass. |
| **Metric can't distinguish (contradiction)** | structural | All three good builds hit 100% on `contradiction_tension` — but see below; the metric rewards an outcome it cannot attribute to any mechanism. |
| **Lenient-judge pass** | small (~5%) | 18/383 passes (4.7%) are `correct=true` at `score<0.8`; 25/383 (6.5%) at `score<0.85`; only 3 (0.8%) below 0.7. Real, but a minority — tightening the judge raises the floor, it doesn't create the saturation. |
| **Genuinely solved (hard probe, real pass)** | real but modest | longmemeval temporal at 84% on N=45 and ruler multihop at 90% on N=30 are real wins on non-trivial probes — the builds *are* good, just not perfect. |

### The judge: lenient but not the main culprit

`judge.ts` returns `correct: Boolean(j.correct)` as a **separate boolean** from
`score`, and `score` only defaults to 1 when `correct` is true (line 184). There is
**no enforced floor**: a probe can pass at `score:0.7`. Quantified across all 383
passes in the suite:

- **score = 1.0:** 297 (77.5%)
- **0.9–0.99:** 41
- **0.8–0.89:** 27
- **0.7–0.79:** 15
- **< 0.7:** 3

**18 passes (4.7% of all passes) would flip to FAIL under a `score≥0.8` floor**;
25 (6.5%) under `score≥0.85`. They cluster in the soft categories — locomo recall
(5), longmemeval temporal (6), contradiction tension (2: ct-diet/ct-ts at 0.7),
custom fact_evolution/opinion_arc (2 at 0.7). A floor would:

- Re-introduce discrimination in `contradiction`: simple's `ct-diet-tension` (0.7) and
  `ct-ts-tension` (0.7) would fail while opinionated's (1.0) would pass — turning the
  fixture's flat "100% vs 100%" into a real gap. (This is the one place a floor would
  *create* signal rather than just lower it.)
- Cost a few real passes (longmemeval temporal at 0.7 is "right answer, slightly
  hedged context"), so the floor should be reported as a *second* accuracy column, not
  a silent replacement.

**Abstention over-credit — a genuine weakness.** The judge gives `correct=true` to any
context that "conveys nothing relevant is known," and `baseline` exploits this: it
passes **every** ruler `absent-*` and locomo/longmemeval abstention probe largely
**because its store is near-empty** (ctxTok≈43, just leaked distractor turns, no
needle). Baseline's 100% on ruler is mostly an artifact of returning little. The
abstention metric rewards an empty store as much as a store that retrieved-and-
correctly-suppressed. There is no "abstain under pressure" probe where the *right*
fact is present but a tempting decoy must be refused — maxxed's 4 abstention fails
(it surfaces a real-but-unrelated code) are the only hint that this case exists, and
they're accidental, not designed.

### The contradiction fixture: rewards an outcome it can't attribute

Confirmed and quantified from the per-probe notes. All three good builds surface "both
sides + unresolved" on the tension probes and the judge scores them correct — but the
notes show *why* it's a broken separator:

- **simple** passes `ct-lang-tension` (0.8) with the judge noting the context *also*
  "contains contradictory 'Rust is now favorite'" — i.e. it passes on a **leaked raw
  recent turn**, not on any contradiction machinery.
- **simple** passes `ct-diet-tension` (0.7) and `ct-ts-tension` (0.7) on **lossy
  breadcrumbs** ("the meat-eating present is not explicitly stated"; "Missing the
  original enthusiasm") — partial context, full credit.
- The single most informative result is a **negative for the design under test**:
  `opinionated` is the *only* build to FAIL a contradiction probe — `ct-move-control`
  (0.1), because its keep-both-and-narrate design over-stated an unsettled move as
  "Denver finalized." Its signature feature cost it the control probe.

So the metric awards a 100% to supersede-based builds for an outcome (tension visible)
that arrives via mechanisms the fixture was built to *exclude* (re-keying under
distinct slots, raw-turn leak, lossy snippets). It cannot tell a CONTRADICT-link from
a breadcrumb. This is "metric can't distinguish," not "probes too easy."

---

## Prioritized next steps

Ordered by signal-per-dollar. Each: what it costs to run, what it reveals, which
weakness it fixes.

### 1. Raise N on the LLM builds to a stated power level (biggest signal, cheap on Haiku)

The dominant defect is sample size, not difficulty. Re-run the standard benchmarks on
the three LLM builds at **N≥30 on Haiku** (where they already are for ruler/longmemeval)
and **bring the Opus cells from N=3–6 up to N≥20**, or drop the Opus LLM-build column
entirely and declare Haiku-N30 the system-of-record. Target: every reported cell has a
Wilson 95% CI half-width < ~10 points (N≥30 for rates near 90%; N≥50 to separate two
builds 10 points apart).

- **Cost:** Haiku is ~$0.02–$2.56/card (existing cost table). Tripling Opus LLM-build N
  to ~20 is a few extra $/card. Total a few dollars and one suite pass.
- **Reveals:** which 100% cells are real vs lucky. The ruler opinionated-recall hole
  (50% at N=10) is the proof that this matters — it was invisible at N=6.
- **Fixes:** small-N-noise (the single largest "near-100%" contributor).

### 2. Run LoCoMo on the three LLM builds (the realistic hard case, currently untested)

LoCoMo is **baseline-only** today, and baseline scores **15% (Haiku, N=100)** —
multihop 9%, temporal 3%, recall 35%. This is the hardest realistic benchmark and the
LLM builds have **never been measured on it**. It is the most likely place to produce a
genuine, well-separated ranking (the floor is so low there's 85 points of headroom).

- **Cost:** the known blocker — ~830 turns/conversation ingested into a live-LLM
  service, MAX_CONVERSATIONS=2, so a multi-hour batch per build. On Haiku, bounded.
  Budget one overnight batch.
- **Reveals:** whether any LLM build actually solves long multi-session multihop/
  temporal, or whether they all collapse toward the baseline floor. This is the result
  most likely to *change the conclusion* "simple is the standout."
- **Fixes:** the "we only test on easy/short data" gap; gives a discriminating
  benchmark with real headroom.

### 3. Add a `score≥0.8` pass-floor column (not a replacement) to the runner/report

Add a second accuracy figure to each card computed as `count(correct && score≥0.8) /
total`, alongside the existing binary accuracy. Keep both visible.

- **Cost:** code-only; recomputable from existing cards (no re-run, no LLM spend).
- **Reveals:** the 18 lenient passes immediately; turns the flat contradiction 100/100
  into a gap (simple drops its two 0.7 tension probes, opinionated keeps its 1.0s).
- **Fixes:** lenient-judge-pass; partially fixes the contradiction non-separation.

### 4. Deepen the ruler haystacks and add same-topic distractors

The generated cache shows **haystack = 12** distractor turns (the env default is 50;
the run used a shallow 12). 12 turns is trivially within any recall window — that's why
single-needle recall is ~100% everywhere. Bump `RULER_HAYSTACK` to **200–500** and add
**near-miss distractors** (other projects' codes, other cities' role-holders) so the
recall layer must discriminate, not just retrieve.

- **Cost:** more ingest turns ⇒ more tokens/run; on Haiku still cheap (~linear in
  turns). One re-run of the ruler adapter.
- **Reveals:** the depth at which each build's recall degrades — the *intended* knob of
  a RULER benchmark, currently turned almost off. Likely re-opens single-needle recall
  as a discriminating category.
- **Fixes:** saturated-easy-probe (ruler recall); strengthens the noise-abstention
  trap (a near-miss code is exactly maxxed's failure mode).

### 5. Add adversarial categories (the missing "hard" probes)

The suite is almost entirely happy-path. Add, as new probe kinds:

- **Stale-fact traps:** plant A, supersede to B, ask for current; then ask a question
  whose answer is *only* correct if A was forgotten. Catches builds that leak stale
  rows (the raw-turn-leak the contradiction fixture exposed accidentally).
- **Raw-turn-leak controls:** a variant of every contradiction probe where the
  *recent raw turn is stripped* before recall, so the probe tests the **structured
  store alone**. This is the control that would finally separate CONTRADICT-link from
  breadcrumb — right now both pass via the leaked turn.
- **Abstention under pressure:** the needle for a *similar* question is present and a
  tempting decoy sits in context; the build must refuse. Distinguishes "abstains
  because empty" (baseline's free pass) from "retrieved and correctly suppressed."
- **Same-slot collisions the extractor cannot re-key:** force values that *must* land
  on one canonical slot (the contradiction docstring's own predicted dodge), e.g.
  numeric single-valued facts ("my employee ID is X" → "no, it's Y" → "I keep mixing
  them up").

- **Cost:** adapter-authoring time + one suite pass (Haiku, cheap). No new datasets.
- **Reveals:** real mechanism-level differences the current outcome-only probes can't.
- **Fixes:** metric-can't-distinguish (contradiction), abstention over-credit,
  saturated happy-path.

### 6. Harden the temporal probes — the one category that already bites

`temporal` is the only consistently discriminating standard category (84% on N=45,
every build fails some). It's the highest-yield place to *add* probes: more
date-arithmetic and event-ordering questions where the dates are present but must be
*computed/compared*, not looked up. Several current fails are "dates present, ordering
not explicit" — lean into exactly that.

- **Cost:** longmemeval already has these instances; just raise the temporal slice N.
  Marginal $.
- **Reveals:** a clean accuracy ranking on the one category that doesn't saturate.
- **Fixes:** confirms whether any build actually reasons over time, with enough N to
  rank them.

---

## Bottom line

The suite is not measuring nothing — when it pushes (temporal, multihop, abstention,
locomo) the builds spread and fail, and those results are trustworthy. But the headline
"near-100%" is set by **easy single-fact `custom` probes at N≤6** and by **N=3–6 Opus
cells** that can't distinguish 100% from 44%. The fastest path to a discriminating
suite is **more N (free on Haiku), LoCoMo on the LLM builds (the untested hard case),
and a score-floor column (free)** — in that order. The judge's leniency and the
contradiction fixture's blind spot are real but secondary; fix them with the score
floor and the raw-turn-leak control.
