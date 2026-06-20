# Knowledge Editing & Contradictions — MQuAKE / zsRE / CounterFact / KnowEdit

A family from the **model-editing** literature about updating/overwriting facts. For us they are the best off-the-shelf source of **contradiction / knowledge-update** test cases (Stripe→Notion shape) and the **ripple effects** of an update on multi-hop questions.

| Dataset | Paper / link | What it provides |
|---|---|---|
| **zsRE** | Levy et al. 2017 / De Cao et al. 2021, [GitHub (MEND)](https://github.com/eric-mitchell/mend) | Relation-extraction QA edits + paraphrases; classic edit-recall test |
| **CounterFact** | Meng et al. (ROME) 2022, [arXiv 2202.05262](https://arxiv.org/abs/2202.05262), [GitHub](https://github.com/kmeng01/rome) | Counterfactual edits ("The Eiffel Tower is in Rome") + paraphrase + neighborhood (locality) prompts |
| **MQuAKE** | Zhong et al. 2023, [arXiv 2305.14795](https://arxiv.org/abs/2305.14795), [GitHub](https://github.com/princeton-nlp/MQuAKE) | **MQuAKE-CF** (counterfactual) + **MQuAKE-T** (real temporal updates); each edit comes with **multi-hop** questions affected by the edit (ripple effect) |
| **KnowEdit** | Zhang et al. 2024 ("A Comprehensive Study of Knowledge Editing", [arXiv 2401.01286](https://arxiv.org/abs/2401.01286)), [HF `zjunlp/KnowEdit`](https://huggingface.co/datasets/zjunlp/KnowEdit) | Unified benchmark bundling zsRE, CounterFact, MQuAKE-style + WikiBio, etc., with standard metrics |

## What they test
Apply an edit (a new/changed fact), then check:
- **Reliability/efficacy** — the new fact is returned.
- **Generalization** — paraphrases of the query also return the new fact.
- **Locality/specificity** — unrelated facts are unchanged (no collateral overwrite).
- **Portability / ripple (MQuAKE)** — multi-hop questions that depend on the edited fact now reflect it.
- **MQuAKE-T** specifically uses real-world **temporal** updates (outdated → current).

## Why relevant to us
This is the canonical **CONTRADICTION / fact-evolution** suite. The four metrics map cleanly onto memory-service behaviors we must get right: efficacy = recall the latest; generalization = paraphrase-robust recall; **locality = don't corrupt other memories on an update**; ripple = multi-hop stays consistent after supersession. MQuAKE-T gives a temporal-update flavor identical to our Stripe→Notion case.

## Data format + concrete example
```json
{"requested_edit":{"subject":"Jane","relation":"employer",
                   "old":"Stripe","new":"Notion"},
 "generalization_prompts":["Where does Jane work now?"],
 "locality_prompts":["What city does Jane live in?"],   // must be unchanged
 "multi_hop_question":"Who is the CEO of Jane's current employer?"}  // ripple
```

## Size
- zsRE/CounterFact: tens of thousands of edits. MQuAKE: ~3K multi-hop instances (MQuAKE-3K). KnowEdit: bundled subsets.

## Metrics
- Edit success/efficacy, paraphrase generalization, locality (no-change) accuracy, portability/multi-hop accuracy.

## License / obtaining
All on GitHub/HF, research use (KnowEdit on HF `zjunlp/KnowEdit`).

## Maps to OUR categories
- **fact-evolution / contradiction ✅✅** · multi-hop ✅ (MQuAKE ripple) · temporal ✅ (MQuAKE-T)
- noise ⚠️ (locality probes ≈ never-discussed-topic) · recall ✅ · extraction ⚠️ · cross-session ⚠️

## How we'd adapt it to our HTTP contract
1. **Ingest old fact** as a turn in session 1; **ingest new/edited fact** as a turn in a later session → a contradiction over time.
2. **Efficacy:** `POST /recall {query}` → must return the **new** value.
3. **Generalization:** run paraphrased queries → still new value.
4. **Locality:** query an unrelated stored fact → unchanged (assert the update didn't corrupt siblings). This is a sharp regression test for our extraction/merge logic.
5. **Ripple (MQuAKE):** run the multi-hop question → must reflect the edit; assert both hops surface.
6. **History/supersession:** `GET /users/{id}/memories` should show old fact marked superseded with timestamps. Best external fixture for our fact-evolution endpoint behavior.
