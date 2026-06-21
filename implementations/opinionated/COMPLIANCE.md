# ASSIGNMENT compliance — statement-by-statement (opinionated build)

This is a self-assessment of the **opinionated** build — the build we are
shipping as the deliverable — against every requirement in `ASSIGNMENT.md`. The
other builds in this repo (`simple`, `maxxed`, the no-LLM `baseline`, and the
vanilla `mem0-chroma` reference) are **supporting comparison context only**, not
the submission.

Every claim below is backed by a `file:line` reference or by the **clean-room
validation** at the end (a fresh `git worktree` + `docker compose up` on
2026-06-21, reproducing the assignment's §8 setup exactly). Legend: ✅ met ·
⚠️ met with a documented caveat.

---

## §2 — Your Task (the six mandatory deliverables)

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | Conforms to the HTTP contract in §3 | ✅ | All 7 endpoints in [`src/app.ts`](src/app.ts) (see §3 below) |
| 2 | Persists across container restarts via a Docker volume | ✅ | Named volume `memory-data:/data` in [`docker-compose.yml`](docker-compose.yml); `VOLUME ["/data"]` in [`Dockerfile`](Dockerfile); on-disk pglite in [`src/store.ts`](src/store.ts:100). **Clean-room: data survived `down`→`up`.** |
| 3 | Comes up with `docker compose up` — no manual setup | ✅ | [`docker-compose.yml`](docker-compose.yml) `build: .` + healthcheck. **Clean-room: healthy in 3s, zero manual steps.** |
| 4 | Internal tests incl. a recall-quality fixture | ✅ | [`tests/`](tests) (25 tests) + [`fixtures/basic.json`](fixtures/basic.json) (4 scenarios / 9 probes) scored "X of Y" by [`tests/quality.test.ts`](tests/quality.test.ts:63) |
| 5 | Ships a `CHANGELOG.md` documenting iteration history | ✅ | [`CHANGELOG.md`](CHANGELOG.md) — 7 entries (v1→v7), each with what/why/result + metrics |
| 6 | `README.md` explaining architecture, store, recall | ✅ | [`README.md`](README.md) §1–§8 |

**Design-freedom choices (all defended in the README):** TypeScript + Node 22 +
Hono · pglite (embedded Postgres) + `vector` extension · LLM-first extraction
(Anthropic Claude) + per-fact reconciliation · wide-pool retrieval + LLM
rerank/compaction · single embedded monolith.

---

## §3 — The HTTP Contract (endpoint by endpoint)

Auth: optional `Authorization: Bearer <MEMORY_AUTH_TOKEN>`, ignored if unset —
[`src/auth.ts`](src/auth.ts), wired at [`app.ts:59`](src/app.ts:59); covered by
the "rejects missing bearer token when configured" contract test.

| Endpoint | Requirement | Status | Evidence |
|---|---|---|---|
| `GET /health` | 200 when ready | ✅ | [`app.ts:68`](src/app.ts:68); `ready` gates port bind so health only greens when the store is initialized ([`server.ts`](src/server.ts)) |
| `POST /turns` | persist + extract, return `201 {id}`, **immediately** queryable, 60s budget | ✅ | [`app.ts:74`](src/app.ts:74) — raw turn persisted first ([`app.ts:88`](src/app.ts:88)), then synchronous extract→reconcile→apply; returns `201 {id}`. **Clean-room: `201 {id}` then recalled from a different session.** |
| `POST /recall` | `{context, citations}`, respect `max_tokens`, priority logic, **empty (200) on cold** | ✅ | [`app.ts:125`](src/app.ts:125) — always 200; wide gather → LLM rerank/compact → budget guard ([`pipeline/recall.ts`](src/pipeline/recall.ts)); cold-session empty-recall test. **Clean-room: named Berlin + the NYC move with citations.** |
| `POST /search` | structured `{results[]}` (content/score/session_id/timestamp/metadata) | ✅ | [`app.ts:149`](src/app.ts:149) → [`store.search`](src/store.ts) |
| `GET /users/{id}/memories` | structured, typed memories (not raw text) | ✅ | [`app.ts:174`](src/app.ts:174) — id/type/key/value/confidence/provenance/supersedes/active **+ `contradicts[]`** extension. **Clean-room: 3 typed memories (event/fact/opinion), not raw text.** |
| `DELETE /sessions/{id}` | delete session data, `204` | ✅ | [`app.ts:201`](src/app.ts:201) → [`store.deleteSession`](src/store.ts:468) (scoped to `session_id`) |
| `DELETE /users/{id}` | delete user data, `204` | ✅ | [`app.ts:206`](src/app.ts:206) → [`store.deleteUser`](src/store.ts:480) (scoped via `IS NOT DISTINCT FROM`, null-safe) |
| (extension) `GET /metrics` | "you may add more endpoints" | ✅ | [`app.ts:72`](src/app.ts:72) — cumulative token/call counters |

Multi-message turns incl. `tool` role are accepted (messages mapped with
`name` at [`app.ts:80`](src/app.ts:80)).

---

## §4 — The Hard Problems

**Fact evolution & contradiction handling** ✅ — Per-fact reconciliation emits
`ADD | UPDATE | REINFORCE | CONTRADICT | NOOP` ([`pipeline/ingest.ts`](src/pipeline/ingest.ts),
README §5). Same-topic detection via semantic search; **single-valued neutral
progression → supersession** (old row `active=false`, `supersedes` chain kept);
**reversals → linked, not deleted** (both rows active + two-way `contradiction`
edge). Current fact returned by recall; history inspectable via
`/users/{id}/memories`. Covered by [`tests/evolution.test.ts`](tests/evolution.test.ts)
(Stripe→Notion supersession; oranges→apples contradiction + narration).
⚠️ **Harder variant (gradual opinion arcs):** handled as a `CONTRADICT`-linked
chain (recall narrates "previously X, now Y"); not collapsed into one modelled
trajectory — **documented as partial** (README §3/§5).

**Extraction, not just storage** ✅ — Typed `fact|preference|opinion|event` with
canonical key, self-contained context-enriched value, confidence, provenance
([`pipeline/schemas.ts`](src/pipeline/schemas.ts), README §3). Personal facts,
preferences/opinions, **corrections** (reconcile ops), and **implicit facts**
("walking Biscuit" → pet) all covered. Clean-room proof: the memories endpoint
returned structured typed rows, not message chunks.

**Context assembly under budget** ✅ — Explicit priority **(1) stable user facts
→ (2) query-relevant memories → (3) recent episodic**, defended in README §4;
deterministic line-trim guard keeps output ≤ ~2× `max_tokens`
([`pipeline/recall.ts`](src/pipeline/recall.ts)).

---

## §5 — Hard Constraints

| Constraint | Status | Evidence |
|---|---|---|
| **Persistence** survives `down && up` (named volume) | ✅ | **Clean-room: recall returned Berlin after `down`→`up`.** Restart-persistence unit test reopens a real on-disk pglite dataDir |
| **Concurrent sessions** don't bleed (unless same user, documented) | ✅ | "concurrent sessions for different users do not bleed" contract test; cross-session sharing for the same `user_id` is **intentional and documented** (README §5) |
| **Synchronous correctness** (read-after-write, no eventual consistency) | ✅ | `/turns` awaits all writes before `201` ([`app.ts:88`](src/app.ts:88)–122); README §1 "the opinion, stated plainly" |
| **Recall budget** returns in reasonable time | ⚠️ | Recall does an LLM rerank/compact (higher latency than a pure vector lookup) — an explicit, **documented** tradeoff (README §6); degrades to a deterministic assembler if the model is slow/unavailable |
| **Resilience** — no crash on malformed/oversized/unicode | ✅ | Zod → `422` ([`app.ts:76`](src/app.ts:76)); top-level `onError` → `500` ([`app.ts:63`](src/app.ts:63)); unicode round-trip + hostile-error tests ([`tests/resilience.test.ts`](tests/resilience.test.ts)) |
| **LLM usage** documented + keys in `.env.example` | ✅ | Models + rationale in README §3/§6; [`.env.example`](.env.example) lists `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, model + feature flags |

---

## §6 — Submission Format

**Required structure** ✅ — `README.md`, `CHANGELOG.md`, `docker-compose.yml`,
`Dockerfile`, `src/`, `tests/`, `fixtures/`, `.env.example` all present (see repo
tree). `.env` is git-ignored ([`.gitignore`](.gitignore)) — no secrets committed.

**README (8 required items)** ✅ — Architecture+diagram (§1) · backing store (§2)
· extraction pipeline incl. "what we miss" (§3) · recall strategy + budget
priority (§4) · fact evolution (§5) · tradeoffs (§6) · failure modes incl. no
data / slow disk / **missing keys** (§7) · how to run tests (§8).

**CHANGELOG (one entry per iteration, what/why/result+metrics)** ✅ — 7 entries:
v1 store+contract+LLM seam · v2 synchronous per-fact reconcile · v3 contradictions
linked-not-deleted · v4 offline mock + fixture · v5 live Claude wiring · v6 reason
as CoT/narration · v7 LoCoMo campaign (27→76%). Each carries observations/metrics.

---

## §7 — Testing and Self-Eval

| Required | Status | Evidence |
|---|---|---|
| Contract roundtrip | ✅ | "POST /turns → 201, memories immediately queryable" |
| Restart persistence | ✅ | "data written before restart is recallable after" (real on-disk pglite) |
| Concurrent sessions | ✅ | "concurrent sessions for different users do not bleed" |
| Malformed input → 4xx not crash | ✅ | bad JSON / missing fields / empty messages / unicode → `422` |
| Recall-quality fixture (3–5 convos + probes, X of Y) | ✅ | [`fixtures/basic.json`](fixtures/basic.json) — 4 scenarios, 9 probes; [`quality.test.ts`](tests/quality.test.ts:63) prints `passed/total` |
| Provided smoke test compatibility | ✅ | **Clean-room ran the exact §7 smoke (Berlin) — pass** |

Tests run **fully offline** against a deterministic mock LLM provider — no keys
needed (`npm test`).

---

## §8 — Setup We'll Use (clean machine)

✅ Reproduced verbatim in a fresh `git worktree` (2026-06-21):
`docker compose up -d` → `until curl -sf http://localhost:8080/health` greened in
**3 seconds**, default port **8080**, **no manual `npm install` / setup**. Keys
documented in `.env.example`; compose reads them from the environment / a `.env`
file (which the harness supplies).

➕ **Beyond spec:** on a clean machine **with no `.env`**, the service now prints
a clear, actionable error naming the missing key(s), pointing at `.env`
(`cp .env.example .env`), and offering the offline `MEMORY_LLM=mock` path, then
exits cleanly with code 1 — verified in the clean room.

---

## §9 — How It Will Be Tested (eval categories → evidence)

| Category | Where we address it |
|---|---|
| Recall quality (primary) | Wide gather + LLM rerank (README §4); LoCoMo **76%** (Haiku, full pipeline) |
| Fact evolution | Supersession + contradiction links (README §5; evolution tests) |
| Multi-hop recall | **All** stable active facts included unconditionally (README §4) |
| Noise resistance | `NOOP` reconcile filter + empty-on-cold recall (README §3/§4) |
| Extraction quality | Typed structured memories + implicit facts (README §3; memories endpoint) |
| Persistence across restarts | Named volume + on-disk pglite (clean-room verified) |
| Cross-session scoping | User-scoped sharing, session-scoped episodic — documented (README §5) |
| Robustness | `422`/`500` guards, never crash (resilience tests) |
| Correctness (read-after-write) | Synchronous `/turns` (README §1) |
| Contract compliance | All 7 endpoints, exact shapes/status codes (§3 above) |

---

## §10 / §11 / §12 — Excellent bar, Originality, Out-of-scope

- **§10 "Excellent":** structured typed memories ✅ · fact evolution ✅ · real
  recall ranking (not vanilla top-k) ✅ · explicit budget priority ✅ ·
  synchronous `/turns` ✅ · persistence ✅ · graceful degradation ✅ · tests cover
  the required matrix ✅ · CHANGELOG 4+ iterative entries ✅ · clean inspectable
  memory store ✅.
- **§11 Originality:** the design (synchronous per-fact reconciliation, linked
  contradictions, wide-pool LLM rerank over pglite) is our own — **not** mem0's
  API shape or pipeline. The `mem0-chroma` build in this repo is a clearly-labelled
  *external baseline for comparison*, kept separate precisely to avoid blurring
  the line.
- **§12 Out-of-scope:** no agent code, no UI, single-user/few-session assumptions
  — not over-built.

---

## Honest gaps & notes (for the interview)

1. **Recall latency.** LLM rerank/compaction makes `/recall` slower than a raw
   vector lookup. Deliberate quality tradeoff (README §6); deterministic fallback
   exists. Would optimize with a smaller rerank model / caching if latency-bound.
2. **Per-fact LLM cost.** One extraction + one reconciliation call **per fact**.
   Comfortable inside the 60s `/turns` budget; would batch reconciliation at very
   high fact volume (README §3).
3. **Code default model.** [`config.ts:29`](src/config.ts:29) defaults
   `llmModel` to `claude-opus-4-8` if `MEMORY_LLM_MODEL` is unset, while
   `docker-compose.yml` / `.env.example` set **Haiku 4.5** (the delivery default).
   In any Docker/`.env` run the env wins, so the shipped default is Haiku; the
   bare-`npm start`-with-no-env path is the only one that would pick Opus. Minor —
   flagged for alignment.
4. **Opinion-arc modelling** is a linked chain, not a single trajectory object
   (documented partial, README §3/§5).
5. **Prompt-injection** in ingested turns is explicitly out of scope, with the
   intended guard-agent design sketched (README §7).

## Clean-room validation log (2026-06-21)

Fresh `git worktree` at the shipped commit, `docker compose` from a clean checkout:
- Image built from the standalone build context — **tsx present in the production
  image** (the prior delivery bug is fixed; `tsx` is in `dependencies`).
- **No `.env`** → clear missing-key error + exit 1; service not serving. ✅
- **With `.env`** → healthy in 3s on :8080. ✅
- Assignment smoke: `/turns` → `201`; `/recall` (different session) → "currently
  in Berlin … moved from New York City in February 2025" + citation; memories →
  3 typed rows. ✅
- `down` (keep volume) → `up` → recall still returns Berlin. **Persistence.** ✅
- `down -v` + worktree removed — no residue.
