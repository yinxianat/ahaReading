import prisma from "@/lib/db.js";
import {
  verifyMagicToken, verifySignInCode, normalizeCode, consumeMagicToken, createSessionToken, setSessionCookie,
  safeNextPath, publicUser, MAX_CODE_ATTEMPTS,
} from "@/lib/auth.js";
import { DEFAULT_NEXT } from "@/lib/next-path.js";
import { validateEmail } from "@/lib/email-check.js";
import { parseJsonBody, badRequest, jsonError, rateLimited, clientIp, withErrorHandling } from "@/lib/http.js";
import { checkRateLimit, mailboxKey } from "@/lib/rate-limit.js";
import { alertEvent } from "@/lib/alerts.js";
import { maskEmail } from "@/lib/redact.js";

const WINDOW_MS = 15 * 60 * 1000;

const SIGN_IN_ERRORS = {
  link_invalid: "This sign-in link isn't valid. Copy the whole link from the email, or request a new one.",
  link_used: "This sign-in link or code has already been used. Request a new one to sign in again.",
  link_expired: "This sign-in link or code has expired or was replaced by a newer one. Request a new one — each works for 15 minutes.",
  code_locked: `That code was entered wrong ${MAX_CODE_ATTEMPTS} times, so it no longer works. Request a new code to sign in.`,
};

function codeInvalidMessage(attemptsLeft) {
  if (attemptsLeft <= 0) return "That code isn't right, and it can't be tried again. Request a new code to sign in.";
  return `That code isn't right. Check the code in the newest email — ${attemptsLeft} ${attemptsLeft === 1 ? "try" : "tries"} left.`;
}

async function findOrCreateUser(email) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return { user: existing, created: false };
  try {
    return { user: await prisma.user.create({ data: { email } }), created: true };
  } catch (err) {
    // Two tabs verifying for the same new address: the loser reads the winner's row.
    if (err?.code === "P2002") return { user: await prisma.user.findUniqueOrThrow({ where: { email } }), created: false };
    throw err;
  }
}

function failure(result) {
  if (result.reason === "code_invalid") {
    return jsonError(400, "code_invalid", codeInvalidMessage(result.attemptsLeft ?? 0), { attemptsLeft: result.attemptsLeft ?? 0 });
  }
  return jsonError(400, result.reason, SIGN_IN_ERRORS[result.reason]);
}

/**
 * POST {token, next?} | {email, code, next?} -> 200 {ok, user, next} + session cookie.
 * Errors (all 400): link_invalid | link_used | link_expired | code_locked |
 * code_invalid {attemptsLeft}; invalid_input (field email|code) for a malformed code request.
 * POST only: link scanners prefetch with GET, which must never consume a token. The
 * token is claimed last, after the user and session exist, so a failure earlier
 * leaves the link usable. `next`: a safe one in the body wins, else the one saved
 * when the link was requested, else /read.
 */
export const POST = withErrorHandling(async (request) => {
  const limit = checkRateLimit(`verify:ip:${clientIp(request)}`, { maxRequests: 30, windowMs: WINDOW_MS });
  if (!limit.allowed) return rateLimited(limit.retryAfter);

  const body = await parseJsonBody(request);
  if (!body.ok) return jsonError(400, "link_invalid", SIGN_IN_ERRORS.link_invalid);
  const data = body.data;

  let result;
  if (data.token !== undefined || data.code === undefined) {
    result = await verifyMagicToken(data.token, "login");
  } else {
    const check = validateEmail(data.email);
    if (!check.ok) return badRequest(check.message, "email");
    const code = normalizeCode(data.code);
    if (!code) return badRequest("Enter the 6-digit code from the email (numbers only).", "code");
    // Per mailbox, on top of the per-row attempt cap, so re-requesting codes can't farm guesses.
    const codeLimit = checkRateLimit(`verify:code:${mailboxKey(check.email)}`, { maxRequests: 15, windowMs: WINDOW_MS });
    if (!codeLimit.allowed) return rateLimited(codeLimit.retryAfter);
    result = await verifySignInCode(check.email, code, "login");
  }
  if (!result.valid) return failure(result);

  const { user, created } = await findOrCreateUser(result.email);
  const session = await createSessionToken(user);

  if (!(await consumeMagicToken(result.tokenId))) return jsonError(400, "link_used", SIGN_IN_ERRORS.link_used);

  if (created) alertEvent("New user signup", { email: maskEmail(user.email) }).catch(() => {});

  const next = safeNextPath(data.next) ?? result.next ?? DEFAULT_NEXT;
  const response = Response.json({ ok: true, user: publicUser(user), next });
  return setSessionCookie(response, session);
}, { source: "auth" });
