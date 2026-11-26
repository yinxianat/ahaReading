/**
 * Read models for the admin portal (/api/admin/*). Route handlers stay thin;
 * every query here is admin-only and never returns article content or
 * explanation text — counts, metadata and redacted log detail only.
 */
import prisma from "./db.js";
import { logger } from "./logger.js";
import { getFindings, getEnvironmentChecks, loadChainStatus } from "./diagnostics.js";
import { estimateCost } from "./ai/pricing.js";
import { smtpState, deliveryHealth } from "./mailer.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function iso(d) {
  return d ? new Date(d).toISOString() : null;
}

function pct(part, whole) {
  return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "0.0%";
}

function usd(n) {
  return `$${(Math.round(n * 100) / 100).toFixed(2)}`;
}

/**
 * Error log entries. Resolved entries are hidden unless asked for; the count
 * of hidden ones is always returned so the UI can offer "Show N resolved".
 * Each entry is one fingerprint: `count` occurrences between first and last seen.
 * @param {{includeResolved?:boolean, limit?:number, level?:string, source?:string}} [options]
 */
export async function getLogs({ includeResolved = false, limit = 100, level, source } = {}) {
  const filter = {};
  if (level) filter.level = level;
  if (source) filter.source = source;
  const where = includeResolved ? filter : { ...filter, resolvedAt: null };
  const take = Math.min(Math.max(Number(limit) || 100, 1), 500);

  const [entries, resolvedCount] = await Promise.all([
    prisma.logEntry.findMany({ where, orderBy: { lastSeenAt: "desc" }, take }),
    prisma.logEntry.count({ where: { ...filter, resolvedAt: { not: null } } }),
  ]);
  return {
    entries: entries.map((e) => ({
      id: e.id,
      level: e.level,
      source: e.source,
      message: e.message,
      detail: e.detail,
      firstDetail: e.firstDetail ?? null,
      count: e.count,
      firstSeenAt: iso(e.createdAt),
      lastSeenAt: iso(e.lastSeenAt ?? e.updatedAt),
      resolvedAt: iso(e.resolvedAt),
      resolved: e.resolvedAt !== null,
    })),
    resolvedCount,
    includeResolved,
  };
}

/**
 * Mark one log entry resolved. Last-seen lives in its own column, so resolving
 * does not move it.
 * @param {string} id
 * @returns {Promise<{id:string, resolvedAt:string}|null>} null when not found
 */
export async function resolveLog(id) {
  const now = new Date();
  const { count } = await prisma.logEntry.updateMany({ where: { id }, data: { resolvedAt: now } });
  if (count === 0) return null;
  return { id, resolvedAt: now.toISOString() };
}

/**
 * AI call ledger: recent attempts plus 24h grouping by provider and status.
 * @param {{limit?:number}} [options]
 */
export async function getAiCalls({ limit = 100 } = {}) {
  const since = new Date(Date.now() - DAY_MS);
  const take = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const [recent, groups, chain] = await Promise.all([
    prisma.aiCall.findMany({ orderBy: { createdAt: "desc" }, take }),
    prisma.aiCall.groupBy({
      by: ["provider", "status"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      _avg: { latencyMs: true },
      _sum: { tokens: true },
    }),
    loadChainStatus(),
  ]);

  const byProvider = {};
  const byStatus = {};
  for (const g of groups) {
    const n = g._count._all;
    const p = (byProvider[g.provider] ??= { total: 0, ok: 0, infrastructure: 0, refusal: 0, invalid_output: 0, tokens: 0, avgLatencyMs: null });
    p.total += n;
    p[g.status] = (p[g.status] ?? 0) + n;
    p.tokens += g._sum.tokens ?? 0;
    if (g.status === "ok" && g._avg.latencyMs != null) p.avgLatencyMs = Math.round(g._avg.latencyMs);
    byStatus[g.status] = (byStatus[g.status] ?? 0) + n;
  }
  for (const p of Object.values(byProvider)) p.successRate = pct(p.ok, p.total);
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);

  return {
    period: "last_24h",
    total,
    successRate: pct(byStatus.ok ?? 0, total),
    byProvider,
    byStatus,
    chain,
    recent: recent.map((c) => ({
      id: c.id,
      task: c.task,
      provider: c.provider,
      model: c.model,
      status: c.status,
      tokens: c.tokens,
      inputTokens: c.inputTokens ?? null,
      outputTokens: c.outputTokens ?? null,
      latencyMs: c.latencyMs,
      detail: c.detail,
      createdAt: iso(c.createdAt),
    })),
  };
}

