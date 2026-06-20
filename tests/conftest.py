"""Shared pytest fixtures.

Each test gets a fresh app over a temp SQLite file. We force the deterministic
baseline pipeline and clear any auth token so the suite is hermetic and offline.
"""

from __future__ import annotations

import os
import pathlib
import sys

import pytest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))

os.environ["MEMORY_EXTRACTOR"] = "baseline"
os.environ["MEMORY_RECALLER"] = "baseline"
os.environ.pop("MEMORY_AUTH_TOKEN", None)

from fastapi.testclient import TestClient  # noqa: E402

from memory_service.main import create_app  # noqa: E402


@pytest.fixture
def db_path(tmp_path) -> str:
    return str(tmp_path / "memory.db")


@pytest.fixture
def make_client(db_path):
    def _make() -> TestClient:
        return TestClient(create_app(db_path=db_path))

    return _make


@pytest.fixture
def client(make_client) -> TestClient:
    with make_client() as c:
        yield c


@pytest.fixture
def fixtures_dir() -> pathlib.Path:
    return REPO_ROOT / "fixtures"
