import { requireUser } from "@/lib/auth.js";
import { parseJsonBody, badRequest, jsonError, rateLimited, hasNul, withErrorHandling } from "@/lib/http.js";
import { checkRateLimit } from "@/lib/rate-limit.js";
import { logger } from "@/lib/logger.js";
import { UrlGuardError } from "@/lib/url-guard.js";
import { createPastedArticle, importArticleFromUrl, listArticles, serializeArticle, parseArticleText, parseArticleTitle } from "@/lib/articles.js";

/** GET → {articles:[{id,title,domain,url,lastReadAt,conceptCount,excerpt}]} */
export const GET = withErrorHandling(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const articles = await listArticles(auth.user.id);
  return Response.json({ articles }, { headers: { "Cache-Control": "no-store" } });
}, { source: "api" });

// One URL import at a time per user: each holds a DNS lookup and a socket for up to 5 s.
const importsInFlight = new Set();

/** POST {text, title?} | {url} → 201 {article}; content uses the article-blocks.js format. */
export const POST = withErrorHandling(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const userId = auth.user.id;

  const limit = checkRateLimit(`articles:${userId}`, { maxRequests: 20, windowMs: 60_000 });
  if (!limit.allowed) return rateLimited(limit.retryAfter);

  const body = await parseJsonBody(request);
  if (!body.ok) return badRequest("Send the article as a JSON object.");
  const { text, title, url } = body.data;

  if (url !== undefined && text !== undefined) return badRequest("Send either text or a url, not both.");

  if (url !== undefined) {
    if (typeof url !== "string" || !url.trim() || hasNul(url)) return badRequest("Paste a full link that starts with http:// or https://.", "url");
    if (importsInFlight.has(userId)) {
      return jsonError(429, "rate_limited", "Another link is still importing. Wait for it to finish, then try again.", { retryAfter: 5 }, { "Retry-After": "5" });
    }
    importsInFlight.add(userId);
    try {
      const article = await importArticleFromUrl(userId, url.trim());
      return Response.json({ article: serializeArticle(article) }, { status: 201 });
    } catch (err) {
      if (!(err instanceof UrlGuardError)) throw err;
      if (err.code === "url_blocked") void logger.warn("api", "Article import blocked by URL guard", { reason: err.detail });
      return jsonError(400, err.code, err.message, { field: "url" });
    } finally {
      importsInFlight.delete(userId);
    }
  }

  const parsedText = parseArticleText(text);
  if (parsedText.error) return parsedText.error;
  const parsedTitle = parseArticleTitle(title);
  if (parsedTitle.error) return parsedTitle.error;
  const { markdown } = body.data;
  if (markdown !== undefined && typeof markdown !== "boolean") return badRequest("markdown must be true or false.", "markdown");

  const article = await createPastedArticle(userId, { text: parsedText.text, title: parsedTitle.title, markdown });
  return Response.json({ article: serializeArticle(article) }, { status: 201 });
}, { source: "api" });
