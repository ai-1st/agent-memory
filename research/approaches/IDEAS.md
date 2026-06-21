# IDEAS — techniques to consider for our memory service

Deduplicated, categorized shortlist distilled from the per-system ADRs in this folder.
Flags: 👍 adopt · 🤔 consider · 👎 avoid (for our scope: a chat-turn memory HTTP service with fact-evolution, budgeted prose recall, structured search, per-user scoping).

Our contract recap: `POST /turns` (extract+persist, sync) · `POST /recall` (budgeted prose) · `POST /search` (structured) · `GET /users/{id}/memories` · DELETEs · types `{fact, preference, opinion, event}` with `confidence/source/supersedes/active`.

---

## Extraction techniques
| # | Technique | One-line tradeoff | Flag | Source(s) |
|---|-----------|-------------------|------|-----------|
| E1 | **Extract candidate facts via LLM, then reconcile** against retrieved existing memories with ADD/UPDATE/DELETE/NOOP | Solves dedup+correction+contradiction in one step; costs 2 LLM calls on the sync path | 👍 | mem0, LangMem |
| E2 | **Schema-constrained extraction** (JSON/Pydantic → our typed rows) | Reliable, testable structured output; rigid schema can miss novel facts | 👍 | LangMem, Cognee |
| E3 | **NOOP as explicit noise filter** in reconciliation | Cheap noise resistance; depends on candidate-retrieval recall | 👍 | mem0 |
| E4 | **Typed-key/ontology grounding** (canonical `key` slugs per type) so the same concept matches for dedup/supersession | Enables reliable matching; over-normalization loses nuance | 👍 | Cognee |
| E5 | **Inferential extraction** of *implicit* preferences/opinions (lower confidence, `source=inferred`) | Captures unstated traits (req: implicit facts); can hallucinate → gate by confidence | 🤔 | Honcho, Generative Agents |
| E6 | **Self-describing notes**: store an LLM context sentence + keywords/tags beside each `value` | Boosts recall + dedup; larger rows, metadata can be wrong | 🤔 | A-MEM |
| E7 | **Importance rating at write time** (LLM 1–10 or type prior) | Feeds recall priority; extra signal to compute/eval | 🤔 | Generative Agents |
| E8 | **Active (sync) + background (async) extraction split** | Predictable latency + eventual quality; eventual-consistency window | 👍 | LangMem, Letta (sleep-time) |
| E9 | Agent-driven self-editing (client emits memory tool calls) | Leverages agent reasoning; non-deterministic, off-contract for a server | 👎 | Letta |
| E10 | Procedural "rewrite the client's system prompt" memory | Powerful for behavior; out of scope for a context-returning service | 👎 | LangMem, Charlie Mnemonic |

## Backing store options
| # | Option | One-line tradeoff | Flag | Source(s) |
|---|--------|-------------------|------|-----------|
| B1 | **Postgres + pgvector** (facts, history, embeddings in one relational DB) | Simplest ops; bi-temporal + structured GET in one place; not best-in-class ANN at huge scale | 👍 | Semantic Kernel, mem0 |
| B2 | **Separate append-only history table** (every ADD/UPDATE/DELETE recorded) | Auditable "keep history, return current"; extra writes | 👍 | mem0 |
| B3 | **Pluggable store interface** (default pgvector, swap to Qdrant/Azure later) | Portability + in-mem test impl; hides backend-specific hybrid search | 👍 | Semantic Kernel |
| B4 | **Lightweight in-row link list** (related-memory IDs) for cheap multi-hop | Multi-hop without a graph DB; link quality drives results | 🤔 | A-MEM |
| B5 | Dedicated graph DB (Neo4j/FalkorDB) as the spine | Native multi-hop + bi-temporal edges; real ops cost, slower/costlier (mem0g benchmark) | 👎 (initially) | Zep/Graphiti, Memary, Cognee, mem0g |
| B6 | FAISS-only / flat vector index | Fast to start; no relational/temporal/structured query support | 👎 | MemoryBank |

## Recall / ranking techniques
| # | Technique | One-line tradeoff | Flag | Source(s) |
|---|-----------|-------------------|------|-----------|
| R1 | **Weighted score = relevance + importance + recency** (recency = exp decay) | Transparent, tunable, defensible priority; weights need eval; pin `active` above decay | 👍 | Generative Agents |
| R2 | **Hybrid retrieval: semantic + BM25, fused with RRF** | Big gains on names/IDs/noisy queries; two indexes to maintain | 👍 | Zep/Graphiti, mem0 |
| R3 | **"Always-include core" tier** (top few facts/prefs injected unconditionally) | Guarantees key facts survive truncation; must bound its size | 👍 | Letta, ChatGPT, MemoryBank, Charlie |
| R4 | **Type-aware recall policy** (facts/prefs ranked; events for temporal Q; instructions always-on) | Sharper priority logic; more branching | 🤔 | LangMem |
| R5 | **Decay + reinforce-on-recall strength** for noise resistance | Self-pruning; could fade rare-but-important facts → protect active/high-importance | 🤔 | MemoryBank |
| R6 | **Cross-encoder / MMR rerank** of fused candidates | Precision + diversity; added latency | 🤔 | Zep/Graphiti |
| R7 | **Feedback-weighted ranking** (usefulness boosts) | Self-improving; needs feedback signal, risks entrenchment | 👎 (defer) | Cognee, Memary |
| R8 | Entity-frequency ranking as a *minor* signal | Surfaces user's core topics; frequency ≠ importance | 🤔 | Memary |

