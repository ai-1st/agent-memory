"""Recall interface.

A recaller assembles the prose context injected into the agent's next prompt,
plus citations, within a token budget.
"""

from __future__ import annotations

from typing import Protocol

from ..models import Citation


class RecallResult:
    def __init__(self, context: str, citations: list[Citation]) -> None:
        self.context = context
        self.citations = citations


class Recaller(Protocol):
    name: str

    def recall(
        self,
        *,
        query: str,
        user_id: str | None,
        session_id: str | None,
        max_tokens: int,
    ) -> RecallResult: ...
