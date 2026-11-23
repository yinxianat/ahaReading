import { requireUser, publicUser } from "@/lib/auth.js";
import { withErrorHandling } from "@/lib/http.js";

/** GET -> 200 {user:{id,email,displayName,locale,helpLevel,onboardedAt,isAdmin}} | 401. */
export const GET = withErrorHandling(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  return Response.json({ user: publicUser(auth.user) }, { headers: { "Cache-Control": "no-store" } });
}, { source: "auth" });
