# BABILong — Long-Context Reasoning-in-a-Haystack

**Paper:** Kuratov et al., "BABILong: Testing the Limits of LLMs with Long Context Reasoning-in-a-Haystack" (NeurIPS 2024 Datasets & Benchmarks).
**Links:** [arXiv 2406.10149](https://arxiv.org/abs/2406.10149) · [NeurIPS PDF](https://proceedings.neurips.cc/paper_files/paper/2024/file/c0d62e70dbc659cc9bd44cbcf1cb652f-Paper-Datasets_and_Benchmarks_Track.pdf) · [HF dataset](https://huggingface.co/datasets/RMT-team/babilong)

## What it tests
Embeds the 20 classic **bAbI** reasoning tasks (fact chaining, induction, deduction, counting, lists/sets, multi-supporting-fact) inside long natural-text distractors (PG-19 books), scalable to **millions of tokens**. So it tests **reasoning over facts scattered across a huge context with heavy noise** — not just retrieval. Splits up to 1M+ tokens.

## Why relevant to us
Unlike NIAH (pure retrieval), BABILong requires **combining multiple supporting facts under noise** = our **multi-hop + noise + volume** intersection. The bAbI tasks include several supporting-fact and counting tasks that map to "connect two memories" and "aggregate over memories." Fully synthetic and length-scalable.

## Data format + concrete example
bAbI facts interleaved into book text + a question; answer is a short token.

```
[book text ...] Mary went to the kitchen. [book text ...] Mary picked up the apple.
[book text ...] Mary travelled to the garden.
Q: Where is the apple?  A: garden
```

## Size
- Derived from bAbI (1K–10K per task) × configurable haystack length (0 → 1M+ tokens). HF ships standard length buckets (0K, 1K, 2K, ... 1M).

## Metrics
- Per-task exact-match accuracy vs context length (accuracy-vs-length curves).

## License / obtaining
HF `RMT-team/babilong`, Apache-2.0; bAbI is BSD. Generator available.

## Maps to OUR categories
- recall ✅ · multi-hop ✅✅ (multi-supporting-fact tasks) · noise ✅✅ · volume ✅✅ (to 1M+)
- aggregation/counting ✅ · temporal ⚠️ (event order tasks) · fact-evolution ❌ · cross-session ❌ · extraction ⚠️

## How we'd adapt it to our HTTP contract
1. Replay the interleaved text as turns → `POST /turns` for one synthetic user (the book filler is the distractor history).
2. `POST /recall {query, token_budget}` then answer; grade exact match.
3. Pick tasks 2/3 (two/three supporting facts) and task 7 (counting) for the **multi-hop-under-noise** signal; sweep length buckets for the **volume** curve.
4. Complements RULER: RULER = retrieval/tracking, BABILong = relational reasoning over scattered facts.