async function lastActivityByUser(userIds) {
  if (userIds.length === 0) return {};
  const where = { userId: { in: userIds } };
  const [explanations, articles, reviews] = await Promise.all([
    prisma.explanation.groupBy({ by: ["userId"], where, _max: { createdAt: true } }),
    prisma.article.groupBy({ by: ["userId"], where, _max: { lastReadAt: true } }),
    prisma.reviewCard.groupBy({ by: ["userId"], where, _max: { reviewedAt: true } }),
  ]);
  const latest = {};
  const bump = (id, d) => {
    if (d && (!latest[id] || d > latest[id])) latest[id] = d;
  };
  for (const r of explanations) bump(r.userId, r._max.createdAt);
  for (const r of articles) bump(r.userId, r._max.lastReadAt);
  for (const r of reviews) bump(r.userId, r._max.reviewedAt);
  return latest;
}

/**
 * Users with activity counts, newest first.
 * @param {{limit?:number}} [options]
 */
export async function getUsers({ limit = 200 } = {}) {
  const take = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const [users, total] = await Promise.all([
    prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      take,
      select: {
        id: true,
        email: true,
        displayName: true,
        locale: true,
        helpLevel: true,
        onboardedAt: true,
        createdAt: true,
        _count: { select: { concepts: true, explanations: true, articles: true, reviewCards: true } },
      },
    }),
    prisma.user.count(),
  ]);
  const activity = await lastActivityByUser(users.map((u) => u.id));
  return {
    total,
    users: users.map((u) => ({
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      locale: u.locale,
      helpLevel: u.helpLevel,
      onboarded: u.onboardedAt !== null,
      joinedAt: iso(u.createdAt),
      lastActiveAt: iso(activity[u.id] ?? null),
      concepts: u._count.concepts,
      explanations: u._count.explanations,
      articles: u._count.articles,
      reviews: u._count.reviewCards,
    })),
  };
}

/**
 * Usage metrics for the last 24 hours (spec 15.5). Error counts are distinct
 * log fingerprints seen in the window, since the log is deduplicated.
 */
