import { requireAdmin } from "@/lib/auth.js";
import { withErrorHandling } from "@/lib/http.js";
import { getAiCalls } from "@/lib/admin.js";

export const dynamic = "force-dynamic";

/** GET -> recent AiCall rows plus 24h grouping by provider and status. 401 without a session, 403 for non-admins. */
export const GET = withErrorHandling(async (request) => {
  const auth = await requireAdmin(request);
  if (auth.response) return auth.response;
  return Response.json(await getAiCalls(), { headers: { "Cache-Control": "no-store" } });
}, { source: "admin" });
