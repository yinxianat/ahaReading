import { clearSessionCookie } from "@/lib/auth.js";
import { withErrorHandling } from "@/lib/http.js";

/** POST -> 200 {ok:true}, clearing the session cookie. Idempotent; cross-site posts get 403. */
export const POST = withErrorHandling(async () => clearSessionCookie(Response.json({ ok: true })), { source: "auth" });
