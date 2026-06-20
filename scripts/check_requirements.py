#!/usr/bin/env python3
"""Guardrail: assert every FORMAL requirement of the assignment is satisfied.

Static checks only (stdlib, fast) so it runs in pre-commit and CI on every commit.
REQUIRED checks fail the build (exit 1); RECOMMENDED checks only warn.

Covers: §6 repo structure, §3 endpoint contract, §5 constraints (persistence
volume, port 8080), and the §6 README/CHANGELOG deliverables.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]

REQUIRED_ENDPOINTS = {
    ("get", "/health"),
    ("post", "/turns"),
    ("post", "/recall"),
    ("post", "/search"),
    ("get", "/users/{user_id}/memories"),
    ("delete", "/sessions/{session_id}"),
    ("delete", "/users/{user_id}"),
}

README_SECTIONS = [
    "architecture",
    "backing store",
    "extraction",
    "recall",
    "fact evolution",
    "tradeoff",
    "failure mode",
    "test",
]

results: list[tuple[bool, bool, str, str]] = []  # (ok, required, name, detail)


def check(ok: bool, name: str, *, required: bool = True, detail: str = "") -> None:
    results.append((ok, required, name, detail))


def _read(rel: str) -> str:
    p = REPO / rel
    return p.read_text(encoding="utf-8", errors="ignore") if p.exists() else ""


def _nonempty_dir(rel: str) -> bool:
    p = REPO / rel
    return p.is_dir() and any(p.iterdir())


def main() -> int:
    # -- §6 required files & directories -------------------------------- #
    for f in [
        "README.md",
        "CHANGELOG.md",
        "docker-compose.yml",
        "Dockerfile",
        ".env.example",
        "pyproject.toml",
    ]:
        check((REPO / f).is_file(), f"file exists: {f}")
    for d in ["src", "tests", "fixtures"]:
        check(_nonempty_dir(d), f"non-empty dir: {d}/")

    # -- §3 endpoint contract ------------------------------------------ #
    src_text = "\n".join(
        p.read_text(encoding="utf-8", errors="ignore") for p in (REPO / "src").rglob("*.py")
    )
    found = set(re.findall(r'@app\.(get|post|delete|put|patch)\(\s*"([^"]+)"', src_text))
    found_norm = {(m.lower(), path) for m, path in found}
    for method, path in sorted(REQUIRED_ENDPOINTS):
        check((method, path) in found_norm, f"endpoint: {method.upper()} {path}")

    # -- §5/§8 deployment constraints ---------------------------------- #
    compose = _read("docker-compose.yml")
    check("8080" in compose, "docker-compose maps/uses port 8080", detail="spec default port")
    check("volumes:" in compose, "docker-compose declares a volume (persistence)")
    check("build" in compose, "docker-compose builds the service")
    check(
        "EXPOSE" in _read("Dockerfile") or "8080" in _read("Dockerfile"),
        "Dockerfile references the port",
        required=False,
    )

    # -- §6 README deliverable sections -------------------------------- #
    readme = _read("README.md").lower()
    for section in README_SECTIONS:
        check(section in readme, f"README covers: {section}", required=False)

    # -- §6 CHANGELOG: 1 required, 4+ recommended ---------------------- #
    changelog = _read("CHANGELOG.md")
    entries = len(re.findall(r"(?m)^##\s+\S", changelog))
    check(entries >= 1, "CHANGELOG has >= 1 entry", detail=f"{entries} found")
    check(
        entries >= 4,
        "CHANGELOG has >= 4 entries (spec: shows iteration)",
        required=False,
        detail=f"{entries} found",
    )

    # -- §7 test coverage hints ---------------------------------------- #
    test_files = " ".join(p.name for p in (REPO / "tests").glob("*.py"))
    for kind in ["contract", "persistence", "concurrent", "robust", "recall_quality"]:
        check(kind in test_files, f"test file present: *{kind}*", required=False)

    # -- report -------------------------------------------------------- #
    hard_fail = 0
    warns = 0
    print("Assignment requirement checklist\n" + "=" * 40)
    for ok, required, name, detail in results:
        mark = "✓" if ok else ("✗" if required else "⚠")
        suffix = f"  ({detail})" if detail else ""
        print(f" {mark} {name}{suffix}")
        if not ok and required:
            hard_fail += 1
        elif not ok:
            warns += 1

    print("=" * 40)
    print(f"{len(results)} checks · {hard_fail} required failing · {warns} recommended warnings")
    if hard_fail:
        print("\nFAILED: required formal requirements are not satisfied.")
        return 1
    print("\nOK: all required formal requirements satisfied.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
