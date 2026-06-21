# mem0 + FAISS — a vanilla baseline for stack-ranking

A thin HTTP wrapper around the **off-the-shelf [`mem0`](https://github.com/mem0ai/mem0)
pipeline** with a **FAISS** vector store, exposed on the same contract our bench
harness drives, so it can be scored on the **same LoCoMo benchmark** as our own
builds (`opinionated`, `simple`, `maxxed`, `baseline`). This is a reference point,
not one of our designs — its memory logic (extraction prompts, fact-update
decisions, retrieval) is entirely mem0's.

## What's "vanilla" and what's configured

The **pipeline is 100% mem0**. The only choices we make are the *backends*, picked
to match our builds so the comparison isolates the **memory pipeline, not the model**:

| component | choice | why |
|---|---|---|
| vector store | **FAISS** (local, on a Docker volume) | as requested; mem0's built-in FAISS provider |
| LLM | **Claude Haiku 4.5** (`mem0` `anthropic` provider) | the exact model our builds default to |
| embeddings | **OpenAI `text-embedding-3-large`** (3072-dim) | identical to our builds |

Two compatibility shims, neither of which touches mem0's memory logic:
- **`top_p` strip.** mem0's Anthropic wrapper sends `temperature` *and* `top_p`;
  Claude 4.x rejects both together, so we drop `top_p` at the client boundary (the
  same provider quirk our TS builds handle).
- **Single lock.** FAISS + mem0's in-place index isn't safe under the bench's
  concurrent ingestion, so all memory ops are serialized (`src/app.py`).

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
# local (uses the repo-root .env for keys)
python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt
./run.sh                 # serves on :8095

# or Docker
docker compose up --build    # serves on :8080
```

Bench it on LoCoMo (same adapter/judge as our builds):
```bash
npx tsx bench/suite/run.ts --adapter locomo --url http://localhost:8095 --label mem0-faiss --limit 100
```

## Results (Haiku, Opus judge, same N as our builds)

Across the whole suite, mem0+FAISS **never beats our no-LLM baseline** and trails
every LLM build (`bash run-suite.sh` reproduces it):

| benchmark | mem0+FAISS | our best build |
|---|---|---|
| custom | **42%** | 100% |
| ruler-niah | **37%** | 100% |
| adversarial | **20%** | 80% |
| longmemeval | **0%** | 78% |
| contradiction | **0%** | 100% |
| locomo | **0%** | 76% |

Best on `custom` (clean explicit facts mem0 keeps intact); collapses on temporal /
fact-evolution / multi-session. Full framing + the per-build table in
[`docs/BENCHMARKS.md`](../../docs/BENCHMARKS.md).

This is a *fair* number, not a broken integration — retrieval was fixed (cosine +
fetch-width; see below) so recall returns substantive query-specific context (~66
tok/recall). It still scores ~0% on **our strict judge** because vanilla mem0 stores
**terse, date-less** facts ("attended the support group" with no *when*; "continuing
her education" instead of "wants to work in counseling") that don't contain the
specific answer the probe needs. **Caveat:** mem0's own published LoCoMo (~66%) uses
mem0's own eval harness, not our exact-answer Opus judge — so this is "vanilla mem0
on our yardstick", and the takeaway is that date-anchoring + detail-preserving
extraction + coverage (what our builds add) are exactly what move the number.

## Known limitations (by design — it's a baseline)

- **No date-anchoring.** mem0 doesn't receive the turn timestamp, so relative dates
  are lost or guessed against *today* (e.g. "moved last month" → "≈ May 2026"). This
  is precisely the gap our builds close — and a big chunk of LoCoMo's temporal set.
- **User-scoped only**; no session deletion, no supersession chain in the contract
  shape (mem0 manages updates internally).
- **Cost untracked** (zeros on `/metrics`).
