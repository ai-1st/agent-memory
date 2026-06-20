# Changelog

Iteration log for the memory service. One entry per significant design iteration:
what changed, why, what we observed, what's next. Newest first.

## v0 — Baseline: full contract, offline, deterministic

**What changed:** First end-to-end slice. FastAPI implementing all seven contract
endpoints over SQLite (single file on a Docker volume). Rule-based extraction of
typed memories (employment, location/moves, pets incl. implicit, diet, allergies,
preferences, names, family). Keyword-overlap + recency + type-priority recall with
budget-bounded assembly. Fact-evolution via key-based supersession (old row kept,
`supersedes` chain, current value returned). Pluggable Extractor/Recaller behind
env-selected factories.

**Why this shape first:** the spec rewards iteration with metrics over a single
clever shot. A deterministic, offline baseline makes the self-eval loop and CI
instant and reproducible (no network, no flakiness), and gives every future
variant (embeddings, LLM extraction, reranking, graph) a measurable floor to beat.

**Result:** self-eval fixture **7/7 probes (100%)** — covers relocation, implicit
pet, multi-hop (Biscuit→Berlin), job-change supersession, preferences, and a
cold-user noise probe. Full suite: **19 tests** green (contract roundtrip, restart
persistence, cross-session scoping, malformed/oversized/unicode robustness,
fact-evolution supersession). Recall latency is sub-millisecond at fixture scale.

**Guardrails added:** `scripts/check_requirements.py` (static check of every
formal requirement — files, endpoints, port 8080, persistence volume, README
sections, CHANGELOG), pre-commit (ruff lint+format, secret detection, the
requirements check) and GitHub Actions CI (lint → requirements → tests → docker
compose smoke → restart-persistence → bench).

**Next:**
- Embedding-based semantic recall (hybrid with the lexical scorer via RRF) — the
  baseline misses paraphrased queries with no token overlap.
- Noise-resistance precision: gate the always-on profile block when a query is
  clearly off-topic, without regressing multi-hop.
- LLM extractor quality pass (prompt + schema) benchmarked vs. the rule-based floor.
- Opinion-arc summarisation beyond latest-stance supersession.
- Expand the fixture toward the eval categories (temporal, ambiguity, volume).
