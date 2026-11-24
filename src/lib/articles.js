import prisma from "@/lib/db.js";
import { safeFetch, UrlGuardError } from "@/lib/url-guard.js";
import { extractReadable, normalizePlainText } from "@/lib/extract.js";
import { extractDocument } from "@/lib/document-import.js";
import { articlePlainText, parseArticleBlocks } from "@/lib/article-blocks.js";
import { MAX_ARTICLE_CHARS, MAX_TITLE_CHARS } from "@/lib/limits.js";

/** Article content is capped on write; it is stored in the article-blocks.js format. */
export const MAX_CONTENT_CHARS = MAX_ARTICLE_CHARS;
export { MAX_TITLE_CHARS };
// Read a little extra so block markers ("## ", "```") can be stripped from the excerpt.
const EXCERPT_CHARS = 240;
const EXCERPT_READ_CHARS = 600;
const LIST_LIMIT = 50;
const DUPLICATE_UPLOAD_WINDOW_MS = 10 * 60_000;

/**
 * Shape returned to the client (with content).
 * @param {object} a Article row
 */
export function serializeArticle(a) {
  return { id: a.id, title: a.title, domain: a.domain, url: a.url, fileName: a.fileName ?? null, content: a.content, createdAt: a.createdAt, lastReadAt: a.lastReadAt };
}

function titleFromText(content) {
  const first = parseArticleBlocks(content.slice(0, 2000)).find((b) => b.type !== "code");
  const line = (first?.type === "list" ? first.items[0] : first?.text) || "Untitled";
  return line.length > 80 ? `${line.slice(0, 77).trimEnd()}…` : line;
}

/**
 * Save pasted text as a new article.
 * @param {string} userId
 * @param {{text: string, title?: string|null}} input already type-checked by the route
 */
export async function createPastedArticle(userId, { text, title }) {
  const { text: content } = normalizePlainText(text);
  return prisma.article.create({
    data: {
      userId,
      url: null,
      domain: null,
      title: (title || titleFromText(content)).slice(0, MAX_TITLE_CHARS),
      content: content.slice(0, MAX_CONTENT_CHARS),
    },
  });
}

/**
 * Save an uploaded PDF or Word file as a new article. The same file uploaded again
 * soon after (a retry after a timeout, a double tap) reopens the article it made
 * instead of adding a duplicate.
 * @param {string} userId
 * @param {{bytes: Uint8Array, fileName: string, signal?: AbortSignal}} upload `fileName` already cleaned by the route
 * @returns {Promise<{article: object, created: boolean}>}
 * @throws {import("./document-import.js").DocumentImportError}
 */
export async function createUploadedArticle(userId, { bytes, fileName, signal }) {
  const doc = await extractDocument(bytes, { fileName, signal });
  const data = { fileName: fileName || null, title: doc.title, content: doc.text };
  const same = await prisma.article.findFirst({
    where: { userId, url: null, ...data, createdAt: { gte: new Date(Date.now() - DUPLICATE_UPLOAD_WINDOW_MS) } },
    select: { id: true },
  });
  if (same) return { article: await prisma.article.update({ where: { id: same.id }, data: { lastReadAt: new Date() } }), created: false };
  return { article: await prisma.article.create({ data: { userId, url: null, domain: null, ...data } }), created: true };
}

/**
 * Fetch a URL through the SSRF guard, extract readable text, and upsert by (userId, url).
 * @param {string} userId
 * @param {string} rawUrl
 * @param {{fetcher?: typeof safeFetch}} [options]
 * @throws {UrlGuardError}
 */
export async function importArticleFromUrl(userId, rawUrl, { fetcher = safeFetch } = {}) {
  const fetched = await fetcher(rawUrl);
  const isHtml = !fetched.contentType.startsWith("text/plain");
  const extracted = isHtml ? extractReadable(fetched.text) : { ...normalizePlainText(fetched.text), title: "" };
  if (extracted.text.length < 50) {
    throw new UrlGuardError(
      "url_not_readable",
      "We couldn't find readable text on that page (it may need JavaScript or a login). Paste the text instead.",
      "no_text"
    );
  }
  const finalUrl = new URL(fetched.finalUrl);
  const url = finalUrl.href.slice(0, 2000);
  const data = {
    title: (extracted.title || finalUrl.hostname).slice(0, MAX_TITLE_CHARS),
    domain: finalUrl.hostname.slice(0, 255),
    content: extracted.text.slice(0, MAX_CONTENT_CHARS),
    lastReadAt: new Date(),
  };
  return prisma.article.upsert({
    where: { userId_url: { userId, url } },
    create: { userId, url, ...data },
    update: data,
  });
}

/**
 * Recent articles for the Library, without full content.
 * @param {string} userId
 * @returns {Promise<Array<{id, title, domain, url, fileName, lastReadAt, conceptCount, excerpt}>>}
 */
export async function listArticles(userId) {
  const rows = await prisma.$queryRaw`
    SELECT a."id", a."title", a."domain", a."url", a."fileName", a."lastReadAt",
           LEFT(COALESCE(a."content", ''), ${EXCERPT_READ_CHARS}) AS "excerpt",
           (SELECT COUNT(*)::int FROM "Concept" c WHERE c."articleId" = a."id" AND c."userId" = ${userId}) AS "conceptCount"
    FROM "Article" a
    WHERE a."userId" = ${userId}
    ORDER BY a."lastReadAt" DESC
    LIMIT ${LIST_LIMIT}`;
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    domain: r.domain,
    url: r.url,
    fileName: r.fileName ?? null,
    lastReadAt: r.lastReadAt,
    conceptCount: Number(r.conceptCount) || 0,
    excerpt: r.excerpt ? articlePlainText(r.excerpt).replace(/\s+/g, " ").trim().slice(0, EXCERPT_CHARS) : "",
  }));
}

/**
 * Get one of the user's articles (and mark it as just read). Null when not the owner.
 * @param {string} userId
 * @param {string} id
 */
export async function getArticle(userId, id) {
  const { count } = await prisma.article.updateMany({ where: { id, userId }, data: { lastReadAt: new Date() } });
  if (count === 0) return null;
  return prisma.article.findFirst({ where: { id, userId } });
}

/**
 * Delete one of the user's articles. Returns false when not found / not the owner.
 * @param {string} userId
 * @param {string} id
 */
export async function deleteArticle(userId, id) {
  const { count } = await prisma.article.deleteMany({ where: { id, userId } });
  return count > 0;
}
