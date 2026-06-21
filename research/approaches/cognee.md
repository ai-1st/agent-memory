# Cognee

## Overview
Cognee is an open-source "AI memory" platform that turns ingested data into a **knowledge graph + vector index** via an **ECL pipeline (Extract → Cognify → Load)**, plus an ontology layer for grounding and a `memify` feedback loop that refines edge weights from rated responses. It targets broad data ingestion (38+ source types), not just chat turns, and emphasizes structured, ontology-grounded memory.

- **Repo:** https://github.com/topoteretes/cognee
- **License:** Apache 2.0 (verify; open source)
- **Maturity:** Medium-High — funded ($7.5M seed), fast-growing (reported ~500x pipeline-run growth in 2025), active.

## Architecture
```
sources (chat, docs, APIs, DBs) ──► EXTRACT (ingest raw)
                                        │
                                   COGNIFY (6-stage):
                                   classify → permissions → chunk →
                                   LLM entity/relation extraction →
                                   summarize → embed
                                        │
                                    LOAD (vector store + graph edges)
                                        │
                                   memify: rated responses → edge-weight refinement
```
- Ontology layer constrains/grounds extracted entities to known types.
- Pluggable backends (graph + vector + relational).

## Extraction strategy
- **Hybrid LLM + ontology.** LLM extracts entities and relationships during Cognify; an ontology grounds them to defined types, reducing schema drift. Generates per-chunk summaries.

## Backing store(s)
- Graph DB (Neo4j / Kùzu / others), vector DB (e.g. LanceDB, pgvector, Qdrant, Redis), and a relational metadata store — pluggable.

## Recall / retrieval pipeline
- Search over both vector index and graph; results combine semantic similarity with graph relationships. Summaries enable coarse-to-fine retrieval.
- `memify` feedback adjusts edge weights so frequently-useful paths rank higher over time.

## Contradiction / fact-evolution / temporal handling
- Primarily additive graph construction; conflict handling is weaker/less explicit than Zep's bi-temporal invalidation. Ontology grounding helps consistency but doesn't give first-class supersession.

---

## ADR 1 — Ontology/typed-schema grounding of extracted memory
- **Status:** Accepted (borrow, lightweight)
- **Context:** Free-form extraction drifts — the same concept gets stored under inconsistent keys/types, hurting dedup and supersession (you can't supersede what you can't match).
- **Decision:** Constrain extraction to our fixed type set `{fact, preference, opinion, event}` and a normalized `key` convention (e.g. canonical slugs), enforced in the extraction prompt/schema.
- **Consequences:** (+) Reliable matching → reliable dedup + supersession; cleaner GET /memories. (+) Cheap (prompt-level, no full ontology engine). (−) Rigid keys can miss nuance; need a fallback for novel facts.

## ADR 2 — Feedback-weighted retrieval (memify)
- **Status:** Considered
- **Context:** Some memories prove repeatedly useful; static similarity ignores this.
- **Decision:** Track usage/usefulness signals and let them boost ranking in /recall.
- **Consequences:** (+) Self-improving relevance over time. (−) Needs a feedback signal we may not have early; risk of feedback loops entrenching wrong memories. Defer.

---

## Relevance to our contract
- **Borrow:** typed-schema grounding (maps straight onto our enum + `key`), and per-chunk summarization for budgeted recall.
- **Avoid for our scope:** the full ECL + ontology + multi-backend stack is heavier than a chat-turn memory service needs. Cognee's strength (broad document ingestion) is largely out of scope for a conversation-turn contract.
