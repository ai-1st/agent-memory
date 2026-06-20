"""Pydantic request/response models matching the HTTP contract (§3 of the spec).

We are intentionally lenient on inputs (extra fields ignored, roles free-form) so
the service is resilient to odd-but-valid payloads, while staying strict enough
that genuinely malformed requests get a 422 instead of a crash.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

# --------------------------------------------------------------------------- #
# Requests
# --------------------------------------------------------------------------- #


class Message(BaseModel):
    model_config = ConfigDict(extra="ignore")

    role: str
    content: str = ""
    name: str | None = None


class TurnRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    session_id: str = Field(min_length=1)
    user_id: str | None = None
    messages: list[Message] = Field(min_length=1)
    timestamp: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class RecallRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    query: str
    session_id: str | None = None
    user_id: str | None = None
    max_tokens: int = 1024


class SearchRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    query: str
    session_id: str | None = None
    user_id: str | None = None
    limit: int = 10


# --------------------------------------------------------------------------- #
# Responses
# --------------------------------------------------------------------------- #


class TurnResponse(BaseModel):
    id: str


class Citation(BaseModel):
    turn_id: str
    score: float
    snippet: str


class RecallResponse(BaseModel):
    context: str
    citations: list[Citation]


class SearchResult(BaseModel):
    content: str
    score: float
    session_id: str | None = None
    timestamp: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class SearchResponse(BaseModel):
    results: list[SearchResult]


class Memory(BaseModel):
    id: str
    type: str
    key: str
    value: str
    confidence: float
    source_session: str | None = None
    source_turn: str | None = None
    created_at: str
    updated_at: str
    supersedes: str | None = None
    active: bool


class MemoriesResponse(BaseModel):
    memories: list[Memory]
