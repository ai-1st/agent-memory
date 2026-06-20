# Letta / MemGPT Evaluation

**Paper/system:** Packer et al., "MemGPT: Towards LLMs as Operating Systems" (arXiv 2310.08560). Now maintained as **Letta**.
**Links:** [MemGPT paper](https://arxiv.org/abs/2310.08560) · [Letta GitHub](https://github.com/letta-ai/letta) · [Letta memory benchmark blog](https://www.letta.com/blog/benchmarking-ai-agent-memory/)

## What it tests
MemGPT introduced two evals that became standard for agent memory:
1. **Deep Memory Retrieval (DMR)** — single-fact cross-session recall over MSC (see `zep-dmr.md`).
2. **Nested key-value retrieval** — chained KV lookups (follow value→key for N levels); MemGPT was the only system that stayed correct beyond 2 nesting levels at the time.
Plus a **document QA / conversation-opener** task showing paging memory in/out of a fixed context window.

Letta's newer blog work benchmarks memory *architectures* (e.g., filesystem-as-memory vs vector recall) on multi-step agent tasks and reports retrieval accuracy + token/step efficiency.

## Why relevant to us
MemGPT is the conceptual ancestor of our service (external memory + paging under a token budget). Its **nested-KV** task is a clean, license-free, tunable **multi-hop retrieval** stressor, and DMR is the cross-session recall gate. Letta's filesystem-vs-vector framing is useful when we decide our recall backend.

## Data format + example
Nested-KV: a JSON map of UUID→UUID plus a start key; answer = terminal value after following the chain. DMR: MSC conversation + 1 QA (see zep-dmr.md).

```json
{"kv": {"k0":"k7","k7":"k3","k3":"VALUE"}, "start":"k0", "depth":3, "answer":"VALUE"}
```

## Size
- DMR: 500 conversations. Nested-KV: synthetic, configurable.

## Metrics
- DMR: LLM-judge accuracy vs gold.
- Nested-KV: exact-match of terminal value per depth.
- Token efficiency / steps to solve.

## License / obtaining
Letta is Apache-2.0; eval harnesses + nested-KV generator are in the repo. DMR data derives from MSC (research use).

## Maps to OUR categories
- recall ✅ · cross-session ✅ · multi-hop ✅ (nested-KV) · volume ⚠️ (KV depth)

## How we'd adapt it to our HTTP contract
1. **Nested-KV:** ingest each pair as a turn; probe the start key; require the service to chain across stored memories to the terminal value. Sweep depth (1→8) to chart where our `/recall` + `/search` multi-hop breaks. No external data/license needed — good unit-style multi-hop test.
2. **DMR:** as in zep-dmr.md, a regression gate.
3. Use Letta's architecture comparisons as design input for our recall layer, not as a graded benchmark.
