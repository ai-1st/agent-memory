# MemoryBank / SiliconFriend

## Overview
MemoryBank (AAAI 2024) is a long-term memory mechanism for LLM companions; SiliconFriend is its reference chatbot. Two ideas stand out: (1) a **hierarchical event-based memory** — raw logs are summarized into daily **event summaries** and an evolving **global user-personality profile**; and (2) a **memory-strength / forgetting mechanism inspired by the Ebbinghaus forgetting curve** — memories decay over time but get *reinforced* (strength reset) when recalled, and rarely-used memories fade. This gives a principled, human-like way to prune/age noise.

- **Paper:** "MemoryBank: Enhancing LLMs with Long-Term Memory" — https://arxiv.org/abs/2305.10250
- **Repo:** https://github.com/zhongwanjun/MemoryBank-SiliconFriend
- **License:** open source (verify in repo)
- **Maturity:** Research artifact (peer-reviewed); influential for the forgetting-curve idea, not a production service.

## Architecture
```
conversation logs ──► daily EVENT SUMMARIES (LLM)
                  ──► GLOBAL USER PROFILE / personality (synthesized, evolving)
                          │
        FAISS dense retrieval over memories (dual-tower encoders)
                          │
   each memory has a STRENGTH that decays w/ time (Ebbinghaus),
   reinforced on recall; weak memories are forgotten
```

## Extraction strategy
- LLM summarization into **daily event summaries** + a synthesized **personality profile**. Hierarchical (raw → daily → profile), similar to RAPTOR/Generative-Agents reflection.

## Backing store(s)
- FAISS vector index with dual-tower (bi-encoder) retrieval; summaries + profile stored alongside.

## Recall / retrieval pipeline
- Dense semantic retrieval over event summaries; the global profile is injected for personalization. Retrieval feeds the prompt.

## Contradiction / fact-evolution / temporal handling
- No explicit supersession. Instead, **forgetting** ages out stale/low-value memories (strength decays unless reinforced). This handles *noise* and *staleness* by attrition rather than by tracking contradictions.

---

## ADR 1 — Ebbinghaus-style memory strength: decay + reinforce-on-recall
- **Status:** Considered (borrow for noise resistance, not for contradiction)
- **Context:** Requirement (5) noise resistance. Many low-value memories accumulate; we don't want them crowding recall forever, but we also shouldn't hard-delete.
- **Decision:** Give each memory a `strength`/`last_accessed`; decay strength over time, bump it when a memory is recalled/used. Optionally drop or de-prioritize memories below a threshold (archive, don't delete).
- **Consequences:** (+) Self-pruning noise; frequently-useful memories stay prominent; cheap and deterministic. (−) Risk of forgetting a rarely-used but important fact — protect `active` facts and high-importance items from decay; prefer archive over delete.

## ADR 2 — Synthesized per-user profile as always-available context
- **Status:** Considered
- **Context:** A compact "who is this user" blob is handy for cold-start recall.
- **Decision:** Maintain a small synthesized user profile (from facts/preferences) refreshed in the background, available to /recall as a top-tier item.
- **Consequences:** (+) Cheap cold-start personalization (overlaps Letta core, Honcho rep). (−) Can drift; must regenerate from current `active` memories so it stays consistent with supersession.

---

## Relevance to our contract
- **Borrow:** the **decay + reinforce-on-recall** strength model is a clean, defensible noise-resistance and recall-priority signal (feeds the recency term from Generative Agents). **Borrow:** background-synthesized user profile as a cold-start recall tier.
- **Avoid:** using forgetting as the *only* fact-evolution mechanism — it can't tell "contradicted" from "merely old." Pair with explicit supersession.
