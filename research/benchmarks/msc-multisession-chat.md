# MSC — Multi-Session Chat ("Beyond Goldfish Memory")

**Paper:** Xu, Szlam, Weston, "Beyond Goldfish Memory: Long-Term Open-Domain Conversation" (ACL 2022).
**Links:** [arXiv 2107.07567](https://arxiv.org/abs/2107.07567) · [ACL](https://aclanthology.org/2022.acl-long.356/) · data via ParlAI (`parlai display_data -t msc`).

## What it tests
Human-human crowdworker chats spanning **5 sessions**, where partners re-engage after hours/days and reference what they learned previously. Each prior session is annotated with **persona summaries** ("important personal points"). It tests whether a model recalls and reuses partner facts across sessions — i.e., basic long-term conversational memory + persona retention.

## Why relevant to us
It is the substrate for the **Deep Memory Retrieval (DMR)** benchmark (see `zep-dmr.md`) that MemGPT/Zep report on. MSC itself is the canonical, **human-written** (not LLM-synthetic) multi-session dataset, and its per-session persona-summary annotations are effectively gold **extracted memories** — useful for grading our extraction quality.

## Data format + concrete example
ParlAI dialogue format: episodes of N sessions; turns are `{id: speaker, text}` with `personas`/`init_personas` and `time_interval` between sessions. Persona summaries accompany each session.

```
[session 2, gap: "a few days later"]
Speaker1: How did your trip to Berlin go?
Speaker2: Loved it — though I'm actually moving to NYC next month.
persona(Speaker2): ["lives in Berlin", "moving to New York"]
```

## Size
- ~5,000 multi-session episodes (train), each up to 5 sessions × up to ~14 utterances.
- Valid/test splits include sessions 1–4 history with a 5th-session continuation.

## Metrics
- Generation quality: perplexity, F1 against gold next utterance, human engagingness/consistency.
- For memory: retrieval of the right persona fact; downstream consistency.

## License / obtaining
Released through ParlAI (MIT-licensed framework; dataset for research). Pull via ParlAI task `msc`.

## Maps to OUR categories
- recall ✅ · cross-session ✅ · extraction ✅ (persona summaries = gold memories)
- fact-evolution ⚠️ (some persona drift, not labeled as supersession)
- multi-hop ❌ · temporal ⚠️ (coarse session gaps only) · noise ❌

## How we'd adapt it to our HTTP contract
1. **Ingest:** replay each episode's sessions in order to `POST /turns` (one `session_id` per session, `ts` from the time-interval label).
2. **Extraction grading:** call `GET /users/{id}/memories` after ingest and compare extracted memories to the gold persona summaries (precision/recall on facts) — a clean extraction-quality probe.
3. **Recall grading:** synthesize probe questions from persona facts ("Where does Speaker2 live?") and check `/recall`.
4. Prefer this for the **extraction** signal; use DMR (below) for the recall-accuracy number that's comparable to vendors.
