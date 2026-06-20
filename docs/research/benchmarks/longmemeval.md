# LongMemEval — Benchmarking Chat Assistants on Long-Term Interactive Memory

**Paper:** Wu et al., "LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory" (ICLR 2025).
**Links:** [arXiv 2410.10813](https://arxiv.org/abs/2410.10813) · [GitHub](https://github.com/xiaowu0162/LongMemEval) · [Project](https://xiaowu0162.github.io/long-mem-eval/) · [HuggingFace dataset]

## What it tests
Five core long-term memory abilities, explicitly named:
1. **Information extraction** (single-session, find the fact)
2. **Multi-session reasoning** (combine facts across sessions)
3. **Temporal reasoning**
4. **Knowledge updates** (a fact changes over time — supersession)
5. **Abstention** (the answer was never discussed → don't hallucinate)

Built "needle-in-a-haystack" style: each question is embedded in a **freely scalable, timestamped** user/assistant chat history. Two scales: `longmemeval_s` (~115K tokens of history) and `longmemeval_m` (~1.5M+ tokens), plus an oracle split.

## Why relevant to us
This is the single closest match to our graded rubric — its 5 abilities are almost a renaming of ours, and crucially it has **explicit knowledge-update (fact-evolution) and abstention (noise) categories** that LoCoMo only covers weakly. The timestamped haystack maps directly to our `/turns` ingest + `/recall` under budget.

## Data format + concrete example
JSON per item: `question_id`, `question_type`, `question`, `answer`, `question_date`, and `haystack_sessions` — a list of sessions, each a list of `{role, content}` turns, with `has_answer` flags marking the evidence turns.

```json
{"question_id":"abc","question_type":"knowledge-update",
 "question":"Where does the user currently work?",
 "answer":"Notion","question_date":"2026/03/01",
 "haystack_sessions":[
   [{"role":"user","content":"I work at Stripe.","has_answer":false}],
   [{"role":"user","content":"I just joined Notion!","has_answer":true}]]}
```

## Size
- **500 curated questions.**
- Distribution: 70 single-session-user, 56 single-session-assistant, 30 single-session-preference, 133 multi-session, 78 knowledge-update, 133 temporal-reasoning.
- Haystacks are scalable: `_s` ≈ 115K tokens, `_m` ≈ millions.

## Metrics
- Per-type accuracy via QA correctness (LLM-judge against gold answer).
- Abstention questions scored on correctly refusing.
- Often reported with retrieval recall@k for the memory/retrieval component separately.

## License / obtaining
Released on HuggingFace + GitHub (research use; check repo LICENSE). The repo ships the haystack-construction pipeline so you can regenerate at any scale.

## Maps to OUR categories
- recall ✅ · extraction ✅ (single-session) · multi-hop ✅ (multi-session) · temporal ✅
- **fact-evolution ✅✅ (knowledge-update — best in class here)**
- **noise ✅✅ (abstention)**
- cross-session ✅ · volume ✅ (scalable haystack) · ambiguity ⚠️ (preference subset)

## How we'd adapt it to our HTTP contract
1. **Ingest:** treat each `haystack_session` as one `session_id`; replay turns to `POST /turns` with `ts=session timestamp`, `user_id=question_id` (or a shared synthetic user for the volume test).
2. **Probe:** `POST /recall {query=question, as_of=question_date, token_budget}`.
3. **Grade by type:**
   - knowledge-update → assert recall returns the **latest** value and (bonus) flags the superseded one → directly tests our fact-evolution endpoint behavior.
   - abstention → assert **empty/low-confidence** context (noise resistance).
   - temporal → pass `question_date`; assert as-of-correct fact.
   - multi-session → assert both evidence turns surface within budget.
4. **Volume test:** use `_m` haystack against one user to stress VOLUME / long-context recall and measure tokens-returned vs budget + latency.
