/**
 * Magic-link tokens, sign-in codes, JWT sessions, and the route guards built on them.
 *
 * Tokens: 32 random bytes (64 hex) sent in the link; only an HMAC-SHA256 of
 * purpose + plaintext keyed by MAGIC_LINK_SECRET is stored. Each token row also
 * carries a 6-digit code (same email, same expiry, single use) for devices whose
 * cookie jar the link can't reach — an installed iOS web app opens links in Safari.
 * The code is stored as an HMAC salted with the row's tokenHash and locks after
 * MAX_CODE_ATTEMPTS wrong guesses. Sessions: HS256 JWT `{sub: userId, email, sv}` in
 * the httpOnly `aha_session` cookie only; `sv` must equal User.sessionVersion, so
 * bumping it signs out every device (SEC-10). Missing or short secrets fail closed.
 */
import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import prisma from "./db.js";
import { getJwtSecret, getMagicLinkSecret, getSessionDays, getAdminEmails, isProduction } from "./env.js";
import { jsonError } from "./http.js";
import { logger } from "./logger.js";
import { safeNextPath } from "./next-path.js";
import { SIGN_IN_CODE_LENGTH } from "./limits.js";

export { safeNextPath };
export const SESSION_COOKIE = "aha_session";
export const MAGIC_LINK_TTL_MINUTES = 15;
export const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
export const CODE_LENGTH = SIGN_IN_CODE_LENGTH;
export const MAX_CODE_ATTEMPTS = 5;
const CODE_PATTERN = /^\d{6}$/;
// Rows older than this are deleted whenever a new link is issued (no unbounded growth).
const TOKEN_RETENTION_MS = 24 * 60 * 60 * 1000;

const USER_FIELDS = { id: true, email: true, locale: true, helpLevel: true, displayName: true, onboardedAt: true, sessionVersion: true };

/**
 * @param {string} plaintext
 * @param {string} purpose
 * @returns {string} hex digest stored in MagicToken.tokenHash
 */
export function hashToken(plaintext, purpose) {
  return createHmac("sha256", getMagicLinkSecret()).update(`${purpose}:${plaintext}`).digest("hex");
}

/**
 * @param {string} code 6 digits
 * @param {string} tokenHash the row the code belongs to (per-row salt)
 * @param {string} purpose
 * @returns {string} hex digest stored in MagicToken.codeHash
 */
export function hashCode(code, tokenHash, purpose) {
  return createHmac("sha256", getMagicLinkSecret()).update(`code:${purpose}:${tokenHash}:${code}`).digest("hex");
}

/**
 * Strip the spaces/dashes people type into a code.
 * @param {unknown} raw
 * @returns {string|null} 6 digits, or null when it is not a well-formed code
 */
export function normalizeCode(raw) {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const digits = String(raw).replace(/[\s-]/g, "");
  return CODE_PATTERN.test(digits) ? digits : null;
}

/**
 * Mint a magic-link token and code for `email`. In one transaction: purge rows
 * older than a day, expire every older live token for the same email and purpose
 * (only the newest link/code works), and create the new row.
 * @param {string} email normalised (lowercase, trimmed)
 * @param {{purpose?:string, next?:string|null}} [options] `next` must already be safe
 * @returns {Promise<{plaintext:string, code:string, expiresAt:Date}>}
 */
export async function issueMagicToken(email, { purpose = "login", next = null } = {}) {
  const plaintext = randomBytes(32).toString("hex");
  const code = String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, "0");
  const tokenHash = hashToken(plaintext, purpose);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + MAGIC_LINK_TTL_MINUTES * 60_000);

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  await prisma.$transaction([
    prisma.magicToken.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - TOKEN_RETENTION_MS) } } }),
    // Expired rather than consumed, so an old link reports "expired or replaced"
    // instead of the misleading "already used".
    prisma.magicToken.updateMany({
      where: { email, purpose, consumed: false, expiresAt: { gt: now } },
      data: { expiresAt: now },
    }),
    prisma.magicToken.create({
      data: {
        tokenHash, codeHash: hashCode(code, tokenHash, purpose), next: next || null,
        email, purpose, userId: existing?.id ?? null, expiresAt,
      },
    }),
  ]);
  return { plaintext, code, expiresAt };
}

