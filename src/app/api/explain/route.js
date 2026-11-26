import prisma from "@/lib/db.js";
import { requireUser } from "@/lib/auth.js";
import { parseJsonBody, badRequest, jsonError, rateLimited, hasNul, withErrorHandling } from "@/lib/http.js";
import { checkRateLimit } from "@/lib/rate-limit.js";
import { runChain } from "@/lib/ai/index.js";
import { buildExplainPrompt, buildFollowUpPrompt, FOLLOW_UPS, EXPLAIN_MAX_TOKENS, MAX_HIGHLIGHT_CHARS, MAX_SURROUNDING_CHARS } from "@/lib/ai/explain-prompt.js";
import { validateExplanation } from "@/lib/ai/safety.js";
import { aiErrorResponse } from "@/lib/ai/route-errors.js";
import { consumeAiQuota } from "@/lib/ai/quota.js";
import { computeCacheKey, getFromCache, setCache } from "@/lib/cache.js";

const LANGUAGES = ["en", "zh"];

const HIDDEN_CHAR = "contains a hidden character. Select the text again and retry.";

function parseInput(data, user) {
  if (typeof data.highlightedText !== "string" || !data.highlightedText.trim()) {
    return { error: badRequest("Highlight some text first, then tap explain.", "highlightedText") };
  }
  for (const field of ["highlightedText", "surroundingText", "articleId"]) {
    if (hasNul(data[field])) return { error: badRequest(`The ${field === "highlightedText" ? "highlighted text" : field} ${HIDDEN_CHAR}`, field) };
  }
  const highlightedText = data.highlightedText.trim();
  if (highlightedText.length > MAX_HIGHLIGHT_CHARS) {
    return { error: badRequest(`Highlight a shorter passage — up to ${MAX_HIGHLIGHT_CHARS.toLocaleString("en-US")} characters.`, "highlightedText") };
  }
  if (data.surroundingText !== undefined && data.surroundingText !== null && typeof data.surroundingText !== "string") {
    return { error: badRequest("surroundingText must be text.", "surroundingText") };
  }
  // Surrounding text is context, so an overlong paragraph is trimmed rather than rejected.
  const surroundingText = (data.surroundingText || "").trim().slice(0, MAX_SURROUNDING_CHARS);

  // Spec §21 flow 8: an unknown level/language degrades to the user's default, never reaches the prompt.
  const helpLevel = [1, 2, 3].includes(data.helpLevel) ? data.helpLevel : [1, 2, 3].includes(user.helpLevel) ? user.helpLevel : 1;
  const language = LANGUAGES.includes(data.language) ? data.language : LANGUAGES.includes(user.locale) ? user.locale : "en";

  let articleId = null;
  if (data.articleId !== undefined && data.articleId !== null) {
    if (typeof data.articleId !== "string" || !data.articleId.trim() || data.articleId.length > 100) {
      return { error: badRequest("articleId must be an article id.", "articleId") };
    }
    articleId = data.articleId.trim();
  }

  // "Keep exploring" after a deep dive: a follow-up continues one earlier explanation.
  let followUp = null;
  let basedOn = null;
  if (data.followUp !== undefined && data.followUp !== null) {
    if (typeof data.followUp !== "string" || !Object.hasOwn(FOLLOW_UPS, data.followUp)) {
      return { error: badRequest('followUp must be "deeper", "big_picture" or "related".', "followUp") };
    }
    if (typeof data.basedOn !== "string" || !data.basedOn.trim() || data.basedOn.length > 100 || hasNul(data.basedOn)) {
      return { error: badRequest("A follow-up needs basedOn: the id of the explanation it continues.", "basedOn") };
    }
    followUp = data.followUp;
    basedOn = data.basedOn.trim();
  }
  return { input: { highlightedText, surroundingText, helpLevel: followUp ? 3 : helpLevel, language, articleId, followUp, basedOn } };
}

