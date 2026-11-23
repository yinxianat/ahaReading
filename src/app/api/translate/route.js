import prisma from "@/lib/db.js";
import { requireUser } from "@/lib/auth.js";
import { parseJsonBody, badRequest, jsonError, rateLimited, requireString, withErrorHandling } from "@/lib/http.js";
import { checkRateLimit } from "@/lib/rate-limit.js";
import { runChain } from "@/lib/ai/index.js";
import { buildTranslatePrompt, TRANSLATE_MAX_TOKENS } from "@/lib/ai/translate-prompt.js";
import { validateTranslation } from "@/lib/ai/safety.js";
import { aiErrorResponse } from "@/lib/ai/route-errors.js";
import { consumeAiQuota } from "@/lib/ai/quota.js";
import { computeTranslationKey, getFromCache, setCache } from "@/lib/cache.js";

async function storeTranslation(userId, explanationId, translation) {
  await prisma.explanation.updateMany({ where: { id: explanationId, userId }, data: { translationZh: translation } });
  // If the explanation is already saved, the notebook card gets the translation too.
  await prisma.concept.updateMany({ where: { explanationId, userId }, data: { definitionZh: translation } });
}

/** POST {explanationId} → {translation, language:"zh", cached} */
export const POST = withErrorHandling(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const userId = auth.user.id;

  const limit = checkRateLimit(`translate:${userId}`, { maxRequests: 20, windowMs: 60_000 });
  if (!limit.allowed) return rateLimited(limit.retryAfter);

  const body = await parseJsonBody(request);
  if (!body.ok) return badRequest("Send the explanation id as a JSON object.");
  const explanationId = requireString(body.data.explanationId, { maxLength: 100 });
  if (!explanationId) return badRequest("explanationId is required.", "explanationId");
  if (body.data.targetLanguage !== undefined && body.data.targetLanguage !== "zh") {
    return badRequest('Only Simplified Chinese is supported — send targetLanguage "zh" or leave it out.', "targetLanguage");
  }

  const explanation = await prisma.explanation.findFirst({
    where: { id: explanationId, userId },
    select: { id: true, explanation: true, language: true, translationZh: true },
  });
  if (!explanation) return jsonError(404, "not_found", "We couldn't find that explanation. Ask for a new explanation and try again.");

  if (explanation.language === "zh") {
    return Response.json({ translation: explanation.explanation, language: "zh", cached: true });
  }
  if (explanation.translationZh) {
    return Response.json({ translation: explanation.translationZh, language: "zh", cached: true });
  }

  const cacheKey = computeTranslationKey(explanation.explanation);
  const hit = getFromCache(cacheKey);
  if (hit?.translation) {
    await storeTranslation(userId, explanationId, hit.translation);
    return Response.json({ translation: hit.translation, language: "zh", cached: true, provider: hit.provider, model: hit.model });
  }

  const overQuota = consumeAiQuota(userId);
  if (overQuota) return overQuota;

  const { system, userMessage } = buildTranslatePrompt({ text: explanation.explanation });
  let result;
  try {
    result = await runChain({
      task: "translate",
      system,
      userMessage,
      maxTokens: TRANSLATE_MAX_TOKENS,
      validate: (text) => validateTranslation(text, explanation.explanation),
    });
  } catch (err) {
    return aiErrorResponse(err, "translate");
  }

  setCache(cacheKey, { translation: result.text, provider: result.provider, model: result.model });
  await storeTranslation(userId, explanationId, result.text);
  return Response.json({ translation: result.text, language: "zh", cached: false, provider: result.provider, model: result.model });
}, { source: "api" });
