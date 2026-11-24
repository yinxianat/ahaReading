import { requireUser } from "@/lib/auth.js";
import { badRequest, jsonError, parseJsonBody, rateLimited, withErrorHandling } from "@/lib/http.js";
import { checkRateLimit } from "@/lib/rate-limit.js";
import { deleteArticle, getArticle, parseArticleText, parseArticleTitle, serializeArticle, updateArticle } from "@/lib/articles.js";

const notFound = () => jsonError(404, "not_found", "We couldn't find that article. Go back to your Library.");

async function articleId(context) {
  const { id } = await context.params;
  return typeof id === "string" && id.length <= 100 ? id : null;
}

/** GET → {article} (with content) */
export const GET = withErrorHandling(async (request, context) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const id = await articleId(context);
  if (!id) return notFound();
  const article = await getArticle(auth.user.id, id);
  if (!article) return notFound();
  return Response.json({ article: serializeArticle(article) }, { headers: { "Cache-Control": "no-store" } });
}, { source: "api" });

/** PATCH {title?, text?} → {article}. A blank title is rebuilt from the text; send at least one field. */
export const PATCH = withErrorHandling(async (request, context) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const userId = auth.user.id;
  const id = await articleId(context);
  if (!id) return notFound();

  // Same bucket as adding articles: an edit rewrites the whole text.
  const limit = checkRateLimit(`articles:${userId}`, { maxRequests: 20, windowMs: 60_000 });
  if (!limit.allowed) return rateLimited(limit.retryAfter);

  const body = await parseJsonBody(request);
  if (!body.ok) return badRequest("Send your changes as a JSON object.");
  const changes = {};
  if ("text" in body.data) {
    const parsed = parseArticleText(body.data.text);
    if (parsed.error) return parsed.error;
    changes.text = parsed.text;
  }
  if ("title" in body.data) {
    const parsed = parseArticleTitle(body.data.title);
    if (parsed.error) return parsed.error;
    changes.title = parsed.title;
  }
  if (Object.keys(changes).length === 0) return badRequest("Nothing to update. Send a title or the text.");

  const article = await updateArticle(userId, id, changes);
  if (!article) return notFound();
  return Response.json({ article: serializeArticle(article) });
}, { source: "api" });

/** DELETE → {ok:true}. Saved concepts keep their content; their articleId becomes null. */
export const DELETE = withErrorHandling(async (request, context) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const id = await articleId(context);
  if (!id) return notFound();
  if (!(await deleteArticle(auth.user.id, id))) return notFound();
  return Response.json({ ok: true });
}, { source: "api" });
