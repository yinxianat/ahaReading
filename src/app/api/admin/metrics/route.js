import { requireAdmin } from "@/lib/auth.js";
import { withErrorHandling } from "@/lib/http.js";
import { getMetrics } from "@/lib/admin.js";

export const dynamic = "force-dynamic";

/** GET -> usage metrics for the last 24 hours (spec 15.5). 401 without a session, 403 for non-admins. */
export const GET = withErrorHandling(async (request) => {
  const auth = await requireAdmin(request);
  if (auth.response) return auth.response;
  return Response.json(await getMetrics(), { headers: { "Cache-Control": "no-store" } });
}, { source: "admin" });
