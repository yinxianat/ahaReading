import { issueMagicToken, safeNextPath, MAGIC_LINK_TTL_MINUTES, CODE_LENGTH } from "@/lib/auth.js";
import { getBaseUrl } from "@/lib/base-url.js";
import { validateEmail } from "@/lib/email-check.js";
import { parseJsonBody, badRequest, rateLimited, clientIp, withErrorHandling } from "@/lib/http.js";
import { sendMail, smtpConfigured, deliveryHealth } from "@/lib/mailer.js";
import { logger } from "@/lib/logger.js";
import { maskEmail } from "@/lib/redact.js";
import { checkRateLimit, mailboxKey } from "@/lib/rate-limit.js";
import { isProduction } from "@/lib/env.js";

const WINDOW_MS = 15 * 60 * 1000;
// Last backstop across the whole app, for when per-IP and per-mailbox keys are both rotated.
const GLOBAL_MAX_PER_WINDOW = 200;

function emailBody(link, code) {
  const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
  const text =
    `Tap the link below to sign in to AhaReading:\n\n${link}\n\n` +
    `Or enter this code in the app: ${spaced}\n\n` +
    `The link and code work for ${MAGIC_LINK_TTL_MINUTES} minutes and can be used once.\n` +
    "If you didn't ask to sign in, you can ignore this email.";
  const html =
    `<p>Tap the button below to sign in to AhaReading.</p>` +
    `<p><a href="${link}" style="display:inline-block;padding:12px 20px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none">Sign in to AhaReading</a></p>` +
    `<p>Using the app from your Home Screen? Enter this code there instead:</p>` +
    `<p style="font-size:28px;font-weight:700;letter-spacing:6px;font-family:ui-monospace,Menlo,monospace">${spaced}</p>` +
    `<p style="color:#475569;font-size:14px">Or paste this link into your browser:<br>${link}</p>` +
    `<p style="color:#64748b;font-size:13px">The link and code work for ${MAGIC_LINK_TTL_MINUTES} minutes and can be used once. If you didn't ask to sign in, you can ignore this email.</p>`;
  return { text, html };
}

/**
 * POST {email, next?} -> 200 {ok, message, expiresInMinutes, codeLength, deliveryDegraded, devLink?, devCode?}.
 * Always 200 for a well-formed address, registered or not. The email (link + code)
 * is sent after the response is built (never awaited), so a slow mail server cannot
 * hang sign-in; failures are logged with their classified remedy.
 */
export const POST = withErrorHandling(async (request) => {
  const ipLimit = checkRateLimit(`request-link:ip:${clientIp(request)}`, { maxRequests: 5, windowMs: WINDOW_MS });
  if (!ipLimit.allowed) return rateLimited(ipLimit.retryAfter);

  const body = await parseJsonBody(request);
  if (!body.ok) return badRequest("Send your email address as JSON, like {\"email\":\"you@example.com\"}.");

  const check = validateEmail(body.data.email);
  if (!check.ok) return badRequest(check.message, "email");
  const email = check.email;

  const emailLimit = checkRateLimit(`request-link:email:${mailboxKey(email)}`, { maxRequests: 5, windowMs: WINDOW_MS });
  if (!emailLimit.allowed) return rateLimited(emailLimit.retryAfter);
  const globalLimit = checkRateLimit("request-link:global", { maxRequests: GLOBAL_MAX_PER_WINDOW, windowMs: WINDOW_MS });
  if (!globalLimit.allowed) {
    logger.error("auth", "Global sign-in email ceiling reached", { windowMs: WINDOW_MS, max: GLOBAL_MAX_PER_WINDOW });
    return rateLimited(globalLimit.retryAfter);
  }

  const next = safeNextPath(body.data.next);
  const { plaintext, code } = await issueMagicToken(email, { purpose: "login", next });
  const link = `${getBaseUrl()}/auth/verify?token=${plaintext}${next ? `&next=${encodeURIComponent(next)}` : ""}`;

  const { text, html } = emailBody(link, code);
  sendMail({ to: email, subject: "Your AhaReading sign-in link", text, html })
    .then((result) => {
      if (result.error) {
        logger.error("email", "Sign-in email could not be delivered", {
          reason: result.error,
          remedy: result.hint,
          detail: result.detail,
          elapsedMs: result.elapsedMs,
          to: maskEmail(email),
        });
      }
    })
    .catch((err) => logger.error("email", "Sign-in email send threw unexpectedly", { detail: err?.message }));

  const response = {
    ok: true,
    message:
      `Check your inbox for a sign-in link and a ${CODE_LENGTH}-digit code. It usually arrives within a minute and works for ${MAGIC_LINK_TTL_MINUTES} minutes. ` +
      "If you don't see it, check your spam or promotions folder.",
    expiresInMinutes: MAGIC_LINK_TTL_MINUTES,
    codeLength: CODE_LENGTH,
    deliveryDegraded: deliveryHealth().degraded,
  };
  if (!isProduction() && !smtpConfigured()) {
    response.devLink = link;
    response.devCode = code;
  }
  return Response.json(response);
}, { source: "auth" });
