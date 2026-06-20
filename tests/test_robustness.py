"""Robustness: malformed/oversized/unicode input yields 4xx or success, never a crash."""

from __future__ import annotations


def test_malformed_json_is_422(client):
    r = client.post(
        "/turns", content=b"{not valid json", headers={"content-type": "application/json"}
    )
    assert r.status_code == 422
    # process still alive
    assert client.get("/health").status_code == 200


def test_missing_required_fields_is_422(client):
    assert (
        client.post("/turns", json={"user_id": "u1"}).status_code == 422
    )  # no session_id/messages
    assert (
        client.post("/turns", json={"session_id": "s1", "messages": []}).status_code == 422
    )  # empty msgs


def test_unicode_does_not_crash(client):
    weird = "emoji 🧠🔥, RTL ‮ابجد‬, zero-width​, NUL-ish �, 𝓯𝓪𝓷𝓬𝔂"
    r = client.post(
        "/turns",
        json={
            "session_id": "s-uni",
            "user_id": "u-uni",
            "messages": [{"role": "user", "content": weird}],
            "timestamp": "2025-06-01T00:00:00Z",
            "metadata": {"x": weird},
        },
    )
    assert r.status_code == 201
    assert client.get("/users/u-uni/memories").status_code == 200


def test_oversized_payload_does_not_crash(client):
    big = "I live in Berlin. " * 20000  # ~360 KB
    r = client.post(
        "/turns",
        json={
            "session_id": "s-big",
            "user_id": "u-big",
            "messages": [{"role": "user", "content": big}],
            "timestamp": "2025-06-01T00:00:00Z",
            "metadata": {},
        },
    )
    assert r.status_code in (201, 413)
    assert client.get("/health").status_code == 200


def test_recall_with_missing_query_is_422(client):
    assert client.post("/recall", json={"session_id": "s", "user_id": "u"}).status_code == 422
