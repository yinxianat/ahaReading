import prisma from "@/lib/db.js";
import { requireUser } from "@/lib/auth.js";
import { parseJsonBody, badRequest, jsonError, rateLimited, withErrorHandling } from "@/lib/http.js";
import { checkRateLimit } from "@/lib/rate-limit.js";
import { BOOKMARK_INCLUDE, parseBlockIndex, parseBookmarkNote, parseId, parseKind, parseQuote, serializeBookmark } from "@/lib/bookmarks.js";
import { BOOKMARK_KINDS, MAX_BOOKMARKS_PER_ARTICLE } from "@/lib/limits.js";

const LIST_LIMIT = 500;

/**
 * GET ?kind=revisit|important&articleId= → {bookmarks:[…], counts:{all, revisit, important}}
 * Newest first. `counts` ignore the kind filter (for the filter labels).
 */
export const GET = withErrorHandling(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const userId = auth.user.id;
  const params = new URL(request.url).searchParams;
  const kind = params.get("kind") || "";
  if (kind && !BOOKMARK_KINDS.includes(kind)) return badRequest('kind must be "revisit" or "important".', "kind");
  const articleId = params.get("articleId") || "";
  if (articleId && !parseId(articleId)) return badRequest("articleId must be an article id.", "articleId");

  const scope = { userId, ...(articleId ? { articleId } : {}) };
  const [rows, grouped] = await Promise.all([
    prisma.bookmark.findMany({
      where: { ...scope, ...(kind ? { kind } : {}) },
      include: BOOKMARK_INCLUDE,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: LIST_LIMIT,
    }),
    prisma.bookmark.groupBy({ by: ["kind"], where: scope, _count: { _all: true } }),
  ]);
  const counts = { all: 0, revisit: 0, important: 0 };
  for (const g of grouped) {
    counts[g.kind] = g._count._all;
    counts.all += g._count._all;
  }
  return Response.json({ bookmarks: rows.map(serializeBookmark), counts }, { headers: { "Cache-Control": "no-store" } });
}, { source: "api" });

/** POST {articleId, blockIndex, quote, kind, note?} → 201 {bookmark} */
export const POST = withErrorHandling(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const userId = auth.user.id;
  const limit = checkRateLimit(`bookmarks:${userId}`, { maxRequests: 60, windowMs: 60_000 });
  if (!limit.allowed) return rateLimited(limit.retryAfter);

  const body = await parseJsonBody(request);
  if (!body.ok) return badRequest("Send the bookmark as a JSON object.");
  const articleId = parseId(body.data.articleId);
  if (!articleId) return badRequest("articleId is required.", "articleId");
  const block = parseBlockIndex(body.data.blockIndex);
  if (block.error) return block.error;
  const quote = parseQuote(body.data.quote);
  if (quote.error) return quote.error;
  const kind = parseKind(body.data.kind);
  if (kind.error) return kind.error;
  const note = parseBookmarkNote(body.data.note);
  if (note.error) return note.error;

  const article = await prisma.article.findFirst({ where: { id: articleId, userId }, select: { id: true } });
  if (!article) return jsonError(404, "not_found", "We couldn't find that article. Go back to your Library and open it again.");
  const existing = await prisma.bookmark.count({ where: { userId, articleId } });
  if (existing >= MAX_BOOKMARKS_PER_ARTICLE) {
    return jsonError(409, "too_many_bookmarks", `This article already has ${MAX_BOOKMARKS_PER_ARTICLE} bookmarks. Delete some you no longer need, then try again.`);
  }

  const bookmark = await prisma.bookmark.create({
    data: { userId, articleId, blockIndex: block.blockIndex, quote: quote.quote, kind: kind.kind, note: note.note },
    include: BOOKMARK_INCLUDE,
  });
  return Response.json({ bookmark: serializeBookmark(bookmark) }, { status: 201 });
}, { source: "api" });
