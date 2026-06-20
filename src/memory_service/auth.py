"""Optional bearer-token auth.

If ``MEMORY_AUTH_TOKEN`` is unset we ignore the ``Authorization`` header entirely
(per the contract). If it is set, every contract endpoint requires a matching
``Authorization: Bearer <token>`` header.
"""

from __future__ import annotations

from collections.abc import Callable

from fastapi import Header, HTTPException


def make_auth_dependency(token: str) -> Callable:
    def dependency(authorization: str | None = Header(default=None)) -> None:
        if not token:
            return
        expected = f"Bearer {token}"
        if authorization != expected:
            raise HTTPException(status_code=401, detail="invalid or missing bearer token")

    return dependency
