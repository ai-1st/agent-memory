# Recommendations — Benchmark Suite for Our Memory Service

Scope reminder. Our HTTP contract: `POST /turns` (ingest+extract), `POST /recall` (formatted context under a token budget), `POST /search`, `GET /users/{id}/memories`, `DELETE /sessions/{id}`, `DELETE /users/{id}`, `GET /health`. Graded capabilities: **contradiction/fact-evolution, ambiguity, volume, multi-hop, temporal, noise, cross-session, extraction**, plus persistence/scoping/robustness/sync-correctness.

## 1. Capability → benchmark map

| Our capability | Primary | Secondary / alternatives |
|---|---|---|
| **Recall quality** (primary) | LongMemEval | LoCoMo, Zep DMR, NIAH |
| **Fact evolution / contradiction** | LongMemEval (knowledge-update) | MQuAKE-T + KnowEdit, TimeQA, MQuAKE-CF (locality) |
| **Multi-hop** | MuSiQue | LoCoMo (cat 2), 2WikiMultihopQA, BABILong, nested-KV (MemGPT), PerLTQA |
| **Temporal** | LongMemEval (temporal) | TimeQA, TempReason L3, LoCoMo (cat 3), Conversation Chronicles |
| **Noise / abstention** | LongMemEval (abstention) | RULER, NIAH, LoCoMo (cat 5), DialSim, MuSiQue-unanswerable |
| **Ambiguity / preferences** | PrefEval | LongMemEval (preference), DialSim referents |
| **Volume / long-context** | RULER (length sweep) | BABILong, LongMemEval-m, MemBench capacity curve, Conversation Chronicles |
| **Cross-session** | LoCoMo | MSC / Zep DMR, LongMemEval, Conversation Chronicles |
| **Extraction quality** | MSC persona summaries | PerLTQA (typed memories), PrefEval (implicit), MemBench |
| **Persistence / scoping / robustness / latency** | Custom fixture | DialSim (real-time deadline), MemBench (efficiency/capacity) |

## 2. Minimal suite for the fast iteration loop (adopt these first)

Pick **3 external + 1 custom**. Rationale: maximize capability coverage with minimal licensing/adaptation cost and high signal.

1. **LongMemEval** — *the anchor.* Its five abilities (extraction, multi-session, temporal, **knowledge-update**, **abstention**) are a near-rename of our rubric, so one dataset covers recall + fact-evolution + temporal + multi-hop + noise. Timestamped, scalable haystack maps cleanly to `/turns`→`/recall under budget`. Open on HF/GitHub, ICLR-vetted, comparable to vendors. *This is the single most important adoption.*

2. **LoCoMo** — *the comparability + cross-session anchor.* Multi-session conversational, per-category QA (single/multi-hop/temporal/adversarial), and the number every memory vendor (Mem0, Zep, LangMem) publishes — so our results are legible to the field. Only 10 convs / ~1,540 QA → cheap to run in CI. Adds genuine long multi-session structure LongMemEval's haystack lacks.

3. **RULER** (with NIAH as the quick smoke variant) — *the synthetic stress + volume + noise anchor.* Apache-2.0, fully synthetic, no licensing, infinitely length-scalable. Gives us the **effective-context-size** curve, multi-needle disambiguation, distractor noise resistance, and variable-tracking multi-hop — all controllable knobs LongMemEval/LoCoMo can't dial. Start with a 5-line NIAH smoke test in CI, graduate to RULER for the volume/noise sweep.

4. **Custom fixture** (section 3) — *the contract + assignment smoke test.* Hand-authored, deterministic, runs in seconds, and is the only thing that directly exercises `DELETE /sessions`, `DELETE /users`, restart-persistence, and the exact assignment scenarios (Berlin/NYC, Biscuit, Stripe→Notion). It is our day-to-day red/green gate before we pay for the big benchmarks.

**Scoring harness for all four:** adopt the **Mem0 three-axis scorecard** — `accuracy_by_category` (LLM-judge), `tokens_per_recall` (at the budget), `p50/p95 latency` — plus our extraction precision/recall. Report accuracy *at a token budget* (our differentiator).

**Deferred (add once the loop is stable):** MQuAKE-T + KnowEdit (sharp contradiction/locality), TimeQA (as-of recall), MuSiQue (hardest multi-hop), PrefEval (implicit-preference ambiguity), MemBench (capacity curve), DialSim (real-time latency). PerLTQA only if we add Chinese or want its typed-memory schema.

## 3. Custom fixture — assignment-aligned smoke test

Goal: a tiny, deterministic YAML/JSON fixture that drives `/turns` → probe `/recall`/`/search` → assert expected facts, covering every graded capability and every endpoint. Anchor user: `u_alice`. Timestamps make temporal/as-of probes real.

