import prisma from "@/lib/db.js";
import { requireUser } from "@/lib/auth.js";
import { parseJsonBody, badRequest, jsonError, rateLimited, hasNul, withErrorHandling } from "@/lib/http.js";
import { checkRateLimit } from "@/lib/rate-limit.js";
import { runChain } from "@/lib/ai/index.js";
import { buildExplainPrompt, EXPLAIN_MAX_TOKENS, MAX_HIGHLIGHT_CHARS, MAX_SURROUNDING_CHARS } from "@/lib/ai/explain-prompt.js";
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
  return { input: { highlightedText, surroundingText, helpLevel, language, articleId } };
}

/**
 * POST {highlightedText, surroundingText?, helpLevel?, language?, articleId?}
 *   → {explanationId, explanation, helpLevel, language, cached, provider, model}
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
  const { highlightedText, surroundingText, helpLevel, language, articleId } = parsed.input;

  if (articleId) {
    const article = await prisma.article.findFirst({ where: { id: articleId, userId: user.id }, select: { id: true } });
    if (!article) return jsonError(404, "not_found", "We couldn't find that article. Go back to your Library and open it again.");
  }

  const cacheKey = computeCacheKey(highlightedText, surroundingText, helpLevel, language);
  const hit = getFromCache(cacheKey);
  if (hit) {
    // Stored for cache hits too, so the client always gets a real id to save/translate.
    const record = await prisma.explanation.create({
      data: {
        userId: user.id, articleId, highlightedText, surroundingText, helpLevel, language,
        explanation: hit.explanation, aiProvider: hit.provider, aiModel: hit.model, cacheHit: true,
      },
    });
    return Response.json({ explanationId: record.id, explanation: hit.explanation, helpLevel, language, cached: true, provider: hit.provider, model: hit.model });
  }

  const overQuota = consumeAiQuota(user.id);
  if (overQuota) return overQuota;

  const { system, userMessage } = buildExplainPrompt({ highlightedText, surroundingText, helpLevel, language });
  let result;
  try {
    result = await runChain({
      task: "explain",
      system,
      userMessage,
      maxTokens: EXPLAIN_MAX_TOKENS[helpLevel],
      validate: (text) => validateExplanation(text, highlightedText, language),
    });
  } catch (err) {
    return aiErrorResponse(err, "explain");
  }

  setCache(cacheKey, { explanation: result.text, provider: result.provider, model: result.model });
  const record = await prisma.explanation.create({
    data: {
      userId: user.id, articleId, highlightedText, surroundingText, helpLevel, language,
      explanation: result.text, aiProvider: result.provider, aiModel: result.model,
      aiTokensUsed: result.tokensUsed, aiLatencyMs: result.latencyMs, cacheHit: false,
    },
  });
  return Response.json({ explanationId: record.id, explanation: result.text, helpLevel, language, cached: false, provider: result.provider, model: result.model });
}, { source: "api" });
