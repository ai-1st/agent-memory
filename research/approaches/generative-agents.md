# Generative Agents (Stanford)

## Overview
The Stanford "Generative Agents: Interactive Simulacra of Human Behavior" paper (2023) introduced a **memory stream** architecture that has become the reference design for scoring memory relevance. Every observation is appended to a time-stamped stream; retrieval ranks memories by a weighted sum of **recency**, **importance**, and **relevance**. Critically, it adds **reflection** — the agent periodically synthesizes higher-level insights from raw observations, and those reflections are themselves stored and retrievable. This is the canonical source for importance-weighted, recency-decayed, reflection-augmented recall.

- **Paper:** "Generative Agents" — https://arxiv.org/abs/2304.03442 (UIST 2023)
- **Repo:** https://github.com/joonspk-research/generative_agents
- **License:** the released code is research/academic use (Apache-2.0 with research terms — verify before reuse).
- **Maturity:** Research artifact (hugely influential), not a production memory service.

## Architecture
```
observations ──► MEMORY STREAM (append-only, timestamped)
                     │
   retrieval score = α_recency·recency + α_importance·importance + α_relevance·relevance
   (Stanford: all α = 1)
     recency    = exp decay since last access (decay ~0.995/hr)
     importance = LLM-rated 1–10 at creation
     relevance  = embedding similarity to current query
                     │
   REFLECTION (periodic): LLM synthesizes insights from top memories,
   stored back into the stream as higher-level memories
                     │
   top-scoring memories that fit context window → prompt
```

## Extraction strategy
- Observations are stored largely as-is (natural-language). The "extraction" intelligence is in (a) the **importance rating** at write time and (b) **reflection** that distills patterns later. Not structured-schema extraction.

## Backing store(s)
- Simple stream store + embeddings (the paper's implementation is lightweight/file-based; production reimplementations use a vector DB).

## Recall / retrieval pipeline
- Compute the three-term score for candidate memories; take the top-N within the context budget. Reflections compete in the same ranking, so abstract insights can outrank raw observations.

## Contradiction / fact-evolution / temporal handling
- No explicit supersession. "Newer wins" emerges only via recency weighting; contradictory old memories aren't invalidated, just down-ranked over time. Weak for our `supersedes` requirement, but the **recency decay** idea is directly useful.

---

## ADR 1 — Weighted retrieval score: recency × importance × relevance
- **Status:** Accepted (borrow — core of our priority logic)
- **Context:** Our /recall needs "defensible priority logic" under a token budget. Pure similarity ignores how important or fresh a memory is.
- **Decision:** Rank candidate memories by `w_r·relevance + w_i·importance + w_t·recency` (recency = exponential decay on `updated_at`), with importance from an LLM rating (or type-based prior: facts/prefs > opinions). Tune weights; allow type/active overrides.
- **Consequences:** (+) Transparent, tunable, explainable priority — exactly what the contract asks for. (+) Recency naturally favors current facts. (−) Needs an importance signal (extra LLM rating or heuristic); weights need tuning/eval. (−) Recency must not bury a still-true old fact — pin "active" status above decay.

## ADR 2 — Reflection: synthesize higher-level memories from raw ones
- **Status:** Considered (borrow as background job)
- **Context:** Many low-level facts are individually low-value but jointly imply something important (e.g., repeated terse requests ⇒ "prefers concise answers").
- **Decision:** Periodically run a reflection pass that generates higher-level memories (typically `preference`/`opinion`) from clusters of observations, stored with provenance.
- **Consequences:** (+) Captures implicit/emergent facts; improves recall coherence and token efficiency. (−) Background compute; reflections can be wrong → route them through normal confidence + supersession.

---

## Relevance to our contract
- **Borrow:** the recency+importance+relevance scoring is the backbone of our /recall priority logic — adopt directly. **Borrow:** reflection as a background way to capture implicit/emergent preferences (overlaps with Honcho inference and A-MEM evolution).
- **Avoid:** relying on recency-decay *alone* for contradiction handling — we still need explicit supersession so an old-but-true fact isn't lost and a contradicted-but-recent fact isn't trusted.
