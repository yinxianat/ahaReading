import { requireAdmin } from "@/lib/auth.js";
import { withErrorHandling } from "@/lib/http.js";
import { getUsers } from "@/lib/admin.js";

export const dynamic = "force-dynamic";

/** GET -> users with concept/explanation counts and last activity. 401 without a session, 403 for non-admins. */
export const GET = withErrorHandling(async (request) => {
  const auth = await requireAdmin(request);
  if (auth.response) return auth.response;
  return Response.json(await getUsers(), { headers: { "Cache-Control": "no-store" } });
}, { source: "admin" });
