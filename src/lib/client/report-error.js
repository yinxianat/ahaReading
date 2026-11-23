/**
 * Report a client crash to /api/client-error. Never throws, never awaits the
 * caller, and sends only the message and trimmed stacks (the server redacts).
 * `kind` is what /api/client-error fingerprints on (render | unhandled |
 * rejection | network | other); `source` says which boundary caught it and
 * `digest` links a server-rendered crash to its server log line.
 * @param {unknown} error
 * @param {{kind?:"render"|"unhandled"|"rejection"|"network"|"other", componentStack?:string, digest?:string, source?:string}} [extra]
 */
export function reportClientError(error, extra = {}) {
  try {
    const err = error instanceof Error ? error : new Error(String(error));
    const body = JSON.stringify({
      message: String(err.message || "Unknown error").slice(0, 500),
      stack: err.stack ? String(err.stack).slice(0, 1000) : undefined,
      componentStack: extra.componentStack ? String(extra.componentStack).slice(0, 1000) : undefined,
      kind: extra.kind || "other",
      digest: typeof extra.digest === "string" ? extra.digest.slice(0, 100) : undefined,
      source: typeof extra.source === "string" ? extra.source.slice(0, 50) : undefined,
      url: typeof window !== "undefined" ? window.location.pathname : undefined,
    });
    fetch("/api/client-error", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
  } catch {
    // reporting must never throw
  }
}
