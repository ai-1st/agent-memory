# Changelog — the "simple" memory service

The design story. Each entry is a real iteration: what I tried, what I observed,
why I changed direction. The guiding constraint throughout: **a maintainer should
grok the whole thing in five minutes.** Whenever a feature would buy recall
quality at the cost of legibility, I left it out and wrote down why.

---

## v0 — Skeleton over the shared stack

**What:** Stood up the seven-endpoint Hono contract over the repo's reference
shapes (request/response bodies, status codes, the `## Known facts…` recall
format). Reused the baseline's lenient Zod schemas so malformed input is a `422`,
not a crash.

**Why:** Get an exact contract match first — the eval scores shapes and status
codes — then layer design on top without touching the wire format.

**Result:** All endpoints return correct shapes; `422` on bad input; cold recall
returns `{"context": "", "citations": []}`.

---

## v1 — pglite + `vector` as the single store

**What changed:** Chose **pglite** (embedded Postgres, WASM) with the `vector`
extension as the only backing store. Two tables: `turns` and `memories`, each
with a `vector(3072)` column. Persistence is one directory on a Docker volume.

**Why:** The brief mandates pgvector-style semantic search but also "minimal
moving parts." A dedicated vector DB (Qdrant) or Postgres sidecar is another
service to boot and reason about; SQLite has no native vector type. pglite is the
smallest thing that gives me *both* first-class vectors and ordinary SQL in one
embedded process — and because every write commits inside the request handler,
reads-after-writes are correct by construction (no eventual-consistency gap).

**Observed pitfall:** the `vector` extension's import path is version-specific.
pglite 0.3+/0.5 dropped the bundled `./vector` subpath; **0.2.17** ships
`@electric-sql/pglite/vector` exactly as the shared spec describes. Pinned 0.2.17.
Verified cosine distance + `dataDir` persistence across reopen before building on
it.

**Result:** semantic search and persistence both work; `docker compose up` is
genuinely the only setup step.

---

## v2 — One structured extraction pass per turn

**What changed:** Added the LLM seam (`provider.ts`). `LiveProvider` runs **one**
`generateObject` call (Claude Opus 4.8 + a Zod schema) per turn, returning typed
memories with a canonical `key`, `confidence`, and a `mutable` flag.
`MockProvider` is a deterministic regex extractor + hash embedder so the whole
suite runs offline.

**Why:** "Extraction, not storage" is the line between a memory service and a
message log. I kept it to a *single* pass with provenance — no multi-stage
reconcile loop — because the variant's whole pitch is a legible, linear pipeline.
The injectable seam is non-negotiable: contract tests must run in CI with no keys.

**Result:** `/users/:id/memories` returns clean typed rows. The mock extracts the
spec's named categories (employment, location, pets incl. implicit, diet,
allergies, family, preferences/opinions) so the offline fixture is meaningful.

---

## v3 — Fact evolution in one method

**What changed:** Put *all* contradiction handling in `store.addMemory`. Mutable
slot + different value → set the active row `active=FALSE` and INSERT the new row
with `supersedes` → old id ("current wins, history kept"); same value → bump
confidence. Additive slots dedupe and coexist. `/recall` annotates the current
fact with `(updated …; previously …)`.

**Why:** Fact evolution is a graded eval category and the place a naive
append-only log loses badly. Keeping it in one method (rather than scattered
across the pipeline) is the single most important "grok in five minutes" decision
in the codebase — there's exactly one place to read to understand supersession.

