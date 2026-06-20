"""Deterministic, offline rule-based extractor (baseline).

Why rule-based for v0: it is instant, free, and 100% reproducible, which makes it
the perfect substrate for the self-eval loop and CI (no network, no flakiness).
It recognises the high-value categories the spec calls out — employment,
location/moves, pets (incl. implicit), diet, allergies, preferences/opinions,
names, family, simple corrections. The LLM extractor (see ``llm.py``) is the
quality upgrade we benchmark against this floor.

It is intentionally precision-leaning: a missed fact is recoverable by the next
turn or the LLM extractor; a wrong fact pollutes recall.
"""

from __future__ import annotations

import re

from ..models import Message
from .base import ExtractedMemory

# Capture a "place" or "org" — letters, spaces, &.-' — stop at sentence punctuation.
_ENT = r"([A-Za-z][\w&.'\- ]*?[A-Za-z])"


def _clean(s: str) -> str:
    return s.strip(" .,!?;:—–-")


class BaselineExtractor:
    name = "baseline"

    def extract(
        self,
        messages: list[Message],
        *,
        user_id: str | None,
        session_id: str,
        turn_id: str,
        timestamp: str | None,
    ) -> list[ExtractedMemory]:
        out: list[ExtractedMemory] = []
        for msg in messages:
            # We only mine first-person statements from the user. Assistant/tool
            # text describes the world, not the user, so it is a precision trap.
            if (msg.role or "").lower() != "user":
                continue
            text = (msg.content or "").strip()
            if not text:
                continue
            out.extend(self._extract_from_text(text))
        return _dedupe(out)

    # ------------------------------------------------------------------ #
    def _extract_from_text(self, text: str) -> list[ExtractedMemory]:
        found: list[ExtractedMemory] = []
        for sentence in re.split(r"(?<=[.!?])\s+|\n+", text):
            s = sentence.strip()
            if not s:
                continue
            found.extend(self._employment(s))
            found.extend(self._location(s))
            found.extend(self._pet(s))
            found.extend(self._diet(s))
            found.extend(self._allergy(s))
            found.extend(self._name(s))
            found.extend(self._family(s))
            found.extend(self._preference(s))
        return found

    def _employment(self, s: str) -> list[ExtractedMemory]:
        m = re.search(
            r"\bI(?:'m| am)?\s+(?:now\s+)?(?:work(?:ing)?\s+(?:at|for)|just\s+(?:joined|started(?:\s+(?:at|working\s+at))?)|joined|started\s+(?:a\s+(?:new\s+)?job\s+at|at)|got\s+a\s+job\s+at)\s+"
            + _ENT
            + r"(?:\s+as\s+(?:an?\s+)?([\w \-]+?))?(?:[.,!?]|$)",
            s,
            re.IGNORECASE,
        )
        if not m:
            return []
        company = _clean(m.group(1))
        role = _clean(m.group(2)) if m.group(2) else ""
        if not company:
            return []
        value = f"{company} as a {role}" if role else company
        return [
            ExtractedMemory(type="fact", key="employment", value=value, confidence=0.85, snippet=s)
        ]

    def _location(self, s: str) -> list[ExtractedMemory]:
        mv: list[ExtractedMemory] = []
        moved = re.search(
            r"\bI\s+(?:just\s+|recently\s+)?moved\s+to\s+"
            + _ENT
            + r"(?:\s+from\s+"
            + _ENT
            + r")?(?:[.,!?]|$)",
            s,
            re.IGNORECASE,
        )
        if moved:
            new_loc = _clean(moved.group(1))
            if new_loc:
                mv.append(
                    ExtractedMemory(
                        type="fact", key="location", value=new_loc, confidence=0.85, snippet=s
                    )
                )
            return mv
        lives = re.search(
            r"\bI(?:'m| am)?\s+(?:live|living|based|located)\s+in\s+" + _ENT + r"(?:[.,!?]|$)",
            s,
            re.IGNORECASE,
        )
        if lives:
            loc = _clean(lives.group(1))
            if loc:
                mv.append(
                    ExtractedMemory(
                        type="fact", key="location", value=loc, confidence=0.8, snippet=s
                    )
                )
        return mv

    def _pet(self, s: str) -> list[ExtractedMemory]:
        out: list[ExtractedMemory] = []
        named = re.search(
            r"\b(?:my|a|our)\s+(dog|cat|puppy|kitten|bird|hamster|rabbit)\s+(?:named|called)\s+([A-Z][\w]+)",
            s,
        )
        if named:
            species, name = named.group(1).lower(), named.group(2)
            out.append(
                ExtractedMemory(
                    type="fact",
                    key=f"pet:{name.lower()}",
                    value=f"has a {species} named {name}",
                    confidence=0.85,
                    snippet=s,
                    mutable=False,
                )
            )
            return out
        # Implicit: "walking Biscuit this morning" -> has a pet named Biscuit.
        walking = re.search(r"\bwalking\s+(?:my\s+)?(?:dog\s+|cat\s+)?([A-Z][\w]+)", s)
        if walking:
            name = walking.group(1)
            out.append(
                ExtractedMemory(
                    type="fact",
                    key=f"pet:{name.lower()}",
                    value=f"has a pet named {name}",
                    confidence=0.55,
                    snippet=s,
                    mutable=False,
                )
            )
        return out

    def _diet(self, s: str) -> list[ExtractedMemory]:
        m = re.search(
            r"\bI(?:'m| am)?\s+(?:a\s+)?(vegetarian|vegan|pescatarian)\b", s, re.IGNORECASE
        )
        if not m:
            return []
        return [
            ExtractedMemory(
                type="preference",
                key="diet",
                value=m.group(1).lower(),
                confidence=0.85,
                snippet=s,
            )
        ]

    def _allergy(self, s: str) -> list[ExtractedMemory]:
        m = re.search(r"\ballergic\s+to\s+" + _ENT + r"(?:[.,!?]|$)", s, re.IGNORECASE)
        if not m:
            return []
        what = _clean(m.group(1)).lower()
        if not what:
            return []
        return [
            ExtractedMemory(
                type="fact",
                key=f"allergy:{what}",
                value=f"allergic to {what}",
                confidence=0.85,
                snippet=s,
                mutable=False,
            )
        ]

    def _name(self, s: str) -> list[ExtractedMemory]:
        m = re.search(r"\bmy name is\s+([A-Z][\w]+)", s)
        if not m:
            return []
        return [
            ExtractedMemory(type="fact", key="name", value=m.group(1), confidence=0.9, snippet=s)
        ]

    def _family(self, s: str) -> list[ExtractedMemory]:
        m = re.search(
            r"\bmy\s+(wife|husband|partner|son|daughter|mother|father|brother|sister|kid|child)\b"
            r"(?:\s+(?:is\s+|named\s+|called\s+)([A-Z][\w]+))?",
            s,
            re.IGNORECASE,
        )
        if not m:
            return []
        relation = m.group(1).lower()
        name = m.group(2)
        value = f"{relation} named {name}" if name else f"has a {relation}"
        return [
            ExtractedMemory(
                type="fact",
                key=f"family:{relation}",
                value=value,
                confidence=0.7,
                snippet=s,
                mutable=bool(name),
            )
        ]

    def _preference(self, s: str) -> list[ExtractedMemory]:
        m = re.search(
            r"\bI\s+(love|really like|like|enjoy|prefer|hate|dislike|can't stand|don't like)\s+"
            + _ENT
            + r"(?:[.,!?]|$)",
            s,
            re.IGNORECASE,
        )
        if not m:
            return []
        verb = m.group(1).lower()
        topic = _clean(m.group(2))
        if not topic or len(topic) > 60:
            return []
        # Opinions evolve along an arc; we treat the topic as a single slot so a
        # later, opposite statement supersedes the earlier one (history preserved).
        topic_key = re.sub(r"\s+", "_", topic.lower())
        return [
            ExtractedMemory(
                type="preference",
                key=f"preference:{topic_key}",
                value=f"{verb} {topic}",
                confidence=0.65,
                snippet=s,
            )
        ]


def _dedupe(mems: list[ExtractedMemory]) -> list[ExtractedMemory]:
    seen: set[tuple[str, str]] = set()
    out: list[ExtractedMemory] = []
    for m in mems:
        sig = (m.key, m.value.lower())
        if sig in seen:
            continue
        seen.add(sig)
        out.append(m)
    return out
