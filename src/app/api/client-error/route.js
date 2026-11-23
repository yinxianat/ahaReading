import { parseJsonBody, badRequest, rateLimited, clientIp, isCrossSiteWrite, crossSiteRejected } from "@/lib/http.js";
import { checkRateLimit } from "@/lib/rate-limit.js";
import { logger } from "@/lib/logger.js";
import { redact } from "@/lib/redact.js";

// Constant log messages per kind keep fingerprints stable (LESSONS 39).
const KINDS = {
  render: "Client render error",
  unhandled: "Client unhandled error",
  rejection: "Client unhandled promise rejection",
  network: "Client network error",
  other: "Client error reported",
};

function capped(value, max) {
  return typeof value === "string" && value.length > 0 ? redact(value.slice(0, max)) : undefined;
}

// Path only: query strings can carry tokens (e.g. /auth/verify?token=...).
function pathOf(value) {
  if (typeof value !== "string") return undefined;
  try {
    return new URL(value, "http://x").pathname.slice(0, 300);
  } catch {
    return undefined;
  }
}

// Error boundaries report a `source` (route/global/boundary name) but older clients no `kind`.
function kindOf(d) {
  if (Object.hasOwn(KINDS, d.kind)) return d.kind;
  return typeof d.source === "string" && d.source ? "render" : "other";
}

/**
 * POST {message, stack?, componentStack?, url?, kind?, source?, digest?} -> 204.
 * Unauthenticated, so it is rate limited per IP and globally, capped, redacted,
 * and never alerts the admin. The log keeps the first and the latest detail, so a
 * flood cannot overwrite the report that mattered. Never 500.
 */
export async function POST(request) {
  try {
    if (isCrossSiteWrite(request)) return crossSiteRejected();
    const limit = checkRateLimit(`client-error:ip:${clientIp(request)}`, { maxRequests: 10, windowMs: 60_000 });
    if (!limit.allowed) return rateLimited(limit.retryAfter);
    const appWide = checkRateLimit("client-error:global", { maxRequests: 300, windowMs: 60_000 });
    if (!appWide.allowed) return rateLimited(appWide.retryAfter);

    const body = await parseJsonBody(request);
    if (!body.ok) return badRequest("Send the error report as a JSON object.");
    const d = body.data;
    const kind = kindOf(d);

    await logger.error("client", KINDS[kind], {
      message: capped(d.message, 500),
      stack: capped(d.stack, 2000),
      componentStack: capped(d.componentStack, 1000),
      source: capped(d.source, 50),
      digest: capped(d.digest, 100),
      path: pathOf(d.url),
      userAgent: capped(request.headers.get("user-agent"), 200),
    });
  } catch {
    // Swallowed by design; the logger already fell back to stderr if it could.
  }
  return new Response(null, { status: 204 });
}
