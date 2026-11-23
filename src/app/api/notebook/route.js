import prisma from "@/lib/db.js";
import { requireUser } from "@/lib/auth.js";
import { parseJsonBody, badRequest, jsonError, rateLimited, requireString, hasNul, withErrorHandling } from "@/lib/http.js";
import { checkRateLimit } from "@/lib/rate-limit.js";
import { addDays } from "@/lib/srs.js";
import {
  CONCEPT_INCLUDE, MAX_TERM_CHARS, MAX_TAG_CHARS, normalizeTag, parseNotes, parseTags, parseTerm, serializeConcept, termKey,
} from "@/lib/concepts.js";

const PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 50;

function encodeCursor(c) {
  return Buffer.from(`${c.createdAt.toISOString()}|${c.id}`).toString("base64url");
}

function decodeCursor(raw) {
  try {
    const [iso, id] = Buffer.from(raw, "base64url").toString("utf8").split("|");
    const createdAt = new Date(iso);
    if (!id || Number.isNaN(createdAt.getTime()) || id.length > 100) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/**
 * GET ?search=&tag=&articleId=&cursor=&limit= → {concepts, tags?:[{tag,count}], nextCursor}.
 * `tags` is only computed for the first page (no cursor); later pages omit it.
 */
export const GET = withErrorHandling(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const userId = auth.user.id;
  const params = new URL(request.url).searchParams;
  for (const name of ["search", "tag", "articleId", "cursor"]) {
    if (hasNul(params.get(name))) return badRequest(`The ${name} filter contains a hidden character. Clear it and try again.`, name);
  }

  const where = { userId };
  const and = [];

  const search = (params.get("search") || "").trim();
  if (search.length > 200) return badRequest("Search for 200 characters or fewer.", "search");
  if (search) {
    and.push({
      OR: [
        { term: { contains: search, mode: "insensitive" } },
        { definition: { contains: search, mode: "insensitive" } },
        { userNotes: { contains: search, mode: "insensitive" } },
        { definitionZh: { contains: search, mode: "insensitive" } },
      ],
    });
  }
  const tag = normalizeTag(params.get("tag") || "");
  if (tag.length > MAX_TAG_CHARS) return badRequest(`Tags are ${MAX_TAG_CHARS} characters or fewer.`, "tag");
  if (tag) where.tags = { has: tag };
  const articleId = (params.get("articleId") || "").trim();
  if (articleId.length > 100) return badRequest("articleId is not valid.", "articleId");
  if (articleId) where.articleId = articleId;

  const rawCursor = params.get("cursor");
  if (rawCursor) {
    const cursor = decodeCursor(rawCursor);
    if (!cursor) return badRequest("That page link is out of date. Reload the notebook.", "cursor");
    // Keyset pagination: rows strictly after the cursor in (createdAt desc, id desc).
    and.push({ OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] });
  }
  if (and.length) where.AND = and;

  const limitParam = parseInt(params.get("limit") || "", 10);
  const take = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, MAX_PAGE_SIZE) : PAGE_SIZE;

  // The tag cloud only matters on the first page; cursor pages skip the aggregate.
  const [rows, tagRows] = await Promise.all([
    prisma.concept.findMany({ where, include: CONCEPT_INCLUDE, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: take + 1 }),
    rawCursor
      ? null
      : prisma.$queryRaw`
      SELECT t AS "tag", COUNT(*)::int AS "count"
      FROM "Concept" c, unnest(c."tags") AS t
      WHERE c."userId" = ${userId}
      GROUP BY t
      ORDER BY "count" DESC, t ASC
      LIMIT 200`,
  ]);

  const page = rows.slice(0, take);
  return Response.json(
    {
      concepts: page.map(serializeConcept),
      tags: tagRows ? tagRows.map((r) => ({ tag: r.tag, count: Number(r.count) })) : undefined,
      nextCursor: rows.length > take ? encodeCursor(page[page.length - 1]) : null,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}, { source: "api" });

const alreadySaved = (conceptId) => jsonError(409, "already_saved", "This is already in your notebook.", { conceptId });

// Same user + same article (or both without one) + same term, ignoring case and spacing.
async function findSameTerm(tx, userId, articleId, key) {
  const rows = await tx.$queryRaw`
    SELECT "id" FROM "Concept"
    WHERE "userId" = ${userId}
      AND "articleId" IS NOT DISTINCT FROM ${articleId}
      AND lower(regexp_replace(btrim("term"), '\\s+', ' ', 'g')) = ${key}
    LIMIT 1`;
  return rows[0]?.id ?? null;
}

/**
 * POST {explanationId, term?, tags?, userNotes?} → 201 {concept}; 409 already_saved {conceptId}
 * when this explanation is saved, or the user already saved the same term from the
 * same article. `term` (optional) replaces the highlighted text as the card's front.
 */
export const POST = withErrorHandling(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const userId = auth.user.id;

  const limit = checkRateLimit(`notebook:${userId}`, { maxRequests: 60, windowMs: 60_000 });
  if (!limit.allowed) return rateLimited(limit.retryAfter);

  const body = await parseJsonBody(request);
  if (!body.ok) return badRequest("Send the concept as a JSON object.");
  const explanationId = requireString(body.data.explanationId, { maxLength: 100 });
  if (!explanationId) return badRequest("explanationId is required.", "explanationId");
  const tags = parseTags(body.data.tags);
  if (tags.error) return tags.error;
  const notes = parseNotes(body.data.userNotes);
  if (notes.error) return notes.error;
  let customTerm = null;
  if (body.data.term !== undefined && body.data.term !== null) {
    const parsed = parseTerm(body.data.term);
    if (parsed.error) return parsed.error;
    customTerm = parsed.term;
  }

  const explanation = await prisma.explanation.findFirst({
    where: { id: explanationId, userId },
    select: { id: true, articleId: true, highlightedText: true, explanation: true, translationZh: true, concept: { select: { id: true } } },
  });
  if (!explanation) return jsonError(404, "not_found", "We couldn't find that explanation. Ask for a new explanation and save that one.");
  if (explanation.concept) return alreadySaved(explanation.concept.id);

  const term = customTerm ?? explanation.highlightedText.trim().replace(/\s+/g, " ").slice(0, MAX_TERM_CHARS);
  const key = termKey(term);

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      // Serialise saves of one term for one user, so two explanations of the same phrase
      // racing each other cannot both pass the duplicate check.
      await tx.$queryRaw`SELECT 1 AS "locked" FROM pg_advisory_xact_lock(hashtext(${`${userId}:${key}`}))`;
      const existingId = await findSameTerm(tx, userId, explanation.articleId, key);
      if (existingId) return { duplicateOf: existingId };
      const concept = await tx.concept.create({
        data: {
          userId,
          explanationId,
          articleId: explanation.articleId,
          term,
          definition: explanation.explanation,
          definitionZh: explanation.translationZh,
          userNotes: notes.userNotes,
          tags: tags.tags,
          easeFactor: 2.5,
          interval: 1,
          nextReviewAt: addDays(new Date(), 1),
        },
        include: CONCEPT_INCLUDE,
      });
      return { concept };
    });
    if (outcome.duplicateOf) return alreadySaved(outcome.duplicateOf);
    return Response.json({ concept: serializeConcept(outcome.concept) }, { status: 201 });
  } catch (err) {
    // Double-tap race: the unique explanationId makes the second insert fail.
    if (err?.code === "P2002") {
      const existing = await prisma.concept.findFirst({ where: { explanationId, userId }, select: { id: true } });
      return alreadySaved(existing?.id);
    }
    throw err;
  }
}, { source: "api" });
