/**
 * Server-side session check for the public pages (landing, login): verifies the
 * JWT signature/expiry only, no database round trip. Server-only (next/headers);
 * it replaces src/lib/client/session.js, which lived in the client folder by mistake.
 * A deleted user's stale cookie is cleared by requireUser on the first API call,
 * after which this returns false and /login stops redirecting.
 */
import { cookies } from "next/headers";
import { getSession, SESSION_COOKIE } from "./auth.js";

/** @returns {Promise<boolean>} */
export async function hasValidSession() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return false;
  try {
    const request = new Request("http://localhost/", { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    return Boolean(await getSession(request));
  } catch {
    return false;
  }
}
