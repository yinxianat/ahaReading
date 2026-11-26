/**
 * Aha Listening (design §3A): audio written for the ear. A series is one listening request
 * (source + level + style + part length); it has parts, written one at a time when first
 * played. Speech itself happens in the browser (lib/client/speech), so the server stores only
 * scripts and progress. Daily audio minutes come from lib/entitlements.js.
 */
import prisma from "@/lib/db.js";
import { badRequest, hasNul, jsonError } from "@/lib/http.js";
import { entitlementsFor, MAX_PART_MINUTES } from "@/lib/entitlements.js";
import { LEVELS, STYLES, PART_MINUTE_CHOICES } from "@/lib/listen-options.js";

export const WORDS_PER_MINUTE = 150;
/** Source text kept for a series and sent to the AI (about 6,000 tokens). */
export const MAX_LISTEN_SOURCE_CHARS = 24_000;
export const MIN_LISTEN_SOURCE_CHARS = 40;
export const MAX_PARTS = 8;
/** A "generating" part older than this is treated as failed and may be retried. */
export const STALE_GENERATING_MS = 3 * 60_000;

export { LEVELS, STYLES, PART_MINUTE_CHOICES };

/**
 * Validate a new-series request.
 * @param {object} data request body
 * @returns {{input: {articleId: string, quote: string|null, level: string, style: string, partMinutes: number, language: string}} | {error: Response}}
 */
export function parseSeriesInput(data) {
  if (typeof data.articleId !== "string" || !data.articleId.trim() || data.articleId.length > 100 || hasNul(data.articleId)) {
    return { error: badRequest("Choose an article to listen to.", "articleId") };
  }
  let quote = null;
  if (data.quote !== undefined && data.quote !== null) {
    if (typeof data.quote !== "string" || hasNul(data.quote)) return { error: badRequest("The selected text contains a hidden character. Select it again.", "quote") };
    quote = data.quote.trim();
    if (quote.length < MIN_LISTEN_SOURCE_CHARS) return { error: badRequest("Select a little more text to listen to: at least a sentence or two.", "quote") };
    if (quote.length > MAX_LISTEN_SOURCE_CHARS) return { error: badRequest(`Select less text, up to ${MAX_LISTEN_SOURCE_CHARS.toLocaleString("en-US")} characters, or listen to the whole article.`, "quote") };
  }
  if (typeof data.level !== "string" || !Object.hasOwn(LEVELS, data.level)) return { error: badRequest("Choose a level.", "level") };
  if (typeof data.style !== "string" || !Object.hasOwn(STYLES, data.style)) return { error: badRequest("Choose a style.", "style") };
  const minutes = data.partMinutes;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_PART_MINUTES) {
    return { error: badRequest(`Part length must be 1 to ${MAX_PART_MINUTES} minutes.`, "partMinutes") };
  }
  const language = data.language === "zh" ? "zh" : "en";
  return { input: { articleId: data.articleId.trim(), quote, level: data.level, style: data.style, partMinutes: minutes, language } };
}

/**
 * How many parts the material can fill: about one part per `partMinutes` of spoken source,
 * at least one, at most MAX_PARTS. A summary is always one part.
 * @param {string} sourceText
 * @param {number} partMinutes
 * @param {string} style
 * @returns {number}
 */
export function maxPartsFor(sourceText, partMinutes, style) {
  if (style === "summary") return 1;
  const words = String(sourceText).split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.min(MAX_PARTS, Math.ceil(words / (partMinutes * WORDS_PER_MINUTE))));
}

