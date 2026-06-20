# Letta (MemGPT)

## Overview
Letta (formerly MemGPT, from UC Berkeley) frames an LLM as an OS process with a memory hierarchy and lets the **agent itself** manage memory via tool calls. It defines three tiers — **core memory** (small, always in-context, like RAM), **recall memory** (searchable conversation history, like a disk cache), and **archival memory** (long-term vector store queried via tools, like cold storage). The agent decides what to remember by calling `core_memory_append` / `core_memory_replace` / archival insert/search during its reasoning loop. This is the canonical "self-editing memory" design.

- **Repo:** https://github.com/letta-ai/letta
- **Paper:** "MemGPT: Towards LLMs as Operating Systems" — https://arxiv.org/abs/2310.08560
- **License:** Apache 2.0
- **Maturity:** High — large community, hosted platform, active framework.

## Architecture
```
context window
┌───────────────────────────────────────────┐
│ system + tools                             │
│ CORE MEMORY (persona block, human block)   │ ◄── agent edits via tool calls
│ recent messages                            │
└───────────────────────────────────────────┘
        │ tool calls (memory functions)
        ▼
RECALL MEMORY (full conversation history, searchable)
ARCHIVAL MEMORY (vector DB: arbitrary facts, searched on demand)
```
- **Memory blocks** are labeled, persistent, editable strings. Conventional blocks: `human` (what the agent knows about the user) and `persona` (self-description); custom blocks for task/project state.
- "Sleep-time compute": memory consolidation/reorganization can run asynchronously between turns to improve quality without hurting response latency.

## Extraction strategy
- **Agent-driven, not a separate pipeline.** There is no offline extractor; the agent, mid-reasoning, decides "this is worth saving" and calls a memory tool. Importance judgment is delegated to the model.
- Newer "sleep-time" variants do offline reflection/reorganization of blocks and archival memory.

## Backing store(s)
- Relational DB (Postgres/SQLite) for agent state, blocks, message history.
- Vector store for archival memory (pgvector and others).

## Recall / retrieval pipeline
- Core memory is *always present* (no retrieval). Recall + archival are retrieved on demand via the agent's own search tool calls (semantic + filters).
- Retrieval is **agent-initiated**, not an automatic pre-prompt assembly step — different from our /recall, which must assemble context deterministically.

## Contradiction / fact-evolution / temporal handling
- Handled by `core_memory_replace` — the agent overwrites the block text when facts change. There is **no automatic supersession ledger**; history is whatever remains in the message log. Contradiction handling is as good (or bad) as the agent's in-the-moment judgment.

---

## ADR 1 — Always-in-context "core memory" block for high-value facts
- **Status:** Accepted (borrow the concept)
- **Context:** Some user facts (name, role, key preferences) should appear in *every* recall, never gambled on retrieval.
- **Decision:** Maintain a small, curated "always-include" set (a few top facts/preferences per user) that /recall injects unconditionally before similarity-ranked memories, within budget.
- **Consequences:** (+) Guarantees the most important facts survive; strong noise resistance and consistency. (+) Gives our priority logic a defensible top tier. (−) Must bound its size or it eats the token budget; needs a rule for what's promoted to "core."

## ADR 2 — Self-editing (agent-managed) memory
- **Status:** Rejected for our contract (note why)
- **Context:** Letta lets the agent decide what/when to store via tool calls.
- **Decision:** Our service owns extraction server-side (POST /turns) rather than depending on the calling agent to emit tool calls.
- **Consequences:** (+) Deterministic, testable extraction independent of client agent quality; consistent across clients. (+) Matches our HTTP contract (the client just posts a turn). (−) We lose the agent's in-context reasoning about salience — mitigate with a good extraction prompt.

---

## Relevance to our contract
- **Borrow:** the **core / archival distinction** → an "always-include" priority tier in /recall plus a retrieved tier. The RAM/disk/cold mental model is a clean way to reason about our token budget.
- **Borrow:** "sleep-time compute" → run consolidation/summarization asynchronously, off the synchronous POST /turns path, to keep latency down.
- **Avoid:** agent-driven extraction (our contract is server-side and deterministic) and overwrite-only correction with no supersession ledger (we need history + `supersedes`).
