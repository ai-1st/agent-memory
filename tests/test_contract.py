"""Contract compliance: endpoints exist, shapes match, status codes are correct."""

from __future__ import annotations


def _turn(session_id="s1", user_id="u1", content="I just moved to Berlin from NYC last month."):
    return {
        "session_id": session_id,
        "user_id": user_id,
        "messages": [
            {"role": "user", "content": content},
            {"role": "assistant", "content": "Nice!"},
        ],
        "timestamp": "2025-03-15T10:30:00Z",
        "metadata": {},
    }


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json().get("status") == "ok"


def test_turns_returns_201_with_id(client):
    r = client.post("/turns", json=_turn())
    assert r.status_code == 201
    body = r.json()
    assert isinstance(body.get("id"), str) and body["id"]


def test_recall_roundtrip_shape_and_content(client):
    client.post("/turns", json=_turn())
    r = client.post(
        "/recall",
        json={
            "query": "Where does this user live?",
            "session_id": "probe",
            "user_id": "u1",
            "max_tokens": 512,
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert "context" in body and isinstance(body["context"], str)
    assert "citations" in body and isinstance(body["citations"], list)
    assert "berlin" in body["context"].lower()
    for c in body["citations"]:
        assert set(c.keys()) >= {"turn_id", "score", "snippet"}


def test_search_shape(client):
    client.post("/turns", json=_turn(content="I work at Stripe as an engineer."))
    r = client.post("/search", json={"query": "Stripe", "user_id": "u1", "limit": 5})
    assert r.status_code == 200
    results = r.json()["results"]
    assert isinstance(results, list) and results
    first = results[0]
    assert set(first.keys()) >= {"content", "score", "session_id", "timestamp", "metadata"}


def test_users_memories_structured(client):
    client.post("/turns", json=_turn(content="I work at Stripe as an engineer."))
    r = client.get("/users/u1/memories")
    assert r.status_code == 200
    mems = r.json()["memories"]
    assert mems, "expected at least one extracted memory, not raw chunks"
    m = mems[0]
    assert set(m.keys()) >= {
        "id",
        "type",
        "key",
        "value",
        "confidence",
        "source_session",
        "source_turn",
        "created_at",
        "updated_at",
        "supersedes",
        "active",
    }
    assert m["type"] in {"fact", "preference", "opinion", "event"}


def test_recall_cold_session_is_empty_not_error(client):
    r = client.post(
        "/recall",
        json={
            "query": "anything",
            "session_id": "never-seen",
            "user_id": "never-seen",
            "max_tokens": 256,
        },
    )
    assert r.status_code == 200
    assert r.json() == {"context": "", "citations": []}


def test_delete_session_204(client):
    client.post("/turns", json=_turn())
    r = client.delete("/sessions/s1")
    assert r.status_code == 204
    assert r.content in (b"", b"null")


def test_delete_user_204_removes_memories(client):
    client.post("/turns", json=_turn(content="I work at Stripe as an engineer."))
    assert client.get("/users/u1/memories").json()["memories"]
    r = client.delete("/users/u1")
    assert r.status_code == 204
    assert client.get("/users/u1/memories").json()["memories"] == []
