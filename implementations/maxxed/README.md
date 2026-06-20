# maxxed — kitchen-sink memory service

The ambitious variant: cover **every** category the assignment and the research
menu surface, while still passing the contract and the offline test suite. It is
a synchronous HTTP memory service that ingests conversation turns, extracts typed
structured memories through an LLM **extract → reconcile** loop, evolves facts
with full supersession history, and answers `/recall` with a **hybrid (dense +
lexical) → graph-expanded → reranked → budget-assembled** context.

> Dev/bench port: **8093**. Container default: **8080**. `docker compose up` is
> the only setup step.

---

## 1. Architecture

```
                         POST /turns                         POST /recall  /search
                              │                                    │
            ┌─────────────────▼─────────────────┐    ┌────────────▼───────────────┐
            │          EXTRACTION PIPELINE        │    │       RECALL PIPELINE       │
            │                                     │    │                             │
   user txt │  1. LLM extract  (generateObject)   │    │  1. query rewrite/expand    │
  ──────────►  2. retrieve existing slot memories │    │  2. hybrid retrieve:        │
            │  3. LLM reconcile decision per cand │    │     dense kNN + lexical FTS │
            │     ADD / UPDATE / SUPERSEDE / NOOP │    │     ── fused with RRF ──    │
            │  4. apply + history ledger          │    │  3. graph 1-hop expansion   │
            │  5. entity-graph linking            │    │  4. LLM rerank              │
            └─────────────────┬───────────────────┘    │  5. temporal "as of" filter │
                              │                         │  6. budget-aware tiered     │
                              │                         │     assembly (+ compaction) │
                              ▼                         └────────────┬────────────────┘
                  ┌──────────────────────────────────────────────────▼──────────┐
                  │                    pglite  (embedded Postgres)                │
                  │  turns │ memories(+pgvector) │ memory_history │ memory_links  │
                  │  FTS (tsvector/GIN) + vector(<=>) exact kNN                   │
                  └───────────────────────────────────────────────────────────────┘
                                   persisted on a Docker volume (/data)
```

Two paragraphs: A single Hono app wires a `Store` (pglite) to an injectable
`LlmClient` and two pipelines. **Writes are fully synchronous** — `POST /turns`
awaits extraction, reconciliation, embedding, indexing, and graph linking before
returning `201`, so there is no eventual-consistency window: anything you wrote is
immediately recallable. **The LLM layer is a seam** (`src/llm`): the live client
wraps the Vercel AI SDK (Claude Opus 4.8 + `text-embedding-3-large`), and a
deterministic offline mock shadows it so the entire contract suite runs in CI
with zero network calls while driving the *same* pipeline code.

Everything lives in one relational store. Facts, their full supersession history,
dense embeddings, a lexical index, and an entity-link graph are all rows in the
same pglite database, which means reads-after-writes are correct by construction
and "real persistence" is just a single directory on a Docker volume.

### Subsystem map (every category, and where it lives)

