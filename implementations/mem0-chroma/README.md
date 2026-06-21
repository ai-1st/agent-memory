# mem0 + Chroma — a vanilla baseline for stack-ranking

A thin HTTP wrapper around the **off-the-shelf [`mem0`](https://github.com/mem0ai/mem0)
pipeline** with a **Chroma** vector store, exposed on the same contract our bench
harness drives, so it can be scored on the **same benchmarks** as our own builds
(`opinionated`, `simple`, `maxxed`, `baseline`). This is a reference point, not one
of our designs — its memory logic (extraction prompts, fact-update decisions,
retrieval) is entirely mem0's.

## What's "vanilla" and what's configured

The **pipeline is 100% mem0**. The only choices we make are the *backends*, picked
to match our builds so the comparison isolates the **memory pipeline, not the model**:

| component | choice | why |
|---|---|---|
| vector store | **Chroma** (local, persistent) | proper metadata-filtered ANN |
| LLM | **Claude Haiku 4.5** (`mem0` `anthropic` provider) | the exact model our builds default to |
| embeddings | **OpenAI `text-embedding-3-large`** (3072-dim) | identical to our builds |

### Why Chroma, not FAISS

We first tried mem0's FAISS provider and it scored ~0% across the board. The cause
was **not** mem0's pipeline but the **FAISS-flat store**: it can't truly delete, so
mem0's reconcile UPDATE/DELETE churn leaves dead vectors that its user-filtered
search then drops — we measured **29 stored facts → only 19 retrievable**, and at
LoCoMo scale **100 → 6**. Recall saw a fraction of memory, so answers were missing.
Chroma does proper filtered ANN (same test: **29 stored → 29 retrieved**), so this
build measures mem0's *pipeline*, not a broken vector store.

One compatibility shim, no pipeline change: mem0's Anthropic wrapper sends
`temperature`+`top_p` together, which Claude 4.x rejects — we strip `top_p` at the
client boundary (`src/app.py`). All memory ops are serialized with one lock (the
bench ingests concurrently).

## Contract mapping

| endpoint | mem0 call |
|---|---|
| `POST /turns` | `mem.add(messages, user_id)` — mem0 extracts + reconciles |
| `POST /recall` | `mem.search(query, user_id)` → formatted context block (budget-bounded) |
| `POST /search` | `mem.search(...)` → structured results |
| `GET /users/{id}/memories` | `mem.get_all(user_id)` |
| `DELETE /users/{id}` | `mem.delete_all(user_id)` |
| `DELETE /sessions/{id}` | no-op — vanilla mem0 scopes by **user**, not session |
| `GET /metrics` | zeros — mem0 doesn't surface token counters (cost untracked) |

## Run it

```bash
python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt
./run.sh                      # serves on :8095 (keys from repo-root .env)
# or Docker:
docker compose up --build     # serves on :8080
```

Bench it (same adapters/judge as our builds):
```bash
bash run-suite.sh             # full suite, fresh server per adapter
# or one adapter:
npx tsx bench/suite/run.ts --adapter locomo --url http://localhost:8095 --label mem0-chroma --limit 100
```

## Results

_Populated by the suite run — full stack-rank vs our builds in the root
[`docs/BENCHMARKS.md`](../../docs/BENCHMARKS.md)._

## Known limitations (by design — it's a baseline)

- **No date-anchoring.** mem0 doesn't receive the turn timestamp, so relative dates
  are lost or guessed against *today* — a big chunk of LoCoMo/longmemeval's temporal set.
- **User-scoped only**; no session deletion, no supersession chain in the contract shape.
- **Cost untracked** (zeros on `/metrics`).
