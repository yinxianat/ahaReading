/**
 * Concept domain helpers shared by the notebook and review routes: the API shape,
 * input parsing for tags/notes/terms, and the duplicate-term key.
 */
import { badRequest, hasNul } from "./http.js";

import { MAX_TAGS, MAX_TAG_CHARS, MAX_NOTES_CHARS, MAX_TERM_CHARS, MAX_DEFINITION_CHARS } from "./limits.js";

export { MAX_TAGS, MAX_TAG_CHARS, MAX_NOTES_CHARS, MAX_TERM_CHARS, MAX_DEFINITION_CHARS };

/** Prisma `include` that every concept response needs. */
export const CONCEPT_INCLUDE = { article: { select: { title: true } } };

/**
 * API shape of a concept.
 * @param {object} c Concept row with `article: {title}` included
 */
export function serializeConcept(c) {
  return {
    id: c.id,
    explanationId: c.explanationId ?? null,
    term: c.term,
    definition: c.definition,
    definitionZh: c.definitionZh,
    userNotes: c.userNotes,
    tags: c.tags,
    articleId: c.articleId,
    articleTitle: c.article?.title ?? null,
    nextReviewAt: c.nextReviewAt,
    reviewCount: c.reviewCount,
    createdAt: c.createdAt,
  };
}

/**
 * Duplicate key for a term: case- and whitespace-insensitive (QA-3), so the same
 * phrase saved twice from one article is caught even with a new explanation id.
 * @param {string} term
 * @returns {string}
 */
export function termKey(term) {
  return String(term).trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Validate a term (string, NUL-free, 1..MAX_TERM_CHARS after trimming).
 * @param {unknown} value
 * @returns {{term: string} | {error: Response}}
 */
export function parseTerm(value) {
  if (typeof value !== "string" || !value.trim()) return { error: badRequest("The term can't be empty.", "term") };
  if (hasNul(value)) return { error: badRequest("The term contains a hidden character. Retype it and try again.", "term") };
  const term = value.trim().replace(/\s+/g, " ");
  if (term.length > MAX_TERM_CHARS) return { error: badRequest(`Keep the term to ${MAX_TERM_CHARS} characters or fewer.`, "term") };
  return { term };
}

/**
 * Validate a definition (string, NUL-free, 1..MAX_DEFINITION_CHARS after trimming).
 * @param {unknown} value
 * @returns {{definition: string} | {error: Response}}
 */
export function parseDefinition(value) {
  if (typeof value !== "string" || !value.trim()) return { error: badRequest("The definition can't be empty.", "definition") };
  if (hasNul(value)) return { error: badRequest("The definition contains a hidden character. Retype it and try again.", "definition") };
  const definition = value.trim();
  if (definition.length > MAX_DEFINITION_CHARS) {
    return { error: badRequest(`Keep the definition to ${MAX_DEFINITION_CHARS.toLocaleString("en-US")} characters or fewer.`, "definition") };
  }
  return { definition };
}

/**
 * Normalize one tag (trim, lowercase, collapse whitespace). Empty → "".
 * @param {string} tag
 */
export function normalizeTag(tag) {
  return tag.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Validate and normalize a tags array: strings only, ≤10 distinct, each ≤50 chars.
 * @param {unknown} value
 * @returns {{tags: string[]} | {error: Response}}
 */
export function parseTags(value) {
  if (value === undefined || value === null) return { tags: [] };
  if (!Array.isArray(value)) return { error: badRequest("Tags must be a list of words.", "tags") };
  const seen = new Set();
  for (const raw of value) {
    if (typeof raw !== "string") return { error: badRequest("Each tag must be text.", "tags") };
    if (hasNul(raw)) return { error: badRequest("A tag contains a hidden character. Retype it and try again.", "tags") };
    const tag = normalizeTag(raw);
    if (!tag) continue;
    if (tag.length > MAX_TAG_CHARS) return { error: badRequest(`Keep each tag to ${MAX_TAG_CHARS} characters or fewer.`, "tags") };
    seen.add(tag);
  }
  if (seen.size > MAX_TAGS) return { error: badRequest(`Use up to ${MAX_TAGS} tags per concept.`, "tags") };
  return { tags: [...seen] };
}

/**
 * Validate optional user notes: string or null, ≤5000 chars.
 * @param {unknown} value
 * @returns {{userNotes: string|null} | {error: Response}}
 */
export function parseNotes(value) {
  if (value === undefined || value === null) return { userNotes: null };
  if (typeof value !== "string") return { error: badRequest("Notes must be text.", "userNotes") };
  if (hasNul(value)) return { error: badRequest("Your note contains a hidden character. Retype it and try again.", "userNotes") };
  const trimmed = value.trim();
  if (trimmed.length > MAX_NOTES_CHARS) return { error: badRequest(`Keep notes to ${MAX_NOTES_CHARS.toLocaleString("en-US")} characters or fewer.`, "userNotes") };
  return { userNotes: trimmed || null };
}