**Result:** "Stripe → Notion" yields the current fact in recall plus the full
chain in `/users/:id/memories`. Verified by `tests/evolution.test.ts` (current
fact, history preserved, `supersedes` pointer, re-statement doesn't duplicate).

---

## v4 — Recall: clear hybrid + budget-bounded triage

**What changed:** `recall.ts` fuses semantic (cosine) and keyword overlap with a
**fixed weight** (α=0.6), then assembles under `max_tokens` with explicit
priority: (1) all stable facts, query-relevant first; (2) query-relevant
opinions/events + recent turns above a relevance floor. Added optional LLM
compaction as a last-resort budget guard (disableable).

**Why:** "Vanilla cosine top-k will not score." But a learned reranker or RRF
tuning is exactly the kind of opaque cleverness this variant avoids. Fixed-weight
fusion is explainable and beats either signal alone — semantic catches
paraphrase, keyword rescues exact-token queries ("dog's name"). Surfacing *all*
stable facts (not query-filtering them) is the deliberate move that makes
**multi-hop** work without a graph: both the pet fact and the location fact are
simply present, so "city of the user with the dog Biscuit" resolves.

**Result:** the quality fixture's relocation / implicit-pet / job-change /
multi-hop probes all pass on the offline provider.

---

## v5 — Quality fixture, and what the noise probe taught me

**What changed:** Built `fixtures/quality.json` + `tests/quality.test.ts` (prints
`X/Y probes passed`). The cold-user **noise** probe initially expected stable
profile facts (diet, allergy) to *not* appear for an off-topic query — and it
failed, because stable facts are intentionally always-on.

**Why the failure was instructive:** it forced me to pin down what "noise
resistance" means *for this design*. The spec's noise case is "queries about
topics **never discussed** → empty context, not hallucinated memories." That's a
property of an *undiscussed topic*, not a reason to hide a known user's profile.
So I rewrote the probe to test a genuinely cold user (nothing ingested) and
documented the always-on-stable-facts decision explicitly. The relevance floor
(0.12) handles the other half: off-topic *episodic* content is gated out.

**Result:** 5/5 quality probes pass; the always-on-profile vs noise-resistance
boundary is now documented and tested rather than implicit.

---

## v6 — Robustness pass (unicode, and a case-sensitivity bug)

**What changed:** Added robustness tests (malformed JSON, missing fields, empty
messages, oversized payload, null `user_id`, empty query) and unicode/emoji +
mixed-script (CJK) ingestion. Two real bugs surfaced and were fixed:

1. **Unicode places.** The mock's location regex used `[\w]`/`[A-Za-z]`, so
   "Zürich" didn't match (the `ü` broke it) and "私の名前です。 I moved to …" wasn't
   split on the Japanese full stop. Switched to Unicode-aware classes
   (`\p{Lu}`/`\p{L}`, `u` flag) and a capitalized-word place pattern that handles
   "San Francisco" *and* "Zürich" while stopping cleanly before emoji; added CJK
   sentence enders to the splitter.
2. **Sentence-initial capitalization.** The pet/`my name is`/`walking` rules only
   matched lowercase keywords, so a turn *starting* with "My dog is named
   Biscuit." extracted **nothing** (caught during a Docker smoke run, not by the
   then-existing tests — the multi-hop fixture only asserted on the location).
   Made leading keywords case-insensitive (`[Mm]y`, `[Ii]`, `[Ww]alking`) while
   keeping name/place captures uppercase-initial, and added a regression test.

**Why it matters:** the offline mock is the substrate the whole CI loop and
quality fixture run on — a silent extraction miss there is a silent quality hole.

**Result:** 27 tests green; unicode/CJK turns recall correctly.

---

## v7 — Live smoke, Docker, and a base-URL guard

**What changed:** Wired up Docker (pglite is pure WASM, so the image is a plain
Node 22 runtime — no python/make/g++ toolchain), a `HOST_PORT`-overridable
compose, and ran the end-to-end live smoke with real keys on port 8092.

**Observed (and fixed):** the live extraction 404'd because the environment
exported `ANTHROPIC_BASE_URL=https://api.anthropic.com` (no `/v1`), which the AI
SDK uses verbatim → `/messages` instead of `/v1/messages`. Rather than treat that
as someone else's misconfiguration, I made `LiveProvider` normalize a base URL
missing its `/v1` segment — the live path is now robust to the most common
env-export mistake.

**Result (live):** Claude Opus 4.8 extracted richer structured memories than the
mock (location with provenance, a separate previous-location fact, an opinion),
`/recall` surfaced Berlin with the "previously NYC" note, and persistence
survived a container restart. Offline: `tsc` clean, `biome` clean, 27/27 vitest
green. `docker build` succeeds; container boots healthy and serves the smoke flow.

---

## Known gaps / next steps (deliberately out of scope here)

- **No entity graph.** Multi-hop is handled by always surfacing stable facts,
  which covers common cases but won't chain arbitrary relations. A graph is the
  "maxxed" variant's territory.
- **No reconcile/dedupe loop.** One extraction pass; rare near-duplicates are
  accepted over a fragile multi-stage loop.
- **Opinion arcs are "latest + history," not a reconstructed narrative.** The
  current stance is correct in recall and the full chain is inspectable, but we
  don't synthesize "your view evolved from X to Y to Z."
- **Approximate token budgeting** (~4 chars/token) rather than a real tokenizer.

Each of these is a place where another variant spends its complexity budget. This
one spends it on being obvious.
