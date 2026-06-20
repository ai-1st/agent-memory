# RAPTOR (hierarchical summarization)

## Overview
RAPTOR (Recursive Abstractive Processing for Tree-Organized Retrieval, Stanford, ICLR 2024) is a retrieval technique, not a full memory system. It recursively **embeds → clusters → summarizes** text chunks to build a **tree of summaries** from the bottom up: leaves are raw chunks, parents are LLM summaries of their children's cluster, repeated to the root. Retrieval can pull from any level, so a query can grab a high-level summary (cheap, holistic) or drill into specific leaves. Highly relevant to our **context-budget assembly** problem.

- **Paper:** "RAPTOR" — https://arxiv.org/abs/2401.18059
- **Repo:** https://github.com/parthsarthi03/raptor
- **License:** open source (MIT, verify)
- **Maturity:** Research with adopted implementations (LlamaIndex, RAGFlow, etc.); a building block, not a service.

## Architecture
```
chunks ──► embed ──► soft cluster (GMM) ──► summarize each cluster (LLM)
   ▲                                              │
   └──────────────── recurse on summaries ────────┘  until root

retrieval:
  - "collapsed tree": search all nodes (leaves + summaries) together, OR
  - "tree traversal": descend level by level
```

## Extraction strategy
- Not memory extraction per se. The "intelligence" is recursive abstractive **summarization** — turning many chunks into fewer, higher-level nodes.

## Backing store(s)
- Vector index over all tree nodes (leaves + summaries); the tree links nodes parent↔child.

## Recall / retrieval pipeline
- Embed query; retrieve across mixed levels (collapsed-tree search usually wins). Summaries provide global context; leaves provide specifics. Big gains on multi-step reasoning QA (e.g., +20% absolute on QuALITY with GPT-4).

## Contradiction / fact-evolution / temporal handling
- None — RAPTOR is static-corpus retrieval. Re-summarization would be needed when underlying facts change; no supersession model.

---

## ADR 1 — Multi-level summaries retrievable alongside leaf memories
- **Status:** Accepted (borrow for /recall budgeting)
- **Context:** /recall has a hard `max_tokens` budget. Returning 30 atomic facts may overflow or read incoherently; a 3-line summary of them is denser and more useful.
- **Decision:** Maintain per-user (and per-topic/session) **rolled-up summaries** as first-class retrievable items. /recall can substitute a summary node for its many children when budget is tight ("collapsed-tree"-style mixed retrieval).
- **Consequences:** (+) Far better token efficiency and coherence under budget — directly serves requirement (3). (+) Pairs with reflection (Generative Agents) and communities (Zep). (−) Background summarization cost; summaries must be invalidated/regenerated when member facts are superseded (consistency burden).

---

## Relevance to our contract
- **Borrow:** hierarchical summaries as a token-budget lever in /recall — when many small memories match, swap in their summary. This is one of the cleanest answers to context assembly under a budget.
- **Avoid:** building the full recursive tree over *all* conversation history — overkill for a fact-memory service. A shallow rollup (leaves → per-topic summary → per-user summary) is enough, and we must wire summary invalidation to supersession so summaries don't go stale.
