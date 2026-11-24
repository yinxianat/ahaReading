/**
 * Bookmarks: spots in an article the reader marked to re-visit or as important,
 * each with an optional note. A bookmark stores the block index and a quote of the
 * marked text, so the reader can find the spot again after the article is edited.
 */
import { badRequest, hasNul, requireString } from "./http.js";
import { BOOKMARK_KINDS, MAX_BOOKMARK_NOTE_CHARS, MAX_BOOKMARK_QUOTE_CHARS } from "./limits.js";

export const BOOKMARK_INCLUDE = { article: { select: { title: true } } };

/**
 * API shape of a bookmark.
 * @param {object} b Bookmark row with `article: {title}` included
 */
export function serializeBookmark(b) {
  return {
    id: b.id,
    articleId: b.articleId,
    articleTitle: b.article?.title ?? null,
    blockIndex: b.blockIndex,
    quote: b.quote,
    kind: b.kind,
    note: b.note,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
  };
}

/**
 * @param {unknown} value
 * @returns {{kind: string} | {error: Response}}
 */
export function parseKind(value) {
  if (!BOOKMARK_KINDS.includes(value)) return { error: badRequest('Choose "revisit" or "important".', "kind") };
  return { kind: value };
}

/**
 * Optional note: string or null, NUL-free, ≤ MAX_BOOKMARK_NOTE_CHARS. Blank → null.
 * @param {unknown} value
 * @returns {{note: string|null} | {error: Response}}
 */
export function parseBookmarkNote(value) {
  if (value === undefined || value === null) return { note: null };
  if (typeof value !== "string") return { error: badRequest("The note must be text.", "note") };
  if (hasNul(value)) return { error: badRequest("Your note contains a hidden character. Retype it and try again.", "note") };
  const note = value.trim();
  if (note.length > MAX_BOOKMARK_NOTE_CHARS) {
    return { error: badRequest(`Keep the note to ${MAX_BOOKMARK_NOTE_CHARS.toLocaleString("en-US")} characters or fewer.`, "note") };
  }
  return { note: note || null };
}

/**
 * The marked text: required, whitespace collapsed, cut to MAX_BOOKMARK_QUOTE_CHARS
 * (a long selection is still a valid bookmark; the start is enough to find it again).
 * @param {unknown} value
 * @returns {{quote: string} | {error: Response}}
 */
export function parseQuote(value) {
  if (typeof value !== "string" || hasNul(value) || !value.trim()) return { error: badRequest("Select some text to bookmark.", "quote") };
  return { quote: Array.from(value.replace(/\s+/g, " ").trim()).slice(0, MAX_BOOKMARK_QUOTE_CHARS).join("") };
}

/**
 * @param {unknown} value
 * @returns {{blockIndex: number} | {error: Response}}
 */
export function parseBlockIndex(value) {
  if (!Number.isInteger(value) || value < 0 || value > 100_000) return { error: badRequest("blockIndex must be a whole number of 0 or more.", "blockIndex") };
  return { blockIndex: value };
}

/**
 * @param {unknown} value
 * @returns {string|null} a plausible id, or null
 */
export function parseId(value) {
  return requireString(value, { maxLength: 100 });
}