| Category (eval / research) | Subsystem | File(s) |
|---|---|---|
| **Extraction → reconcile loop** (ADD/UPDATE/SUPERSEDE/NOOP) | LLM extractor + decision per candidate | `src/extraction/extractor.ts`, `schemas.ts`, `prompts.ts` |
| **Extraction (typed, implicit, corrections)** | schema-constrained `generateObject`; rule shadow | `src/extraction/rules.ts`, `schemas.ts` |
| **Hybrid retrieval** (dense + lexical) | pgvector kNN + Postgres FTS | `src/store/index.ts` (`vectorMemories`/`lexicalMemories`) |
| **Reciprocal Rank Fusion** | rank-based fusion of all retrievers | `src/recall/fusion.ts` |
| **LLM reranking** | rerank fused set, blended with RRF | `src/recall/recaller.ts` (`rerank`, `combined`) |
| **Multi-hop / graph** | entity-link graph + 1-hop expansion + entity seeding | `src/store/index.ts` (`neighbours`, `memoriesByEntities`), `recaller.ts` (`graphExpand`) |
| **Temporal reasoning** | bi-temporal `valid_from`/`valid_to`, `as_of` point-in-time view | `src/store/index.ts` (`memoriesAsOf`), `recaller.ts` (`applyAsOf`) |
| **Fact evolution / contradiction** | invalidate-don't-delete supersession + history ledger | `extractor.ts` (`apply`), `store/index.ts` (`supersede`, `recordHistory`) |
| **Opinion arc** | same topic slot; later stance supersedes; history preserved | `rules.ts` (preference/opinion keys), `extractor.ts` |
| **Budget-aware assembly** | tiered (stable → relevant → recent), rank-then-truncate, LLM compaction | `recaller.ts` (`assemble`, `compact`), `util/tokens.ts` |
| **Noise resistance / abstention** | relevance gate (rerank/entity/lexical/intent union) | `recaller.ts` (`hasRelevance`) |
| **Query rewriting / expansion** | synonyms + multi-hop sub-questions + entities | `recaller.ts` (`rewrite`), `recall/schemas.ts` |
| **Cross-session scoping** | per-`user_id` knowledge, per-`session` turn scope | `store/index.ts` scoping in every query |
| **Persistence / robustness** | pglite `dataDir`; lenient Zod; never-crash handlers | `store/index.ts`, `models.ts`, `app.ts` |

---

## 2. Backing store choice — pglite + pgvector

**pglite** (`@electric-sql/pglite`) is embedded Postgres compiled to WASM, with
the official `vector` extension. We chose it because it gives one store that does
*all four* jobs the spec needs without external infrastructure:

- **Relational facts + history** — typed memory rows, `active`/`supersedes`,
  an append-only `memory_history` ledger, and a `memory_links` graph table.
- **Dense vector search** — a `vector(N)` column with `<=>` cosine distance.
- **Lexical search** — Postgres full-text search (`tsvector` + GIN) for the
  keyword-heavy queries ("what's the dog's name?") where embeddings underperform.
- **Real persistence** — pglite persists to a `dataDir`; mount it on a named
  Docker volume and restart is invisible to clients. No separate DB container.

Because pglite runs in-process and Node is single-threaded for our handlers,
reads-after-writes are correct with no locking gymnastics — the synchronous
correctness the spec demands falls out for free.

**Index strategy.** We use exact vector search (`ORDER BY embedding <=> q`), not
an ANN index. At this service's scale (a few users, thousands of memories) exact
kNN is fast and always 100% recall, and it removes ANN build/recall tuning as a
variable. If volume grew, adding an HNSW index is a one-line schema change —
called out as a deliberate, reversible tradeoff.

---

## 3. Extraction pipeline

`POST /turns` runs the **extract → reconcile** loop (mem0 / LangMem family),
re-derived for this contract rather than copied:

1. **Extract** — only the *user* messages are mined (assistant/tool text
   describes the world, not the user — a precision trap). A schema-constrained
   `generateObject` call (Claude Opus 4.8) returns typed candidates:
   `{type, key, value, confidence, mutable, snippet, entities}`. `key` is a
   canonical slug (`employment`, `location`, `pet:biscuit`, `diet`,
   `allergy:shellfish`, `preference:<topic>`) so the same concept dedups across
   turns. The prompt explicitly asks for **implicit** facts ("walking Biscuit" →
   pet named Biscuit; "Biscuit and I hiked" → enjoys hiking) and **corrections**.
2. **Retrieve** — for each candidate, fetch the existing active memories in the
   same slot.
3. **Reconcile** — a second `generateObject` call returns a structured decision:
   - **ADD** — new information.
   - **UPDATE** — refines the same current fact in place (e.g. adds a role).
   - **SUPERSEDE** — contradiction/correction: the old row is kept but marked
     inactive, the new one points back via `supersedes`.
   - **NOOP** — duplicate / noise (this is the cheap noise filter).
4. **Apply + ledger** — the decision is applied to the store and recorded in the
   append-only `memory_history` table (decision, reason, source turn).
