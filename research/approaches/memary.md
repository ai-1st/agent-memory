# Memary

## Overview
Memary is an open-source reference implementation of long-term memory for autonomous agents, from the LlamaIndex ecosystem. It stores agent inputs/responses as a **Neo4j knowledge graph**, then layers two retrieval structures on top: a **Memory Stream** that tracks all entities over time (breadth of what the user has touched) and an **Entity Knowledge Store** that groups and ranks entities (depth/importance), injecting the top-N entities into context. It's a concrete, smaller-scale take on graph-backed agent memory.

- **Repo:** https://github.com/kingjulio8238/Memary
- **License:** MIT (verify)
- **Maturity:** Low-Medium — community/reference project, not a hardened service.

## Architecture
```
turn ──► LLM entity extraction ──► Neo4j knowledge graph (responses + entities)
              │
   MEMORY STREAM: timeline of all entities seen (breadth)
   ENTITY KNOWLEDGE STORE: group + rank entities (depth) → top-N to context
              │
   KG also usable as a tool the agent searches explicitly
```

## Extraction strategy
- LLM **entity extraction** from each turn; entities + responses become graph nodes/edges. Lighter than full triple OpenIE — entity-centric.

## Backing store(s)
- Neo4j knowledge graph; vector/embedding retrieval for semantic search; LlamaIndex glue.

## Recall / retrieval pipeline
- Semantic retrieval over the graph plus **entity-frequency/recency ranking**: the Entity Knowledge Store surfaces the most-referenced entities (depth) while the Memory Stream tracks breadth. Top-N entities injected into the prompt.

## Contradiction / fact-evolution / temporal handling
- Minimal — additive graph; no first-class supersession or bi-temporal model.

---

## ADR 1 — Entity-frequency ranking (breadth vs. depth) for recall
- **Status:** Considered
- **Context:** Some entities (the user's main project, their dog) come up constantly and should be easy to recall; others are one-offs.
- **Decision:** Track per-user entity reference counts/recency; let frequently-referenced entities boost related memories in /recall ranking.
- **Consequences:** (+) Cheap personalization signal; surfaces the user's "core" topics (overlaps MemoryBank strength, Cognee memify). (−) Frequency ≠ importance (a frequent complaint isn't a preference); use as one signal, not the ranker.

---

## Relevance to our contract
- **Borrow:** entity-reference frequency as a *minor* ranking signal and as an anchor for entity-based multi-hop linking (feeds A-MEM links / HippoRAG PPR if we go graph).
- **Avoid:** adopting Neo4j as the substrate for a project this size; Memary is more a pattern to learn from than a base to build on. Its lack of fact-evolution makes it a poor fit for our core requirement.
