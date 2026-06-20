# mem0

## Overview
mem0 is a production-oriented, open-source memory layer for AI agents. Its core idea: after each conversation turn, an LLM **extracts salient facts** from the messages, then a second LLM step **reconciles** those facts against existing memory by emitting one of four operations — ADD / UPDATE / DELETE / NOOP. It ships as a pip/npm library, a self-hostable Docker server, and a managed cloud. A graph variant (`mem0g`) additionally stores entity/relation triples. This is the single closest analog to the contract we are building (turn ingest → extraction → reconciliation → recall).

- **Repo:** https://github.com/mem0ai/mem0
- **Paper:** "Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory" — https://arxiv.org/abs/2504.19413
- **License:** Apache 2.0
- **Maturity:** High — widely adopted, active, hosted product, benchmarked (LOCOMO).

## Architecture
```
turn messages[] ──► EXTRACT (LLM: "what facts here?")
                        │  candidate facts
                        ▼
                    SEARCH existing memories (semantic top-k)
                        │  facts + related existing memories
                        ▼
                    RECONCILE (LLM tool-call): ADD | UPDATE | DELETE | NOOP
                        │
            ┌───────────┴────────────┐
            ▼                         ▼
       vector store              (mem0g) graph store
       (text + embedding)        entities + relation triples
```
- **Two-phase pipeline:** extraction phase, then update/consolidation phase. Recall is a separate read path.
- `mem0g` adds a graph layer for relational/multi-hop reasoning; the paper found it wins on temporal reasoning but is ~3x slower and ~2x the tokens, and is *worse* on single-/multi-hop in their benchmark — i.e. graph is not a free win.
- Note on evolution: recent mem0 (v3) reportedly moved toward **single-pass ADD-only** extraction (accumulate, don't overwrite) for latency/cost; the classic v1/v2 ADD/UPDATE/DELETE/NOOP design below is the one most relevant to our fact-evolution requirement.

## Extraction strategy
- **Pure LLM, two calls.** Call 1: extract candidate facts from the new turn (plus a rolling summary / recent messages for context). Call 2: given each candidate + semantically-retrieved existing memories, decide ADD/UPDATE/DELETE/NOOP via a structured tool call.
- Captures implicit facts and corrections because the reconcile step *sees the old memory* and can decide "this updates that."
- `mem0g`: a separate LLM pass turns the turn into `(entity, relation, entity)` triples; conflicting triples are detected and resolved on insert.

## Backing store(s)
- **Vector DB** for facts (Qdrant default; pluggable: pgvector, Chroma, Weaviate, etc.).
- **History DB** (SQLite/relational) records every ADD/UPDATE/DELETE so prior values are auditable.
- **Graph DB** (Neo4j / Memgraph / Kùzu) only for `mem0g`.
- Default LLM GPT-4o-mini; default embeddings `text-embedding-3-small`.

## Recall / retrieval pipeline
- Default: semantic top-k over the vector store, scoped by `user_id` / `agent_id` / `run_id` (session).
- Hosted/newer path: **multi-signal fusion** — semantic + BM25 keyword + entity linking, with temporal weighting.
- No built-in reranker by default; multi-hop relies on `mem0g` graph traversal.

## Contradiction / fact-evolution / temporal handling
- The **UPDATE** op rewrites a memory in place; **DELETE** marks contradicted facts removed; the **history DB** preserves the prior text so you can reconstruct the timeline.
- This is *logical* supersession (old row updated/deleted, history kept separately) rather than Zep-style bi-temporal validity intervals on the live record.

---

## ADR 1 — LLM reconciliation as ADD/UPDATE/DELETE/NOOP tool call
- **Status:** Accepted (borrow)
- **Context:** New turns contain facts that may be new, refinements, or contradictions of what we already store. Naively appending creates duplicates and stale/contradictory memories.
- **Decision:** After extracting candidate facts, retrieve semantically-related existing memories and have an LLM emit a structured operation per candidate: ADD (new), UPDATE (supersede/refine), DELETE (contradicted), NOOP (already known/noise).
- **Consequences:** (+) Directly solves dedup, correction, and contradiction in one defensible step; maps cleanly onto our `supersedes`/`active` columns. (+) NOOP is our noise filter. (−) Two LLM calls per turn → latency/cost on the synchronous POST /turns path. (−) Quality depends on the candidate-retrieval recall: if the relevant old memory isn't retrieved, the model wrongly ADDs a duplicate.

## ADR 2 — Graph layer is optional, not the spine
- **Status:** Accepted (borrow the caution)
- **Context:** Graph memory is fashionable, but mem0's own benchmark shows `mem0g` is slower, costlier, and not uniformly better.
- **Decision:** Keep the primary store a vector+relational design; treat graph/entity-linking as an *additive* signal for multi-hop, not the default substrate.
- **Consequences:** (+) Lower latency/cost on the hot path; simpler to operate. (−) Pure-vector multi-hop is weaker — we may need a query-decomposition or entity-linking add-on for hard multi-hop cases (see HippoRAG, A-MEM).

---

## Relevance to our contract
- **Borrow:** the extract→retrieve→reconcile loop is essentially our POST /turns. ADD/UPDATE/DELETE/NOOP maps to `active`/`supersedes`. The separate history DB matches "keep history, return current." Per-user/session/run scoping matches our cross-session scoping requirement.
- **Borrow:** NOOP as an explicit noise-resistance mechanism.
- **Avoid / watch:** two synchronous LLM calls may blow our latency budget — consider caching candidate retrieval, batching, or smaller models. Don't adopt the graph store as default. The v3 ADD-only direction trades away in-place correction — not acceptable for our fact-evolution requirement, so prefer the reconcile design.
