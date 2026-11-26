import prisma from "@/lib/db.js";
import { requireUser } from "@/lib/auth.js";
import { parseJsonBody, badRequest, jsonError, rateLimited, withErrorHandling } from "@/lib/http.js";
import { checkRateLimit } from "@/lib/rate-limit.js";
import { runChain } from "@/lib/ai/index.js";
import { aiErrorResponse } from "@/lib/ai/route-errors.js";
import { consumeAiQuota } from "@/lib/ai/quota.js";
import { buildOutlinePrompt, validateOutline, OUTLINE_MAX_TOKENS, LISTEN_TIMEOUTS } from "@/lib/ai/listen-prompt.js";
import { articlePlainText } from "@/lib/article-blocks.js";
import { markdownPlainText } from "@/lib/article-markdown.js";
import { entitlementsFor } from "@/lib/entitlements.js";
import {
  audioLimitResponse,
  audioUsage,
  maxPartsFor,
  parseSeriesInput,
  serializeSeries,
  MAX_LISTEN_SOURCE_CHARS,
  MIN_LISTEN_SOURCE_CHARS,
} from "@/lib/listen.js";

const LIST_LIMIT = 100;
const PART_LIST_SELECT = { id: true, order: true, title: true, status: true, startedAt: true, durationSec: true, positionChapter: true, positionSentence: true, completedAt: true };

/** Plain readable text of an article, whatever its stored format. */
function articleText(article) {
  const content = article.content || "";
  return article.format === "markdown" ? markdownPlainText(content) : articlePlainText(content);
}

/** GET → {series: [...] (newest listened first, parts without scripts), usage} */
export const GET = withErrorHandling(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const user = auth.user;
  const [rows, usage] = await Promise.all([
    prisma.audioSeries.findMany({
      where: { userId: user.id },
      include: { parts: { select: PART_LIST_SELECT } },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: LIST_LIMIT,
    }),
    audioUsage(user),
  ]);
  return Response.json({ series: rows.map((s) => serializeSeries(s)), usage }, { headers: { "Cache-Control": "no-store" } });
}, { source: "api" });

/**
 * POST {articleId, quote?, level, style, partMinutes, language?} → 201 {series, usage}
 * Plans the series (one AI call). Parts are written later, when first played.
 */
export const POST = withErrorHandling(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const user = auth.user;
  const limit = checkRateLimit(`listen:${user.id}`, { maxRequests: 10, windowMs: 60_000 });
  if (!limit.allowed) return rateLimited(limit.retryAfter);

  const body = await parseJsonBody(request);
  if (!body.ok) return badRequest("Send the listening choices as a JSON object.");
  const parsed = parseSeriesInput(body.data);
  if (parsed.error) return parsed.error;
  const { articleId, quote, level, style, partMinutes, language } = parsed.input;

  const article = await prisma.article.findFirst({ where: { id: articleId, userId: user.id }, select: { id: true, title: true, content: true, format: true } });
  if (!article) return jsonError(404, "not_found", "We couldn't find that article. Go back to your Library and open it again.");
  const sourceText = (quote || articleText(article)).trim().slice(0, MAX_LISTEN_SOURCE_CHARS);
  if (sourceText.length < MIN_LISTEN_SOURCE_CHARS) return badRequest("This article has too little text to listen to.", "articleId");

  // Don't spend an AI call planning audio the user can't play today.
  const usage = await audioUsage(user);
  if (usage.dailyMinutes === 0 || usage.usedMinutes >= usage.dailyMinutes) return audioLimitResponse(usage);
  if (partMinutes > entitlementsFor(user).audioMaxPartMinutes) return badRequest("Choose a shorter part length.", "partMinutes");

  const overQuota = consumeAiQuota(user.id);
  if (overQuota) return overQuota;

  const sourceTitle = (article.title || "Untitled").slice(0, 300);
  const maxParts = maxPartsFor(sourceText, partMinutes, style);
  const { system, userMessage } = buildOutlinePrompt({ sourceTitle, sourceText, level, style, partMinutes, maxParts, language });
  let result;
  try {
    result = await runChain({
      task: "listen",
      system,
      userMessage,
      maxTokens: OUTLINE_MAX_TOKENS,
      ...LISTEN_TIMEOUTS.outline,
      validate: (text) => validateOutline(text, maxParts),
    });
  } catch (err) {
    return aiErrorResponse(err, "listen");
  }
  const outline = JSON.parse(result.text);

  const series = await prisma.audioSeries.create({
    data: {
      userId: user.id,
      articleId: article.id,
      sourceKind: quote ? "selection" : "article",
      sourceTitle,
      sourceText,
      title: outline.title.slice(0, 120),
      level,
      style,
      partMinutes,
      language,
      lastListenedAt: new Date(),
      parts: { create: outline.parts.map((p, order) => ({ order, title: p.title, focus: p.focus })) },
    },
    include: { parts: true },
  });
  return Response.json({ series: serializeSeries(series), usage }, { status: 201 });
}, { source: "api" });
