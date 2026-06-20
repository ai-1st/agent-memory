# LoCoMo — Long Conversational Memory

**Paper:** Maharana et al., "Evaluating Very Long-Term Conversational Memory of LLM Agents" (ACL 2024).
**Links:** [arXiv/ACL](https://aclanthology.org/2024.acl-long.747/) · [Project + data](https://snap-research.github.io/locomo/) · [GitHub](https://github.com/snap-research/locomo)

## What it tests
Memory over **very long, multi-session, two-speaker conversations** (avg ~27 sessions, ~590 turns, ~17K tokens per conversation, each turn timestamped, with persona + image grounding). The headline task is question answering over the full history; there are also event-summarization and multimodal-generation tasks.

## Why relevant to us
This is the de-facto standard for AI-agent memory services (Mem0, Zep, LangMem all report on it). Its QA categories map almost 1:1 onto our graded capabilities. It exercises **recall, multi-hop, temporal, and noise/adversarial (unanswerable)** in one dataset, across many sessions — exactly the cross-session ingest→recall loop we ship.

## Data format + concrete example
JSON per conversation: a list of sessions, each session a list of `{speaker, text, timestamp, (optional) image}` turns, plus `qa` pairs with `question`, `answer`, `evidence` (session/turn ids), and a `category`.

```json
{
  "session_1": [{"speaker":"Caroline","text":"I adopted a puppy!","dia_id":"D1:1"}],
  "session_2_date_time":"2:14 pm on 23 May 2023",
  "qa": [{"question":"When did Caroline adopt her puppy?",
          "answer":"23 May 2023","category":2,"evidence":["D1:1"]}]
}
```

## Size
- 10 conversations (gold human-verified), ~1,540 QA pairs total (the most-cited "LoCoMo" QA set).
- A larger machine-generated split exists for training; the 10-conversation eval set is the one everyone reports.

## QA categories (their numbering)
1. Single-hop, 2. Multi-hop, 3. Temporal, 4. Open-domain (commonsense over dialogue), 5. Adversarial/Unanswerable (must abstain).

## Metrics
- QA: F1 / exact-match against gold short answers; LLM-as-judge ("J" score) is now the common reporting metric (Mem0/Zep use GPT-4-class judge).
- Summarization: ROUGE / FactScore-style. Generation: human + automatic.
- Vendors additionally report **tokens per query** and **p50 latency**.

## License / obtaining
Snap Research release; check repo for the data license (research use). Pull from the GitHub repo / project page. Widely mirrored on HuggingFace.

## Maps to OUR categories
- recall ✅ (single-hop)
- multi-hop ✅ (cat 2)
- temporal ✅ (cat 3)
- noise ✅ (cat 5 adversarial / unanswerable → must yield empty/abstain)
- cross-session ✅ (core design)
- fact-evolution ⚠️ partial (timestamps + repeated topics, but not designed as explicit supersession)
- extraction ⚠️ indirect (you must extract to answer, but no gold "memory" labels)

## How we'd adapt it to our HTTP contract
1. **Ingest:** for each conversation, iterate sessions in order; for each turn `POST /turns` with `{user_id=conv_id, session_id, role=speaker, text, ts=timestamp}`. Use the session date as the turn timestamp so temporal questions are answerable.
2. **Probe:** for each `qa`, `POST /recall {user_id, query=question, token_budget}` and/or `POST /search`.
3. **Grade:** LLM-judge the recalled context + a downstream answer against `answer`. For cat-5 adversarial, assert recall returns **empty/low-confidence** context (noise-resistance check).
4. **Cross-session/persistence:** ingest sessions 1..n-1, restart the service, then ingest the last session + probe to test persistence.
5. Report accuracy per category + tokens-returned-under-budget + latency, mirroring Mem0/Zep tables so results are comparable.
