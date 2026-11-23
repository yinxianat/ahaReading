import { isProduction } from "./env.js";

/**
 * Public origin for magic links. Never derived from request headers: a forged
 * `Host` would mail a victim a genuine token pointing at the attacker's site.
 */

const DEV_FALLBACK = "http://localhost:3000";

// A Railway reference like ${{RAILWAY_PUBLIC_DOMAIN}} that was never expanded.
function hasUnresolvedTemplate(value) {
  return /\$\{/.test(value);
}

/**
 * Why BASE_URL is unusable, or null when it is fine.
 * @returns {null|"missing"|"unresolved_template"|"invalid"}
 */
export function baseUrlProblem() {
  const configured = (process.env.BASE_URL ?? "").trim();
  if (!configured) return "missing";
  if (hasUnresolvedTemplate(configured)) return "unresolved_template";
  try {
    const url = new URL(configured);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "invalid";
  } catch {
    return "invalid";
  }
  return null;
}

/**
 * @returns {string} origin without trailing slash
 * @throws in production when BASE_URL is missing, templated, or not an http(s) URL
 */
export function getBaseUrl() {
  const problem = baseUrlProblem();
  if (!problem) return process.env.BASE_URL.trim().replace(/\/+$/, "");

  if (isProduction()) {
    const reasons = {
      missing: "BASE_URL must be set in production (e.g. https://your-app.up.railway.app).",
      unresolved_template:
        "BASE_URL contains an unexpanded ${...} template. Set it to the real public URL.",
      invalid: "BASE_URL is not a valid http(s) URL.",
    };
    throw new Error(reasons[problem]);
  }
  return DEV_FALLBACK;
}
