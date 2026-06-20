"""Extractor factory — selects the pipeline from settings."""

from __future__ import annotations

from ..config import Settings
from .base import ExtractedMemory, Extractor
from .baseline import BaselineExtractor

__all__ = ["Extractor", "ExtractedMemory", "build_extractor"]


def build_extractor(settings: Settings) -> Extractor:
    if settings.extractor == "llm":
        from .llm import LLMExtractor

        return LLMExtractor(settings)
    return BaselineExtractor()
