/**
 * Optional bearer-token auth as Hono middleware.
 *
 * If MEMORY_AUTH_TOKEN is unset we ignore Authorization entirely (per contract).
 * If set, every endpoint except the operational ones (/health, /metrics)
 * requires `Authorization: Bearer <token>`.
 */

import type { MiddlewareHandler } from "hono";

const PUBLIC_PATHS = new Set(["/health", "/metrics"]);

export function makeAuth(token: string): MiddlewareHandler {
  return async (c, next) => {
    if (PUBLIC_PATHS.has(c.req.path)) return next();
    if (!token) return next();
    if (c.req.header("authorization") !== `Bearer ${token}`) {
      return c.json({ error: "invalid or missing bearer token" }, 401);
    }
    return next();
  };
}
