# Temporal QA — TimeQA / TempReason / TGQA

Three datasets for **time-sensitive reasoning** — answers depend on *when* you ask or on event ordering. Directly relevant to our as-of recall and fact-evolution.

| Dataset | Paper / link | Focus | Levels |
|---|---|---|---|
| **TimeQA** | Chen et al. 2021, [arXiv 2108.06314](https://arxiv.org/abs/2108.06314), [GitHub](https://github.com/wenhuchen/Time-Sensitive-QA) | Time-scoped facts from Wikipedia ("Who was X's employer in 2015?"); Easy + Hard splits | event-time |
| **TempReason** | Tan et al. 2023, [arXiv 2306.08952](https://arxiv.org/abs/2306.08952), [GitHub](https://github.com/DAMO-NLP-SG/TempReason) | Structured temporal reasoning, 3 levels | L1 time-time, L2 event-time, L3 event-event |
| **TGQA** | Xiong et al. 2024 ("Large Language Models Can Learn Temporal Reasoning", ACL 2024), [GitHub](https://github.com/xiongsiheng/TG-LLM) | Temporal-graph QA over synthetic stories; controllable, contamination-free | graph-based, multi-level |

## What they test
- **TimeQA:** given a question with an implicit/explicit time, return the fact valid at that time (employers, residences, team membership over years).
- **TempReason L1/L2/L3:** time arithmetic → event-at-time → relative ordering of events ("what team did Cantona play for *before* Man Utd?").
- **TGQA:** reason over a temporal graph (before/after/during/duration) extracted from a story.

## Why relevant to us
This is the purest **TEMPORAL** signal and the closest external proxy for **fact-evolution**: TimeQA's "employer in year Y" is exactly "I work at Stripe (s1) → Notion (s3); where did I work as-of date D?". TempReason L3 (event-event ordering) tests whether our memory keeps and orders history. These force our `/recall as_of` parameter and supersession logic to be correct.

## Data format + concrete example
```json
{"question":"Which team did Cristiano Ronaldo play for in 2010?",
 "answer":"Real Madrid",
 "context":["Ronaldo joined Manchester United in 2003.",
            "Ronaldo joined Real Madrid in 2009.",
            "Ronaldo joined Juventus in 2018."]}
```

## Size
- TimeQA: ~20K questions (Easy+Hard). TempReason: ~tens of thousands across L1–L3. TGQA: synthetic, configurable.

## Metrics
- EM / F1 vs gold; per-level accuracy (TempReason); per-difficulty (TimeQA Easy/Hard).

## License / obtaining
TimeQA BSD-style (repo); TempReason + TGQA on GitHub (research/MIT-ish — check repos). All easy to script.

## Maps to OUR categories
- temporal ✅✅ · fact-evolution ✅✅ (time-scoped facts = supersession) · recall ✅
- multi-hop ⚠️ (L3 chaining) · noise ⚠️ (distractor years) · cross-session ⚠️ · extraction ⚠️

## How we'd adapt it to our HTTP contract
1. **Ingest as a timeline:** push each time-stamped fact ("joined Real Madrid in 2009") as a separate turn with `ts` set to that year, across multiple sessions → builds an evolving history in the store.
2. **As-of probe:** `POST /recall {query, as_of=<question year>}`; assert the **time-correct** fact (not the latest, not an old one) — the core fact-evolution + temporal test.
3. **Supersession check:** also assert history is retained (`GET /users/{id}/memories` shows old + new with validity windows) and that default recall returns the current value.
4. Use TimeQA for as-of recall, TempReason L3 for ordering, TGQA for clean synthetic controllability.
