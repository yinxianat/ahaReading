import prisma from "@/lib/db.js";
import { requireUser } from "@/lib/auth.js";
import { parseJsonBody, badRequest, jsonError, rateLimited, requireString, withErrorHandling } from "@/lib/http.js";
import { checkRateLimit } from "@/lib/rate-limit.js";
import { calculateNextReview, streakDays, utcDay, MASTERED_INTERVAL_DAYS } from "@/lib/srs.js";
import { logger } from "@/lib/logger.js";
import { CONCEPT_INCLUDE, serializeConcept } from "@/lib/concepts.js";

const SESSION_SIZE = 20;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

const notFound = () => jsonError(404, "not_found", "We couldn't find that concept. It may have been deleted — continue with the next card.");

const MAX_OPTIMISTIC_RETRIES = 3;
// A streak longer than this is reported as this; keeps the day scan bounded.
const MAX_STREAK_DAYS = 400;

/**
 * PO-13 progress line: {streakDays, reviewedToday, mastered}. Null when the
 * queries fail, so a stats problem never blocks reviewing.
 * @param {string} userId
 * @param {Date} now
 */
async function reviewStats(userId, now) {
  try {
    const startOfToday = new Date(`${utcDay(now)}T00:00:00Z`);
    const [days, reviewedToday, mastered] = await Promise.all([
      // reviewedAt is a naive timestamp holding UTC, so ::date is the UTC day.
      prisma.$queryRaw`SELECT DISTINCT ("reviewedAt"::date)::text AS day FROM "ReviewCard"
        WHERE "userId" = ${userId} ORDER BY day DESC LIMIT ${MAX_STREAK_DAYS}`,
      prisma.reviewCard.count({ where: { userId, reviewedAt: { gte: startOfToday } } }),
      prisma.concept.count({ where: { userId, interval: { gte: MASTERED_INTERVAL_DAYS } } }),
    ]);
    return { streakDays: streakDays(days.map((r) => r.day), now), reviewedToday, mastered };
  } catch (err) {
    logger.warn("api", "Review stats query failed", { detail: err?.message });
    return null;
  }
}

/**
 * GET → {due:[concept], dueCount, nextDueAt, stats} (most overdue first, max 20;
 * stats = {streakDays, reviewedToday, mastered} or null, PO-13).
 * GET ?countOnly=1 → {dueCount, nextDueAt} only (for the nav badge).
 */
export const GET = withErrorHandling(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const userId = auth.user.id;
  const countOnly = new URL(request.url).searchParams.get("countOnly") === "1";
  const now = new Date();
  const dueWhere = { userId, nextReviewAt: { lte: now } };

  const [due, dueCount, next, stats] = await Promise.all([
    countOnly
      ? null
      : prisma.concept.findMany({ where: dueWhere, include: CONCEPT_INCLUDE, orderBy: [{ nextReviewAt: "asc" }, { id: "asc" }], take: SESSION_SIZE }),
    prisma.concept.count({ where: dueWhere }),
    prisma.concept.findFirst({ where: { userId, nextReviewAt: { gt: now } }, orderBy: { nextReviewAt: "asc" }, select: { nextReviewAt: true } }),
    countOnly ? null : reviewStats(userId, now),
  ]);

  const nextDueAt = dueCount > 0 ? now : (next?.nextReviewAt ?? null);
  const body = countOnly ? { dueCount, nextDueAt } : { due: due.map(serializeConcept), dueCount, nextDueAt, stats };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}, { source: "api" });

async function replay(userId, clientId) {
  const card = await prisma.reviewCard.findFirst({
    where: { userId, clientId },
    select: { concept: { include: CONCEPT_INCLUDE } },
  });
  if (!card?.concept || card.concept.userId !== userId) return null;
  return Response.json({ concept: serializeConcept(card.concept), nextReviewAt: card.concept.nextReviewAt, duplicate: true });
}

/** POST {conceptId, quality 0..5, clientId?} → {concept, nextReviewAt}; duplicate clientId → same result (200). */
export const POST = withErrorHandling(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const userId = auth.user.id;

  const limit = checkRateLimit(`review:${userId}`, { maxRequests: 120, windowMs: 60_000 });
  if (!limit.allowed) return rateLimited(limit.retryAfter);

  const body = await parseJsonBody(request);
  if (!body.ok) return badRequest("Send the review as a JSON object.");
  const conceptId = requireString(body.data.conceptId, { maxLength: 100 });
  if (!conceptId) return badRequest("conceptId is required.", "conceptId");
  const quality = body.data.quality;
  if (!Number.isInteger(quality) || quality < 0 || quality > 5) return badRequest("quality must be a whole number from 0 to 5.", "quality");
  let clientId = null;
  if (body.data.clientId !== undefined && body.data.clientId !== null) {
    if (typeof body.data.clientId !== "string" || !CLIENT_ID_RE.test(body.data.clientId)) {
      return badRequest("clientId must be 1–100 letters, digits, - or _.", "clientId");
    }
    clientId = body.data.clientId;
  }

  // Offline sync may resend a review that already landed: answer with the stored result.
  if (clientId) {
    const replayed = await replay(userId, clientId);
    if (replayed) return replayed;
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      // Optimistic: the write only lands if reviewCount is still what we computed from,
      // so two devices rating one card at once can't both apply to the same old state.
      for (let tries = 0; tries < MAX_OPTIMISTIC_RETRIES; tries++) {
        const concept = await tx.concept.findFirst({ where: { id: conceptId, userId } });
        if (!concept) return null;
        const next = calculateNextReview(quality, concept.interval, concept.easeFactor, concept.repetitions);
        const now = new Date();
        const { count } = await tx.concept.updateMany({
          where: { id: concept.id, userId, reviewCount: concept.reviewCount },
          data: {
            interval: next.interval,
            easeFactor: next.easeFactor,
            repetitions: next.repetitions,
            nextReviewAt: next.nextReviewAt,
            lastReviewedAt: now,
            reviewCount: { increment: 1 },
          },
        });
        if (count === 1) {
          await tx.reviewCard.create({ data: { userId, conceptId, quality, clientId, reviewedAt: now } });
          return tx.concept.findFirst({ where: { id: concept.id, userId }, include: CONCEPT_INCLUDE });
        }
      }
      throw Object.assign(new Error("review write kept conflicting"), { code: "REVIEW_CONFLICT" });
    });
    if (!updated) return notFound();
    return Response.json({ concept: serializeConcept(updated), nextReviewAt: updated.nextReviewAt });
  } catch (err) {
    // Two copies of the same queued review raced: the unique (userId, clientId) rejected the second.
    if (err?.code === "P2002" && clientId) {
      const replayed = await replay(userId, clientId);
      if (replayed) return replayed;
    }
    if (err?.code === "REVIEW_CONFLICT") {
      return jsonError(409, "review_conflict", "This card was just reviewed on another device. Reload to see its new schedule.");
    }
    throw err;
  }
}, { source: "api" });
