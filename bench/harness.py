#!/usr/bin/env python3
"""HTTP benchmark harness — score a running memory service and compare variants.

It talks to the service over HTTP only (the contract), so it is implementation-
agnostic: point it at any container/variant and compare the numbers. Use it to
benchmark our own implementations against each other as we iterate.

Stdlib-only (urllib) so it runs on the host without installing anything.

Examples
--------
    # score the baseline running on :8080, save results labelled "baseline"
    python bench/harness.py --label baseline

    # score a variant on another port
    MEMORY_BASE=http://localhost:8081 python bench/harness.py --label llm-extract

    # print a comparison table across all saved runs
    python bench/harness.py --compare
"""

from __future__ import annotations

import argparse
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
RESULTS_DIR = REPO / "bench" / "results"
DEFAULT_SCENARIO = REPO / "fixtures" / "basic.json"


def _req(method: str, url: str, body: dict | None, token: str | None) -> tuple[int, dict]:
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read().decode() or "{}"
            return r.status, (json.loads(raw) if raw.strip() else {})
    except urllib.error.HTTPError as e:
        raw = e.read().decode() or "{}"
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, {"error": raw}


def check_probe(context: str, probe: dict) -> bool:
    ctx = context.lower()
    if probe.get("expect_empty"):
        return ctx.strip() == ""
    if "expect_all" in probe:
        return all(t.lower() in ctx for t in probe["expect_all"])
    if "expect_any" in probe:
        return any(t.lower() in ctx for t in probe["expect_any"])
    return False


def run(base: str, scenario_path: Path, label: str, token: str | None, reset: bool) -> dict:
    data = json.loads(scenario_path.read_text())
    passed = total = 0
    turn_latencies: list[float] = []
    recall_latencies: list[float] = []
    misses: list[str] = []

    for scenario in data["scenarios"]:
        user_id = scenario["user_id"]
        if reset and user_id:
            _req("DELETE", f"{base}/users/{user_id}", None, token)

        for turn in scenario["turns"]:
            t0 = time.perf_counter()
            status, _ = _req(
                "POST",
                f"{base}/turns",
                {
                    "session_id": turn["session_id"],
                    "user_id": user_id,
                    "messages": turn["messages"],
                    "timestamp": turn.get("timestamp"),
                    "metadata": turn.get("metadata", {}),
                },
                token,
            )
            turn_latencies.append((time.perf_counter() - t0) * 1000)
            if status != 201:
                misses.append(f"[{scenario['name']}] ingest failed: HTTP {status}")

        for probe in scenario["probes"]:
            total += 1
            t0 = time.perf_counter()
            status, body = _req(
                "POST",
                f"{base}/recall",
                {
                    "query": probe["query"],
                    "session_id": probe.get("session_id"),
                    "user_id": user_id,
                    "max_tokens": probe.get("max_tokens", 512),
                },
                token,
            )
            recall_latencies.append((time.perf_counter() - t0) * 1000)
            ctx = body.get("context", "") if status == 200 else ""
            if check_probe(ctx, probe):
                passed += 1
            else:
                misses.append(f"[{scenario['name']}] {probe['query']!r}")

    def avg(xs: list[float]) -> float:
        return round(sum(xs) / len(xs), 1) if xs else 0.0

    result = {
        "label": label,
        "scenario": scenario_path.name,
        "passed": passed,
        "total": total,
        "recall_quality": round(passed / total, 3) if total else 0.0,
        "avg_turn_ms": avg(turn_latencies),
        "p_recall_ms": avg(recall_latencies),
        "misses": misses,
    }
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    (RESULTS_DIR / f"{label}.json").write_text(json.dumps(result, indent=2))
    return result


def print_result(r: dict) -> None:
    print(f"\n== {r['label']} ({r['scenario']}) ==")
    print(f"recall quality : {r['passed']}/{r['total']} ({r['recall_quality']:.0%})")
    print(f"avg ingest     : {r['avg_turn_ms']} ms")
    print(f"avg recall     : {r['p_recall_ms']} ms")
    for m in r["misses"]:
        print(f"  MISS: {m}")


def compare() -> None:
    files = sorted(RESULTS_DIR.glob("*.json"))
    if not files:
        print("no results in bench/results/ yet — run a benchmark first.")
        return
    rows = [json.loads(f.read_text()) for f in files]
    print(f"\n{'label':<22}{'quality':<12}{'ingest ms':<12}{'recall ms':<12}")
    print("-" * 58)
    for r in sorted(rows, key=lambda x: x["recall_quality"], reverse=True):
        q = f"{r['passed']}/{r['total']} ({r['recall_quality']:.0%})"
        print(f"{r['label']:<22}{q:<12}{r['avg_turn_ms']:<12}{r['p_recall_ms']:<12}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--base-url", default=os.environ.get("MEMORY_BASE", "http://localhost:8080"))
    ap.add_argument("--scenario", default=str(DEFAULT_SCENARIO))
    ap.add_argument("--label", default="run")
    ap.add_argument("--token", default=os.environ.get("MEMORY_AUTH_TOKEN") or None)
    ap.add_argument("--no-reset", action="store_true", help="do not DELETE users before ingest")
    ap.add_argument("--compare", action="store_true", help="print comparison table and exit")
    args = ap.parse_args()

    if args.compare:
        compare()
        return

    result = run(
        args.base_url.rstrip("/"),
        Path(args.scenario),
        args.label,
        args.token,
        reset=not args.no_reset,
    )
    print_result(result)
    compare()


if __name__ == "__main__":
    main()
