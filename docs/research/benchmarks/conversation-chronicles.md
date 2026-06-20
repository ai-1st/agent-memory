# Conversation Chronicles

**Paper:** Jang, Boo, Kim, "Conversation Chronicles: Towards Diverse Temporal and Relational Dynamics in Multi-Session Conversations" (EMNLP 2023).
**Links:** [arXiv 2310.13420](https://arxiv.org/abs/2310.13420) · [ACL](https://aclanthology.org/2023.emnlp-main.838/) · [HF dataset](https://huggingface.co/datasets/jihyoung/ConversationChronicles) · [Project](https://conversation-chronicles.github.io/)

## What it tests
A **1M-dialogue** multi-session dataset (200K episodes × 5 sessions) that deliberately injects **diverse time intervals** ("a few hours later", "a couple of years later") and **fine-grained speaker relationships** (e.g., classmates, employee-boss, parent-child). Each session has a chronological summary. Tests long-term context understanding with realistic temporal + relational drift.

## Why relevant to us
Much larger and more temporally varied than MSC, and LLM-generated so easy to extend/regenerate. The explicit, labeled **time intervals** make it a good fixture for **temporal/as-of recall**, and the relationship labels add a **multi-hop** angle ("what did the user's boss recommend?"). Per-session summaries serve as gold extracted memories.

## Data format + concrete example
HF dataset rows contain the 5 sessions, the `time_interval` per session, a `relationship` label, speaker names, and `summary` per session.

```json
{"relationship":"Classmates",
 "time_interval":["", "A few hours later","Two weeks later","A month later","A year later"],
 "first_session_dialogue":["...","..."],
 "first_session_summary":"..."}
```

## Size
- 200,000 episodes, 1,000,000 sessions (5 per episode). Very large — sample for our use.

## Metrics
- Generation: F1/perplexity vs gold continuation; human engagement/consistency (their ReBot model).
- For memory probing we supply our own QA (the dataset ships summaries, not QA).

## License / obtaining
On HuggingFace (`jihyoung/ConversationChronicles`); check the dataset card for license (research use). Synthetic, so distribution is liberal.

## Maps to OUR categories
- recall ✅ · cross-session ✅ · temporal ✅✅ (labeled intervals) · extraction ✅ (summaries)
- volume ✅ (1M dialogues; subset for scale tests) · multi-hop ⚠️ (via relationships, needs custom QA)
- fact-evolution ⚠️ · noise ❌ (no abstention items)

## How we'd adapt it to our HTTP contract
1. **Ingest:** convert `time_interval` into concrete timestamps (anchor session 1 at a base date, add the labeled deltas), replay turns to `POST /turns` with those `ts`.
2. **Temporal probe:** auto-generate as-of questions from facts + intervals; `POST /recall {as_of}` and check the time-correct answer.
3. **Volume probe:** ingest thousands of episodes under one (or few) users to stress VOLUME, then run recall + measure latency/token budget.
4. **Extraction probe:** compare `GET /users/{id}/memories` to per-session summaries.
