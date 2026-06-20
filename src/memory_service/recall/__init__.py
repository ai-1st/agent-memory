"""Recaller factory — selects the pipeline from settings."""

from __future__ import annotations

from ..config import Settings
from ..store import Store
from .base import Recaller, RecallResult
from .baseline import BaselineRecaller

__all__ = ["Recaller", "RecallResult", "build_recaller"]


def build_recaller(settings: Settings, store: Store) -> Recaller:
    # Only the baseline recaller exists today; future variants (hybrid, rerank,
    # graph) register here and are selected by MEMORY_RECALLER.
    return BaselineRecaller(store)
