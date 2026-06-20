/**
 * Optional bearer-token auth as Hono middleware.
 *
 * If MEMORY_AUTH_TOKEN is unset we ignore Authorization entirely (per contract:
 * "we'll set it if you require one and ignore it if you don't"). If set, every
 * endpoint except the operational probes (/health, /metrics) requires
 * `Authorization: Bearer <token>` — the benchmark harness scrapes /metrics
 * unauthenticated, same as /health.
 */

import type { MiddlewareHandler } from "hono";

export function makeAuth(token: string): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.path === "/health" || c.req.path === "/metrics") return next();
    if (!token) return next();
    if (c.req.header("authorization") !== `Bearer ${token}`) {
      return c.json({ error: "invalid or missing bearer token" }, 401);
    }
    return next();
  };
}