export async function getMetrics() {
  const now = Date.now();
  const since = new Date(now - DAY_MS);
  const hourAgo = new Date(now - HOUR_MS);
  const window = { createdAt: { gte: since } };

  const [
    explTotal, explCacheHits, explAgg, byProviderRows, byHelpRows, byFollowRows, byLangRows,
    totalUsers, activeRows, conceptsTotal, dueNow, reviewsToday,
    errorsHour, errorsDay, bySeverityRows, tokenRows,
  ] = await Promise.all([
    prisma.explanation.count({ where: window }),
    prisma.explanation.count({ where: { ...window, cacheHit: true } }),
    prisma.explanation.aggregate({ where: { ...window, cacheHit: false }, _avg: { aiLatencyMs: true } }),
    prisma.explanation.groupBy({
      by: ["aiProvider"],
      where: { ...window, cacheHit: false, aiProvider: { not: null } },
      _count: { _all: true },
      _avg: { aiTokensUsed: true, aiLatencyMs: true },
    }),
    // "Keep exploring" follow-ups are stored at level 3; counted apart so level 3 means deep dives only.
    prisma.explanation.groupBy({ by: ["helpLevel"], where: { ...window, followUp: null }, _count: { _all: true } }),
    prisma.explanation.groupBy({ by: ["followUp"], where: { ...window, followUp: { not: null } }, _count: { _all: true } }),
    prisma.explanation.groupBy({ by: ["language"], where: window, _count: { _all: true } }),
    prisma.user.count(),
    // Counted in the database: loading every active row to dedupe in memory doesn't scale.
    prisma.$queryRaw`
      SELECT COUNT(DISTINCT "userId")::int AS "active" FROM (
        SELECT "userId" FROM "Explanation" WHERE "createdAt" >= ${since}
        UNION SELECT "userId" FROM "ReviewCard" WHERE "reviewedAt" >= ${since}
      ) AS recent`,
    prisma.concept.count(),
    prisma.concept.count({ where: { nextReviewAt: { lte: new Date(now) } } }),
    prisma.reviewCard.count({ where: { reviewedAt: { gte: since } } }),
    prisma.logEntry.count({ where: { lastSeenAt: { gte: hourAgo }, level: { in: ["ERROR", "CRITICAL"] } } }),
    prisma.logEntry.count({ where: { lastSeenAt: { gte: since }, level: { in: ["ERROR", "CRITICAL"] } } }),
    prisma.logEntry.groupBy({ by: ["level"], where: { lastSeenAt: { gte: since } }, _count: { _all: true } }),
    // Every status that consumed tokens is billed by the provider, not only "ok".
    prisma.aiCall.groupBy({
      by: ["model"],
      where: { ...window, tokens: { not: null } },
      _sum: { tokens: true, inputTokens: true, outputTokens: true },
    }),
  ]);

  const byProvider = {};
  for (const r of byProviderRows) {
    byProvider[r.aiProvider] = {
      count: r._count._all,
      avgTokens: Math.round(r._avg.aiTokensUsed ?? 0),
      avgLatencyMs: Math.round(r._avg.aiLatencyMs ?? 0),
    };
  }
  const toMap = (rows, key) => Object.fromEntries(rows.map((r) => [String(r[key]), r._count._all]));

  let today = 0;
  for (const g of tokenRows) {
    const cost = Number(estimateCost(g.model, g._sum.tokens, { inputTokens: g._sum.inputTokens, outputTokens: g._sum.outputTokens }));
    if (Number.isFinite(cost)) today += cost;
  }
  const costEstimate = { today: usd(today), projectedMonthly: usd(today * 30), basis: "AiCall rows with tokens, last 24h" };
  const activeToday = Number(activeRows?.[0]?.active ?? 0);

  return {
    period: "last_24h",
    explanations: {
      total: explTotal,
      cacheHits: explCacheHits,
      cacheHitRate: pct(explCacheHits, explTotal),
      avgLatencyMs: Math.round(explAgg._avg.aiLatencyMs ?? 0),
      byProvider,
      byHelpLevel: toMap(byHelpRows, "helpLevel"),
      byFollowUp: toMap(byFollowRows, "followUp"),
      byLanguage: toMap(byLangRows, "language"),
    },
    costEstimate,
    users: { totalRegistered: totalUsers, activeToday },
    concepts: { totalSaved: conceptsTotal, reviewsDueNow: dueNow, reviewsCompletedToday: reviewsToday },
    errors: { lastHour: errorsHour, last24h: errorsDay, bySeverity: toMap(bySeverityRows, "level"), unit: "distinct fingerprints" },
  };
}

/** Infrastructure tab: env presence, SMTP state and AI chain. Never values. */
export async function getInfrastructure() {
  return {
    environment: getEnvironmentChecks(),
    nodeEnv: process.env.NODE_ENV ?? null,
    smtp: { state: smtpState(), ...deliveryHealth() },
    aiChain: await loadChainStatus(),
  };
}

function guarded(name, promise) {
  return promise.catch((err) => {
    logger.error("admin", "Admin overview section failed", { section: name, detail: err?.message });
    return { error: "unavailable", message: "This section could not be loaded. Refresh to retry." };
  });
}

/**
 * Everything the Overview tab needs in one request; each section degrades on
 * its own instead of blanking the page.
 */
export async function getOverview() {
  const [findings, metrics, logs, aiCalls, users, infrastructure] = await Promise.all([
    guarded("findings", getFindings()),
    guarded("metrics", getMetrics()),
    guarded("logs", getLogs({ limit: 10 })),
    guarded("aiCalls", getAiCalls({ limit: 20 })),
    guarded("users", getUsers({ limit: 20 })),
    guarded("infrastructure", getInfrastructure()),
  ]);
  const counts = { high: 0, medium: 0, low: 0 };
  if (Array.isArray(findings)) for (const f of findings) counts[f.severity] += 1;
  const headline = !Array.isArray(findings)
    ? { status: "unknown", counts }
    : { status: counts.high > 0 ? "act_now" : counts.medium > 0 ? "worth_a_look" : "healthy", counts };
  return { generatedAt: new Date().toISOString(), headline, findings, metrics, logs, aiCalls, users, infrastructure };
}
