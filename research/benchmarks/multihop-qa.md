# Multi-Hop QA — HotpotQA / 2WikiMultihopQA / MuSiQue

Three Wikipedia-based datasets that require **connecting facts across documents** to answer — the textbook form of our "what city does the user with the dog named Biscuit live in?" probe.

| Dataset | Paper / link | Size | Construction | Multi-hop rigor |
|---|---|---|---|---|
| **HotpotQA** | Yang et al. 2018, [arXiv 1809.09600](https://arxiv.org/abs/1809.09600), [HF `hotpot_qa`](https://huggingface.co/datasets/hotpot_qa) | ~113K questions | Crowdsourced over Wikipedia, gold supporting sentences | Weak — criticized for shortcut answers |
| **2WikiMultihopQA** | Ho et al. 2020, [arXiv 2011.01060](https://arxiv.org/abs/2011.01060), [GitHub](https://github.com/Alab-NII/2wikimultihop) | ~192K | Wikipedia + Wikidata; comparison/inference/compositional/bridge-comparison; ships evidence **reasoning paths** | Medium-strong |
| **MuSiQue** | Trivedi et al. 2022, [arXiv 2108.00573](https://arxiv.org/abs/2108.00573), [GitHub](https://github.com/StonyBrookNLP/musique) | 24,814 (Ans) | Bottom-up from single-hop questions to force connected reasoning; 2–4 hops | **Strongest** — designed against shortcuts |

## What they test
Compositional reasoning: e.g., "Who is the spouse of the director of *Inception*?" requires hop1 (director → Nolan) then hop2 (Nolan → spouse). 2Wiki and MuSiQue give explicit decomposition / evidence chains; MuSiQue also has an unanswerable variant (MuSiQue-Full).

## Why relevant to us
These are the cleanest, best-studied **multi-hop** datasets, with gold supporting facts so we can grade *whether our `/recall` surfaced both hops*, not just the final answer. MuSiQue's anti-shortcut design + unanswerable items also give us **noise/abstention** signal. They are document-QA, not conversations, so we treat the supporting paragraphs as the memory store.

## Data format + concrete example
```json
{"question":"Who is the spouse of the director of Inception?",
 "answer":"Emma Thomas",
 "supporting_facts":[["Inception","directed by Christopher Nolan"],
                     ["Christopher Nolan","spouse Emma Thomas"]],
 "context":[ ...paragraphs incl. distractors... ]}
```

## Metrics
- Answer EM / F1; **supporting-fact EM/F1** (did you retrieve the right evidence); MuSiQue adds an "answerability" score.

## License / obtaining
HotpotQA CC BY-SA 4.0; 2Wiki Apache-2.0; MuSiQue CC BY 4.0. All on HF/GitHub.

## Maps to OUR categories
- multi-hop ✅✅ · recall ✅ · noise ✅ (distractor paragraphs; MuSiQue unanswerable)
- ambiguity ⚠️ (comparison questions) · temporal ❌ · fact-evolution ❌ · cross-session ❌ · extraction ⚠️

## How we'd adapt it to our HTTP contract
1. **Ingest:** push each context paragraph (incl. distractors) as a turn → `POST /turns` for a per-question synthetic user (or spread hop-1 and hop-2 facts across different **sessions** to make it cross-session multi-hop — a nice twist on our contract).
2. **Probe:** `POST /recall {query=question}`; grade (a) final answer and (b) whether both `supporting_facts` appear in the returned context (our true multi-hop signal).
3. Prefer **MuSiQue** for the headline multi-hop number (hardest, anti-shortcut) and to exercise abstention; use 2Wiki for typed reasoning categories.
