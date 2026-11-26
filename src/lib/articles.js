import prisma from "@/lib/db.js";
import { safeFetch, UrlGuardError } from "@/lib/url-guard.js";
import { extractReadableMarkdown, normalizePlainText } from "@/lib/extract.js";
import { extractDocument } from "@/lib/document-import.js";
import { articlePlainText, parseArticleBlocks } from "@/lib/article-blocks.js";
import { looksLikeMarkdown, markdownPlainText, markdownUnits } from "@/lib/article-markdown.js";
import { MAX_ARTICLE_CHARS, MAX_TITLE_CHARS } from "@/lib/limits.js";
import { badRequest, hasNul } from "@/lib/http.js";

/**
 * Article content is capped on write. `format` says how it's stored: "markdown" keeps the original
 * formatting (article-markdown.js); "blocks" is plain block text (article-blocks.js) for PDFs, plain
 * pastes and older articles.
 */
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
  return { id: a.id, title: a.title, domain: a.domain, url: a.url, fileName: a.fileName ?? null, format: a.format ?? "blocks", content: a.content, createdAt: a.createdAt, lastReadAt: a.lastReadAt, readBlock: a.readBlock ?? null, readPercent: a.readPercent ?? 0 };
}

function titleFromText(content, format = "blocks") {
  let line;
  if (format === "markdown") {
    line = markdownUnits(content.slice(0, 4000)).find((u) => u.type !== "code" && u.type !== "row")?.text;
  } else {
    const first = parseArticleBlocks(content.slice(0, 2000)).find((b) => b.type !== "code");
    line = first?.type === "list" ? first.items[0] : first?.text;
  }
  line = (line || "Untitled").replace(/\s+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 77).trimEnd()}…` : line;
}

/**
 * Content and format for text the user wrote or pasted. `markdown`: true keeps it as Markdown,
 * false stores plain text, undefined decides from the text (looksLikeMarkdown).
 * @param {string} text
 * @param {boolean} [markdown]
 * @returns {{content: string, format: "markdown"|"blocks"}}
 */
export function contentFromText(text, markdown) {
  const asMarkdown = markdown === undefined ? looksLikeMarkdown(text) : Boolean(markdown);
  if (!asMarkdown) return { content: normalizePlainText(text).text.slice(0, MAX_CONTENT_CHARS), format: "blocks" };
  const content = String(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, MAX_CONTENT_CHARS);
  return { content, format: "markdown" };
}

/**
 * Validate article text (pasted or edited): non-empty, NUL-free, within the cap.
 * @param {unknown} text
 * @returns {{text: string} | {error: Response}}
 */
export function parseArticleText(text) {
  if (typeof text !== "string" || !text.trim()) return { error: badRequest("Paste the text you want to read.", "text") };
  if (hasNul(text)) return { error: badRequest("Your text contains a hidden NUL character. Copy it again from the source, or retype the affected part.", "text") };
  if (text.length > MAX_CONTENT_CHARS) {
    return { error: badRequest(`That's too long to save — use up to ${MAX_CONTENT_CHARS.toLocaleString("en-US")} characters.`, "text") };
  }
  return { text };
}

/**
 * Validate an optional title: text, NUL-free, ≤ MAX_TITLE_CHARS. Blank → null (one is made from the text).
 * @param {unknown} title
 * @returns {{title: string|null} | {error: Response}}
 */
export function parseArticleTitle(title) {
  if (title === undefined || title === null) return { title: null };
  if (typeof title !== "string") return { error: badRequest("The title must be text.", "title") };
  if (hasNul(title)) return { error: badRequest("The title contains a hidden character. Retype it and try again.", "title") };
  const clean = title.trim().replace(/\s+/g, " ");
  if (clean.length > MAX_TITLE_CHARS) return { error: badRequest(`Keep the title to ${MAX_TITLE_CHARS} characters or fewer.`, "title") };
  return { title: clean || null };
}

