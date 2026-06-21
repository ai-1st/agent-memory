# Mem0 Benchmark Methodology

**Paper:** Chhikara et al., "Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory" (ECAI 2025, arXiv 2504.19413).
**Links:** [arXiv 2504.19413](https://arxiv.org/abs/2504.19413) · [Mem0 research](https://mem0.ai/research) · [AI memory benchmarks 2026](https://mem0.ai/blog/ai-memory-benchmarks-in-2026)

## What it is
Not a dataset — a **methodology + reporting harness** for evaluating memory systems. Mem0 ran the first broad head-to-head of ~10 memory approaches (literature baselines, RAG, full-context, OpenAI Memory, Zep, LangMem, Mem0, Mem0g) **on LoCoMo**, and now also reports on LongMemEval and BEAM (1M/10M-token scales).

## Why relevant to us
It defines the **three-axis scorecard** the industry uses, which is exactly the trade-off our service lives or dies on:
1. **Accuracy** — LLM-judge ("J") score on the underlying QA benchmark.
2. **Token cost** — tokens consumed per recall/query (Mem0 ≈ 7K vs full-context ≈ 26K).
3. **Latency** — p50/p95 search + add latency (Mem0 p50 ≤ ~1.1s).

Reported Mem0 LoCoMo: ~66.9% (Mem0) / 68.4% (Mem0g). Adopting this scorecard makes our `/recall` results legible to anyone who's read the memory literature.

## Methodology details worth copying
- **Add vs Search split:** measure extraction/ingest cost (`/turns`) separately from retrieval cost (`/recall`, `/search`). We have the same split in our API.
- **LLM-as-judge** with a fixed grader prompt + per-category breakdown.
- **Token budget framing:** report accuracy *at a token budget*, not just raw accuracy — matches our `/recall token_budget` parameter.
- Per-category (single-hop/multi-hop/temporal/open-domain) accuracy, not just an aggregate.

## License / obtaining
Methodology is described in the paper + blog; the harness lives in the Mem0 OSS repo (Apache-2.0). The benchmarks it runs on (LoCoMo, LongMemEval) have their own licenses — see those files.

## Maps to OUR categories
Indirect — it tells us **how to score**, on top of whichever dataset (LoCoMo/LongMemEval) supplies the categories.

## How we'd adopt it
1. Wrap our endpoints in their scorecard: every benchmark run emits `{accuracy_by_category, tokens_per_recall, p50/p95_latency, tokens_per_ingest}`.
2. Always evaluate `/recall` **under a fixed token_budget** and report accuracy-at-budget (this is our differentiator vs full-context).
3. Use their per-category LLM-judge prompt so our LoCoMo/LongMemEval numbers are directly comparable to published tables.
4. Keep the add/search separation in CI dashboards so we can see if a recall regression is actually an extraction regression.
