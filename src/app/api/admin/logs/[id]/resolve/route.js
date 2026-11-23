import { requireAdmin } from "@/lib/auth.js";
import { withErrorHandling, jsonError } from "@/lib/http.js";
import { resolveLog } from "@/lib/admin.js";

/**
 * POST -> 200 {ok, id, resolvedAt}; 404 not_found. Hides the entry from the
 * default view until the same fingerprint recurs. No body is read.
 */
export const POST = withErrorHandling(async (request, { params }) => {
  const auth = await requireAdmin(request);
  if (auth.response) return auth.response;
  const { id } = await params;
  if (typeof id !== "string" || id.length === 0 || id.length > 64) {
    return jsonError(404, "not_found", "That log entry doesn't exist. Refresh the list.");
  }
  const result = await resolveLog(id);
  if (!result) return jsonError(404, "not_found", "That log entry doesn't exist. Refresh the list.");
  return Response.json({ ok: true, ...result });
}, { source: "admin" });
