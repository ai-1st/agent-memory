# LangMem (LangChain)

## Overview
LangMem is LangChain's open-source SDK (released early 2025) for giving LangGraph agents long-term memory. It cleanly separates three **memory types** — **semantic** (facts/preferences), **episodic** (past interactions/examples), and **procedural** (behavior rules, stored as updated prompt instructions). Its extraction is **schema-based**: you define Pydantic schemas and the SDK uses an LLM to fill them, optionally with an in-loop store manager that handles consolidation. It's a library over a pluggable `BaseStore`, not a hosted service.

- **Repo / docs:** https://github.com/langchain-ai/langmem · https://langchain-ai.github.io/langmem/
- **Launch post:** https://www.langchain.com/blog/langmem-sdk-launch
- **License:** MIT
- **Maturity:** Medium-High — backed by LangChain, decent adoption; SDK rather than a standalone server.

## Architecture
```
conversation ──► MemoryManager (stateless extract → schema objects)
                       │
              MemoryStoreManager (extract + reconcile + persist)
                       │
                 BaseStore (pluggable: in-mem, Postgres, vector DBs)
                       │
     semantic facts | episodic examples | procedural prompt-rules
```
- Two extraction modes: **active** (in the hot path) or **background/subconscious** (after the turn).
- Procedural memory = the SDK rewrites the agent's *system prompt* from successful/failed episodes.

## Extraction strategy
- **Schema-driven LLM extraction.** Caller supplies typed schemas; LLM emits structured objects. Store manager can search existing memories and update/merge (reconciliation similar to mem0).
- Episodic extraction captures few-shot examples of good behavior; procedural extraction distills rules into prompt text.

## Backing store(s)
- Pluggable `BaseStore`: in-memory, Postgres, vector stores, key-value. Embeddings configurable.

## Recall / retrieval pipeline
- Semantic search over the store, namespaced per user/agent. Episodic memories retrieved as exemplars; procedural memories injected into the prompt directly (always-on).

## Contradiction / fact-evolution / temporal handling
- Reconciliation in the store manager can update/merge existing memories on extract (mem0-like), but there's no bi-temporal model; supersession is "update the record." History depends on the chosen store.

---

## ADR 1 — Explicit memory-type taxonomy (semantic / episodic / procedural)
- **Status:** Accepted (partially — maps to our enum)
- **Context:** Our types are `{fact, preference, opinion, event}`. LangMem's taxonomy clarifies *how each type is used*: facts/prefs are retrieved as context; events are episodic; "procedural" (how to behave) is a distinct, always-injected category.
- **Decision:** Keep our four types, but treat them with type-specific recall policy: facts/preferences ranked into context; events used for episodic/temporal queries; consider a lightweight "procedural/instruction" notion injected always-on (like Letta core).
- **Consequences:** (+) Type-aware priority logic = more defensible /recall ranking. (−) Per-type policy adds branching in context assembly.

## ADR 2 — Schema-based extraction with active vs. background modes
- **Status:** Accepted (borrow)
- **Context:** POST /turns is synchronous and latency-bound, but we also want high-quality extraction.
- **Decision:** Do fast, schema-constrained extraction synchronously on /turns; optionally run heavier consolidation/summarization in the background ("subconscious"), like Letta sleep-time.
- **Consequences:** (+) Predictable latency + good eventual quality. (−) Eventual-consistency window where a just-ingested turn isn't fully consolidated.

---

## Relevance to our contract
- **Borrow:** schema-constrained extraction (Pydantic/JSON schema → our typed memory rows) and the active/background split for the latency budget. The type taxonomy sharpens our recall priority logic.
- **Avoid:** procedural "rewrite the system prompt" memory — out of scope for a memory *service* that returns context rather than mutating a client agent's prompt. Don't couple to LangGraph.
