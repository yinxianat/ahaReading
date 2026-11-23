import prisma from "@/lib/db.js";
import { requireUser, publicUser, clearSessionCookie } from "@/lib/auth.js";
import { parseJsonBody, badRequest, rateLimited, hasNul, withErrorHandling } from "@/lib/http.js";
import { checkRateLimit } from "@/lib/rate-limit.js";
import { MAX_DISPLAY_NAME_CHARS as DISPLAY_NAME_MAX } from "@/lib/limits.js";

const LOCALES = ["en", "zh"];
// Reading the profile is GET /api/auth/me; this route only changes or deletes it.

// Returns {data} or {error: Response}. Wrong types are rejected, never coerced.
function parsePatch(input) {
  const data = {};
  if ("displayName" in input) {
    const v = input.displayName;
    if (v === null || (typeof v === "string" && v.trim() === "")) data.displayName = null;
    else if (typeof v !== "string") return { error: badRequest("Display name must be text.", "displayName") };
    else if (hasNul(v)) return { error: badRequest("Display name contains a hidden character. Retype it and try again.", "displayName") };
    else if (v.trim().length > DISPLAY_NAME_MAX) {
      return { error: badRequest(`Display name must be ${DISPLAY_NAME_MAX} characters or fewer.`, "displayName") };
    } else data.displayName = v.trim();
  }
  if ("locale" in input) {
    if (!LOCALES.includes(input.locale)) return { error: badRequest('Language must be "en" or "zh".', "locale") };
    data.locale = input.locale;
  }
  if ("helpLevel" in input) {
    if (!Number.isInteger(input.helpLevel) || input.helpLevel < 1 || input.helpLevel > 3) {
      return { error: badRequest("Help level must be 1, 2 or 3.", "helpLevel") };
    }
    data.helpLevel = input.helpLevel;
  }
  if ("onboarded" in input) {
    if (input.onboarded !== true) return { error: badRequest("onboarded can only be set to true.", "onboarded") };
    data.onboarded = true;
  }
  if (Object.keys(data).length === 0) {
    return { error: badRequest("Nothing to update. Send displayName, locale, helpLevel or onboarded.") };
  }
  return { data };
}

/** PATCH {displayName?, locale?, helpLevel?, onboarded?:true} -> 200 {user}. */
export const PATCH = withErrorHandling(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;

  const limit = checkRateLimit(`me:patch:${auth.user.id}`, { maxRequests: 30, windowMs: 60_000 });
  if (!limit.allowed) return rateLimited(limit.retryAfter);

  const body = await parseJsonBody(request);
  if (!body.ok) return badRequest("Send your changes as a JSON object.");
  const parsed = parsePatch(body.data);
  if (parsed.error) return parsed.error;

  const { onboarded, ...fields } = parsed.data;
  // First completion wins; re-sending onboarded keeps the original timestamp.
  if (onboarded && !auth.user.onboardedAt) fields.onboardedAt = new Date();

  const user = Object.keys(fields).length > 0
    ? await prisma.user.update({ where: { id: auth.user.id }, data: fields })
    : auth.user;
  return Response.json({ user: publicUser(user) });
}, { source: "api" });

/** DELETE {confirm:"DELETE"} -> 200; removes the account and all its data (cascade). */
export const DELETE = withErrorHandling(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;

  const body = await parseJsonBody(request);
  if (!body.ok || body.data.confirm !== "DELETE") {
    return badRequest('To delete your account, send {"confirm":"DELETE"}.', "confirm");
  }

  // Pending sign-in links for this address are not linked by userId when they
  // were minted before the account existed, so remove them by email too.
  await prisma.$transaction([
    prisma.magicToken.deleteMany({ where: { email: auth.user.email } }),
    prisma.user.delete({ where: { id: auth.user.id } }),
  ]);
  return clearSessionCookie(Response.json({ ok: true, message: "Your account and all of its data have been deleted." }));
}, { source: "api" });