## Contradiction & fact-evolution
| # | Technique | One-line tradeoff | Flag | Source(s) |
|---|-----------|-------------------|------|-----------|
| C1 | **Invalidate-don't-delete**: superseded memory keeps a row, gets marked inactive | Clean current+history; maps to `active`/`supersedes`; more write logic | 👍 | Zep/Graphiti, mem0 |
| C2 | **Bi-temporal: valid-time + transaction-time** (`valid_from/to` + `created/updated`) | Enables point-in-time queries; extra columns, often aspirational | 🤔 | Zep/Graphiti |
| C3 | **LLM conflict detection on insert** (reconcile candidate vs. retrieved old) | Catches contradictions/corrections automatically; recall-dependent, LLM cost | 👍 | mem0, Zep/Graphiti |
| C4 | **Confidence on every memory**, lower for inferred, used to break ties | Graceful handling of uncertain/inferred facts; needs calibration | 👍 | Honcho, (our contract) |
| C5 | Recency-decay as the *only* contradiction handling | Cheap; can't distinguish "contradicted" from "old" | 👎 | Generative Agents, MemoryBank |
| C6 | Overwrite-in-place with no history ledger | Simple; loses auditability our contract requires | 👎 | Letta, ChatGPT |

## Context-budget assembly
| # | Technique | One-line tradeoff | Flag | Source(s) |
|---|-----------|-------------------|------|-----------|
| A1 | **Hard token budget + rank-then-truncate, never dump all** | Avoids ChatGPT "dossier bloat"; aggressive truncation can drop a needed fact | 👍 | ChatGPT (cautionary), Zep |
| A2 | **Hierarchical summaries swapped in when budget tight** (leaf facts → topic/user summary) | Dense, coherent context under budget; summaries must be invalidated on supersession | 👍 | RAPTOR, Zep communities, MemoryBank |
| A3 | **Reflection / background rollups** generating higher-level memories from clusters | Captures emergent prefs; compute cost, can be wrong → route via confidence/supersede | 🤔 | Generative Agents, A-MEM, MemoryBank |
| A4 | **Priority tiers in assembly**: core (always) → active high-confidence facts → ranked retrieval → summaries | Defensible, explainable budget logic; tier rules need tuning | 👍 | Letta, ChatGPT, synthesis |
| A5 | **Cold vs. warm context selection** (general user facts vs. current-session) | Right context for the situation; needs session signal in the query | 🤔 | Honcho |

## Multi-hop
| # | Technique | One-line tradeoff | Flag | Source(s) |
|---|-----------|-------------------|------|-----------|
| M1 | **One-hop link expansion** from top vector hits (lightweight links, no graph DB) | Cheap multi-hop on top of vectors; can pull noise → bound + rerank | 👍 | A-MEM |
| M2 | **Personalized PageRank** over an entity graph (single-pass multi-hop) | Best principled multi-hop; requires building/maintaining entity graph | 🤔 (only if we commit to a graph) | HippoRAG / HippoRAG 2 |
| M3 | **Query decomposition** (LLM splits multi-hop query into sub-queries) | No graph needed; extra LLM calls per query | 🤔 | (general / HippoRAG comparison) |
| M4 | Full graph traversal as default retrieval | Native multi-hop; ops cost, slower, not uniformly better (mem0g) | 👎 (initially) | Zep, mem0g, Memary, Cognee |

---

## Top 5 recommendations
1. **Extract → retrieve → reconcile (ADD/UPDATE/DELETE/NOOP)** as the POST /turns core — the single best fit for our extraction + contradiction requirements. *(E1, C3; mem0/LangMem)*
2. **Invalidate-don't-delete with `active`/`supersedes` + an append-only history table** — copy Zep's bi-temporal spirit in plain Postgres rows; nail fact-evolution with full auditability. *(C1, B1, B2; Zep/mem0)*
3. **Weighted recall ranking = relevance + importance + recency, over hybrid semantic+BM25 (RRF)** — defensible, tunable priority logic that handles names and noise. *(R1, R2; Generative Agents + Zep)*
4. **Tiered, budget-aware context assembly**: always-include core → active high-confidence facts → ranked retrieval → hierarchical summaries when over budget; rank-then-truncate, never dump. *(A4, A2, A1, R3; Letta/RAPTOR/ChatGPT lessons)*
5. **Lightweight one-hop link expansion for multi-hop** (related-memory links on top of vectors), keeping a graph DB / PPR as a later upgrade only if single-hop proves insufficient. *(M1, B4; A-MEM, with HippoRAG PPR as the upgrade path)*