/**
 * POST {highlightedText, surroundingText?, helpLevel?, language?, articleId?, followUp?, basedOn?}
 *   → {explanationId, explanation, helpLevel, language, followUp, cached, provider, model}
 * `followUp` ("deeper" | "big_picture" | "related") with `basedOn` (an explanation id of
 * this user, for the same highlight) continues that explanation instead of starting over.
 */
export const POST = withErrorHandling(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const user = auth.user;

  const limit = checkRateLimit(`explain:${user.id}`, { maxRequests: 30, windowMs: 60_000 });
  if (!limit.allowed) return rateLimited(limit.retryAfter);

  const body = await parseJsonBody(request);
  if (!body.ok) return badRequest("Send the highlighted text as a JSON object.");
  const parsed = parseInput(body.data, user);
  if (parsed.error) return parsed.error;
  const { highlightedText, surroundingText, helpLevel, language, articleId, followUp, basedOn } = parsed.input;

  if (articleId) {
    const article = await prisma.article.findFirst({ where: { id: articleId, userId: user.id }, select: { id: true } });
    if (!article) return jsonError(404, "not_found", "We couldn't find that article. Go back to your Library and open it again.");
  }

  // The explanation being continued is read from the database (never taken from the client),
  // scoped to this user and this highlight.
  let previous = null;
  if (followUp) {
    const row = await prisma.explanation.findFirst({ where: { id: basedOn, userId: user.id }, select: { explanation: true, highlightedText: true } });
    if (!row) return jsonError(404, "not_found", "We couldn't find the explanation to build on. Ask for the deep dive again, then keep exploring.");
    if (row.highlightedText !== highlightedText) return badRequest("That explanation is about different text. Keep exploring from the explanation of this selection.", "basedOn");
    previous = row.explanation;
  }

  const cacheKey = computeCacheKey(highlightedText, surroundingText, helpLevel, language, followUp ? { kind: followUp, previous } : null);
  const hit = getFromCache(cacheKey);
  if (hit) {
    // Stored for cache hits too, so the client always gets a real id to save/translate.
    const record = await prisma.explanation.create({
      data: {
        userId: user.id, articleId, highlightedText, surroundingText, helpLevel, language,
        explanation: hit.explanation, aiProvider: hit.provider, aiModel: hit.model, cacheHit: true, followUp, basedOnId: basedOn,
      },
    });
    return Response.json({ explanationId: record.id, explanation: hit.explanation, helpLevel, language, followUp, cached: true, provider: hit.provider, model: hit.model });
  }

  const overQuota = consumeAiQuota(user.id);
  if (overQuota) return overQuota;

  const { system, userMessage } = followUp
    ? buildFollowUpPrompt({ highlightedText, surroundingText, previousExplanation: previous, followUp, language })
    : buildExplainPrompt({ highlightedText, surroundingText, helpLevel, language });
  let result;
  try {
    result = await runChain({
      task: "explain",
      system,
      userMessage,
      maxTokens: followUp ? FOLLOW_UPS[followUp].maxTokens : EXPLAIN_MAX_TOKENS[helpLevel],
      validate: (text) => validateExplanation(text, highlightedText, language, followUp ? { maxChars: FOLLOW_UPS[followUp].maxChars } : undefined),
    });
  } catch (err) {
    return aiErrorResponse(err, "explain");
  }

  setCache(cacheKey, { explanation: result.text, provider: result.provider, model: result.model });
  const record = await prisma.explanation.create({
    data: {
      userId: user.id, articleId, highlightedText, surroundingText, helpLevel, language,
      explanation: result.text, aiProvider: result.provider, aiModel: result.model,
      aiTokensUsed: result.tokensUsed, aiLatencyMs: result.latencyMs, cacheHit: false, followUp, basedOnId: basedOn,
    },
  });
  return Response.json({ explanationId: record.id, explanation: result.text, helpLevel, language, followUp, cached: false, provider: result.provider, model: result.model });
}, { source: "api" });