/**
 * Change one of the user's articles. Edited text is normalised like pasted text (blank-line
 * paragraphs, fenced code kept), so headings/lists written as "## …" / "- …" still render.
 * Saved concepts stay linked; their highlights are found again by term in the new text.
 * @param {string} userId
 * @param {string} id
 * @param {{title?: string|null, text?: string, markdown?: boolean}} changes already validated; a key that is
 *   absent is unchanged. `markdown` (with `text`) switches the format; without it the format is kept.
 * @returns {Promise<object|null>} the updated article, or null when it isn't the user's
 */
export async function updateArticle(userId, id, changes) {
  const data = {};
  const current = await prisma.article.findFirst({ where: { id, userId }, select: { content: true, format: true } });
  if (!current) return null;
  if (changes.text !== undefined) {
    const keep = changes.markdown === undefined ? current.format === "markdown" : changes.markdown;
    Object.assign(data, contentFromText(changes.text, keep));
  }
  if (changes.title !== undefined) {
    const content = data.content ?? current.content ?? "";
    data.title = (changes.title || titleFromText(content, data.format ?? current.format)).slice(0, MAX_TITLE_CHARS);
  }
  const { count } = await prisma.article.updateMany({ where: { id, userId }, data });
  if (count === 0) return null;
  return prisma.article.findFirst({ where: { id, userId } });
}

/**
 * Save pasted text as a new article.
 * @param {string} userId
 * @param {{text: string, title?: string|null, markdown?: boolean}} input already type-checked by the route;
 *   `markdown` as in contentFromText
 */
export async function createPastedArticle(userId, { text, title, markdown }) {
  const { content, format } = contentFromText(text, markdown);
  return prisma.article.create({
    data: {
      userId,
      url: null,
      domain: null,
      title: (title || titleFromText(content, format)).slice(0, MAX_TITLE_CHARS),
      content,
      format,
    },
  });
}

/**
 * Save an uploaded PDF, Word or Markdown file as a new article. The same file uploaded again
 * soon after (a retry after a timeout, a double tap) reopens the article it made
 * instead of adding a duplicate.
 * @param {string} userId
 * @param {{bytes: Uint8Array, fileName: string, signal?: AbortSignal}} upload `fileName` already cleaned by the route
 * @returns {Promise<{article: object, created: boolean}>}
 * @throws {import("./document-import.js").DocumentImportError}
 */
export async function createUploadedArticle(userId, { bytes, fileName, contentType, signal }) {
  const doc = await extractDocument(bytes, { fileName, contentType, signal });
  const data = { fileName: fileName || null, title: doc.title, content: doc.text, format: doc.format || "blocks" };
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
  // Web pages keep their formatting as Markdown; plain-text pages stay plain blocks.
  const extracted = isHtml
    ? (({ title, markdown }) => ({ title, text: markdown, format: "markdown" }))(extractReadableMarkdown(fetched.text, { baseUrl: fetched.finalUrl }))
    : { ...normalizePlainText(fetched.text), title: "", format: "blocks" };
  const readable = extracted.format === "markdown" ? markdownPlainText(extracted.text) : extracted.text;
  if (readable.length < 50) {
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
    format: extracted.format,
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
 * @returns {Promise<Array<{id, title, domain, url, fileName, lastReadAt, readPercent, conceptCount, excerpt}>>}
 */
export async function listArticles(userId) {
  const rows = await prisma.$queryRaw`
    SELECT a."id", a."title", a."domain", a."url", a."fileName", a."format", a."lastReadAt", a."readPercent",
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
    readPercent: Number(r.readPercent) || 0,
    lastReadAt: r.lastReadAt,
    conceptCount: Number(r.conceptCount) || 0,
    excerpt: r.excerpt ? (r.format === "markdown" ? markdownPlainText(r.excerpt) : articlePlainText(r.excerpt)).replace(/\s+/g, " ").trim().slice(0, EXCERPT_CHARS) : "",
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
