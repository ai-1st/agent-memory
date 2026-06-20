"""LLM-backed extractor (optional variant).

Enabled with ``MEMORY_EXTRACTOR=llm``. Lazily imports the provider SDK so the
baseline image/tests never need it. On any failure (no key, network, bad JSON)
it falls back to the baseline extractor — extraction must never break ingestion.

This is intentionally a thin, defensible first cut: one structured-output call
per turn asking for typed memories. The CHANGELOG tracks how we iterate on the
prompt and schema.
"""

from __future__ import annotations

import json
import logging

from ..config import Settings
from ..models import Message
from .base import ExtractedMemory
from .baseline import BaselineExtractor

log = logging.getLogger("memory_service.extraction.llm")

_SYSTEM = """You extract durable, structured memories about the USER from a \
conversation turn. Return STRICT JSON: {"memories":[{"type","key","value",\
"confidence","mutable"}]}.
- type: one of fact|preference|opinion|event
- key: a stable canonical slot so later updates map to the same fact, e.g.
  "employment", "location", "diet", "pet:biscuit", "preference:typescript".
- value: short human-readable value, e.g. "Notion as a PM".
- confidence: 0..1.
- mutable: true if single-valued (a new value replaces the old, e.g. job,
  location); false if additive (e.g. one of several allergies/pets).
Only extract things about the user. Capture implicit facts ("walking Biscuit"
=> pet named Biscuit) and corrections. If nothing durable, return an empty list.
"""


class LLMExtractor:
    name = "llm"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.fallback = BaselineExtractor()

    def extract(
        self,
        messages: list[Message],
        *,
        user_id: str | None,
        session_id: str,
        turn_id: str,
        timestamp: str | None,
    ) -> list[ExtractedMemory]:
        convo = "\n".join(f"{m.role}: {m.content}" for m in messages if m.content)
        try:
            raw = self._call(convo)
            mems = _parse(raw)
            if mems:
                return mems
        except Exception as exc:  # noqa: BLE001 - never let extraction break ingest
            log.warning("LLM extraction failed (%s); falling back to baseline", exc)
        return self.fallback.extract(
            messages, user_id=user_id, session_id=session_id, turn_id=turn_id, timestamp=timestamp
        )

    def _call(self, convo: str) -> str:
        provider = self.settings.llm_provider
        if provider == "anthropic":
            import anthropic  # lazy

            model = self.settings.llm_model or "claude-haiku-4-5-20251001"
            client = anthropic.Anthropic(api_key=self.settings.anthropic_api_key)
            resp = client.messages.create(
                model=model,
                max_tokens=1024,
                system=_SYSTEM,
                messages=[{"role": "user", "content": convo}],
            )
            return "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")

        from openai import OpenAI  # lazy

        model = self.settings.llm_model or "gpt-4o-mini"
        client = OpenAI(api_key=self.settings.openai_api_key)
        resp = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": _SYSTEM},
                {"role": "user", "content": convo},
            ],
            response_format={"type": "json_object"},
            temperature=0,
        )
        return resp.choices[0].message.content or "{}"


def _parse(raw: str) -> list[ExtractedMemory]:
    data = json.loads(raw)
    items = data.get("memories", []) if isinstance(data, dict) else []
    out: list[ExtractedMemory] = []
    for it in items:
        try:
            key = str(it["key"]).strip()
            value = str(it["value"]).strip()
            if not key or not value:
                continue
            out.append(
                ExtractedMemory(
                    type=str(it.get("type", "fact")),
                    key=key,
                    value=value,
                    confidence=float(it.get("confidence", 0.7)),
                    mutable=bool(it.get("mutable", True)),
                    snippet=value,
                )
            )
        except (KeyError, TypeError, ValueError):
            continue
    return out
