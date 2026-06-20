"""Shared lightweight text utilities (tokenization for keyword scoring).

Deliberately dependency-free so the baseline runs fully offline and fast.
"""

from __future__ import annotations

import re

_WORD_RE = re.compile(r"[a-z0-9]+")

# Small, hand-picked stopword set. We keep it short on purpose: dropping too many
# tokens hurts keyword recall on short queries like "where do they live".
STOPWORDS: frozenset[str] = frozenset(
    """
    a an the this that these those is are was were be been being am
    i me my we our you your he she it they them his her its their
    of to in on at for with and or but if then than so as by from into
    do does did done has have had having will would can could should
    what when where who whom which why how about not no yes
    """.split()
)


def tokenize(text: str, *, drop_stopwords: bool = True) -> list[str]:
    """Lowercase, split into alphanumeric tokens, optionally drop stopwords."""
    if not text:
        return []
    toks = _WORD_RE.findall(text.lower())
    if drop_stopwords:
        toks = [t for t in toks if t not in STOPWORDS]
    return toks


def token_set(text: str, *, drop_stopwords: bool = True) -> set[str]:
    return set(tokenize(text, drop_stopwords=drop_stopwords))
