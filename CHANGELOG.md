# Changelog

Iteration log for the memory service. One entry per significant design iteration:
what changed, why, what we observed, what's next. Newest first.

## Plan — four implementations, one benchmark

**v0 (below) is the starting point**: a deployable, contract-complete control. From
here we explore three independent designs, each on its own branch, then benchmark
all four against each other to see where we stand.

**The four implementations**

| # | Name | Branch | Idea |
|---|------|--------|------|
| 1 | **Baseline / control** | `main` | The cheap, deterministic, no-LLM floor. SQLite + rule-based extraction + lexical recall. Stays as-is — it tells us what the floor is. |
| 2 | **Opinionated** | `impl/opinionated` | Built on conviction / gut feeling about what a good memory system should be, not on a literature survey. A strong point of view, executed. |
| 3 | **Simple & transparent** | `impl/simple` | Optimizes for minimal moving parts, readability, and inspectability — the design a maintainer groks in five minutes. |
| 4 | **Maxxed** | `impl/maxxed` | Kitchen-sink: tries to cover every category — extract→reconcile, hybrid + rerank recall, graph/multi-hop, temporal reasoning, the lot. |

**Shared stack for the three new implementations** (the v0 control keeps its
SQLite/rule-based stack so we can measure what the additions buy us):

- **Runtime:** Python + FastAPI
- **Store:** pglite (embedded Postgres)
- **Embeddings:** OpenAI `text-embedding-3-large` (3072-dim)
- **LLM:** Claude **Opus 4.8** (`claude-opus-4-8`) for extraction / reconciliation / recall
- **Cost:** **not** optimizing for LLM cost or latency yet — chase the quality
  ceiling first, trim later.

**How we'll compare:** the HTTP benchmark harness (`bench/`) plus the suite chosen
from the research — LongMemEval + LoCoMo + RULER/NIAH + our custom fixture (see
[`docs/research/benchmarks/RECOMMENDATIONS.md`](docs/research/benchmarks/RECOMMENDATIONS.md)) —
scored on the three-axis card: accuracy-by-category · tokens-per-recall · p50/p95
latency. Each branch appends its own entries below as it iterates; the winner (or
hybrid of winners) gets promoted back to `main`.

---

## v0 — Baseline / control: full contract, offline, deterministic

**What changed:** First end-to-end slice and the control for the comparison above.
FastAPI implementing all seven contract endpoints over SQLite (single file on a
Docker volume). Rule-based extraction of typed memories (employment, location/moves,
pets incl. implicit, diet, allergies, preferences, names, family). Keyword-overlap +
recency + type-priority recall with budget-bounded assembly. Fact-evolution via
key-based supersession (old row kept, `supersedes` chain, current value returned).
Pluggable Extractor/Recaller behind env-selected factories.

**Why this shape first:** the spec rewards iteration with metrics over a single
clever shot. A deterministic, offline baseline makes the self-eval loop and CI
instant and reproducible (no network, no flakiness), and gives every branch a
measurable floor to beat. It is intentionally the no-embeddings, no-LLM control.

**Result:** self-eval fixture **7/7 probes (100%)** — relocation, implicit pet,
multi-hop (Biscuit→Berlin), job-change supersession, preferences, and a cold-user
noise probe. Full suite: **19 tests** green (contract roundtrip, restart
persistence, cross-session scoping, malformed/oversized/unicode robustness,
fact-evolution supersession). Verified in the real container: `docker compose up`
boots on :8080, data survives `docker compose down && up` (named volume), and the
bench harness scores 7/7 at ~6 ms ingest / ~2 ms recall. CI (lint → requirements →
tests → docker smoke → restart-persistence → bench) is green.

**Guardrails added:** `scripts/check_requirements.py` (static check of every formal
requirement — files, endpoints, port 8080, persistence volume, README sections,
CHANGELOG), pre-commit (ruff lint+format, secret detection, the requirements check)
and GitHub Actions CI.

**Next:** branch the three explorations above onto the shared pglite + embeddings +
Opus stack and benchmark them against this control.
