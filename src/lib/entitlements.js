/**
 * What each account may use: one place that turns "who is this user" into limits.
 *
 * Today there are two plans: "admin" (accounts in ADMIN_EMAILS) and "free" (everyone else).
 * When payment arrives, add plans here (e.g. "plus", "pro") and make `planFor` read the user's
 * subscription; every feature already asks `entitlementsFor(user)` for its limits, so nothing
 * else changes. Each limit can be overridden per plan from the environment:
 *   AUDIO_DAILY_MINUTES_ADMIN (default 240), AUDIO_DAILY_MINUTES_USER (default 60, the free plan),
 *   and for any future plan AUDIO_DAILY_MINUTES_<PLAN> (e.g. AUDIO_DAILY_MINUTES_PRO).
 * A limit of 0 turns the feature off for that plan.
 */
import { isAdminEmail } from "@/lib/auth.js";
import { intFromEnv } from "@/lib/env.js";

/** Longest part anyone can ask for (the script must fit one AI call). */
export const MAX_PART_MINUTES = 15;

/**
 * Plan catalogue. `env` is the suffix of each limit's environment variable.
 * @type {Readonly<Record<string, {label: string, env: string, audioDailyMinutes: number}>>}
 */
export const PLANS = Object.freeze({
  free: { label: "Free", env: "USER", audioDailyMinutes: 60 },
  admin: { label: "Administrator", env: "ADMIN", audioDailyMinutes: 240 },
});

/**
 * The user's plan. Admins first; then a paid plan from the user record once one exists
 * (`user.plan`, set by billing); otherwise free. Unknown plan names fall back to free.
 * @param {{email?: string, plan?: string|null}} user
 * @returns {keyof typeof PLANS}
 */
export function planFor(user) {
  if (isAdminEmail(user?.email)) return "admin";
  const plan = typeof user?.plan === "string" ? user.plan : "";
  return plan && Object.hasOwn(PLANS, plan) ? plan : "free";
}

/**
 * Limits for one user.
 * @param {{email?: string, plan?: string|null}} user
 * @returns {{plan: string, planLabel: string, audioDailyMinutes: number, audioMaxPartMinutes: number}}
 */
export function entitlementsFor(user) {
  const plan = planFor(user);
  const def = PLANS[plan];
  return {
    plan,
    planLabel: def.label,
    audioDailyMinutes: intFromEnv(`AUDIO_DAILY_MINUTES_${def.env}`, { fallback: def.audioDailyMinutes, min: 0, max: 24 * 60 }),
    audioMaxPartMinutes: MAX_PART_MINUTES,
  };
}
