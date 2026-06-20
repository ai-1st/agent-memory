# PerLTQA — Personal Long-Term Memory QA

**Paper:** Du et al., "PerLTQA: A Personal Long-Term Memory Dataset for Memory Classification, Retrieval, and Synthesis in Question Answering" (SIGHAN @ ACL 2024).
**Links:** [arXiv 2402.16288](https://arxiv.org/abs/2402.16288) · [ACL](https://aclanthology.org/2024.sighan-1.18/) · [HF paper page](https://huggingface.co/papers/2402.16288)

## What it tests
Personal long-term memory that blends **semantic memory** (world knowledge, profiles, social relationships) and **episodic memory** (events, dialogues) for 30 fictional characters. The proposed pipeline has three stages we care about: **Memory Classification → Retrieval → Synthesis**. QA requires combining different memory types (e.g., a profile fact + an event) to answer.

> Note: PerLTQA is **Chinese-language**. Plan for translation or treat it as a structure template if the rest of our suite is English.

## Why relevant to us
It is structured exactly like a memory store: typed memories (profile/relationship/event/dialogue) tied to a user, with QA that forces **multi-hop across memory types** ("what city does the user with the dog named Biscuit live in?" is this shape). The explicit memory-type taxonomy is a useful schema for our **extraction** (structured, typed memories) and a clean **multi-hop** + **cross-memory** probe.

## Data format + concrete example
Per character: a set of typed memory records + QA. Memories have a `type`, `content`, and links; questions reference one or more memory ids.

```json
{"profile":{"name":"Li Hua","city":"Chengdu"},
 "relationships":[{"pet":"Biscuit","owner":"Li Hua"}],
 "qa":[{"q":"In which city does Biscuit's owner live?","a":"Chengdu",
        "evidence":["relationships#0","profile"]}]}
```

## Size
- **8,593 questions across 30 characters**, spanning the 5 memory types.

## Metrics
- Memory classification accuracy/F1; retrieval recall@k; synthesis answer correctness (BLEU/ROUGE + LLM/human).

## License / obtaining
Released with the paper (GitHub/HF; research use). Chinese text.

## Maps to OUR categories
- recall ✅ · multi-hop ✅✅ (cross-memory-type) · extraction ✅✅ (typed-memory schema)
- ambiguity ⚠️ · cross-session ⚠️ · temporal ⚠️ · noise ❌

## How we'd adapt it to our HTTP contract
1. **Ingest:** either (a) replay the dialogue memories as turns to `POST /turns` and let extraction populate memories, or (b) seed typed memories directly to test retrieval/synthesis in isolation.
2. **Extraction probe:** compare extracted memory types to PerLTQA's gold types via `GET /users/{id}/memories`.
3. **Multi-hop probe:** run the QA against `/recall`/`/search`; assert both evidence memories surface and the synthesized answer is correct — directly exercises our "Biscuit" multi-hop case.
4. If staying English-only, use PerLTQA primarily as a **schema/multi-hop template** for our custom fixture rather than running it verbatim.
