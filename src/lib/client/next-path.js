/**
 * Client helpers around the shared `next` validator (src/lib/next-path.js,
 * used by the server too — one rule set, ENG-18).
 */
import { safeNextPath } from "@/lib/next-path.js";

/**
 * Post-sign-in redirect target: a same-origin relative path that isn't an
 * auth page, else `fallback`.
 * @param {unknown} value
 * @param {string} [fallback]
 * @returns {string}
 */
export function sanitizeNext(value, fallback = "/read") {
  return safeNextPath(value) ?? fallback;
}

/**
 * The login URL that brings the user back to `next` afterwards.
 * @param {string} next
 * @param {{reason?:string}} [options]
 * @returns {string}
 */
export function loginUrl(next, { reason } = {}) {
  const params = new URLSearchParams();
  const safe = sanitizeNext(next, "");
  if (safe) params.set("next", safe);
  if (reason) params.set("reason", reason);
  const qs = params.toString();
  return qs ? `/login?${qs}` : "/login";
}
