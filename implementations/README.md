# Implementations — supporting builds

> **The shipped deliverable is the `opinionated` build, which now lives at the
> repo root** (`/README.md`, `/src`, `/docker-compose.yml`). This folder holds the
> **supporting builds** kept for the benchmark comparison — they are *not* the
> submission. Each is a self-contained, docker-deployable service on the same
> contract, scored by the HTTP harness in [`../bench`](../bench). See the
> cross-build stack-rank in [`../docs/BENCHMARKS.md`](../docs/BENCHMARKS.md).

| Folder | Role | Design | Dev/bench port |
|--------|------|--------|----------------|
| [`baseline/`](baseline) | control | No-LLM floor: TypeScript + better-sqlite3 + rule-based extraction + lexical recall. | 8080 |
| [`simple/`](simple) | exploration | Minimal moving parts; readable & inspectable. | 8092 |
| [`maxxed/`](maxxed) | exploration | Kitchen-sink: cover every category. | 8093 |
| [`mem0-chroma/`](mem0-chroma) | external baseline | Vanilla [mem0](https://github.com/mem0ai/mem0) + Chroma (Python), for stack-ranking against our own designs. | 8095 |

> The deliverable (`opinionated`) runs from the repo root on port **8080** via
> `docker compose up`; the baseline control also targets 8080, so run them one at
> a time (or override the host port).

## Shared contract (all folders must satisfy)

- Implement the **exact HTTP contract** in [`../ASSIGNMENT.md`](../ASSIGNMENT.md) §3:
  `GET /health`, `POST /turns`, `POST /recall`, `POST /search`,
  `GET /users/:user_id/memories`, `DELETE /sessions/:session_id`,
  `DELETE /users/:user_id`. Same request/response shapes and status codes as the
  repo-root deliverable (use it as the reference for shapes).
- **`docker compose up`** is the only setup step. Default container port **8080**
  (host port may be overridden via env for parallel runs). Persist across
  `docker compose down && up` via a named volume.
- Synchronous correctness: after `POST /turns` returns, extracted memories are
  immediately queryable. Never crash on bad input (4xx/5xx, not a crash).

## Shared stack

- **Runtime:** TypeScript + Node 22. HTTP via **Hono** (match the baseline for
  contract parity).
- **Store:** **pglite** (`@electric-sql/pglite`) — embedded Postgres — with its
  `vector` extension (`@electric-sql/pglite/vector`) for semantic search.
  Persist via pglite `dataDir` on the Docker volume.
- **LLM + embeddings:** **Vercel AI SDK** (`ai`, `@ai-sdk/openai`,
  `@ai-sdk/anthropic`).
  - Embeddings: OpenAI **`text-embedding-3-large`** (3072-dim) via `embed`/`embedMany`.
  - LLM: Claude **Opus 4.8** (`claude-opus-4-8`) via `@ai-sdk/anthropic`.
  - **Structured outputs:** use `generateObject` with a Zod schema everywhere the
    spec calls for structured extraction/decisions.
- **Cost:** do **not** optimize for LLM cost or latency yet — chase quality first.
- **Toolchain:** Biome (lint+format), Vitest (tests), tsx (run TS, no build step).

## Engineering conventions

- **LLM layer must be injectable** so the contract/unit tests run **offline** with
  a mock provider (no network in CI). Add a separate, opt-in live smoke that uses
  real keys for an end-to-end check.
- **Keys:** the repo-root `.env` (gitignored) holds `OPENAI_API_KEY` and
  `ANTHROPIC_API_KEY`. For live testing, load them, e.g.
  `set -a; . ../../.env; set +a`. Each folder ships its own `.env.example`.
- **Required files per folder:** `README.md` (with the §6 sections: architecture,
  backing store, extraction, recall, fact evolution, tradeoffs, failure modes,
  how to run tests), `CHANGELOG.md` (≥1 entry, the design story), `Dockerfile`,
  `docker-compose.yml`, `package.json`, `tsconfig.json`, `src/`, `tests/`,
  `fixtures/` (incl. design-specific quality fixtures), `.env.example`,
  `.gitignore` (node_modules, .env, data, dist).
- **npm scripts:** `start`, `test`, `lint`, `typecheck`; optional `bench`, `smoke`.
- The root harness ([`../bench/harness.ts`](../bench/harness.ts)) targets any base
  URL, so it can score each service: `MEMORY_BASE=http://localhost:8091 npm run bench`.

## References

- Full assignment: [`../ASSIGNMENT.md`](../ASSIGNMENT.md)
- Reference implementation / deliverable (shapes, store seam, recall assembly): repo root `src/` (the `opinionated` build)
- Memory-system ADRs & technique shortlist: [`../docs/research/approaches`](../docs/research/approaches)
- Benchmark survey & recommendations: [`../docs/research/benchmarks`](../docs/research/benchmarks)
