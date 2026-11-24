import prisma from "@/lib/db.js";
import { requireUser } from "@/lib/auth.js";
import { parseJsonBody, badRequest, jsonError, rateLimited, withErrorHandling } from "@/lib/http.js";
import { checkRateLimit } from "@/lib/rate-limit.js";
import { BOOKMARK_INCLUDE, parseBookmarkNote, parseKind, serializeBookmark } from "@/lib/bookmarks.js";

const notFound = () => jsonError(404, "not_found", "We couldn't find that bookmark. It may have been deleted.");

async function bookmarkId(context) {
  const { id } = await context.params;
  return typeof id === "string" && id.length <= 100 ? id : null;
}

/** PATCH {kind?, note?} → {bookmark} */
export const PATCH = withErrorHandling(async (request, context) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const userId = auth.user.id;
  const id = await bookmarkId(context);
  if (!id) return notFound();
  const limit = checkRateLimit(`bookmarks:${userId}`, { maxRequests: 60, windowMs: 60_000 });
  if (!limit.allowed) return rateLimited(limit.retryAfter);

  const body = await parseJsonBody(request);
  if (!body.ok) return badRequest("Send your changes as a JSON object.");
  const data = {};
  if ("kind" in body.data) {
    const kind = parseKind(body.data.kind);
    if (kind.error) return kind.error;
    data.kind = kind.kind;
  }
  if ("note" in body.data) {
    const note = parseBookmarkNote(body.data.note);
    if (note.error) return note.error;
    data.note = note.note;
  }
  if (Object.keys(data).length === 0) return badRequest("Nothing to update. Send kind or note.");

  const { count } = await prisma.bookmark.updateMany({ where: { id, userId }, data });
  if (count === 0) return notFound();
  const bookmark = await prisma.bookmark.findFirst({ where: { id, userId }, include: BOOKMARK_INCLUDE });
  return Response.json({ bookmark: serializeBookmark(bookmark) });
}, { source: "api" });

/** DELETE → {ok:true} */
export const DELETE = withErrorHandling(async (request, context) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const id = await bookmarkId(context);
  if (!id) return notFound();
  const { count } = await prisma.bookmark.deleteMany({ where: { id, userId: auth.user.id } });
  if (count === 0) return notFound();
  return Response.json({ ok: true });
}, { source: "api" });
