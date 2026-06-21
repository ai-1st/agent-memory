/**
 * Safe error logging.
 *
 * ROOT-CAUSE GUARD: passing a raw error/object straight to `console.*` lets
 * Node's `util.inspect` run over it. Some error objects produced by the model
 * SDKs (and other exotic shapes) make `util.inspect` itself THROW
 * ("TypeError: Cannot read properties of undefined (reading 'value')" deep in
 * node:internal/util/inspect). When that throw happens INSIDE a catch block's
 * own logging call, it escapes the catch — defeating "this failure must not fail
 * the write" guards and turning a recoverable error into an HTTP 500.
 *
 * `errStr` collapses any thrown value to a plain string (name: message + stack),
 * never recursing into hostile property descriptors, so logging can never throw.
 */

export function errStr(err: unknown): string {
  if (err instanceof Error) {
    const name = typeof err.name === "string" ? err.name : "Error";
    let message = "";
    try {
      message = String(err.message ?? "");
    } catch {
      message = "<unprintable message>";
    }
    let stack = "";
    try {
      // Only the first few frames — enough to debug, no object recursion.
      stack =
        typeof err.stack === "string" ? `\n${err.stack.split("\n").slice(0, 6).join("\n")}` : "";
    } catch {
      stack = "";
    }
    return `${name}: ${message}${stack}`;
  }
  try {
    return typeof err === "string" ? err : JSON.stringify(err);
  } catch {
    // Last resort: even String()/JSON.stringify can throw on hostile objects.
    try {
      return Object.prototype.toString.call(err);
    } catch {
      return "<unprintable error>";
    }
  }
}
