# Review before we improve the implementations

The decision checklist you asked for. Everything below is committed + pushed
unless marked _pending_. Detail lives in
[failure-analysis-and-action-plan.md](failure-analysis-and-action-plan.md),
[probe-discrimination-audit.md](probe-discrimination-audit.md), and
[BENCHMARKS.md](../BENCHMARKS.md).

## 1. What changed in the harness/suite (review the approach, not line-by-line)
- **Resumable + parallel runner** — JSONL journal per run; `--resume` skips
  finished work (validated: 0 redundant judge calls); concurrency-capped ingest +
  probes; retry/backoff on 429/529/network. So long runs survive a kill. *(This is
  why the LoCoMo run is now safe to leave unattended.)*
- **Model-aware cost** — every card priced at the model it ran on (was all-Opus,
  overstating Haiku ~10–15×).
- **Strict pass-floor** — `accuracyStrict` (score≥0.8) alongside `accuracy`;
  lenient passes are only 2.5% of good-build passes, so judge leniency is *not* the
  reason for high scores.
- **Discriminating probes** — new `adversarial` adapter (30 probes, 9 categories)
  + LoCoMo now run on the LLM builds (was baseline-only).

## 2. Current standing (what the numbers actually say)
- **Raising N collapsed the low-N ranking.** longmemeval at N=40: simple 75 /
  opinionated 77.5 / maxxed 70 — a 7.5-pt cluster, *not* the simple-93/maxxed-73
  spread N=15 implied. The "simple clearly wins" story was a small-N artifact.
- **LoCoMo (realistic, hard) separates builds from the floor:** baseline 15% →
  simple 24% → maxxed 26% → opinionated 27% (N=100). The LLM builds cluster ~10–12
  pts above the floor, opinionated marginally best — again *not* a simple runaway.
  This is the benchmark that matters most and where the headroom is (73 pts).
- **The adversarial set REVERSES the earlier "simple wins / opinionated has no
  premium" read:** baseline 20% → simple 63% → maxxed 70% → **opinionated 80%**.
  On probes that actually discriminate, opinionated's link-graph design *earns its
  cost* — `multihop_decoy` 4/4, `temporal_duration` 2/2, `stale_trap` 3/3 (best of
  all builds). Its one backfire: `slot_collision` 2/3 (keep-both is wrong for a
  plain correction). **The earlier conclusion was an artifact of non-discriminating
  tests — this changes the recommendation in §4.5.**
- **The remaining gaps are specific, not diffuse** — see §3.

## 3. The failure taxonomy → what we'd change (DECISION NEEDED: approve directions)
Per your constraint — **simple stays simple, opinionated stays true to its idea,
maxxed grows freely**:

| Build | Top failures | Proposed fix (respecting its contract) |
|---|---|---|
| **simple** | temporal arithmetic; LoCoMo coverage; loses A in A→B→C | one-line all-priors breadcrumb; date-anchor at extraction (prompt only); widen recall + speaker-scope. **No new subsystems.** |
| **opinionated** | empty recall on needle queries (5/6 ruler); over-narration; keep-both backfires on plain corrections (slot_collision 2/3) | retention guard so compaction can't drop a strong hit; narrate "unresolved unless resolved"; route corrections→clean UPDATE, reserve keep-both for true reversals. **Keeps the link-graph + narration identity (which adversarial proves wins: multihop 4/4, temporal_duration 2/2).** |
| **maxxed** | temporal; weak abstention; multi-hop | add a temporal layer, an abstention gate, a multi-hop expansion layer. **Free to add layers.** |

**Highest-leverage shared fix: date-anchoring at extraction** — temporal is the
dominant longmemeval failure for *all three* and it's prompt-only.

## 4. Decisions I need from you
1. **Approve the per-build directions in §3** (or adjust the line between
   "simple stays simple" and what counts as too much).
2. **Approve the priority order:** (1) date-anchoring [all], (2) opinionated
   retention guard, (3) all-priors breadcrumb [simple+maxxed], (4) simple LoCoMo
   coverage, (5) maxxed layers, (6) opinionated narration discipline.
3. **Harder probes — go further?** The audit's step 4 (deepen ruler haystacks to
   200–500 with near-miss distractors) is *not* done. Worth it before improving, or
   is the current discriminating set (LoCoMo + adversarial + N=40) enough to drive
   the work?
4. **Model for the improvement loop:** Haiku default (near-Opus accuracy at ~1/15
   cost), Opus only for a final confirmation run?
5. **opinionated's cost — reframed by the adversarial result:** it's the most
   expensive build (3–8× the calls), but it now shows a *real* accuracy premium on
   hard reasoning (adversarial 80% vs 63–70%; multihop 4/4). So the question is no
   longer "is it worth it" but "**keep developing as-is**, or also cap its fan-out
   cost while keeping the link-graph that delivers the win?" My read: keep it; the
   premium is real where it matters.

## 5. Inputs — all complete ✅
- **LoCoMo** N=100 — baseline 15 / simple 24 / maxxed 26 / opinionated 27.
- **adversarial** N=30 — baseline 20 / simple 63 / maxxed 70 / opinionated 80;
  per-category breakdown in
  [failure-analysis-and-action-plan.md](failure-analysis-and-action-plan.md#adversarial-n30--the-discriminating-set-per-category).

Both fixtures discriminate (the original concern). The suite is now a
defensible basis for the improvement work.
