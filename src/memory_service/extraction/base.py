"""Extraction interface + the structured-memory value object.

An extractor turns raw conversation messages into typed, queryable memories.
This is the line between a memory service and a message log.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from ..models import Message

MEMORY_TYPES = ("fact", "preference", "opinion", "event")


@dataclass
class ExtractedMemory:
    type: str  # one of MEMORY_TYPES
    key: str  # canonical slot, e.g. "employment", "location", "pet:Biscuit"
    value: str  # human-readable value, e.g. "Notion as a PM"
    confidence: float = 0.7
    snippet: str = ""  # source text the memory was derived from
    # mutable == single-valued slot: a new value supersedes the old one.
    # additive (mutable=False): multiple coexisting values (e.g. several allergies).
    mutable: bool = True


class Extractor(Protocol):
    name: str

    def extract(
        self,
        messages: list[Message],
        *,
        user_id: str | None,
        session_id: str,
        turn_id: str,
        timestamp: str | None,
    ) -> list[ExtractedMemory]: ...
