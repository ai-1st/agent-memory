# OpenAI ChatGPT Memory (as publicly known)

## Overview
ChatGPT's consumer memory is the highest-scale deployed memory product, but it's closed — details below are from OpenAI posts and reverse-engineering, so treat as *inferred*. It has two layers: (1) **Saved memories** — discrete user-fact snippets, originally user-instructed ("remember that…"), now also auto-extracted; visible and individually deletable. (2) **Chat history reference** (April 2025+) — the model can draw on patterns across *all* past conversations, not just the saved list. A 2025 "**dreaming**" update auto-curates memories in the background into a synthesized profile. Practical lessons here are about UX, transparency, and pitfalls, not internals.

- **OpenAI posts:** https://openai.com/index/memory-and-new-controls-for-chatgpt/ · https://openai.com/index/chatgpt-memory-dreaming/
- **License / maturity:** Proprietary; production at massive scale (Plus/Pro get both layers; free gets saved memories only).
- **Independent analysis (use with caution):** https://simonwillison.net/2025/May/21/chatgpt-new-memory/ · https://embracethered.com/blog/posts/2025/chatgpt-how-does-chat-history-memory-preferences-work/

## Architecture (inferred)
```
SAVED MEMORIES: discrete fact snippets (user- or auto-created),
                user-visible + deletable, injected into the system prompt

CHAT HISTORY REFERENCE: retrieval/synthesis over full past conversations

"DREAMING": background job curates/updates the synthesized user profile
```

## Extraction strategy (inferred)
- Hybrid: explicit user instruction + automatic LLM extraction of durable facts/preferences. Background "dreaming" consolidates and refreshes memories from history (reflection-like).

## Backing store(s)
- Not disclosed. Saved memories behave like a small structured list injected into context; history reference implies retrieval over conversation logs.

## Recall / retrieval pipeline (inferred)
- Saved memories appear to be injected wholesale (within a size cap); history reference is retrieval/synthesis at query time. Users report the injected "dossier" can become large and leak across contexts.

## Contradiction / fact-evolution / temporal handling
- Auto-curation/dreaming updates/replaces stale memories; users can delete individual memories. No public temporal/supersession model.

---

## ADR 1 — User-visible, individually-deletable memories (transparency + control)
- **Status:** Accepted (borrow — product/contract principle)
- **Context:** Our GET /users/{id}/memories and DELETE endpoints already expose memories. ChatGPT's experience shows users *need* to see and correct what's stored, and that opacity erodes trust.
- **Decision:** Keep memories first-class, inspectable, and individually deletable/correctable; record `source` so each memory is traceable to its turn.
- **Consequences:** (+) Trust, debuggability, GDPR-style control; aligns with our existing endpoints. (−) Requires keeping memories human-readable (favors structured rows over opaque embeddings/profile blobs).

## ADR 2 — Cap and scope injected memory ("dossier bloat")
- **Status:** Accepted (borrow the cautionary tale)
- **Context:** Reported failure mode: the auto-injected memory grows unbounded, wastes tokens, and bleeds irrelevant context into unrelated chats.
- **Decision:** Enforce a hard token budget in /recall (already in contract) AND scope strictly per user/session; never dump the full memory set — always rank + truncate, and prefer summaries when over budget.
- **Consequences:** (+) Directly validates our `max_tokens` + priority design; avoids the known ChatGPT pitfall. (−) Aggressive truncation can drop a needed fact — mitigate with the always-include core tier + good ranking.

---

## Relevance to our contract
- **Borrow:** transparency/control (inspectable, deletable, sourced memories) and the **two-layer split** (a small curated saved-fact set vs. broader history retrieval) — maps to our "always-include core" + ranked-retrieval design. **Borrow** the dossier-bloat lesson as direct justification for our token-budget + scoping logic.
- **Avoid:** opaque, unbounded auto-injected profiles and cross-context leakage. Our per-user scoping (requirement 6) and ranking/budget must prevent exactly this.
