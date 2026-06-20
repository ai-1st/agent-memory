# Implementations

Three independent explorations of the memory service, each in its own folder, each
a **self-contained, docker-deployable** service implementing the full assignment
contract. They are benchmarked against the root **baseline / control** (the
TypeScript + better-sqlite3 + rule-based service at the repo root) using the
HTTP harness in [`../bench`](../bench).

| Folder | Design | Dev/bench port |
|--------|--------|----------------|
| [`opinionated/`](opinionated) | A strong point of view, executed (see its README). | 8091 |
| [`simple/`](simple) | Minimal moving parts; readable & inspectable. | 8092 |
| [`maxxed/`](maxxed) | Kitchen-sink: cover every category. | 8093 |

> Root (`/`) is the baseline control on port **8080**.

## Shared contract (all folders must satisfy)

- Implement the **exact HTTP contract** in [`../ASSIGNMENT.md`](../ASSIGNMENT.md) §3:
  `GET /health`, `POST /turns`, `POST /recall`, `POST /search`,
  `GET /users/:user_id/memories`, `DELETE /sessions/:session_id`,
  `DELETE /users/:user_id`. Same request/response shapes and status codes as the
  root baseline (use it as the reference for shapes).
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
- Reference implementation (shapes, store seam, recall assembly): repo root `src/`
- Memory-system ADRs & technique shortlist: [`../docs/research/approaches`](../docs/research/approaches)
- Benchmark survey & recommendations: [`../docs/research/benchmarks`](../docs/research/benchmarks)