5. **Link** — the new memory is linked into the entity graph: strong edges to
   memories sharing an entity token, weak `same_subject` edges to the user's
   identity-bearing facts — the backbone multi-hop traverses.

Each candidate value is embedded (batched) at write time so vector recall works
immediately. **What we miss / why:** purely conversational nuance with no durable
fact ("had a rough day") is intentionally dropped; very long multi-fact turns may
under-extract (precision over recall — a missed fact is recoverable next turn, a
wrong one pollutes recall). If the LLM call fails, extraction **degrades to the
rule extractor** so a write still produces structured memories.

**Offline parity:** the rule extractor (`rules.ts`) is both the degradation path
*and* the shadow the mock LLM returns, so the offline suite exercises the real
reconcile/recall code — a green offline run is real evidence, not a stubbed no-op.

---

## 4. Recall strategy

`POST /recall` is the primary scored signal. End-to-end (`recaller.ts`):

1. **Query rewrite / expansion** — Opus produces 1–3 reformulations (synonyms,
   and for multi-hop the intermediate sub-question) plus the entities named.
2. **Hybrid retrieval** — for the query and each expansion, run **dense kNN**
   (pgvector) and **lexical FTS** over both memories and turns, then fuse all
   ranked lists with **Reciprocal Rank Fusion** (rank-based, so cosine and
   `ts_rank` scales don't fight).
3. **Graph expansion** — seed from the query's named entities (direct match) and
   do **one-hop** expansion from the top fused memories over `memory_links`. This
   is what resolves *"what city does the owner of the dog Biscuit live in?"* —
   the "Biscuit" entity reaches the pet memory, one hop reaches the city.
4. **LLM rerank** — Opus scores each candidate's relevance; the final order
   blends rerank (precision) with RRF (recall robustness) so one strong retriever
   isn't fully overridden.
5. **Temporal filter** — if `as_of` is supplied, candidates and turns observed
   after the cutoff are dropped and the profile uses the point-in-time view.
6. **Budget-aware tiered assembly** — see below.

### Ranking + token-budget priority logic (defended)

Context is assembled in three tiers, **rank-then-truncate, never dump-all**:

- **Tier A — stable user facts** (`fact`/`preference`): the always-on profile.
  Surfaced even when only loosely query-relevant, ordered so the fact the query
  is about floats to the top (rerank blended with intent/lexical overlap, then
  importance, then recency). *Why first:* these are low-volume, high-value, and
  most often what a follow-up depends on — and surfacing them is what makes
  multi-hop work without a heavyweight graph.
- **Tier B — query-relevant memories** not already in A (events/opinions and any
  ranked extras).
- **Tier C — recent/relevant raw conversation snippets**. *Cut first* under
  pressure: they are the most recoverable.

Each tier appends bullet-by-bullet only while it fits `max_tokens` (≈4 chars/token).
If a fact block is still over budget, an **LLM compaction** pass merges bullets
while preserving every concrete fact, with a hard char-trim as a final guard so
we never exceed budget by 2×.

**Abstention / noise resistance.** Tier A is always-on *only when the query is
on-topic*. A relevance gate (`hasRelevance`) returns empty context when **nothing**
is genuinely relevant — no reranked memory above the floor, no named entity, no
lexical turn hit, no intent/lexical overlap. So *"favorite programming language"*
for a user who never discussed it returns `{"context":"", "citations":[]}` rather
than dumping the profile — the abstention behavior the eval rewards, while
on-topic queries still get the full profile.

`/search` reuses the same hybrid retrieval but returns structured rows (no prose,
no budget) for explicit agent tool calls.

---

## 5. Fact evolution

**Invalidate, don't delete.** When the reconciler returns SUPERSEDE, the old row
stays — `active=false`, `valid_to=<observed time>` — and the new row records
`supersedes=<old id>` and `valid_from`. So:

- `/recall` returns the **current** fact ("Notion"), and notes the prior value
  inline ("…previously Stripe…").
- `/users/{id}/memories` shows the full chain (both rows, the `supersedes` link,
  `active` flags), and `/users/{id}/history` shows the decision ledger.
- **Temporal correctness:** `recall` with `as_of=2026-02-15` returns *Stripe*
  (valid then), because `memoriesAsOf` selects the row whose `[valid_from,
  valid_to)` interval contains the cutoff.

**Opinion arcs** ("I love TypeScript" → "TypeScript generics are annoying") share
one topic slot (`preference:typescript` / `opinion:typescript`), so the later
stance supersedes the earlier one while history preserves the arc — inspectable in
`/users/{id}/memories`. The implementation is a supersession chain, not a learned
sentiment trajectory; that limitation is explicit.

---

## 6. Tradeoffs

- **Quality over cost/latency.** Up to 4 LLM calls on `/turns` (extract + a
  reconcile per candidate) and up to 3 on `/recall` (rewrite + rerank + maybe
  compaction). The spec says don't optimize for cost; we don't. The 60s `/turns`
  budget is ample. The lean cut (see CHANGELOG) is documented.
- **Exact kNN over ANN.** Always-correct recall and zero index tuning, at the
  cost of large-scale throughput we don't need.
- **One-hop graph over a graph DB / PPR.** Cheap multi-hop on top of vectors; we
  skip Neo4j/PageRank, which the research flags as not uniformly better at our
  scale. Chained (n-hop) reasoning is the explicit upgrade path.
- **Per-user shared knowledge (intentional).** Memories are scoped by `user_id`
  and shared across that user's sessions (the spec permits this when documented);
  raw turns can additionally be session-scoped. Different users never bleed.
- **Precision-leaning extraction.** We'd rather miss a fact than store a wrong
  one.

---

## 7. Failure modes

- **No data / cold session** — `/recall` returns `{"context":"","citations":[]}`,
  never an error.
- **Missing API keys** — with `MEMORY_PIPELINE=llm` and no keys the client throws
  at construction (loud, not silent). Run `MEMORY_PIPELINE=rule` for a fully
  offline service (rule extraction + deterministic hashed embeddings) — degraded
  semantic recall, but every endpoint works and tests pass.
- **LLM call fails mid-request** — extraction falls back to rules; rerank/rewrite
  fall back to fused/lexical ordering; compaction falls back to a hard trim. A
  failed extraction never fails the write (the turn is already persisted).
- **Malformed / oversized / unicode input** — lenient Zod yields `422` (never a
  crash); a top-level `onError` returns `500` rather than killing the process;
  oversized payloads are accepted and the service stays responsive.
- **Slow disk** — pglite is local; `/health` reports `starting` (503) until the
  schema is ready, then `ok`.

---

## 8. How to run the tests

```bash
npm install
npm run typecheck     # tsc --noEmit, clean
npm run lint          # biome check, clean
npm run test          # vitest run — all offline, LLM mocked

# Live end-to-end smoke against the real models (opt-in, needs keys):
set -a; . ../../.env; set +a
npm run smoke:live

# HTTP smoke against a running container (default port 8093):
HOST_PORT=8093 docker compose up -d
PORT=8093 npm run smoke
MEMORY_BASE=http://localhost:8093 npm run bench
```

The suite covers: contract roundtrip + shapes + status codes, restart
persistence (new `Store` over the same dataDir), cross-session/cross-user
scoping, malformed/unicode/oversized robustness, fact evolution + supersession
chain + history ledger + opinion arc, multi-hop via the entity graph, temporal
`as_of`, RRF fusion + mock-embedding clustering unit tests, and the
**recall-quality fixture** (`fixtures/quality.json`) which reports `X of Y`
probes passed across every category.

### Run modes

| Env | Behavior |
|---|---|
| `MEMORY_PIPELINE=llm` (default) | Full LLM extract/reconcile + embeddings + hybrid recall + rerank. Needs `OPENAI_API_KEY` + `ANTHROPIC_API_KEY`. |
| `MEMORY_PIPELINE=rule` | Fully offline: rule extraction + deterministic hashed embeddings. No network. |

The test suite forces the offline path via the injected mock client regardless of
env, so CI never needs keys.
