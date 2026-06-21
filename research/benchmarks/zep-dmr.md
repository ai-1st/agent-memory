# Zep DMR — Deep Memory Retrieval (+ MemGPT eval methodology)

**Origin:** DMR introduced in MemGPT (Packer et al., "MemGPT: Towards LLMs as Operating Systems", arXiv 2310.08560); re-run + extended by Zep (Rasmussen et al., "Zep: A Temporal Knowledge Graph Architecture for Agent Memory", arXiv 2501.13956).
**Links:** [MemGPT paper](https://arxiv.org/abs/2310.08560) · [Zep paper](https://arxiv.org/abs/2501.13956) · [Zep SOTA blog](https://blog.getzep.com/state-of-the-art-agent-memory/) · [Letta/MemGPT code](https://github.com/letta-ai/letta)

## What it tests
**Deep Memory Retrieval (DMR):** a 500-conversation subset of MSC. Each conversation is 5 sessions (≤12 messages/session) and has **one Q/A pair** asking about a specific fact stated in an earlier session. The agent must retrieve that fact from memory and answer; the answer is graded against the gold. It is a focused **single-fact cross-session recall** test.

MemGPT also defines a **nested key-value retrieval** task (chained KV lookups) — a synthetic multi-hop retrieval stressor where you follow value→next-key links.

## Why relevant to us
DMR is the headline number every memory vendor quotes (MemGPT 93.4%, Zep 94.8% w/ GPT-4-Turbo; up to ~98% w/ GPT-4o-mini). Adopting it makes our `/recall` accuracy **directly comparable to commercial systems**. It is small, cheap, and trivial to wire to our contract. Nested-KV gives us a synthetic multi-hop probe with no licensing friction.

## Data format + concrete example
DMR item = an MSC-style 5-session conversation + `{question, gold_answer}`. Nested-KV = a dict of UUID→UUID chains plus a start key; the answer is the value reached after following N hops.

```json
{"sessions":[...5 MSC sessions...],
 "question":"What sport did the user say they picked up?",
 "answer":"rock climbing"}
```

## Size
- DMR: 500 conversations × 1 QA each.
- Nested-KV: synthetic, configurable depth/width.

## Metrics
- DMR: answer accuracy via LLM-judge against gold (binary correct/incorrect).
- Nested-KV: exact match of final value at each nesting depth.
- Vendors also report latency + tokens.

## Caveats
DMR is **near-saturated** (top systems >94%) and largely single-hop — good as a regression gate, weak as a discriminator. Pair it with LongMemEval/LoCoMo for headroom.

## License / obtaining
Derived from MSC (research use). The MemGPT/Letta and Zep repos contain the DMR question set + harness. Nested-KV generator is in the MemGPT repo.

## Maps to OUR categories
- recall ✅ · cross-session ✅
- multi-hop ✅ (nested-KV only) · volume ⚠️ (KV depth) · everything else ❌

## How we'd adapt it to our HTTP contract
1. **DMR ingest:** replay the 5 sessions to `POST /turns`; `POST /recall {query=question}`; LLM-judge answer vs gold. Use as a **fast smoke/regression gate** in CI (500 items, single-hop, runs quickly).
2. **Nested-KV:** ingest each `key: value` as a turn ("Remember: <k> maps to <v>"), then probe with the start key and assert the service can chain via `/search` + `/recall` to the terminal value — a controllable **multi-hop** stressor; sweep depth to find where recall breaks.
3. Report DMR accuracy next to vendor numbers; treat <90% as a release blocker.
