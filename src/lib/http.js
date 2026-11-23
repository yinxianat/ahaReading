/**
 * Request/response helpers shared by every API route. Error shape everywhere:
 * `{ error: "<code>", message: "<human sentence>", retryAfter?, field? }`.
 */
import { logger } from "./logger.js";
import { redact } from "./redact.js";

// C0 controls except tab, newline and carriage return, plus DEL. NUL is handled separately:
// Postgres rejects it in text columns, so it is refused with a 400 rather than silently dropped.
const CONTROL_CHARS = /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const MAX_SANITIZE_DEPTH = 8;

/**
 * Remove invisible control characters (keeps \n, \t; turns \r\n and \r into \n). NUL is kept
 * so callers can reject it with a field-specific message.
 * @param {string} value
 * @returns {string}
 */
export function stripControlChars(value) {
  return value.replace(/\r\n?/g, "\n").replace(CONTROL_CHARS, "");
}

/** @param {unknown} value @returns {boolean} true for a string containing U+0000 */
export function hasNul(value) {
  return typeof value === "string" && value.includes("\u0000");
}

function sanitize(value, depth) {
  if (typeof value === "string") return stripControlChars(value);
  if (depth >= MAX_SANITIZE_DEPTH || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = sanitize(v, depth + 1);
  return out;
}

function isJsonContentType(header) {
  if (!header) return true; // no body type at all; a cross-site form always sends one
  const type = header.split(";")[0].trim().toLowerCase();
  return type === "application/json" || type.endsWith("+json");
}

/**
 * Parse a JSON object body. Empty, malformed, null, array and primitive bodies
 * are all `{ok:false}` — a client error, never a 500. A non-JSON Content-Type is
 * refused too, so a cross-site `text/plain` form cannot smuggle a JSON body.
 * Every string has control characters stripped (NUL survives for field checks).
 * @param {Request} request
 * @returns {Promise<{ok:true, data:object}|{ok:false}>}
 */
export async function parseJsonBody(request) {
  try {
    if (!isJsonContentType(request.headers.get("content-type"))) return { ok: false };
    const data = await request.json();
    if (data === null || typeof data !== "object" || Array.isArray(data)) return { ok: false };
    return { ok: true, data: sanitize(data, 0) };
  } catch {
    return { ok: false };
  }
}

/**
 * @param {number} status
 * @param {string} code machine-readable
 * @param {string} message shown to the user; should name the recovery
 * @param {{retryAfter?:number, field?:string, [k:string]:unknown}} [extra] merged into the body
 * @param {HeadersInit} [headers]
 * @returns {Response}
 */
export function jsonError(status, code, message, extra = undefined, headers = undefined) {
  const body = { error: code, message };
  if (extra && typeof extra === "object") {
    for (const [k, v] of Object.entries(extra)) if (v !== undefined) body[k] = v;
  }
  return Response.json(body, { status, headers });
}

/**
 * @param {string} message names the fix
 * @param {string} [field]
 * @returns {Response} 400 invalid_input
 */
export function badRequest(message, field = undefined) {
  return jsonError(400, "invalid_input", message, { field });
}

/**
 * Type-check and trim a string input. Control characters are stripped; a NUL is refused.
 * @param {unknown} value
 * @param {{maxLength:number, minLength?:number}} limits
 * @returns {string|null} trimmed string, or null when not a string, contains NUL, or is out of bounds
 */
export function requireString(value, { maxLength, minLength = 1 }) {
  if (typeof value !== "string" || hasNul(value)) return null;
  const trimmed = stripControlChars(value).trim();
  if (trimmed.length < minLength || trimmed.length > maxLength) return null;
  return trimmed;
}

/**
 * @param {number} retryAfter seconds
 * @returns {Response} 429 rate_limited with Retry-After header
 */
export function rateLimited(retryAfter) {
  const seconds = Math.max(1, Math.ceil(Number(retryAfter) || 1));
  return jsonError(
    429,
    "rate_limited",
    `You're going a bit fast. Try again in ${seconds} seconds.`,
    { retryAfter: seconds },
    { "Retry-After": String(seconds) }
  );
}

/**
 * Client IP for rate-limit keys only (never for authorization). Trusts the header the
 * platform's edge sets (TRUSTED_IP_HEADER, default Railway's `x-real-ip`), else the
 * RIGHTMOST x-forwarded-for hop — the one our proxy appended. The leftmost hop is
 * whatever the client typed, so keying on it let anyone rotate past every per-IP limit.
 * @param {Request} request
 * @returns {string} up to 64 chars, or "unknown"
 */
export function clientIp(request) {
  const trusted = (process.env.TRUSTED_IP_HEADER || "x-real-ip").trim().toLowerCase();
  const lastHop = (value) => value?.split(",").map((h) => h.trim()).filter(Boolean).at(-1);
  if (trusted && trusted !== "x-forwarded-for") {
    const fromEdge = lastHop(request.headers.get(trusted));
    if (fromEdge) return fromEdge.slice(0, 64);
  }
  const forwarded = lastHop(request.headers.get("x-forwarded-for"));
  return forwarded ? forwarded.slice(0, 64) : "unknown";
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * True when the browser says a state-changing request came from another site.
 * Second CSRF layer behind SameSite=Lax; non-browser clients send no Sec-Fetch-Site.
 * @param {Request} request
 * @returns {boolean}
 */
export function isCrossSiteWrite(request) {
  if (!request?.headers || SAFE_METHODS.has(String(request.method).toUpperCase())) return false;
  return request.headers.get("sec-fetch-site") === "cross-site";
}

/** @returns {Response} 403 for a cross-site state-changing request */
export function crossSiteRejected() {
  return jsonError(403, "forbidden", "This request came from another website, so it was blocked. Open AhaReading directly and try again.");
}

// Postgres refuses U+0000 in text (SQLSTATE 22021). Any input path that slipped past the
// field checks still gets a 400 naming the fix, not a 500.
function isNulByteError(err) {
  return err?.code === "22021" || /invalid byte sequence[^\n]*0x00|\\u0000 cannot be converted/i.test(String(err?.message ?? ""));
}

/**
 * Wrap a route handler so an unexpected throw is logged and becomes a 500
 * with the standard error shape instead of a framework error page.
 * @template {(...args:any[]) => Promise<Response>|Response} H
 * @param {H} handler
 * @param {{source?:string}} [options]
 * @returns {H}
 */
export function withErrorHandling(handler, { source = "api" } = {}) {
  return async (...args) => {
    if (isCrossSiteWrite(args[0])) return crossSiteRejected();
    try {
      return await handler(...args);
    } catch (err) {
      if (isNulByteError(err) || isNulByteError(err?.cause)) {
        return badRequest("Your text contains a hidden NUL character. Remove it (retype or re-paste the text) and try again.");
      }
      let path;
      try {
        path = new URL(args[0]?.url).pathname;
      } catch {
        path = undefined;
      }
      // Not awaited: when the database is what failed, the log write would stall the 500 too.
      logger.error(source, "Unhandled route error", {
        detail: redact(err?.message ?? String(err)),
        name: err?.name,
        code: err?.code,
        method: args[0]?.method,
        path,
        stack: typeof err?.stack === "string" ? err.stack.split("\n").slice(0, 6).join("\n") : undefined,
      });
      return jsonError(500, "server_error", "Something went wrong on our side. Please try again.");
    }
  };
}
