# How high LoCoMo scores are achieved (2026 SOTA) — and how we'll borrow

Web research (June 2026) into what separates a ~25% LoCoMo system from a SOTA one,
and how each technique maps onto our three builds. LoCoMo's five QA categories are
single-hop, multi-hop, temporal, open-domain, adversarial; **multi-hop and temporal
are where the headroom is** — exactly the categories our own failure analysis flagged.

## Reported scores (LLM-judge)
- **Mem0 (April 2026 algorithm): 92.5** on LoCoMo. Its two largest gains over the
  prior version were **temporal +29.6** and **multi-hop +23.1** — our two weakest
  categories.
- **Memori 81.95**, **Zep/Graphiti ~75**, older Mem0 graph ~62–75. Human QA F1 ≈88.
- Single-hop / knowledge-update saturate near the ceiling; multi-session reasoning
  (multi-hop, temporal) stays materially harder for everyone.

## The techniques that move the hard categories

**Multi-hop (cross-session chaining):**
1. **Entity extraction + linking** — entities are extracted, embedded, and linked
   across memories so retrieval can **boost on entity matches**; multi-hop is then
   traversing entity relationships (Mem0). We have a partial analogue in
   opinionated's contradiction-link graph and maxxed's entity graph.
2. **Multi-signal retrieval fusion** — semantic similarity + **BM25 keyword** +
   **entity match**, scored in parallel and fused (RRF) (Mem0). maxxed already has
   hybrid+RRF scaffolding.
3. **Multi-query / iterative retrieval** — generate follow-up queries from the
   first-round facts and merge (we built this for opinionated; +mq in the sweep).

**Temporal (date / order / interval):**
1. **Date-anchoring** — resolve "last Monday" → an absolute date via the session
   timestamp (TReMu's "date-inference mapping anchored on session timestamps").
   **We already did this (Phase-1) and it drove opinionated temporal 16→46.**
2. **Time-aware memorization** — summarize each session into **timeline entries with
   explicit (date, event) tuples** (TReMu), so temporal queries hit dated structure
   rather than prose.
3. **Temporal-aware retrieval** — condition retrieval on **timestamp + speaker
   metadata**, coarse-to-fine (Memory-T1): narrow to the relevant sessions, then
   select fine-grained dated evidence.

**Cross-cutting:** speaker-conditioned retrieval (LoCoMo is two-speaker — don't
conflate Caroline's facts with Melanie's), session summarization/consolidation, and
a final rerank.

## Mapping to our three builds (the 3-iteration plan)

Per the standing constraint — **simple stays simple, opinionated stays true to its
idea, maxxed grows freely** — maxxed is the **playground** for the heavier SOTA
techniques.

| build | iter 1 | iter 2 | iter 3 |
|---|---|---|---|
| **maxxed** (playground) | date-preservation in compaction + temporal-aware retrieval (fix the −3 anchoring regression) | entity-boosted hybrid fusion for multi-hop (semantic+BM25+entity) | session→timeline (date,event) summarization |
| **simple** (stay simple) | keyword/BM25 hybrid + all-priors breadcrumb | speaker-scoped + wider recall coverage | date-preservation in the recall note |
| **opinionated** (as-is) | adopt the sweep winner (mq and/or chunk) by default | entity-link recall (generalize the link graph beyond contradictions) | temporal narration discipline (state dates/order only when a dated fact supports it) |

Each iteration is benchmarked on LoCoMo (Haiku, N=100), documented, and committed.
Honest ceiling note stands: SOTA systems use heavier graph/temporal machinery than a
job-challenge scope warrants; our target remains a strong, *measured* climb on
multi-hop + temporal, not parity with Mem0's 92.5.

## Sources
- [Mem0 — AI memory benchmarks in 2026](https://mem0.ai/blog/ai-memory-benchmarks-in-2026)
- [Mem0: Production-Ready AI Agents with Scalable Long-Term Memory (paper)](https://arxiv.org/html/2504.19413v1)
- [Zep — "Is Mem0 Really SOTA in Agent Memory?"](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/)
- [TReMu: time-aware memorization + date-inference (LoCoMo-derived)](https://www.emergentmind.com/topics/locomo-derived-multi-session-dialogues-tremu)
- [Memory-T1: temporal-aware coarse-to-fine retrieval](https://arxiv.org/html/2512.20092v1)
- [LoCoMo benchmark overview](https://www.emergentmind.com/topics/locomo-benchmark)
