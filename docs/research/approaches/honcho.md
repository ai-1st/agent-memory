# Honcho

## Overview
Honcho (Plastic Labs) is an AI-native memory/identity backend that models *who the user is* rather than just storing facts. Instead of key-value memories, it builds a running **psychological/representation model** of each user (preferences, communication style, goals, mental models) by reasoning over conversations after they happen ("Theory of Mind"). Its distinctive interface is the **dialectic API**: you query the user model in natural language ("what tone does this user prefer?") and it reasons over accumulated insights to answer, with multi-pass depth and cold/warm prompt selection.

- **Repo:** https://github.com/plastic-labs/honcho
- **Docs:** https://docs.honcho.to/
- **License:** open source (AGPL/Apache — verify in repo before use; flagged uncertain).
- **Maturity:** Medium — active, smaller community, novel approach; used in Nous Research's Hermes agent.

## Architecture
```
turn ──► store raw (peers: users AND agents are "peers")
            │
   background REASONING LAYER (Theory-of-Mind inference)
            │  derives insights: style, preferences, goals, patterns
            ▼
   user REPRESENTATION (accumulating psychological profile)
            ▲
            │  DIALECTIC API: NL query → multi-pass reasoning over rep
            │  cold-start prompts (general facts) vs warm prompts (session ctx)
        agent asks "how should I talk to this user?"
```
- **Peer model:** users and agents are both "peers," enabling multi-participant sessions.
- Reasoning is asynchronous/post-hoc, separate from the request path.

## Extraction strategy
- **Inferential, not transcriptive.** An LLM reasons about *implications* of the conversation (Theory of Mind) to derive non-explicit traits, then accumulates them. Goes beyond what the user literally said — strongest example of capturing **implicit** facts.
- Multi-pass dialectic (1–3 passes) to deepen inferences.

## Backing store(s)
- Postgres for sessions/messages/derived insights; embeddings for retrieval. (Confirm specifics in repo.)

## Recall / retrieval pipeline
- Query-time: the **dialectic** endpoint takes an NL question about the user and synthesizes an answer from stored representation + relevant session context.
- Cold/warm switching: cold queries pull general long-term user facts; warm queries prioritize current session.

## Contradiction / fact-evolution / temporal handling
- Less explicit than Zep/mem0. The representation is re-derived/updated over time; contradictions are smoothed by the reasoning layer rather than tracked as discrete supersessions. Weaker fit for our auditable `supersedes` requirement.

---

## ADR 1 — Inferential extraction (capture implicit traits, not just stated facts)
- **Status:** Considered (borrow selectively)
- **Context:** Our extraction must "capture implicit facts and corrections," not just literal statements. A user who keeps asking for terse answers has an implicit preference they never stated.
- **Decision:** Add an inference pass that proposes *implied* preferences/opinions (type=preference/opinion) with **lower confidence** than stated facts, clearly sourced as inferred.
- **Consequences:** (+) Richer personalization; satisfies the "implicit facts" requirement. (−) Inference hallucinates — must gate with confidence scores and let supersession correct it. (−) Extra LLM cost.

## ADR 2 — Natural-language query interface over the user model
- **Status:** Rejected as primary, noted as future
- **Context:** Honcho's dialectic answers NL questions instead of returning rows.
- **Decision:** Our contract returns structured memories (GET /users/{id}/memories) and prose (/recall); we will not make NL-dialectic the primary API.
- **Consequences:** (+) Structured output is testable and composable. (−) We give up the elegant "ask the memory a question" UX — could add it later as a thin layer over /search.

---

## Relevance to our contract
- **Borrow:** inferential extraction for implicit preferences/opinions (with confidence + `source=inferred`); cold-vs-warm prompt selection maps nicely onto our priority logic (session context vs long-term user facts).
- **Avoid for our scope:** making the user "representation" a black box — it conflicts with our requirement for discrete, auditable, supersedable memories. Keep insights as typed rows, not an opaque profile blob.
