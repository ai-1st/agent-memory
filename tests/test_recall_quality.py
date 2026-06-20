"""Recall-quality self-eval: ingest the fixture, run probes against /recall,
report 'X of Y expected facts appeared', and gate on a baseline threshold.

This is the iteration loop: run it after every change and watch the number move.
"""

from __future__ import annotations

import json

QUALITY_THRESHOLD = 0.8


def check_probe(context: str, probe: dict) -> bool:
    ctx = context.lower()
    if probe.get("expect_empty"):
        return ctx.strip() == ""
    if "expect_all" in probe:
        return all(tok.lower() in ctx for tok in probe["expect_all"])
    if "expect_any" in probe:
        return any(tok.lower() in ctx for tok in probe["expect_any"])
    return False


def test_recall_quality_fixture(client, fixtures_dir, capsys):
    data = json.loads((fixtures_dir / "basic.json").read_text())
    passed = total = 0
    failures: list[str] = []

    for scenario in data["scenarios"]:
        user_id = scenario["user_id"]
        for turn in scenario["turns"]:
            r = client.post(
                "/turns",
                json={
                    "session_id": turn["session_id"],
                    "user_id": user_id,
                    "messages": turn["messages"],
                    "timestamp": turn.get("timestamp"),
                    "metadata": turn.get("metadata", {}),
                },
            )
            assert r.status_code == 201

        for probe in scenario["probes"]:
            total += 1
            ctx = client.post(
                "/recall",
                json={
                    "query": probe["query"],
                    "session_id": probe.get("session_id"),
                    "user_id": user_id,
                    "max_tokens": probe.get("max_tokens", 512),
                },
            ).json()["context"]
            if check_probe(ctx, probe):
                passed += 1
            else:
                failures.append(f"[{scenario['name']}] {probe['query']!r}")

    score = passed / total if total else 0.0
    with capsys.disabled():
        print(f"\nRecall quality: {passed}/{total} probes passed ({score:.0%})")
        for f in failures:
            print(f"  MISS: {f}")

    assert score >= QUALITY_THRESHOLD, f"recall quality {score:.0%} below {QUALITY_THRESHOLD:.0%}"
