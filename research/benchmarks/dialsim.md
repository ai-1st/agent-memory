# DialSim — Dialogue Simulator for Long-Term Multi-Party Dialogue

**Paper:** Kim et al., "DialSim: A (Real-Time) Dialogue Simulator for Evaluating Long-Term Multi-Party Dialogue Understanding of Conversational Agents" (arXiv 2406.13144).
**Links:** [arXiv 2406.13144](https://arxiv.org/abs/2406.13144) · [Project](https://dialsim.github.io/) · [GitHub](https://github.com/jiho283/Simulator)

## What it tests
The agent plays a **main character in a TV show** (Friends, The Big Bang Theory, The Office) and must answer **spontaneous questions from other characters within a time limit**, using info from past dialogue — and must say "I don't know" when the info isn't available. It is **real-time** (latency counts) and **multi-party** (>2 speakers), with character names anonymized/swapped to remove pretraining shortcuts. Supporting QA set: **LongDialQA** (~1,300 sessions, >1,000 questions each, hundreds of thousands of tokens).

## Why relevant to us
Two properties we want and most datasets lack: (1) a **hard time budget** on the answer (real-time recall, like our latency SLO), and (2) explicit **unanswerable / "don't know"** handling (noise resistance). Multi-party means memories must be **scoped per-speaker**, mirroring our per-user/session scoping and the multi-hop "which person said X" pattern.

## Data format + concrete example
Scripts segmented into sessions of multi-speaker turns `{speaker, utterance}`; questions are injected mid-stream with an answer + an "unanswerable yet" flag and a deadline.

```
[session 42]
Phoebe: Who did Ross say he's dating now?
(expected: answerable from session 37 → "Rachel"; if not yet stated → "I don't know")
```

## Size
- 3 show environments; LongDialQA ≈ 1,300 dialogue sessions, ~1,000+ questions per show, hundreds of thousands of tokens.

## Metrics
- Answer accuracy (incl. correct abstention) **under a time limit**; "real-time score" penalizing slow answers.

## License / obtaining
Code (simulator) on GitHub. Note: TV scripts are copyrighted — the repo distributes the harness/QA and instructions to obtain scripts; check repo for terms.

## Maps to OUR categories
- recall ✅ · cross-session ✅ · multi-hop ⚠️ (multi-party attribution) · noise ✅✅ (must abstain)
- temporal ⚠️ (event ordering) · volume ✅ (long shows) · ambiguity ✅ (who/what referent)
- **robustness/latency ✅✅ (real-time deadline — unique here)**

## How we'd adapt it to our HTTP contract
1. **Ingest:** stream each session's multi-speaker turns to `POST /turns`, tagging `role`/speaker per turn so memories are speaker-scoped.
2. **Probe at the cut point:** at each injected question, `POST /recall {query}` then answer; enforce our latency SLO as the "time limit" → this is a **synchronous-correctness + latency** test.
3. **Abstention:** for not-yet-stated questions, assert empty/low-confidence recall (noise).
4. Use it mainly for **latency-under-load** and **abstention**, complementing LongMemEval's offline categories. Mind script licensing before redistributing fixtures.