/**
 * Look up a token without consuming it. Purpose is always required.
 * @param {unknown} plaintext
 * @param {string} expectedPurpose
 * @returns {Promise<{valid:true, tokenId:string, email:string, userId:string|null, next:string|null} | {valid:false, reason:"link_invalid"|"link_used"|"link_expired"}>}
 */
export async function verifyMagicToken(plaintext, expectedPurpose) {
  if (typeof plaintext !== "string" || !TOKEN_PATTERN.test(plaintext) || !expectedPurpose) {
    return { valid: false, reason: "link_invalid" };
  }
  const record = await prisma.magicToken.findUnique({ where: { tokenHash: hashToken(plaintext, expectedPurpose) } });
  if (!record || record.purpose !== expectedPurpose) return { valid: false, reason: "link_invalid" };
  if (record.consumed) return { valid: false, reason: "link_used" };
  if (record.expiresAt.getTime() <= Date.now()) return { valid: false, reason: "link_expired" };
  return { valid: true, tokenId: record.id, email: record.email, userId: record.userId, next: safeNextPath(record.next) };
}

function sameHex(a, b) {
  const left = Buffer.from(String(a), "hex");
  const right = Buffer.from(String(b), "hex");
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

/**
 * Check a 6-digit code against the newest token for `email`, without consuming it.
 * Each check spends one attempt first (atomically, so parallel guesses can't exceed
 * the cap); after MAX_CODE_ATTEMPTS wrong codes the row answers `code_locked`.
 * @param {string} email normalised
 * @param {string} code from normalizeCode
 * @param {string} expectedPurpose
 * @returns {Promise<{valid:true, tokenId:string, email:string, userId:string|null, next:string|null}
 *   | {valid:false, reason:"code_invalid"|"code_locked"|"link_used"|"link_expired", attemptsLeft?:number}>}
 */
export async function verifySignInCode(email, code, expectedPurpose) {
  const record = await prisma.magicToken.findFirst({
    where: { email, purpose: expectedPurpose },
    orderBy: { createdAt: "desc" },
  });
  if (!record || !record.codeHash) return { valid: false, reason: "code_invalid", attemptsLeft: 0 };
  if (record.consumed) return { valid: false, reason: "link_used" };
  if (record.expiresAt.getTime() <= Date.now()) return { valid: false, reason: "link_expired" };
  if (record.attempts >= MAX_CODE_ATTEMPTS) return { valid: false, reason: "code_locked" };

  const spent = await prisma.magicToken.updateMany({
    where: { id: record.id, consumed: false, attempts: { lt: MAX_CODE_ATTEMPTS } },
    data: { attempts: { increment: 1 } },
  });
  if (spent.count !== 1) return { valid: false, reason: "code_locked" };

  if (!sameHex(hashCode(code, record.tokenHash, expectedPurpose), record.codeHash)) {
    return { valid: false, reason: "code_invalid", attemptsLeft: Math.max(0, MAX_CODE_ATTEMPTS - record.attempts - 1) };
  }
  return { valid: true, tokenId: record.id, email: record.email, userId: record.userId, next: safeNextPath(record.next) };
}

/**
 * Claim a token atomically. Call LAST, after everything that can fail.
 * @param {string} tokenId
 * @returns {Promise<boolean>} false when another request already claimed it
 */
export async function consumeMagicToken(tokenId) {
  const claimed = await prisma.magicToken.updateMany({
    where: { id: tokenId, consumed: false },
    data: { consumed: true },
  });
  return claimed.count === 1;
}

function jwtKey() {
  return new TextEncoder().encode(getJwtSecret());
}

/**
 * @param {{id:string, email:string, sessionVersion?:number}} user
 * @returns {Promise<string>} signed JWT
 * @throws when JWT_SECRET is unset
 */
export async function createSessionToken(user) {
  return new SignJWT({ email: user.email, sv: user.sessionVersion ?? 0 })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${getSessionDays()}d`)
    .sign(jwtKey());
}

/**
 * Attach the session cookie to a response.
 * @param {Response} response
 * @param {string} token
 * @returns {Response}
 */
export function setSessionCookie(response, token) {
  const maxAge = getSessionDays() * 24 * 60 * 60;
  response.headers.append(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${isProduction() ? "; Secure" : ""}`
  );
  return response;
}

