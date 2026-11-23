import { requireUser, revokeAllSessions, clearSessionCookie } from "@/lib/auth.js";
import { withErrorHandling } from "@/lib/http.js";

/**
 * POST -> 200 {ok:true}: signs out every device (SEC-10) by bumping the user's
 * sessionVersion, and clears this device's cookie. 401 without a session;
 * cross-site posts get 403 from withErrorHandling.
 */
export const POST = withErrorHandling(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  await revokeAllSessions(auth.user.id);
  return clearSessionCookie(Response.json({ ok: true }));
}, { source: "auth" });