### 3a. Scripted conversations (ingest via `POST /turns`)

```yaml
user_id: u_alice
sessions:
  - session_id: s1            # 2026-01-10
    turns:
      - {role: user, ts: "2026-01-10T09:00", text: "Hey! I'm Alice. I live in Berlin."}
      - {role: user, ts: "2026-01-10T09:01", text: "I work at Stripe as a backend engineer."}
      - {role: user, ts: "2026-01-10T09:02", text: "I have a dog named Biscuit, a corgi."}
  - session_id: s2            # 2026-02-15  (cross-session, implicit fact, noise)
    turns:
      - {role: user, ts: "2026-02-15T18:00", text: "Biscuit and I went hiking near the lake all weekend."}  # implicit: likes hiking
      - {role: user, ts: "2026-02-15T18:05", text: "Thinking about a big change soon."}                      # vague, non-committal
  - session_id: s3            # 2026-03-20  (CONTRADICTION / fact-evolution)
    turns:
      - {role: user, ts: "2026-03-20T11:00", text: "Big news — I just left Stripe and joined Notion!"}
      - {role: user, ts: "2026-03-20T11:01", text: "Also I'm relocating from Berlin to New York City next month."}
  - session_id: s4            # 2026-04-25  (post-move confirmation)
    turns:
      - {role: user, ts: "2026-04-25T08:00", text: "Settled into NYC. Biscuit loves Central Park."}
```

### 3b. Probe queries → expected facts (after full ingest)

| # | Capability | `POST /recall` query | Expected (assert) |
|---|---|---|---|
| P1 | recall | "Where does Alice live?" | **New York City** (current); NOT Berlin as the answer |
| P2 | fact-evolution / contradiction | "Where does Alice work?" | **Notion** (current); Stripe present but **superseded** in history |
| P3 | temporal / as-of | "Where did Alice work in February 2026?" `as_of=2026-02-15` | **Stripe** (time-correct, not latest) |
| P4 | history retention | `GET /users/u_alice/memories` for employer | Two records: Stripe (valid s1→s3) + Notion (valid s3→now), with supersession link |
| P5 | multi-hop | "What city does the owner of the dog named Biscuit live in?" | **New York City** (Biscuit→Alice→current city) |
| P6 | extraction (implicit) | "What outdoor hobby does Alice enjoy?" | **hiking** (never stated as "hobby"; inferred from s2) |
| P7 | extraction (typed) | `GET /users/u_alice/memories` | typed memories: person=Alice, pet=Biscuit(corgi), employer, city, hobby |
| P8 | noise / abstention | "What is Alice's favorite programming language?" | **empty / low-confidence** context, no hallucination |
| P9 | cross-session | "Tell me about Alice's pet." | Biscuit (s1) + Central Park detail (s4) combined |
| P10 | ambiguity | "What's the big change Alice mentioned?" | resolves to the job/city change (s3), not the vague s2 line |

### 3c. Lifecycle / robustness probes (the endpoints no public benchmark covers)

| # | Capability | Action | Expected |
|---|---|---|---|
| L1 | persistence | ingest s1–s3 → **restart service** → run P1/P2 | identical answers (memory survives restart) |
| L2 | session-scoped delete | `DELETE /sessions/s3` → re-run P2 | employer reverts toward **Stripe**; s3 facts gone, s1/s2/s4 intact |
| L3 | user delete (GDPR) | `DELETE /users/u_alice` → re-run any probe | empty; `GET /users/u_alice/memories` → 404/empty |
| L4 | cross-user isolation | ingest `u_bob` "I live in Tokyo" → run P1 for u_alice | Tokyo never leaks into u_alice recall |
| L5 | synchronous correctness | `POST /turns` (s3 job change) then immediately `POST /recall` P2 | returns **Notion** with no read-after-write lag |
| L6 | health | `GET /health` | 200 + ready |
| L7 | token budget | run P9 with small `token_budget` | returns most-relevant facts, stays under budget, doesn't truncate the key fact |

### 3d. Why this fixture
- Deterministic and offline → runs in CI in seconds; no licensing.
- Hits **all 8 graded capabilities** + every endpoint (`/turns`, `/recall`, `/search`, `/users/{id}/memories`, `DELETE /sessions`, `DELETE /users`, `/health`).
- Mirrors the assignment's exact scenarios (Berlin→NYC, Biscuit multi-hop, Stripe→Notion), so a green run is direct evidence against the spec before we spend compute on LongMemEval/LoCoMo/RULER.

## TL;DR first move
Adopt **LongMemEval + LoCoMo + RULER(NIAH) + the custom fixture**, scored on the Mem0 accuracy/tokens/latency scorecard with accuracy-at-budget. Custom fixture is the CI gate; the three public sets give coverage, comparability, and scalable stress.
