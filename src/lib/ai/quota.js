/**
 * Per-user daily AI quota (SEC-4). Counts explain + translate requests that reach the
 * provider chain (cache hits are free and not counted). In-memory per process, reset
 * at UTC midnight; it bounds spend per account, while AI_DAILY_TOKEN_BUDGET (in the
 * chain) bounds the whole app.
 */
import { jsonError } from "@/lib/http.js";
import { consumeDailyQuota } from "@/lib/rate-limit.js";
import { intFromEnv } from "@/lib/env.js";

/** @returns {number} AI_DAILY_LIMIT_PER_USER, default 300 */
export function dailyAiLimit() {
  return intFromEnv("AI_DAILY_LIMIT_PER_USER", { fallback: 300, min: 1, max: 100_000 });
}

/**
 * Spend one unit of the user's daily AI quota.
 * @param {string} userId
 * @returns {Response|null} 429 daily_limit when the quota is used up, else null
 */
export function consumeAiQuota(userId) {
  const limit = dailyAiLimit();
  const result = consumeDailyQuota(`ai-daily:${userId}`, limit);
  if (result.allowed) return null;
  const hours = Math.max(1, Math.round(result.retryAfter / 3600));
  return jsonError(
    429,
    "daily_limit",
    `You've used today's ${limit} explanations and translations. They reset in about ${hours} hour${hours === 1 ? "" : "s"} — your Notebook and Review still work.`,
    { retryAfter: result.retryAfter },
    { "Retry-After": String(result.retryAfter) }
  );
}
