# memory-service

A memory service for an AI agent. It ingests conversation turns, extracts
**structured** knowledge, persists it, and answers recall queries that decide
what context the agent sees on the next turn.

> Status: **v0 baseline (TypeScript).** A deliberately thin, fast, fully-offline
> vertical slice that satisfies the entire HTTP contract and the formal
> requirements, with a clean seam for swapping in smarter extraction/recall.
> It is the **control** for a 4-way comparison — see [CHANGELOG.md](CHANGELOG.md)
> for the plan and iteration log.

**Stack:** TypeScript · [Hono](https://hono.dev) · better-sqlite3 · Zod ·
Biome · Vitest. (The exploration branches add the Vercel AI SDK + pglite +
embeddings + Claude Opus 4.8 — see the CHANGELOG.)

## Quick start

```bash
docker compose up -d
until curl -sf http://localhost:8080/health; do sleep 1; done
./scripts/smoke.sh                       # §7 smoke test
```

No manual setup steps; SQLite data persists in the `memory-data` Docker volume.
LLM keys are optional for the baseline (see [.env.example](.env.example)).

Local dev (without Docker):

```bash
npm install
npm start            # tsx src/server.ts, listens on :8080
npm test             # Vitest suite
```

## Architecture

```
                ┌──────────────────────── Hono (contract §3) ──────────────────────────┐
  POST /turns ─▶│  ingest ─▶ Extractor ─▶ Store.addMemory (fact-evolution)             │
  POST /recall ▶│  Recaller ─▶ rank (lexical+recency+type) ─▶ budget assembly ─▶ prose │
  POST /search ▶│  Store.search (keyword overlap)                                       │
  GET  /users/:id/memories ─▶ structured memory rows                                    │
  DELETE /sessions|users ─▶ scoped cleanup                                              │
                └───────────────────────────────┬──────────────────────────────────────┘
                                                 ▼
                              better-sqlite3 (turns, memories)  ── Docker volume /data
```

Two pluggable pipelines sit behind small interfaces so they can be swapped and
benchmarked without touching the API:

- **Extractor** ([`src/extraction/`](src/extraction)) — raw messages → typed
  memories. `baseline` (rule-based, offline) on `main`; branches add `llm`.
- **Recaller** ([`src/recall/`](src/recall)) — ranks memories and assembles
  budget-bounded context. `baseline` today.

Both are selected by environment variable (`MEMORY_EXTRACTOR`, `MEMORY_RECALLER`),
which is also how we A/B variants in the benchmark harness. `createApp(dbPath?)`
([src/app.ts](src/app.ts)) builds the app over a given database, so tests use a
temp file and a "restart" is just a new app over the same file.

## Backing store choice

**SQLite via better-sqlite3**, one file on a named Docker volume.

- **Why:** zero external services → `docker compose up` is the only setup step,
  and persistence is real with nothing to provision. better-sqlite3 is
  **synchronous**, so reads-after-writes are correct by construction — no
  eventual-consistency gap the spec warns about. Fastest substrate to iterate on.
- **Concurrency:** Node runs JS single-threaded so no write lock is needed; WAL
  mode keeps reads concurrent with the occasional writer.
- **Swap path:** the store is a thin method surface ([src/store.ts](src/store.ts)),
  so the exploration branches move to **pglite** (embedded Postgres) + pgvector
  for vector recall without rewriting the API or pipelines.

## Extraction pipeline

The difference between this and a message log. `POST /turns` runs the configured
extractor and **commits memories before returning** (synchronous correctness).

The **baseline** extractor is rule-based and mines only first-person user
statements (assistant/tool text is a precision trap). It produces typed memories
— `fact | preference | opinion | event` — with a canonical `key` (the slot that
makes updates collide), a `value`, a `confidence`, and provenance
(`source_turn`, `source_session`). It recognises employment, location &
relocations, names, family, pets (including **implicit** — "walking Biscuit" →
has a pet named Biscuit), diet, allergies, and preferences/opinions.

**What it misses (by design, for now):** paraphrased/indirect facts, anything
needing world knowledge, multi-sentence coreference, and subtle correction arcs.
Choosing rule-based as the *control* keeps CI and the self-eval loop instant,
free, and reproducible; the LLM extractor (Vercel AI SDK + Opus 4.8) is a branch
upgrade benchmarked against this floor.

## Recall strategy

`POST /recall` end-to-end:

1. Pull the user's **active** memories and the session's recent turns.
2. **Rank** each candidate by lexical overlap with the query
   (`|query ∩ item| / |query|`), nudged by confidence and recency. Vanilla
   cosine top-k is explicitly discouraged by the spec, so even the baseline
   blends lexical relevance with structural priority and budget-aware assembly.
3. **Assemble under `max_tokens`** (≈4 chars/token estimate; within tolerance)
   with explicit triage.

**Priority logic under a tight budget** (the design decision the spec asks us to
defend):

1. **Stable user facts first** — low-volume, high-value, often exactly what a
   follow-up depends on. We surface *all* of them (budget permitting) rather than
   filtering by the query.
2. **Query-relevant memories** (opinions/events).
3. **Recent conversation snippets** — most recoverable if cut.

Surfacing all stable facts is also what makes **multi-hop** work without a graph:
"what city does the user with the dog named Biscuit live in?" succeeds because
both the pet fact and the location fact are in the profile block, and the frozen
LLM connects them. Output mirrors the spec's example (`## Known facts about this
user` / `## Relevant from recent conversations`) with `citations` to source turns.

## Fact evolution

Mutable facts use a single-valued `key` (e.g. `employment`, `location`). When a
new value arrives for an existing active key:

- the old row is marked `active = 0` (superseded, **not deleted**),
- the new row is inserted with `supersedes = <old id>`,
- `/recall` returns the **current** value and annotates it
  ("updated 2025-03-20; previously Stripe as a engineer"),
- the full chain stays inspectable via `/users/:user_id/memories`.

Additive facts (allergies, multiple pets) use distinct keys so they coexist.
**Opinion arcs** ("love TypeScript" → "TS generics are annoying") map to the same
`preference:<topic>` slot, so the latest stance is active while history is
preserved — a partial answer to the harder variant; richer arc-summarisation is a
tracked next step.

## Tradeoffs

- **Optimized for:** build speed, reproducibility, exact contract compliance, and
  a clean swap seam — so iteration is cheap and measurable.
- **Gave up (for now):** semantic recall (no embeddings yet), so paraphrased
  queries with no token overlap can miss; and noise-resistance precision — the
  baseline always surfaces stable facts, so an off-topic query against a known
  user still returns that user's profile (real data, not hallucination). Both are
  the first things the embedding/LLM branches fix, measured by the harness.

## Failure modes

- **No data / cold session:** `/recall` returns `{"context": "", "citations": []}`
  with 200 — never an error.
- **Missing API keys:** the baseline needs none.
- **Malformed / oversized / unicode input:** validation errors return 422, the
  catch-all handler returns 500 JSON, and extraction errors are logged but never
  fail a write — the process stays up.
- **Slow disk:** SQLite busy timeout is 30s; `/turns` is allowed up to 60s by the
  eval, ample for SQLite + rules.

## Running the tests

```bash
npm install
npm test                 # contract, persistence, concurrency, robustness,
                         # fact-evolution, recall-quality fixture
npm run check:reqs       # formal-requirements guardrail
npm run lint             # biome
npm run typecheck        # tsc --noEmit
```

Benchmark a running service (and compare variants):

```bash
npm run bench -- --label baseline
npm run bench -- --compare
```

See [bench/README.md](../../bench/README.md) for the benchmark harness, and
[research/](../../research) for the memory-system ADRs and benchmark survey.
