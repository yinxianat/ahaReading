import { requireAdmin } from "@/lib/auth.js";
import { withErrorHandling } from "@/lib/http.js";
import { getOverview } from "@/lib/admin.js";

export const dynamic = "force-dynamic";

/** GET -> headline, findings, metrics, logs, AI calls, users and infrastructure in one payload (each section degrades on its own). 401 without a session, 403 for non-admins. */
export const GET = withErrorHandling(async (request) => {
  const auth = await requireAdmin(request);
  if (auth.response) return auth.response;
  return Response.json(await getOverview(), { headers: { "Cache-Control": "no-store" } });
}, { source: "admin" });
