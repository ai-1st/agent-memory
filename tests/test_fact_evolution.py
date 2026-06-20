"""Fact evolution: contradictions supersede, current fact wins, history preserved."""

from __future__ import annotations


def _job_turn(session_id, value):
    return {
        "session_id": session_id,
        "user_id": "bob",
        "messages": [{"role": "user", "content": value}],
        "timestamp": "2025-01-01T00:00:00Z",
        "metadata": {},
    }


def test_job_change_supersedes_old_fact(client):
    client.post("/turns", json=_job_turn("bob-s1", "I work at Stripe as an engineer."))
    client.post("/turns", json=_job_turn("bob-s3", "I just joined Notion as a PM."))

    mems = client.get("/users/bob/memories").json()["memories"]
    employment = [m for m in mems if m["key"] == "employment"]
    assert len(employment) == 2, "expected old + new employment rows (history preserved)"

    active = [m for m in employment if m["active"]]
    superseded = [m for m in employment if not m["active"]]
    assert len(active) == 1 and "notion" in active[0]["value"].lower()
    assert len(superseded) == 1 and "stripe" in superseded[0]["value"].lower()
    assert active[0]["supersedes"] == superseded[0]["id"]


def test_recall_returns_current_job(client):
    client.post("/turns", json=_job_turn("bob-s1", "I work at Stripe as an engineer."))
    client.post("/turns", json=_job_turn("bob-s3", "I just joined Notion as a PM."))
    ctx = (
        client.post(
            "/recall",
            json={
                "query": "Where does the user work now?",
                "session_id": "p",
                "user_id": "bob",
                "max_tokens": 512,
            },
        )
        .json()["context"]
        .lower()
    )
    assert "notion" in ctx
