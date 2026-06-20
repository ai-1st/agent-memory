"""Persistence: data survives a 'restart' (a new app over the same DB file)."""

from __future__ import annotations


def test_data_survives_restart(make_client):
    with make_client() as c1:
        r = c1.post(
            "/turns",
            json={
                "session_id": "s1",
                "user_id": "u1",
                "messages": [{"role": "user", "content": "I live in Lisbon."}],
                "timestamp": "2025-04-01T00:00:00Z",
                "metadata": {},
            },
        )
        assert r.status_code == 201

    # New app instance over the same db_path == a container restart.
    with make_client() as c2:
        mems = c2.get("/users/u1/memories").json()["memories"]
        assert any("lisbon" in m["value"].lower() for m in mems)
        ctx = (
            c2.post(
                "/recall",
                json={
                    "query": "where does the user live",
                    "session_id": "p",
                    "user_id": "u1",
                    "max_tokens": 256,
                },
            )
            .json()["context"]
            .lower()
        )
        assert "lisbon" in ctx
