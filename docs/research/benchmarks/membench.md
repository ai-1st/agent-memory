# MemBench — Comprehensive Evaluation of LLM-Agent Memory

**Paper:** "MemBench: Towards More Comprehensive Evaluation on the Memory of LLM-based Agents" (Findings of ACL 2025).
**Links:** [arXiv 2506.21605](https://arxiv.org/abs/2506.21605) · [ACL](https://aclanthology.org/2025.findings-acl.989/) · [GitHub](https://github.com/import-myself/Membench)

## What it tests
A multi-aspect memory benchmark that grades along **three dimensions**:
1. **Effectiveness** (accuracy on the task),
2. **Efficiency** (number of memory operations / cost),
3. **Capacity** (how much performance degrades as the memory store grows).

It models two memory levels — **factual** and **reflective** — and two interaction modes — **participation** (agent acts) vs **observation** (agent watches). Tasks cover information extraction, multi-hop reasoning, knowledge updating, preference following, and temporal reasoning. It implements 7 memory mechanisms (FullMemory, RetrievalMemory, RecentMemory, GenerativeAgent, MemoryBank, MemGPT, Self-Controlled Memory) as baselines.

## Why relevant to us
The closest benchmark to a **production scorecard**: it explicitly measures **capacity degradation as memory grows** (our VOLUME concern) and **operation efficiency** (our token/latency concern), not just accuracy. Its task list covers nearly all our capabilities in one place, and it ships baseline memory systems we can diff against.

## Data format + concrete example
Scenario logs the agent participates in or observes, plus probe queries per capability with gold answers. (See repo for exact JSON schema.)

```json
{"mode":"observation","capability":"knowledge-update",
 "history":[...interaction turns...],
 "query":"What is the user's current employer?","answer":"Notion"}
```

## Size
- Multiple capability subsets; see repo. Designed to scale the memory store to probe capacity.

## Metrics
- Effectiveness: task accuracy. Efficiency: # memory ops. Capacity: accuracy vs store-size curve.

## License / obtaining
Code + data on GitHub (`import-myself/Membench`); check repo LICENSE (research use).

## Maps to OUR categories
- recall ✅ · extraction ✅ · multi-hop ✅ · fact-evolution ✅ (knowledge update) · temporal ✅
- ambiguity ✅ (preference) · **volume ✅✅ (capacity curve)** · cross-session ✅ · noise ⚠️

## How we'd adapt it to our HTTP contract
1. **Ingest** participation/observation histories via `POST /turns`.
2. Run each capability subset against `/recall`/`/search`; grade vs gold.
3. **Capacity curve:** progressively grow the store (more users/sessions), re-run a fixed probe set, and plot our accuracy + latency + tokens-returned vs store size — the single most production-relevant chart we can produce.
4. Use their 7 baseline mechanisms as reference points for our recall backend.
