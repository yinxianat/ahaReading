import prisma from "@/lib/db.js";
import { requireUser } from "@/lib/auth.js";
import { parseJsonBody, badRequest, jsonError, rateLimited, withErrorHandling } from "@/lib/http.js";
import { checkRateLimit } from "@/lib/rate-limit.js";
import { runChain } from "@/lib/ai/index.js";
import { aiErrorResponse } from "@/lib/ai/route-errors.js";
import { consumeAiQuota } from "@/lib/ai/quota.js";
import { buildPartPrompt, validatePart, partMaxTokens, LISTEN_TIMEOUTS } from "@/lib/ai/listen-prompt.js";
import { audioLimitResponse, audioUsage, serializePart, STALE_GENERATING_MS, WORDS_PER_MINUTE } from "@/lib/listen.js";

const notFound = () => jsonError(404, "not_found", "We couldn't find that part. The series may have been deleted.");
/** Seconds of silence the player leaves at each [pause] (quiz answers). */
const PAUSE_SECONDS = 4;
const MAX_POSITION = 10_000;

async function target(context) {
  const { id, order } = await context.params;
  const n = Number(order);
  if (typeof id !== "string" || id.length > 100 || !Number.isInteger(n) || n < 0 || n > 100) return null;
  return { id, order: n };
}

/**
 * POST → {part (with script), usage}. Writes the part's script if it isn't written yet:
 * the first play (or the player's prefetch of the next part) pays for it, once.
 * 409 audio_generating while another request is writing it; 429 audio_limit when today's
 * minutes are used up.
 */
export const POST = withErrorHandling(async (request, context) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const user = auth.user;
  const t = await target(context);
  if (!t) return notFound();
  const limit = checkRateLimit(`listen-part:${user.id}`, { maxRequests: 20, windowMs: 60_000 });
  if (!limit.allowed) return rateLimited(limit.retryAfter);

  const series = await prisma.audioSeries.findFirst({ where: { id: t.id, userId: user.id }, include: { parts: { orderBy: { order: "asc" } } } });
  const part = series?.parts.find((p) => p.order === t.order);
  if (!part) return notFound();
  if (part.status === "ready") return Response.json({ part: serializePart(part, { withScript: true }), usage: await audioUsage(user) });

  // Claim the part, so two tabs (or play + prefetch) never pay for it twice.
  const stale = new Date(Date.now() - STALE_GENERATING_MS);
  const claim = await prisma.audioPart.updateMany({
    where: { id: part.id, OR: [{ status: { in: ["pending", "failed"] } }, { status: "generating", startedAt: { lt: stale } }] },
    data: { status: "generating", startedAt: new Date() },
  });
  if (claim.count === 0) {
    return jsonError(409, "audio_generating", "This part is still being written. It'll be ready in a moment.", { retryAfter: 5 }, { "Retry-After": "5" });
  }
  const release = (status = "pending") => prisma.audioPart.update({ where: { id: part.id }, data: { status, startedAt: null } });

  // Checked after claiming: this part now counts at its full length, so parallel claims see each other.
  const usage = await audioUsage(user);
  if (usage.dailyMinutes === 0 || usage.usedMinutes > usage.dailyMinutes) {
    await release();
    return audioLimitResponse({ ...usage, usedMinutes: Math.max(0, usage.usedMinutes - series.partMinutes) }, series.partMinutes);
  }
  const overQuota = consumeAiQuota(user.id);
  if (overQuota) {
    await release();
    return overQuota;
  }

  const { system, userMessage } = buildPartPrompt({
    sourceTitle: series.sourceTitle,
    sourceText: series.sourceText,
    level: series.level,
    style: series.style,
    partMinutes: series.partMinutes,
    language: series.language,
    seriesTitle: series.title,
    parts: series.parts.map((p) => ({ title: p.title, focus: p.focus })),
    index: part.order,
  });
  let result;
  try {
    result = await runChain({
      task: "listen",
      system,
      userMessage,
      maxTokens: partMaxTokens(series.partMinutes, series.language),
      ...LISTEN_TIMEOUTS.part,
      validate: (text) => validatePart(text, { partMinutes: series.partMinutes, language: series.language }),
    });
  } catch (err) {
    await release("failed");
    return aiErrorResponse(err, "listen");
  }

  const { chapters, words } = JSON.parse(result.text);
  const pauses = chapters.reduce((n, c) => n + (c.text.match(/\[pause\]/gi) || []).length, 0);
  const durationSec = Math.round((words / WORDS_PER_MINUTE) * 60 + pauses * PAUSE_SECONDS);
  const [saved] = await prisma.$transaction([
    prisma.audioPart.update({ where: { id: part.id }, data: { status: "ready", chapters, words, durationSec, generatedAt: new Date() } }),
    prisma.audioUsage.create({ data: { userId: user.id, seconds: durationSec } }),
  ]);
  return Response.json({ part: serializePart(saved, { withScript: true }), usage: await audioUsage(user) });
}, { source: "api" });

function position(value, field) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_POSITION) return { error: badRequest(`${field} must be a whole number from 0.`, field) };
  return { value };
}

/** PATCH {chapter, sentence, completed?} → {part}. Saves where the listener is. */
export const PATCH = withErrorHandling(async (request, context) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const t = await target(context);
  if (!t) return notFound();
  const limit = checkRateLimit(`listen-progress:${auth.user.id}`, { maxRequests: 120, windowMs: 60_000 });
  if (!limit.allowed) return rateLimited(limit.retryAfter);

  const body = await parseJsonBody(request);
  if (!body.ok) return badRequest("Send the position as a JSON object.");
  const chapter = position(body.data.chapter, "chapter");
  if (chapter.error) return chapter.error;
  const sentence = position(body.data.sentence, "sentence");
  if (sentence.error) return sentence.error;
  if (body.data.completed !== undefined && typeof body.data.completed !== "boolean") return badRequest("completed must be true or false.", "completed");

  const part = await prisma.audioPart.findFirst({ where: { order: t.order, series: { id: t.id, userId: auth.user.id } }, select: { id: true, completedAt: true } });
  if (!part) return notFound();
  const completedAt = body.data.completed === true ? part.completedAt || new Date() : body.data.completed === false ? null : undefined;
  const [saved] = await prisma.$transaction([
    prisma.audioPart.update({ where: { id: part.id }, data: { positionChapter: chapter.value, positionSentence: sentence.value, ...(completedAt !== undefined ? { completedAt } : {}) } }),
    prisma.audioSeries.update({ where: { id: t.id }, data: { lastListenedAt: new Date() } }),
  ]);
  return Response.json({ part: serializePart(saved) });
}, { source: "api" });
