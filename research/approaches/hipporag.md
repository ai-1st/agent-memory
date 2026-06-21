# HippoRAG & HippoRAG 2

## Overview
HippoRAG (NeurIPS 2024, OSU NLP) is a retrieval framework inspired by the **hippocampal indexing theory** of human memory. It builds an open knowledge graph from a corpus, then at query time runs **Personalized PageRank (PPR)** seeded by query-relevant entities to retrieve passages that are *associatively* connected — giving strong multi-hop retrieval in a single graph search instead of iterative LLM hops. **HippoRAG 2** (2025) improves factual recall, sense-making, and associative memory, integrating passages more tightly and using the LLM more effectively online; it beats strong embedding models notably on associative tasks.

- **Repo:** https://github.com/OSU-NLP-Group/HippoRAG
- **Papers:** HippoRAG https://arxiv.org/abs/2405.14831 · "From RAG to Memory" (HippoRAG 2) https://arxiv.org/abs/2502.14802
- **License:** open source (MIT, verify)
- **Maturity:** Medium — influential research with usable code; not a turnkey memory service.

## Architecture
```
OFFLINE INDEX:
corpus ──► LLM OpenIE (entities + triples) ──► knowledge graph
           passages linked to their entities; synonym edges added

ONLINE QUERY:
query ──► extract query entities ──► map to KG nodes (seeds)
       ──► Personalized PageRank over KG (weighted by seeds)
       ──► node scores propagate to passages ──► top passages
```
- The KG is the "hippocampal index"; the LLM is the "neocortex"; an encoder is the "parahippocampal region" that links synonyms.
- HippoRAG 2 adds tighter passage integration and better online LLM use for filtering/ranking.

## Extraction strategy
- **LLM OpenIE** at index time: extract entities and `(subject, relation, object)` triples from each passage to build the graph; synonym/embedding edges connect near-duplicate entities.

## Backing store(s)
- A graph (entities + triples) + passage store + embeddings for entity/synonym linking. PPR runs over the graph.

## Recall / retrieval pipeline
- **Single-shot multi-hop via PPR.** Instead of iterative retrieve-read loops, one PPR run from the query's seed entities surfaces multi-hop-connected evidence — fast and effective for associative/multi-hop questions.

## Contradiction / fact-evolution / temporal handling
- Not its focus. HippoRAG is about *retrieval* quality over a (largely static) corpus; it has no first-class supersession or temporal model. Continual integration of new docs is supported, but contradiction resolution is not the contribution.

---

## ADR 1 — Personalized PageRank for single-pass multi-hop retrieval
- **Status:** Considered (borrow if multi-hop is a priority)
- **Context:** Our requirement (4) is multi-hop recall. Iterative LLM-driven multi-hop is slow/expensive; pure vector kNN misses chained relations.
- **Decision:** If/when we build an entity graph over memories, use PPR seeded by the query's entities to retrieve associatively-linked memories in one pass.
- **Consequences:** (+) Strong, cheap multi-hop without iterative LLM calls — directly serves requirement (4). (+) Deterministic and explainable (graph paths). (−) Requires building/maintaining an entity graph (index-time OpenIE) — real cost; overkill if most queries are single-hop. (−) PPR tuning (damping, seed weighting) needs care.

---

## Relevance to our contract
- **Borrow (conditionally):** PPR is the most principled multi-hop technique surveyed; adopt it *only if* we commit to an entity graph (e.g., the mem0g/A-MEM link layer). It pairs well with A-MEM's lightweight links.
- **Avoid:** treating HippoRAG as a full memory system — it has no extraction-to-structured-memory or fact-evolution story. It's a retrieval module, not a contract-level solution.
