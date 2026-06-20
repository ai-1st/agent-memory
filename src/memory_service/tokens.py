"""Token budgeting helpers.

The recall contract asks us to respect ``max_tokens`` approximately ("don't blow
past it by 2x"). A real tokenizer (tiktoken) would add a heavy dependency and a
first-run network download, which fights our build-speed goal. The ~4-chars-per-
token heuristic is well within the allowed tolerance for English prose; we can
swap in an exact tokenizer later as a benchmarked variant.
"""

from __future__ import annotations

CHARS_PER_TOKEN = 4


def estimate_tokens(text: str) -> int:
    if not text:
        return 0
    return max(1, (len(text) + CHARS_PER_TOKEN - 1) // CHARS_PER_TOKEN)
