"""Runtime configuration, read from the environment.

Strategy selection (extractor/recaller) is env-driven so we can A/B different
pipelines against the same benchmark harness without code changes.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


@dataclass
class Settings:
    db_path: str = "/data/memory.db"
    auth_token: str = ""
    extractor: str = "baseline"  # baseline | llm
    recaller: str = "baseline"  # baseline
    llm_provider: str = "openai"  # openai | anthropic
    llm_model: str = ""
    openai_api_key: str = ""
    anthropic_api_key: str = ""
    port: int = 8080

    @classmethod
    def load(cls) -> Settings:
        return cls(
            db_path=_env("MEMORY_DB_PATH", "/data/memory.db"),
            auth_token=_env("MEMORY_AUTH_TOKEN", ""),
            extractor=_env("MEMORY_EXTRACTOR", "baseline").lower(),
            recaller=_env("MEMORY_RECALLER", "baseline").lower(),
            llm_provider=_env("MEMORY_LLM_PROVIDER", "openai").lower(),
            llm_model=_env("MEMORY_LLM_MODEL", ""),
            openai_api_key=_env("OPENAI_API_KEY", ""),
            anthropic_api_key=_env("ANTHROPIC_API_KEY", ""),
            port=int(_env("PORT", "8080") or "8080"),
        )
