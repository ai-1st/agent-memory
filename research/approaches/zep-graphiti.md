# Zep / Graphiti (temporal knowledge graph)

## Overview
Graphiti is an open-source **temporally-aware knowledge graph** engine for agent memory; Zep is the commercial product built on it. The defining feature is a **bi-temporal model**: every fact (graph edge) carries both *valid time* (when the fact is true in the world) and *transaction/ingestion time* (when the system learned it). When new information contradicts an old edge, the old edge is **invalidated, not deleted** — it gets a `t_invalid` timestamp so history is preserved and you can query "what did we believe as of date X." This is the most rigorous answer to our fact-evolution / temporal requirement.

- **Graphiti repo:** https://github.com/getzep/graphiti
- **Zep paper:** "Zep: A Temporal Knowledge Graph Architecture for Agent Memory" — https://arxiv.org/abs/2501.13956
- **License:** Graphiti is Apache 2.0 (open source); Zep is a hosted commercial service.
- **Maturity:** High — 20k+ stars, production users; paper reports beating MemGPT on the DMR benchmark.

## Architecture
```
turn / episode ──► LLM entity+relation extraction ──► candidate edges
                                                          │
                            resolve entities (embedding + name match)
                                                          │
        semantic + BM25 + graph search for CONFLICTING existing edges
                                                          │
              ┌───── new edge ADD with t_valid           │
              └───── conflicting edge → set t_invalid (invalidate, keep)
                                                          │
                          three-tier graph:
                          episodes (raw) → entities → communities (summaries)
```
- **Three tiers:** episode subgraph (raw messages/events), semantic entity subgraph (extracted facts/edges), and community subgraph (clustered higher-level summaries — similar in spirit to RAPTOR).
- Backed by **Neo4j** (also FalkorDB / other graph backends) plus embeddings for hybrid search.

## Extraction strategy
- LLM extracts **entities and relationships** from each episode (turn or document) into typed nodes and edges with attributes.
- Edges carry `t_valid` / `t_invalid` (valid time) and `created_at` / `expired_at` (transaction time) — bi-temporal.
- Entity resolution dedupes nodes (embedding + name similarity) so the same person/thing isn't fragmented.
- Communities are periodically (re)summarized via label-propagation clustering.

## Backing store(s)
- Graph database (Neo4j default; FalkorDB, Kùzu, others) holding nodes/edges + their embeddings.
- Hybrid indexes: vector index for semantic, full-text for BM25, graph for traversal.

## Recall / retrieval pipeline
- **Hybrid search**: cosine semantic similarity + BM25 keyword + **graph distance / breadth-first** from relevant nodes, with a reranking step (e.g. RRF / cross-encoder / MMR options).
- Multi-hop is native (graph traversal between entities).
- Temporal filters: queries can be scoped to a point in time using validity intervals.

## Contradiction / fact-evolution / temporal handling
- **The reference design.** New edge that contradicts an existing one triggers **edge invalidation**: old edge gets `t_invalid` set; it stays in the graph. Current state = edges with no `t_invalid`. History = all edges. Point-in-time = filter on valid interval.
- Distinguishes "the fact stopped being true on date X" (valid time) from "we learned it was false on date Y" (transaction time) — strictly more expressive than a single `updated_at`.

---

## ADR 1 — Bi-temporal validity intervals on facts
- **Status:** Accepted (borrow, adapted)
- **Context:** Our memories have `supersedes`, `active`, `created/updated`. We must return *current* facts, keep history, and ideally answer "what was true then."
- **Decision:** Store `valid_from` / `valid_to` (valid time) in addition to `created_at` / `updated_at` (transaction time) on each memory. "Active" = `valid_to IS NULL`. Supersession sets the old row's `valid_to` instead of deleting it.
- **Consequences:** (+) Clean history + current view + point-in-time queries from one table; superior contradiction semantics. (+) Maps directly to `active` + `supersedes`. (−) More columns and write logic; most apps never query point-in-time, so it can be partly aspirational. (−) Requires extraction to estimate *when* a fact became true (often "now"), which is approximate.

## ADR 2 — Hybrid (semantic + BM25 + graph) retrieval with reranking
- **Status:** Accepted (borrow the first two; graph optional)
- **Context:** Pure vector search misses exact-match terms (names, IDs) and multi-hop relations.
- **Decision:** Combine semantic + BM25, fuse with RRF, optionally rerank; add graph traversal where multi-hop is needed.
- **Consequences:** (+) Big recall/precision gains, especially on names and noisy queries; (+) directly improves our POST /search and /recall. (−) Graph adds Neo4j ops burden — defer it.

## ADR 3 — Community/cluster summaries as a retrieval tier
- **Status:** Considered
- **Context:** Many small facts are hard to assemble into coherent context under a token budget.
- **Decision:** Periodically cluster related memories and store LLM summaries as higher-level "community" nodes that can be retrieved instead of dozens of leaves.
- **Consequences:** (+) Token-efficient context assembly; good for /recall budget. (−) Background compute; summaries can drift stale; adds a maintenance job.

---

## Relevance to our contract
- **Borrow:** bi-temporal validity → our `active`/`supersedes` done right (invalidate, never delete). This is the model to copy for fact evolution.
- **Borrow:** hybrid semantic+BM25 retrieval with RRF for /search and /recall; community summaries for budgeted context assembly.
- **Avoid for our scope (initially):** the full graph DB spine. We can get bi-temporal semantics in plain Postgres rows; reserve graph traversal for if/when multi-hop proves to need it. Running Neo4j is real operational cost.
