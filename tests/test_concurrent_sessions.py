"""Cross-session scoping: two users' data must not bleed into each other."""

from __future__ import annotations


def _turn(session_id, user_id, content):
    return {
        "session_id": session_id,
        "user_id": user_id,
        "messages": [{"role": "user", "content": content}],
        "timestamp": "2025-05-01T00:00:00Z",
        "metadata": {},
    }


def test_sessions_do_not_bleed(client):
    client.post("/turns", json=_turn("sess-a", "alice", "I live in Paris."))
    client.post("/turns", json=_turn("sess-b", "bob", "I live in Tokyo."))

    a = (
        client.post(
            "/recall",
            json={
                "query": "where do they live",
                "session_id": "sess-a",
                "user_id": "alice",
                "max_tokens": 256,
            },
        )
        .json()["context"]
        .lower()
    )
    b = (
        client.post(
            "/recall",
            json={
                "query": "where do they live",
                "session_id": "sess-b",
                "user_id": "bob",
                "max_tokens": 256,
            },
        )
        .json()["context"]
        .lower()
    )

    assert "paris" in a and "tokyo" not in a
    assert "tokyo" in b and "paris" not in b


def test_user_memories_are_scoped(client):
    client.post("/turns", json=_turn("sess-a", "alice", "I live in Paris."))
    client.post("/turns", json=_turn("sess-b", "bob", "I live in Tokyo."))
    alice = client.get("/users/alice/memories").json()["memories"]
    assert alice and all("tokyo" not in m["value"].lower() for m in alice)
