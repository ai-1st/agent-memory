# Needle-in-a-Haystack (NIAH) + Variants

**Origin:** Greg Kamradt's "Pressure Testing GPT-4-128K" (2023); now standard, generalized inside RULER and many model cards.
**Links:** [Original repo](https://github.com/gkamradt/LLMTest_NeedleInAHaystack) · variants live in [RULER](https://github.com/NVIDIA/RULER) (see `ruler.md`).

## What it tests
Insert a single unrelated fact (the "needle") at a controlled **depth** inside a long filler document (the "haystack"), then ask for it. Sweep over (context length × insertion depth) to produce the famous heatmap of where retrieval fails. Variants:
- **Multi-needle** (insert k facts, retrieve all).
- **NeedleInAHaystack-Reasoning** / **multi-hop needle** (needles must be combined).
- **NoLiMa / "no literal match"** (paraphrased query so lexical overlap can't shortcut).

## Why relevant to us
The simplest, fastest **recall + noise** sanity check. Cheap to author, immediately interpretable (a heatmap), and the multi-needle / paraphrased variants directly test our **disambiguation** and **no-lexical-shortcut** robustness. It is the conceptual base of LongMemEval's construction.

## Data format + concrete example
A filler corpus + an inserted sentence + a query.

```
[Paul Graham essays ...] The best thing to do in San Francisco is eat a sandwich
in Dolores Park on a sunny day. [more essays ...]
Q: What is the best thing to do in San Francisco?  A: eat a sandwich in Dolores Park
```

## Size
- Synthetic; you choose # lengths × # depths × # trials.

## Metrics
- Retrieval accuracy per (length, depth) cell; pass/fail heatmap; for multi-needle, recall over the k needles.

## License / obtaining
Original repo MIT. Trivial to reimplement; RULER subsumes the serious variants.

## Maps to OUR categories
- recall ✅ · noise ✅ (haystack filler) · ambiguity ✅ (multi-needle, paraphrase) · volume ✅ (length sweep)
- multi-hop ⚠️ (reasoning variant only) · temporal ❌ · fact-evolution ❌ · cross-session ❌ · extraction ❌

## How we'd adapt it to our HTTP contract
1. Chunk the haystack into turns → `POST /turns` for a synthetic user; insert the needle at a chosen turn (depth).
2. `POST /recall {query, token_budget}`; assert the needle is in the returned context.
3. Sweep length × depth → produce our own recall heatmap; sweep needle paraphrasing to confirm we're not relying on lexical match.
4. Use as the **fastest CI smoke test** for the recall path; graduate to RULER for rigorous, multi-variant coverage.
