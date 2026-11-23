/**
 * Test-only helpers that talk to the QA database directly: mint a magic-link
 * token the same way the app does (HMAC of purpose:plaintext keyed by
 * MAGIC_LINK_SECRET) so suites can sign in many users without burning the
 * real request-link rate limit (5 / 15 min / IP), and small SQL utilities.
 */
import { createHmac, randomBytes } from "node:crypto";
import pg from "pg";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

export const QA_DB = process.env.QA_DATABASE_URL || "postgresql://yinxiatao@localhost:5432/ahareading_qa";
export const BASE = process.env.QA_BASE_URL || "http://localhost:3100";

let pool;
export function db() {
  if (!pool) pool = new pg.Pool({ connectionString: QA_DB, max: 3 });
  return pool;
}

export async function sql(text, params = []) {
  const res = await db().query(text, params);
  return res.rows;
}

export async function closeDb() {
  if (pool) await pool.end();
  pool = undefined;
}

/** Insert a valid login token for `email`; returns the plaintext. */
export async function mintLoginToken(email, { expiresInMs = 15 * 60_000 } = {}) {
  const secret = process.env.MAGIC_LINK_SECRET;
  if (!secret) throw new Error("MAGIC_LINK_SECRET missing from .env");
  const plaintext = randomBytes(32).toString("hex");
  const tokenHash = createHmac("sha256", secret).update(`login:${plaintext}`).digest("hex");
  const id = `qa${randomBytes(10).toString("hex")}`;
  await sql(
    `INSERT INTO "MagicToken" (id, "tokenHash", email, purpose, consumed, "expiresAt", "createdAt") VALUES ($1,$2,$3,'login',false,(now() at time zone 'utc') + ($4 || ' milliseconds')::interval,(now() at time zone 'utc'))`,
    [id, tokenHash, email.toLowerCase(), String(expiresInMs)]
  );
  return plaintext;
}

/** Sign in through the real POST /api/auth/verify; returns the session cookie value. */
export async function signInViaApi(email, next) {
  const token = await mintLoginToken(email);
  const res = await fetch(`${BASE}/api/auth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(next ? { token, next } : { token }),
  });
  if (!res.ok) throw new Error(`verify failed ${res.status} ${await res.text()}`);
  const cookie = res.headers.get("set-cookie") || "";
  const m = cookie.match(/aha_session=([^;]+)/);
  if (!m) throw new Error("no session cookie");
  return m[1];
}

export async function userId(email) {
  const rows = await sql(`SELECT id FROM "User" WHERE email=$1`, [email.toLowerCase()]);
  return rows[0]?.id;
}

export async function markOnboarded(email, { locale = "en", helpLevel = 1 } = {}) {
  await sql(`UPDATE "User" SET "onboardedAt"=(now() at time zone 'utc'), locale=$2, "helpLevel"=$3 WHERE email=$1`, [email.toLowerCase(), locale, helpLevel]);
}

/** Remove a user and everything that cascades from it. */
export async function deleteUser(email) {
  await sql(`DELETE FROM "User" WHERE email=$1`, [email.toLowerCase()]);
  await sql(`DELETE FROM "MagicToken" WHERE email=$1`, [email.toLowerCase()]);
}

/**
 * Create a fresh user row directly (onboarded by default) and mint a session
 * JWT with the app's JWT_SECRET. Used for test isolation: the real sign-in
 * flow is covered by auth.spec.mjs, and minting here keeps every other test
 * independent of the per-IP verify rate limit (30 / 15 min).
 */
export async function createUser({ email, onboarded = true, locale = "en", helpLevel = 1 } = {}) {
  const { SignJWT } = await import("jose");
  const addr = (email || `qa-${randomBytes(6).toString("hex")}@example.test`).toLowerCase();
  const id = `qau${randomBytes(10).toString("hex")}`;
  await sql(
    `INSERT INTO "User" (id, email, locale, "helpLevel", "onboardedAt", "createdAt", "updatedAt")
     VALUES ($1,$2,$3,$4, CASE WHEN $5 THEN (now() at time zone 'utc') ELSE NULL END, (now() at time zone 'utc'), (now() at time zone 'utc'))`,
    [id, addr, locale, helpLevel, onboarded]
  );
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET missing from .env");
  const token = await new SignJWT({ email: addr })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(id)
    .setIssuedAt()
    .setExpirationTime("1d")
    .sign(new TextEncoder().encode(secret));
  return { id, email: addr, token };
}
