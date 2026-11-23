import { requireAdmin } from "@/lib/auth.js";
import { withErrorHandling } from "@/lib/http.js";
import { getLogs } from "@/lib/admin.js";

export const dynamic = "force-dynamic";

const LEVELS = ["WARN", "ERROR", "CRITICAL"];

/**
 * GET ?includeResolved=1&level=&source=&limit= -> {entries, resolvedCount, includeResolved}.
 * Resolved entries are hidden by default; each entry shows count and first/last seen.
 */
export const GET = withErrorHandling(async (request) => {
  const auth = await requireAdmin(request);
  if (auth.response) return auth.response;
  const params = new URL(request.url).searchParams;
  const includeResolved = ["1", "true"].includes(params.get("includeResolved") ?? "");
  const level = LEVELS.includes(params.get("level")) ? params.get("level") : undefined;
  const source = params.get("source")?.slice(0, 50) || undefined;
  const limit = parseInt(params.get("limit") ?? "", 10) || undefined;
  return Response.json(await getLogs({ includeResolved, level, source, limit }), { headers: { "Cache-Control": "no-store" } });
}, { source: "admin" });
