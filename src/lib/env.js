/**
 * Environment access. Secrets are resolved lazily — never at module load — so
 * `next build` (which imports every route) works without production secrets,
 * while any real auth operation fails closed instead of using a known key.
 * Pure: no imports, safe for any module (including the alert path) to use.
 */

/** Shortest accepted HS256/HMAC key. A short key can be brute-forced offline from one JWT. */
export const MIN_SECRET_LENGTH = 32;

const GENERATE_HINT = `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`;

/**
 * Why a signing secret is unusable, or null when it is fine.
 * @param {string} name
 * @returns {null|"missing"|"weak"}
 */
export function secretProblem(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim().length === 0) return "missing";
  if (value.trim().length < MIN_SECRET_LENGTH) return "weak";
  return null;
}

function required(name) {
  const problem = secretProblem(name);
  if (problem === "missing") throw new Error(`${name} is not set. ${GENERATE_HINT}`);
  if (problem === "weak") throw new Error(`${name} is shorter than ${MIN_SECRET_LENGTH} characters. ${GENERATE_HINT}`);
  return process.env[name];
}

/** @returns {string} JWT signing secret. @throws when JWT_SECRET is unset or shorter than 32 chars. */
export function getJwtSecret() {
  return required("JWT_SECRET");
}

/** @returns {string} Magic-link hashing secret. @throws when MAGIC_LINK_SECRET is unset or shorter than 32 chars. */
export function getMagicLinkSecret() {
  return required("MAGIC_LINK_SECRET");
}

/** @returns {boolean} */
export function isProduction() {
  return process.env.NODE_ENV === "production";
}

/** @returns {boolean} true when the named variable holds a non-blank value. */
export function isSet(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Session lifetime in days. A blank, zero, negative or non-numeric
 * SESSION_EXPIRY_DAYS falls back to 30 rather than disabling sessions.
 * @returns {number} integer in 1..365
 */
export function getSessionDays() {
  const parsed = parseInt(process.env.SESSION_EXPIRY_DAYS ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 30;
  return Math.min(parsed, 365);
}

/**
 * Admin allow-list from ADMIN_EMAILS, lowercased and trimmed. Empty means
 * nobody is an admin — never everybody.
 * @returns {string[]}
 */
export function getAdminEmails() {
  const raw = process.env.ADMIN_EMAILS ?? "";
  return [
    ...new Set(
      raw
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e.length > 0 && e.includes("@"))
    ),
  ];
}

/**
 * Positive integer from an env var, clamped; blank/garbage/out-of-range falls back.
 * @param {string} name
 * @param {{fallback:number, min:number, max:number}} bounds
 * @returns {number}
 */
export function intFromEnv(name, { fallback, min, max }) {
  const parsed = parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.min(parsed, max);
}
