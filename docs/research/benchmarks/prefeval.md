# PrefEval — Personalized Preference Following

**Paper:** Zhao et al., "Do LLMs Recognize Your Preferences? Evaluating Personalized Preference Following in LLMs" (ICLR 2025, Oral).
**Links:** [arXiv 2502.09597](https://arxiv.org/abs/2502.09597) · [Project](https://prefeval.github.io/) · [GitHub](https://github.com/amazon-science/PrefEval)

## What it tests
Whether an assistant **infers, memorizes, and adheres to** a user's stated preferences across a long multi-session conversation. Preferences come in **explicit** ("I'm vegetarian") and **implicit** forms; later, an unrelated-looking query ("recommend a restaurant for tonight") must respect the preference. Covers preference **inference**, **long-range retrieval**, and **context-aware following**, including **conflicting** and **multiple** preferences.

## Why relevant to us
This is our **AMBIGUITY + implicit-extraction + cross-session** capability in one place. Preferences are exactly the kind of implicit, evolving, sometimes-conflicting memory our extraction must capture and our recall must surface at the right moment. PrefEval's finding — accuracy <10% by 10 turns zero-shot — shows this is a discriminating, unsolved task, i.e., good signal.

## Data format + concrete example
Per item: a preference statement (explicit/implicit), filler turns, then a query whose correct handling depends on the preference; gold = whether the response honors it.

```json
{"preference":"I'm allergic to nuts (mentioned in session 1).",
 "form":"explicit",
 "filler_turns":[...many unrelated turns...],
 "query":"Suggest a dessert for my dinner party.",
 "violation_if":"recommends anything with nuts"}
```

## Size
- **3,000 manually curated preference/query pairs across 20 topics**; scalable conversation lengths up to ~100K tokens.

## Metrics
- Generation task: preference-following accuracy (LLM-judge: violated / acknowledged / followed) and **error/violation rate**.
- Classification task: detect whether a response respects the preference.

## License / obtaining
Amazon Science release on GitHub (`amazon-science/PrefEval`); check repo LICENSE.

## Maps to OUR categories
- **ambiguity ✅✅** (implicit preferences) · extraction ✅✅ (implicit facts) · cross-session ✅ · recall ✅
- fact-evolution ✅ (conflicting/updated preferences) · noise ⚠️ (filler turns) · multi-hop ⚠️ · temporal ⚠️

## How we'd adapt it to our HTTP contract
1. **Ingest** the preference statement + filler turns across sessions via `POST /turns`.
2. **Extraction probe:** `GET /users/{id}/memories` should contain the (implicit) preference as a typed memory — tests implicit-fact extraction.
3. **Recall probe:** at the query turn, `POST /recall {query}` should surface the relevant preference even though the query doesn't mention it lexically (long-range, non-lexical retrieval).
4. **Conflict probe:** ingest two conflicting preferences in different sessions; assert recall surfaces the current one and/or flags the conflict.
5. Grade with their violated/acknowledged/followed judge.
