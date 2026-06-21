# RULER — Real Context Size of Long-Context LLMs

**Paper:** Hsieh et al. (NVIDIA), "RULER: What's the Real Context Size of Your Long-Context Language Models?" (arXiv 2404.06654, COLM 2024).
**Links:** [arXiv 2404.06654](https://arxiv.org/abs/2404.06654) · [GitHub](https://github.com/NVIDIA/RULER)

## What it tests
Synthetic, **configurable-length** tasks across 4 categories / 13 tasks:
1. **Retrieval** — needle-in-a-haystack variants: multiple needles, multiple values per key, multiple simultaneous queries.
2. **Multi-hop tracing** — variable tracking (follow a chain of variable bindings).
3. **Aggregation** — return most-common words (common/frequent-words extraction).
4. **QA** — answer over long distractor context.
Generates examples at any sequence length to find the **effective** context size (where accuracy drops below a threshold), which is usually far below the advertised window.

## Why relevant to us
RULER is the gold standard for **retrieval-under-noise at scale**. Its multi-key / multi-value / multi-query needle variants are precisely our **noise resistance** and **disambiguation** concerns, and variable-tracking is a clean **multi-hop** probe. Fully synthetic = no licensing, infinitely scalable for our VOLUME tests.

## Data format + concrete example
Generated text haystacks with inserted needles + a query; answer is the inserted value(s).

```
[long filler ...] One special magic number for berlin is 7421. [more filler ...]
Q: What is the special magic number for berlin? A: 7421
```

## Size
- Synthetic; generate as many items as needed at lengths from 4K → 1M+ tokens.

## Metrics
- Per-task accuracy (exact match) vs context length; "effective context length" = longest length still above threshold (commonly ~85–90%).

## License / obtaining
NVIDIA RULER repo, Apache-2.0. Run the generator locally.

## Maps to OUR categories
- recall ✅ · noise ✅✅ (distractor scaling) · multi-hop ✅ (variable tracking)
- ambiguity ✅ (multi-value/multi-query) · volume ✅✅ (length sweep)
- temporal ❌ · fact-evolution ❌ · cross-session ❌ · extraction ⚠️

## How we'd adapt it to our HTTP contract
1. Treat the haystack as a **session transcript**: chunk it into turns and `POST /turns` for one synthetic user.
2. **Probe:** `POST /recall {query, token_budget}`; assert the needle value(s) appear in the returned context within budget, and that distractors do **not** dominate.
3. **Noise/volume sweep:** increase haystack length and # distractor needles; chart recall accuracy + tokens-returned to find our service's effective context size — the direct analog of RULER's headline metric.
4. **Multi-value:** use multi-value-per-key items to test that fact-evolution returns the right (e.g., latest) one and disambiguates.