/**
 * @param {Response} response
 * @returns {Response}
 */
export function clearSessionCookie(response) {
  response.headers.append(
    "Set-Cookie",
    `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${isProduction() ? "; Secure" : ""}`
  );
  return response;
}

function readCookie(request, name) {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

/**
 * Read and verify the session. Fails closed: a missing JWT_SECRET, bad
 * signature or expired token all mean "no session".
 * @param {Request} request
 * @returns {Promise<{userId:string, email:string, sessionVersion:number}|null>}
 */
export async function getSession(request) {
  // Cookie only: the web client never sends Authorization, and a bearer path would make
  // a JWT that leaked into any header or log usable.
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  let key;
  try {
    key = jwtKey();
  } catch {
    logger.critical("auth", "JWT_SECRET is not set; every session is rejected");
    return null;
  }
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
    if (typeof payload.sub !== "string" || typeof payload.email !== "string") return null;
    // Tokens minted before SEC-10 have no `sv`; they match the column's default of 0.
    const sessionVersion = payload.sv === undefined ? 0 : payload.sv;
    if (!Number.isInteger(sessionVersion)) return null;
    return { userId: payload.sub, email: payload.email, sessionVersion };
  } catch {
    return null;
  }
}

/** @returns {Response} 401 unauthenticated */
export function unauthenticated() {
  return jsonError(401, "unauthenticated", "Your session has expired. Please sign in again.");
}

/**
 * Guard for signed-in routes. Loads the user so a deleted account's still-valid
 * JWT, or one from before "sign out of all devices", is rejected — and its cookie
 * cleared, or /login (which trusts the JWT alone) would bounce the browser back
 * into the app forever.
 * @param {Request} request
 * @returns {Promise<{user:{id:string,email:string,locale:string,helpLevel:number,displayName:string|null,onboardedAt:Date|null}} | {response:Response}>}
 */
export async function requireUser(request) {
  const session = await getSession(request);
  if (!session) return { response: unauthenticated() };
  const user = await prisma.user.findUnique({ where: { id: session.userId }, select: USER_FIELDS });
  if (!user || user.sessionVersion !== session.sessionVersion) return { response: clearSessionCookie(unauthenticated()) };
  return { user };
}

/**
 * Sign out every device: bump sessionVersion so every outstanding JWT stops matching.
 * @param {string} userId
 * @returns {Promise<void>}
 */
export async function revokeAllSessions(userId) {
  await prisma.user.update({ where: { id: userId }, data: { sessionVersion: { increment: 1 } } });
}

/**
 * Case- and whitespace-insensitive membership in ADMIN_EMAILS. An empty list
 * means nobody.
 * @param {unknown} email
 * @returns {boolean}
 */
export function isAdminEmail(email) {
  if (typeof email !== "string") return false;
  const admins = getAdminEmails();
  return admins.length > 0 && admins.includes(email.trim().toLowerCase());
}

/**
 * Guard for admin routes: 401 without a session, 403 for non-admins (and for
 * everyone when ADMIN_EMAILS is empty).
 * @param {Request} request
 * @returns {Promise<{user:object}|{response:Response}>}
 */
export async function requireAdmin(request) {
  const auth = await requireUser(request);
  if (auth.response) return auth;
  if (!isAdminEmail(auth.user.email)) {
    return { response: jsonError(403, "forbidden", "This page is only available to administrators.") };
  }
  return auth;
}

/**
 * Public view of a user for API responses.
 * @param {{id:string,email:string,displayName:string|null,locale:string,helpLevel:number,onboardedAt:Date|null}} user
 */
export function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName ?? null,
    locale: user.locale,
    helpLevel: user.helpLevel,
    onboardedAt: user.onboardedAt ? new Date(user.onboardedAt).toISOString() : null,
    isAdmin: isAdminEmail(user.email),
  };
}
