# Microsoft Semantic Kernel memory (+ Kernel Memory)

## Overview
Microsoft Semantic Kernel (SK) is an LLM orchestration SDK. Its memory story is essentially **RAG plumbing**: a unified **Vector Store** abstraction (`VectorStoreCollection`) over many backends, plus the older `ISemanticTextMemory` / `TextMemoryPlugin` (now deprecated in favor of the new vector-store architecture). A sibling project, **Kernel Memory**, is a more complete service that handles ingestion, chunking, embedding, and retrieval (RAG) with citations. Neither does conversational *fact extraction* or *fact evolution* out of the box — they are storage/retrieval substrates you build on.

- **SK repo:** https://github.com/microsoft/semantic-kernel · **Kernel Memory:** https://github.com/microsoft/kernel-memory
- **Migration (vector store, 2025):** https://learn.microsoft.com/semantic-kernel/support/migration/vectorstore-may-2025
- **License:** MIT
- **Maturity:** High (well-engineered, Microsoft-backed) — but as an abstraction layer, not an opinionated memory system.

## Architecture
```
SK Vector Store abstraction
   ├── connectors: Postgres/pgvector, Azure AI Search, Qdrant, Redis,
   │               Weaviate, SQLite, in-memory, ...
   └── record collection API (upsert / get / vector search / filter)

Kernel Memory (separate service):
   ingest doc ──► chunk ──► embed ──► store ──► ask() with citations
```
- 2025 changes consolidated/renamed the vector APIs (`*Collection`, `EnsureCollectionExistsAsync`, etc.) and deprecated the legacy `memory_stores` / `ISemanticTextMemory` path.

## Extraction strategy
- **None built-in for conversation facts.** SK gives you embeddings + storage; you supply any extraction logic. Kernel Memory does document chunking, not structured fact extraction or contradiction handling.

## Backing store(s)
- Broad connector set via the Vector Store abstraction (pgvector, Azure AI Search, Qdrant, Redis, Weaviate, Mongo, SQLite, in-memory, etc.).

## Recall / retrieval pipeline
- Vector similarity search with metadata filtering; Kernel Memory adds RAG-style `ask` with citations. No reranking/graph/multi-hop by default.

## Contradiction / fact-evolution / temporal handling
- Not addressed. Upsert overwrites by key; no supersession ledger, no temporal model.

---

## ADR 1 — Provider-agnostic vector-store abstraction
- **Status:** Accepted (borrow the design principle)
- **Context:** We shouldn't hard-couple to one vector DB; needs may change (pgvector for simplicity now, Qdrant/Azure later).
- **Decision:** Define a thin internal store interface (upsert/get/search/filter, namespaced by user/session) and implement it once per backend, defaulting to pgvector for an all-in-one Postgres footprint.
- **Consequences:** (+) Portability, easy testing with an in-memory impl, single-DB ops with pgvector. (−) Lowest-common-denominator API can hide backend-specific features (e.g., native hybrid search).

---

## Relevance to our contract
- **Borrow:** the pluggable vector-store interface, and the **pgvector-in-Postgres** option so facts, history, and embeddings live in one relational DB (simplifies bi-temporal supersession + structured GET /memories).
- **Avoid:** expecting SK/Kernel Memory to provide extraction or fact-evolution — those are exactly the hard parts we must build ourselves. Treat SK only as a storage/retrieval layer reference.
