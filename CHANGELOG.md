# Changelog

Iteration log for the memory service. One entry per significant design iteration:
what changed, why, what we observed, what's next. Newest first.

## Plan — four implementations, one benchmark

**v0 (below) is the starting point**: a deployable, contract-complete control.
From here we explore three independent designs, each on its own branch, then
benchmark all four against each other to see where we stand.

**The four implementations**

| # | Name | Branch | Idea |
|---|------|--------|------|
| 1 | **Baseline / control** | `main` | The cheap, deterministic, no-LLM floor. TypeScript + better-sqlite3 + rule-based extraction + lexical recall. Stays as-is — it tells us what the floor is. |
| 2 | **Opinionated** | `impl/opinionated` | Built on conviction / gut feeling about what a good memory system should be, not on a literature survey. A strong point of view, executed. |
| 3 | **Simple & transparent** | `impl/simple` | Optimizes for minimal moving parts, readability, and inspectability — the design a maintainer groks in five minutes. |
| 4 | **Maxxed** | `impl/maxxed` | Kitchen-sink: tries to cover every category — extract→reconcile, hybrid + rerank recall, graph/multi-hop, temporal reasoning, the lot. |

**Shared stack for the three new implementations** (the v0 control keeps its
SQLite/rule-based stack so we can measure what the additions buy us):

- **Runtime:** TypeScript + Node + Hono
- **LLM/embeddings interface:** **Vercel AI SDK**
- **Store:** pglite (`@electric-sql/pglite`, embedded Postgres) + pgvector
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

## v0.1 — Port the control to TypeScript

**What changed:** Rewrote the v0 control from Python/FastAPI to **TypeScript +
Hono + better-sqlite3**, keeping behaviour identical. Toolchain moved to the Node
ecosystem: **Biome** (lint+format), **Vitest** (tests), **tsx** (run TS directly,
no build step), **Zod** (request validation). Benchmark harness and the
requirements guardrail were ported to TS; smoke test (curl) is unchanged.

**Why:** the three exploration implementations will use the Vercel AI SDK and
pglite, both first-class in the TS/JS ecosystem (pglite is natively a WASM/JS
package). Putting the control on the same toolchain means one language, one set of
guardrails, and an apples-to-apples comparison where only the *design* differs.

**Result:** behaviour preserved — self-eval fixture **7/7 probes (100%)**, full
Vitest suite green (contract, persistence, cross-session scoping, robustness,
fact-evolution), container boots via `docker compose up` on :8080, data survives
`docker compose down && up`. CI is Node-based (biome → typecheck → requirements →
vitest → docker smoke → restart-persistence → bench).

**Next:** branch the three explorations onto the shared pglite + Vercel AI SDK +
Opus stack and benchmark them against this control.

---

## v0 — Baseline / control: full contract, offline, deterministic

**What changed:** First end-to-end slice and the control for the comparison above.
All seven contract endpoints over an embedded SQLite database (single file on a
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
noise probe. Verified in the real container: `docker compose up` boots on :8080,
data survives a restart (named volume), bench harness scores 7/7.

**Guardrails added:** `scripts/check-requirements.*` (static check of every formal
requirement — files, endpoints, port 8080, persistence volume, README sections,
CHANGELOG), pre-commit (lint+format, secret detection, the requirements check) and
GitHub Actions CI.

> Note: v0 was originally prototyped in Python/FastAPI; v0.1 ported it to
> TypeScript (see above). The design and behaviour are unchanged.
