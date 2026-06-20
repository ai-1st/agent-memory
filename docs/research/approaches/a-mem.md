# A-MEM (Agentic Memory)

## Overview
A-MEM is a research memory system (NeurIPS 2025) inspired by the **Zettelkasten** note-taking method. Each new memory becomes a richly-attributed **atomic note** (content + LLM-generated context, keywords, tags). New notes are then **dynamically linked** to related existing notes, and crucially the system performs **memory evolution**: adding a note can trigger updates to the attributes/context of *existing* notes, so the network continuously refines itself. It reports ~2x improvement on complex multi-hop reasoning at reduced token cost vs. baselines.

- **Repo:** https://github.com/WujiangXu/A-mem
- **Paper:** "A-MEM: Agentic Memory for LLM Agents" — https://arxiv.org/abs/2502.12110
- **License:** open source (MIT, verify in repo)
- **Maturity:** Medium — research code, peer-reviewed (NeurIPS'25), not a hardened product.

## Architecture
```
turn ──► NOTE CONSTRUCTION (LLM):
            content + contextual description + keywords + tags
            │
       LINK GENERATION: embed note, find related notes, create links
            │
       MEMORY EVOLUTION: linked old notes get their context/tags
            UPDATED in light of the new note
            ▼
       interconnected note network (vector index + link graph)
```

## Extraction strategy
- **LLM note construction.** Beyond the raw content, the LLM generates structured metadata (a contextual summary, keywords, tags) per note — making each memory self-describing and easier to retrieve/link.

## Backing store(s)
- Vector store over note embeddings + an explicit link structure between notes (lightweight graph, no heavy graph DB required).

## Recall / retrieval pipeline
- Embedding similarity to find seed notes, then **follow links** to pull in connected notes → strong multi-hop / associative recall without a full graph database.

## Contradiction / fact-evolution / temporal handling
- **Memory evolution** is the interesting bit: inserting a note can rewrite the context/tags of related old notes (e.g., re-characterize them in light of new info). This is *refinement*, not strict supersession with history — softer than Zep but cheaper and emergent.

---

## ADR 1 — Self-describing notes (LLM-generated context + keywords + tags)
- **Status:** Accepted (borrow)
- **Context:** A bare extracted fact ("likes Python") is hard to retrieve for varied queries and hard to dedup.
- **Decision:** Store, alongside each memory's `value`, an LLM-generated short context sentence + keyword/tag list, and index those too (for BM25/keyword recall and dedup).
- **Consequences:** (+) Better recall across paraphrased queries; better noise resistance and matching for supersession. (+) Cheap to add to the existing extraction call. (−) Slightly larger rows; metadata can be wrong and needs the same correction path.

## ADR 2 — Link-following for multi-hop recall (vector + lightweight links)
- **Status:** Considered (good middle ground)
- **Context:** We need multi-hop recall but want to avoid a heavyweight graph DB.
- **Decision:** Maintain lightweight "related memory" links (entity overlap or embedding kNN) and, at recall time, optionally expand from top hits along links one hop.
- **Consequences:** (+) Multi-hop without Neo4j; (+) cheap to implement on top of vectors. (−) Link quality drives results; one-hop expansion can pull in noise — bound the expansion and re-rank.

---

## Relevance to our contract
- **Borrow:** self-describing notes (context/keywords/tags) to strengthen extraction quality, dedup, and multi-hop. **Borrow:** link-following as a *cheap* multi-hop mechanism (no graph DB) — a strong fit for our scope.
- **Avoid:** unbounded "memory evolution" that silently rewrites old memories — for us, any change to an existing memory must go through the supersession/history path so it's auditable.
