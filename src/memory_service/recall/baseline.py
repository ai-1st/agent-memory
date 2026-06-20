"""Baseline recall: keyword-overlap + recency + type priority, assembled under
a token budget with explicit triage.

Ranking (per item): relevance = |query ∩ item| / |query| (token overlap), nudged
by confidence and recency. Vanilla cosine top-k is explicitly discouraged by the
spec, so even the baseline blends lexical overlap with structural priority and a
budget-aware assembler — the cheap, deterministic floor we benchmark embeddings
and rerankers against.

Priority logic under a tight budget (the design decision the spec asks us to
defend): stable user facts first, then query-relevant memories (opinions/events),
then recent conversation snippets. Rationale: stable facts are low-volume,
high-value, and frequently the thing a follow-up depends on ("what's their dog's
name?"); recent chatter is the most recoverable if cut. We always surface ALL
stable facts (budget permitting) rather than filtering by the query, which is
what makes multi-hop ("city of the user with the dog named Biscuit") work without
an explicit graph.
"""

from __future__ import annotations

from ..models import Citation
from ..store import Store
from ..text import token_set
from ..tokens import estimate_tokens
from .base import RecallResult

_STABLE_TYPES = ("fact", "preference")
_HEADER_FACTS = "## Known facts about this user"
_HEADER_RECENT = "## Relevant from recent conversations"


def _date(ts: str | None) -> str:
    return (ts or "")[:10]


def _relevance(qset: set[str], text: str) -> float:
    if not qset:
        return 0.0
    tset = token_set(text)
    if not tset:
        return 0.0
    return len(qset & tset) / len(qset)


class BaselineRecaller:
    name = "baseline"

    def __init__(self, store: Store) -> None:
        self.store = store

    def recall(
        self,
        *,
        query: str,
        user_id: str | None,
        session_id: str | None,
        max_tokens: int,
    ) -> RecallResult:
        qset = token_set(query)
        budget = max(0, max_tokens)

        memories = self.store.list_memories(user_id, active_only=True) if user_id else []
        stable = [m for m in memories if m["type"] in _STABLE_TYPES]
        episodic = [m for m in memories if m["type"] not in _STABLE_TYPES]

        # Stable facts: relevance-first, then confidence, then recency.
        stable.sort(
            key=lambda m: (
                _relevance(qset, f"{m['key']} {m['value']}"),
                m["confidence"],
                m["updated_at"],
            ),
            reverse=True,
        )

        turns = self.store.recent_turns(session_id=session_id, user_id=user_id, limit=50)
        scored_turns = sorted(
            ((_relevance(qset, t.text), t) for t in turns),
            key=lambda x: x[0],
            reverse=True,
        )
        scored_episodic = sorted(
            ((_relevance(qset, f"{m['key']} {m['value']}"), m) for m in episodic),
            key=lambda x: x[0],
            reverse=True,
        )

        lines: list[str] = []
        citations: list[Citation] = []
        used = [0]  # mutable closure cell

        def fits(extra: str) -> bool:
            return used[0] + estimate_tokens(extra) <= budget

        def emit(line: str) -> bool:
            if not fits(line + "\n"):
                return False
            lines.append(line)
            used[0] += estimate_tokens(line + "\n")
            return True

        # 1) Stable facts (always-on profile context).
        fact_lines: list[tuple[str, dict]] = []
        for m in stable:
            prior = self.store.superseded_values(user_id, m["key"])
            note = f" (updated {_date(m['updated_at'])}"
            if prior:
                note += f"; previously {prior[0]}"
            note += ")"
            fact_lines.append((f"- {m['value']}{note}", m))

        if fact_lines and fits(_HEADER_FACTS + "\n"):
            header_emitted = False
            for line, m in fact_lines:
                if not header_emitted:
                    if not emit(_HEADER_FACTS):
                        break
                    header_emitted = True
                if emit(line):
                    citations.append(
                        Citation(
                            turn_id=m["source_turn"] or "",
                            score=round(float(m["confidence"]), 4),
                            snippet=m["value"],
                        )
                    )

        # 2) Query-relevant episodic memories + recent conversation snippets.
        recent_items: list[tuple[float, str, Citation]] = []
        for score, m in scored_episodic:
            if score <= 0:
                continue
            line = f"- [{_date(m['updated_at'])}] {m['value']}"
            recent_items.append(
                (
                    score,
                    line,
                    Citation(
                        turn_id=m["source_turn"] or "", score=round(score, 4), snippet=m["value"]
                    ),
                )
            )
        for score, t in scored_turns:
            if score <= 0:
                continue
            snippet = t.text.replace("\n", " ")
            snippet = snippet[:240] + ("…" if len(snippet) > 240 else "")
            line = f"- [{_date(t.timestamp)}] {snippet}"
            recent_items.append(
                (score, line, Citation(turn_id=t.id, score=round(score, 4), snippet=snippet))
            )

        recent_items.sort(key=lambda x: x[0], reverse=True)
        if recent_items and fits(_HEADER_RECENT + "\n"):
            header_emitted = False
            for _score, line, cit in recent_items:
                if not header_emitted:
                    if not emit(_HEADER_RECENT):
                        break
                    header_emitted = True
                if emit(line):
                    citations.append(cit)

        return RecallResult(context="\n".join(lines).strip(), citations=citations)
