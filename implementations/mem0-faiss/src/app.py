"""
Vanilla mem0 + FAISS memory service — a *baseline* for stack-ranking against our
own builds on the same LoCoMo bench.

This is intentionally thin: it wraps the off-the-shelf `mem0` pipeline (its own
extraction + fact-management prompts) behind the same HTTP contract our bench
harness drives. The only non-default choices are the backends, picked for an
apples-to-apples comparison with our builds:
  - vector store: FAISS (local)
  - LLM:          Anthropic Claude Haiku 4.5  (same model our builds default to)
  - embeddings:   OpenAI text-embedding-3-large (3072-dim, same as ours)

So differences in the LoCoMo score reflect the *memory pipeline*, not the model.
"""

import os
import threading
import time
from typing import Any, Optional

from fastapi import FastAPI, Response
from pydantic import BaseModel

MODEL = os.environ.get("MEMORY_LLM_MODEL", "claude-haiku-4-5-20251001")
EMBED_MODEL = os.environ.get("MEMORY_EMBED_MODEL", "text-embedding-3-large")
EMBED_DIMS = int(os.environ.get("MEMORY_EMBED_DIM", "3072"))
DATA_DIR = os.environ.get("MEMORY_DATA_DIR", os.path.join(os.path.dirname(__file__), "..", "data", "faiss"))
RECALL_LIMIT = int(os.environ.get("MEM0_RECALL_LIMIT", "10"))

os.makedirs(DATA_DIR, exist_ok=True)

from mem0 import Memory  # noqa: E402  (import after env is read)

CONFIG = {
    "vector_store": {
        "provider": "faiss",
        "config": {
            "collection_name": "mem0",
            "path": DATA_DIR,
            "embedding_model_dims": EMBED_DIMS,
        },
    },
    "llm": {
        "provider": "anthropic",
        "config": {"model": MODEL, "temperature": 0.0, "max_tokens": 2000},
    },
    "embedder": {
        "provider": "openai",
        "config": {"model": EMBED_MODEL, "embedding_dims": EMBED_DIMS},
    },
    "version": "v1.1",
}

mem = Memory.from_config(CONFIG)


def _patch_anthropic_top_p(memory) -> None:
    """Claude 4.x rejects `temperature` and `top_p` together; mem0's Anthropic
    wrapper sends both. Strip `top_p` at the client boundary — a provider-compat
    shim only (mirrors the fix our TS builds apply). mem0's memory pipeline,
    prompts, and logic are untouched, so this stays 'vanilla mem0'."""
    client = getattr(getattr(memory, "llm", None), "client", None)
    msgs = getattr(client, "messages", None)
    if msgs is None:
        return
    original = msgs.create

    def create(*args, **kwargs):
        kwargs.pop("top_p", None)
        return original(*args, **kwargs)

    msgs.create = create


_patch_anthropic_top_p(mem)

# FAISS + mem0's in-place index isn't safe under concurrent writes; the bench
# ingests multiple users concurrently. Serialize all memory ops with one lock —
# correctness over throughput for a baseline.
_lock = threading.Lock()

app = FastAPI(title="mem0-faiss baseline")


def _items(res: Any) -> list:
    """mem0 returns either {"results": [...]} (v1.1) or a bare list (older)."""
    if isinstance(res, dict):
        return res.get("results", [])
    return res or []


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/metrics")
def metrics():
    # Vanilla mem0 does not surface token counters; report zeros (cost untracked
    # for this baseline, like our no-LLM control).
    return {"llm": {"calls": 0, "input_tokens": 0, "output_tokens": 0},
            "embedding": {"calls": 0, "tokens": 0}}


class Turn(BaseModel):
    session_id: str
    user_id: Optional[str] = None
    messages: list[dict[str, Any]]
    timestamp: Optional[str] = None
    metadata: Optional[dict[str, Any]] = {}


@app.post("/turns", status_code=201)
def turns(t: Turn):
    uid = t.user_id or t.session_id
    msgs = [{"role": m.get("role", "user"), "content": m.get("content", "")}
            for m in t.messages if m.get("content")]
    if msgs:
        meta = {"session_id": t.session_id}
        if t.timestamp:
            meta["timestamp"] = t.timestamp
        with _lock:
            mem.add(msgs, user_id=uid, metadata=meta)
    return {"id": f"turn_{int(time.time() * 1000)}"}


class Recall(BaseModel):
    query: str
    session_id: Optional[str] = None
    user_id: Optional[str] = None
    max_tokens: int = 1024


@app.post("/recall")
def recall(r: Recall):
    uid = r.user_id or r.session_id
    if not uid or not r.query.strip():
        return {"context": "", "citations": []}
    with _lock:
        res = mem.search(r.query, user_id=uid, limit=RECALL_LIMIT)
    items = _items(res)
    lines, cites, used = [], [], 0
    budget = max(0, r.max_tokens)
    for it in items:
        text = (it.get("memory") or it.get("text") or "").strip()
        if not text:
            continue
        cost = len(text) // 4 + 1
        if used + cost > budget:
            break
        lines.append(f"- {text}")
        used += cost
        cites.append({"turn_id": str(it.get("id", "")),
                      "score": float(it.get("score", 0.0) or 0.0),
                      "snippet": text[:200]})
    context = "## Known facts about this user\n" + "\n".join(lines) if lines else ""
    return {"context": context, "citations": cites}


@app.get("/users/{user_id}/memories")
def memories(user_id: str):
    with _lock:
        items = _items(mem.get_all(user_id=user_id))
    out = [{"id": str(it.get("id", "")), "type": "fact", "key": "",
            "value": it.get("memory", ""), "confidence": 1.0,
            "source_session": (it.get("metadata") or {}).get("session_id", ""),
            "created_at": it.get("created_at", ""), "updated_at": it.get("updated_at", ""),
            "supersedes": None, "active": True}
           for it in items]
    return {"memories": out}


class Search(BaseModel):
    query: str
    session_id: Optional[str] = None
    user_id: Optional[str] = None
    limit: int = 10


@app.post("/search")
def search(s: Search):
    uid = s.user_id or s.session_id
    if not uid:
        return {"results": []}
    with _lock:
        items = _items(mem.search(s.query, user_id=uid, limit=s.limit))
    return {"results": [{"content": it.get("memory", ""),
                         "score": float(it.get("score", 0.0) or 0.0),
                         "session_id": (it.get("metadata") or {}).get("session_id", ""),
                         "timestamp": (it.get("metadata") or {}).get("timestamp", ""),
                         "metadata": it.get("metadata") or {}} for it in items]}


@app.delete("/users/{user_id}", status_code=204)
def del_user(user_id: str):
    try:
        with _lock:
            mem.delete_all(user_id=user_id)
    except Exception:
        pass
    return Response(status_code=204)


@app.delete("/sessions/{session_id}", status_code=204)
def del_session(session_id: str):
    # Vanilla mem0 scopes by user, not session — no session-level delete. We tag
    # turns with session_id in metadata for inspection, but cleanup is per-user.
    return Response(status_code=204)
