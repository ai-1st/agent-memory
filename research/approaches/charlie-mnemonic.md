# Charlie Mnemonic (GoodAI)

## Overview
Charlie Mnemonic (GoodAI, 2024) is an open-source personal assistant marketed as "the first with long-term memory." It combines **Long-Term Memory (LTM)**, **Short-Term Memory (STM)**, and **episodic memory** on top of GPT-4 to simulate human-like memory. It stores not just facts (names, birthdays, workplaces) but also **instructions and learned skills**, and integrates user messages, assistant responses, and environmental feedback into LTM for later retrieval. It's an application-level demonstration rather than a memory API.

- **Repo:** https://github.com/GoodAI/charlie-mnemonic
- **Announcement:** https://www.goodai.com/introducing-charlie-mnemonic/
- **License:** open source (GoodAI; verify exact license in repo)
- **Maturity:** Low-Medium — a working product/demo, not a memory service with a clean contract.

## Architecture
```
turn ──► STM (immediate working context)
     ──► EPISODIC memory (specific past interactions)
     ──► LTM (facts + instructions + skills, integrated over time)
              │
     retrieval blends STM/episodic/LTM into the GPT-4 context window
```
- Tiered like Letta/MemGPT (working vs. episodic vs. long-term), but oriented at an end-user assistant.

## Extraction strategy
- LLM-driven; integrates messages, responses, and **environmental feedback** into LTM. Notably stores **procedural** content (instructions/skills), not only declarative facts.

## Backing store(s)
- Local DB + vector retrieval (implementation-specific; verify in repo).

## Recall / retrieval pipeline
- Blends the three tiers into context per turn; standard semantic retrieval over LTM/episodic plus current STM.

## Contradiction / fact-evolution / temporal handling
- Not a documented strength; relies on LTM updates over time rather than explicit supersession/temporal tracking.

---

## ADR 1 — Store instructions/skills, not just declarative facts
- **Status:** Considered (note, low priority for our scope)
- **Context:** Users sometimes state durable *instructions* ("always answer in metric units") that are neither a fact nor a fleeting message.
- **Decision:** Recognize standing-instruction-style memories (closest to a `preference` in our enum) and treat them as always-injected when active.
- **Consequences:** (+) Captures durable behavioral guidance users expect honored every turn (overlaps Letta core, LangMem procedural). (−) Risk of contradictory standing instructions — must go through supersession like any other memory.

---

## Relevance to our contract
- **Borrow:** the idea that durable user *instructions/preferences* deserve always-on injection (reinforces the Letta "core" tier). Tiered STM/episodic/LTM is consistent with the other systems but adds little new beyond Letta.
- **Avoid:** treating Charlie as an architectural template — it's an end-user app without a clean extraction/contradiction model or service contract. Low signal relative to mem0/Zep/Letta.
