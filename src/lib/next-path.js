/**
 * Post-sign-in redirect targets, shared by server and client (pure, no imports).
 * Only same-origin relative paths are accepted, and never the auth pages
 * themselves (redirecting there after sign-in would loop).
 */

export const DEFAULT_NEXT = "/read";
const MAX_NEXT_LENGTH = 512;

/**
 * @param {unknown} next
 * @returns {string|null} the path, or null when it is not a safe same-origin target
 */
export function safeNextPath(next) {
  if (typeof next !== "string" || next.length === 0 || next.length > MAX_NEXT_LENGTH) return null;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return null;
  if (/[\u0000-\u001f\u007f\\]/.test(next)) return null;
  if (next === "/" || next === "/login" || /^\/login[?#]/.test(next) || next.startsWith("/auth/")) return null;
  return next;
}
