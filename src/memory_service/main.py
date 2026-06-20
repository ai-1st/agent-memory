"""FastAPI application implementing the memory-service HTTP contract (§3).

The app is built by ``create_app()`` so tests can point it at a temp database and
so "restart" is just constructing a new app over the same file. Endpoints are
synchronous by contract: when ``POST /turns`` returns, extracted memories are
already committed and queryable.
"""

from __future__ import annotations

import logging

from fastapi import Depends, FastAPI, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from . import __version__
from .auth import make_auth_dependency
from .config import Settings
from .extraction import build_extractor
from .models import (
    MemoriesResponse,
    Memory,
    RecallRequest,
    RecallResponse,
    SearchRequest,
    SearchResponse,
    SearchResult,
    TurnRequest,
    TurnResponse,
)
from .recall import build_recaller
from .store import Store

log = logging.getLogger("memory_service")


def create_app(db_path: str | None = None) -> FastAPI:
    settings = Settings.load()
    if db_path is not None:
        settings.db_path = db_path

    store = Store(settings.db_path)
    store.init()
    extractor = build_extractor(settings)
    recaller = build_recaller(settings, store)
    auth = make_auth_dependency(settings.auth_token)

    app = FastAPI(title="memory-service", version=__version__)
    app.state.settings = settings
    app.state.store = store

    # -- robustness: never crash the process on a bad request ------------- #
    @app.exception_handler(RequestValidationError)
    async def _validation_handler(_req, exc: RequestValidationError):
        return JSONResponse(
            status_code=422, content={"error": "invalid request", "detail": exc.errors()}
        )

    @app.exception_handler(Exception)
    async def _unhandled_handler(_req, exc: Exception):  # noqa: BLE001
        log.exception("unhandled error: %s", exc)
        return JSONResponse(status_code=500, content={"error": "internal error"})

    # -- contract endpoints ---------------------------------------------- #
    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/turns", status_code=201, response_model=TurnResponse)
    def post_turns(req: TurnRequest, _=Depends(auth)) -> TurnResponse:
        messages = [m.model_dump() for m in req.messages]
        turn_id = store.insert_turn(
            session_id=req.session_id,
            user_id=req.user_id,
            messages=messages,
            timestamp=req.timestamp,
            metadata=req.metadata,
        )
        try:
            extracted = extractor.extract(
                req.messages,
                user_id=req.user_id,
                session_id=req.session_id,
                turn_id=turn_id,
                timestamp=req.timestamp,
            )
            for em in extracted:
                store.add_memory(
                    em, user_id=req.user_id, session_id=req.session_id, source_turn=turn_id
                )
        except Exception as exc:  # noqa: BLE001 - persistence already succeeded
            log.warning("extraction error on turn %s: %s", turn_id, exc)
        return TurnResponse(id=turn_id)

    @app.post("/recall", response_model=RecallResponse)
    def post_recall(req: RecallRequest, _=Depends(auth)) -> RecallResponse:
        result = recaller.recall(
            query=req.query,
            user_id=req.user_id,
            session_id=req.session_id,
            max_tokens=req.max_tokens,
        )
        return RecallResponse(context=result.context, citations=result.citations)

    @app.post("/search", response_model=SearchResponse)
    def post_search(req: SearchRequest, _=Depends(auth)) -> SearchResponse:
        rows = store.search(
            req.query, user_id=req.user_id, session_id=req.session_id, limit=req.limit
        )
        return SearchResponse(
            results=[
                SearchResult(
                    content=r["content"],
                    score=float(r["score"]),
                    session_id=r["session_id"],
                    timestamp=r["timestamp"],
                    metadata=r["metadata"],
                )
                for r in rows
            ]
        )

    @app.get("/users/{user_id}/memories", response_model=MemoriesResponse)
    def get_memories(user_id: str, _=Depends(auth)) -> MemoriesResponse:
        rows = store.list_memories(user_id, active_only=False)
        return MemoriesResponse(
            memories=[
                Memory(
                    id=r["id"],
                    type=r["type"],
                    key=r["key"],
                    value=r["value"],
                    confidence=float(r["confidence"]),
                    source_session=r["source_session"],
                    source_turn=r["source_turn"],
                    created_at=r["created_at"],
                    updated_at=r["updated_at"],
                    supersedes=r["supersedes"],
                    active=bool(r["active"]),
                )
                for r in rows
            ]
        )

    @app.delete("/sessions/{session_id}", status_code=204)
    def delete_session(session_id: str, _=Depends(auth)) -> Response:
        store.delete_session(session_id)
        return Response(status_code=204)

    @app.delete("/users/{user_id}", status_code=204)
    def delete_user(user_id: str, _=Depends(auth)) -> Response:
        store.delete_user(user_id)
        return Response(status_code=204)

    return app


# NOTE: we intentionally do NOT build a module-level ``app`` here. Constructing
# the app opens the database (default /data on a Docker volume), which must not
# happen merely on import (it breaks tooling/tests on read-only filesystems).
# Run with the factory:  uvicorn memory_service.main:create_app --factory