function startOfUtcDay(now = Date.now()) {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Audio minutes this user has used today (UTC): parts written today (from the usage ledger,
 * which outlives deleted series), plus parts being written now, counted at their target
 * length so parallel requests can't overshoot.
 * @param {string} userId
 * @returns {Promise<number>} minutes, rounded up
 */
export async function audioMinutesUsedToday(userId) {
  const since = startOfUtcDay();
  const [done, inFlight] = await Promise.all([
    prisma.audioUsage.aggregate({ _sum: { seconds: true }, where: { userId, createdAt: { gte: since } } }),
    prisma.audioPart.findMany({
      where: { status: "generating", startedAt: { gte: new Date(Date.now() - STALE_GENERATING_MS) }, series: { userId } },
      select: { series: { select: { partMinutes: true } } },
    }),
  ]);
  const seconds = (done._sum.seconds || 0) + inFlight.reduce((sum, p) => sum + p.series.partMinutes * 60, 0);
  return Math.ceil(seconds / 60);
}

/**
 * Today's audio usage and limit for a user.
 * @param {{id: string, email: string}} user
 * @returns {Promise<{usedMinutes: number, dailyMinutes: number, plan: string, planLabel: string, resetsAt: string}>}
 */
export async function audioUsage(user) {
  const ent = entitlementsFor(user);
  const usedMinutes = await audioMinutesUsedToday(user.id);
  const resetsAt = new Date(startOfUtcDay().getTime() + 86_400_000).toISOString();
  return { usedMinutes, dailyMinutes: ent.audioDailyMinutes, plan: ent.plan, planLabel: ent.planLabel, resetsAt };
}

/**
 * 429 audio_limit for a used-up day (or a plan without audio).
 * @param {{usedMinutes: number, dailyMinutes: number}} usage
 * @param {number} [needMinutes] length of the part that didn't fit
 * @returns {Response}
 */
export function audioLimitResponse(usage, needMinutes = 0) {
  const retryAfter = secondsToReset();
  const left = Math.max(0, usage.dailyMinutes - usage.usedMinutes);
  const message =
    usage.dailyMinutes === 0
      ? "Listening isn't included in your plan."
      : left > 0 && needMinutes > left
        ? `This part is about ${needMinutes} minutes and you have ${left} audio minute${left === 1 ? "" : "s"} left today.`
        : `You've used ${Math.min(usage.usedMinutes, usage.dailyMinutes)} of today's ${usage.dailyMinutes} audio minutes.`;
  return jsonError(429, "audio_limit", message, { retryAfter, usage }, { "Retry-After": String(retryAfter) });
}

/** Seconds until the next UTC midnight (when daily minutes reset). */
export function secondsToReset(now = Date.now()) {
  return Math.max(1, Math.ceil((startOfUtcDay(now).getTime() + 86_400_000 - now) / 1000));
}

/**
 * @param {object} part AudioPart row
 * @param {{withScript?: boolean}} [options]
 */
export function serializePart(part, { withScript = false } = {}) {
  const stale = part.status === "generating" && part.startedAt && Date.now() - new Date(part.startedAt).getTime() > STALE_GENERATING_MS;
  return {
    id: part.id,
    order: part.order,
    title: part.title,
    status: stale ? "failed" : part.status,
    durationSec: part.durationSec,
    position: { chapter: part.positionChapter, sentence: part.positionSentence },
    completedAt: part.completedAt ? new Date(part.completedAt).toISOString() : null,
    ...(withScript ? { chapters: part.status === "ready" && Array.isArray(part.chapters) ? part.chapters : null } : {}),
  };
}

/**
 * @param {object} series AudioSeries row with `parts`
 * @param {{withScripts?: boolean}} [options]
 */
export function serializeSeries(series, { withScripts = false } = {}) {
  const parts = [...(series.parts || [])].sort((a, b) => a.order - b.order);
  return {
    id: series.id,
    title: series.title,
    articleId: series.articleId,
    sourceKind: series.sourceKind,
    sourceTitle: series.sourceTitle,
    level: series.level,
    style: series.style,
    partMinutes: series.partMinutes,
    language: series.language,
    createdAt: new Date(series.createdAt).toISOString(),
    lastListenedAt: series.lastListenedAt ? new Date(series.lastListenedAt).toISOString() : null,
    parts: parts.map((p) => serializePart(p, { withScript: withScripts })),
  };
}
