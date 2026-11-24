import prisma from "@/lib/db.js";
import { requireUser } from "@/lib/auth.js";
import { parseJsonBody, badRequest, jsonError, rateLimited, withErrorHandling } from "@/lib/http.js";
import { checkRateLimit } from "@/lib/rate-limit.js";

/**
 * PUT {block, percent} → 204. Where the reader stopped (block index of the topmost
 * visible block) and how far down they got (0..100). Sent while scrolling (debounced)
 * and when leaving the page, so it must be cheap and quiet.
 */
export const PUT = withErrorHandling(async (request, context) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const userId = auth.user.id;
  const { id } = await context.params;
  if (typeof id !== "string" || id.length > 100) return jsonError(404, "not_found", "We couldn't find that article.");
  const limit = checkRateLimit(`progress:${userId}`, { maxRequests: 120, windowMs: 60_000 });
  if (!limit.allowed) return rateLimited(limit.retryAfter);

  const body = await parseJsonBody(request);
  if (!body.ok) return badRequest("Send the reading position as a JSON object.");
  const { block, percent } = body.data;
  if (!Number.isInteger(block) || block < 0 || block > 100_000) return badRequest("block must be a whole number of 0 or more.", "block");
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return badRequest("percent must be between 0 and 100.", "percent");

  const { count } = await prisma.article.updateMany({ where: { id, userId }, data: { readBlock: block, readPercent: Math.round(percent) } });
  if (count === 0) return jsonError(404, "not_found", "We couldn't find that article.");
  return new Response(null, { status: 204 });
}, { source: "api" });
