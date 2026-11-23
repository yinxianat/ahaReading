import { requireUser } from "@/lib/auth.js";
import { jsonError, withErrorHandling } from "@/lib/http.js";
import { deleteArticle, getArticle, serializeArticle } from "@/lib/articles.js";

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

/** DELETE → {ok:true}. Saved concepts keep their content; their articleId becomes null. */
export const DELETE = withErrorHandling(async (request, context) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const id = await articleId(context);
  if (!id) return notFound();
  if (!(await deleteArticle(auth.user.id, id))) return notFound();
  return Response.json({ ok: true });
}, { source: "api" });
