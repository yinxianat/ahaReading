/**
 * Diagnostic findings, derived on every read and never stored (LESSONS 43), so
 * they cannot go stale. Every finding carries a remediation. This is the one
 * catalogue: /api/health is a view of it (HEALTH_IMPACT says which codes make
 * health fatal or degraded), so health and the admin lanes cannot disagree.
 */
import prisma from "./db.js";
import { isProduction, isSet, getAdminEmails, secretProblem, MIN_SECRET_LENGTH } from "./env.js";
import { baseUrlProblem } from "./base-url.js";
import { smtpState, deliveryHealth } from "./mailer.js";
import { getChainStatus } from "./ai/index.js";
import { getCacheStats } from "./cache.js";

export const SEVERITIES = ["high", "medium", "low"];
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

/** One catalogue of titles so wording cannot drift between emitters. */
export const FINDING_TITLES = {
  missing_jwt_secret: "JWT_SECRET is not set",
  missing_magic_link_secret: "MAGIC_LINK_SECRET is not set",
  weak_jwt_secret: "JWT_SECRET is too short",
  weak_magic_link_secret: "MAGIC_LINK_SECRET is too short",
  missing_base_url: "BASE_URL is not set",
  base_url_unresolved_template: "BASE_URL contains an unexpanded template",
  base_url_invalid: "BASE_URL is not a valid URL",
  ai_status_unavailable: "AI provider status could not be read",
  no_ai_provider: "No AI provider is configured",
  single_ai_provider: "No AI fallback provider",
  mock_ai_active: "Mock AI provider is active",
  smtp_not_configured: "Email delivery is not configured",
  smtp_credentials_incomplete: "SMTP credentials are incomplete",
  smtp_recent_failure: "Recent email delivery failed",
  no_admin_emails: "No administrators configured",
  critical_logged: "Critical errors recorded recently",
  errors_logged: "Errors recorded recently",
  ai_failures: "AI calls failing",
  ai_refusals: "AI providers refusing content",
  cache_near_capacity: "Explanation cache near capacity",
  local_only_var_in_production: "Local-only variable set in production",
  log_query_failed: "Error log could not be read",
  ai_call_query_failed: "AI call ledger could not be read",
};

/**
 * What a configuration finding means for GET /api/health: "fatal" → 503, "warning" →
 * 200 degraded. Codes not listed are admin-only information.
 */
export const HEALTH_IMPACT = {
  missing_jwt_secret: "fatal",
  missing_magic_link_secret: "fatal",
  weak_jwt_secret: "fatal",
  weak_magic_link_secret: "fatal",
  missing_base_url: "fatal",
  base_url_unresolved_template: "fatal",
  base_url_invalid: "fatal",
  ai_status_unavailable: "warning",
  no_ai_provider: "warning",
  smtp_not_configured: "warning",
  smtp_credentials_incomplete: "warning",
  smtp_recent_failure: "warning",
};

/**
 * AI chain status, or null if reading it throws (a broken adapter must not break health).
 * @returns {Promise<Array<{name:string, registered:boolean, configured:boolean, defaultModel:string}>|null>}
 */
export async function loadChainStatus() {
  try {
    const status = await getChainStatus();
    return Array.isArray(status) ? status : null;
  } catch {
    return null;
  }
}

/**
 * Configuration-only findings (no database). Used by health and admin.
 * @param {{chain?: Array<object>|null}} [context] chain status if already loaded
 * @returns {Promise<Array<{code:string, severity:"high"|"medium"|"low", title:string, detail:string, remediation:string}>>}
 */
export async function getConfigFindings({ chain } = {}) {
  const findings = [];
  const add = (code, severity, detail, remediation) =>
    findings.push({ code, severity, title: FINDING_TITLES[code], detail, remediation });

  const jwt = secretProblem("JWT_SECRET");
  if (jwt === "missing") {
    add("missing_jwt_secret", "high", "Sessions cannot be signed or verified, so every sign-in fails.",
      "Set JWT_SECRET to 32+ random bytes (hex) in the deployment environment and redeploy.");
  } else if (jwt === "weak") {
    add("weak_jwt_secret", "high", `JWT_SECRET is shorter than ${MIN_SECRET_LENGTH} characters, so sessions are refused (a short key can be brute-forced from one cookie).`,
      "Set JWT_SECRET to the output of `openssl rand -hex 32` and redeploy. Everyone will need to sign in again.");
  }
  const magic = secretProblem("MAGIC_LINK_SECRET");
  if (magic === "missing") {
    add("missing_magic_link_secret", "high", "Magic-link tokens cannot be issued or checked, so nobody can sign in.",
      "Set MAGIC_LINK_SECRET to 32+ random bytes (hex) and redeploy.");
  } else if (magic === "weak") {
    add("weak_magic_link_secret", "high", `MAGIC_LINK_SECRET is shorter than ${MIN_SECRET_LENGTH} characters, so sign-in links are refused.`,
      "Set MAGIC_LINK_SECRET to the output of `openssl rand -hex 32` and redeploy.");
  }
  const urlProblem = baseUrlProblem();
  if (urlProblem && isProduction()) {
    const code = urlProblem === "missing" ? "missing_base_url" : `base_url_${urlProblem}`;
    add(code, "high", `BASE_URL is ${urlProblem.replace(/_/g, " ")}; magic links cannot be built.`,
      "Set BASE_URL to the public origin, e.g. https://your-app.up.railway.app (no ${...} templates).");
  }

  const status = chain === undefined ? await loadChainStatus() : chain;
  if (!status) {
    add("ai_status_unavailable", "medium", "The AI module could not be loaded, so provider configuration is unknown.",
      "Check the server log for an import error in src/lib/ai/index.js.");
  } else {
    const configured = status.filter((p) => p.configured);
    const real = configured.filter((p) => p.name !== "mock");
    if (configured.length === 0) {
      add("no_ai_provider", "high", "No provider in AI_PROVIDER_CHAIN has an API key. Explain and translate will return 503.",
        "Set ANTHROPIC_API_KEY (and optionally OPENAI_API_KEY / GOOGLE_AI_API_KEY) and redeploy.");
    } else if (real.length === 1) {
      add("single_ai_provider", "low", `Only ${real[0].name} is configured, so there is no failover if it goes down.`,
        "Add a second provider key, e.g. OPENAI_API_KEY or GOOGLE_AI_API_KEY.");
    }
    if (configured.some((p) => p.name === "mock")) {
      add("mock_ai_active", "low", "AI_MOCK=1: explanations are deterministic test text.",
        "Unset AI_MOCK to use real providers. (The mock cannot run in production.)");
    }
  }

  const smtp = smtpState();
  if (smtp === "not_configured") {
    add("smtp_not_configured", isProduction() ? "high" : "low",
      isProduction()
        ? "Magic-link emails cannot be sent, so new sessions are impossible."
        : "Development: magic links are printed to the server console and returned as devLink.",
      "Set SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASS (or SMTP_USERNAME/SMTP_PASSWORD).");
  } else if (smtp === "credentials_incomplete") {
    add("smtp_credentials_incomplete", "high", "SMTP_HOST is set but the user or password is missing, so every send is rejected.",
      "Set SMTP_USER/SMTP_PASS (or SMTP_USERNAME/SMTP_PASSWORD) on the deployed service.");
  } else {
    const delivery = deliveryHealth();
    if (delivery.degraded) {
      add("smtp_recent_failure", "high", `The last send failed in the past 10 minutes (${delivery.reason}).`,
        "Open the Errors tab for the classified failure and its remedy, or run the SMTP probe in Infrastructure.");
    }
  }

  if (isProduction()) {
    const stray = ["TEST_DATABASE_URL", "AI_MOCK"].filter(isSet);
    if (stray.length > 0) {
      add("local_only_var_in_production", "medium", `${stray.join(", ")} set in production; these are local-only.`,
        "Remove them from the production service variables.");
    }
  }

  if (getAdminEmails().length === 0) {
    add("no_admin_emails", "medium", "Nobody can open /admin and no alert emails are sent.",
      "Set ADMIN_EMAILS to a comma-separated list of administrator addresses.");
  }
  return findings;
}

/**
 * All findings: configuration plus runtime evidence from the log and AI ledger,
 * sorted high -> low.
 * @returns {Promise<Array<{code:string, severity:"high"|"medium"|"low", title:string, detail:string, remediation:string, evidence?:object}>>}
 */
export async function getFindings() {
  const findings = await getConfigFindings();
  const add = (code, severity, detail, remediation, evidence) =>
    findings.push({ code, severity, title: FINDING_TITLES[code], detail, remediation, ...(evidence ? { evidence } : {}) });
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  try {
    const groups = await prisma.logEntry.groupBy({
      by: ["level"],
      where: { lastSeenAt: { gte: since }, resolvedAt: null },
      _count: { _all: true },
    });
    const entries = (level) => groups.find((g) => g.level === level)?._count._all ?? 0;
    const critical = entries("CRITICAL");
    const errors = entries("ERROR");
    if (critical > 0) {
      add("critical_logged", "high", `${critical} unresolved critical error type(s) seen in the last 24 hours.`,
        "Open the Errors tab, fix the cause, then mark each resolved.", { entries: critical });
    }
    if (errors > 0) {
      add("errors_logged", errors > 10 ? "high" : "medium", `${errors} unresolved error type(s) seen in the last 24 hours.`,
        "Open the Errors tab; each row shows its count and first/last seen.", { entries: errors });
    }
  } catch {
    add("log_query_failed", "high", "The LogEntry table could not be queried.",
      "Check the database: run GET /api/health and confirm migrations are applied (prisma migrate deploy).");
  }

  try {
    const calls = await prisma.aiCall.groupBy({
      by: ["status"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    });
    const count = (s) => calls.find((c) => c.status === s)?._count._all ?? 0;
    const total = calls.reduce((n, c) => n + c._count._all, 0);
    const failed = count("infrastructure") + count("invalid_output");
    if (total >= 5 && failed / total > 0.2) {
      add("ai_failures", failed / total > 0.5 ? "high" : "medium",
        `${failed} of ${total} AI attempts failed in the last 24 hours.`,
        "Open the AI Calls tab to see which provider is failing; check its key, quota and status page.",
        { failed, total });
    }
    const refusals = count("refusal");
    if (refusals >= 5) {
      add("ai_refusals", "low", `${refusals} refusals in the last 24 hours.`,
        "Review refused calls in the AI Calls tab; frequent refusals on normal text suggest the prompt needs tuning.",
        { refusals });
    }
  } catch {
    add("ai_call_query_failed", "medium", "The AiCall table could not be queried.",
      "Check the database connection and that migrations are applied.");
  }

  let cache = null;
  try {
    cache = await getCacheStats();
  } catch {
    cache = null;
  }
  if (cache && Number(cache.maxEntries) > 0 && Number(cache.active ?? cache.size) > cache.maxEntries * 0.9) {
    add("cache_near_capacity", "low", `${cache.active ?? cache.size}/${cache.maxEntries} cache entries in use; LRU eviction is active.`,
      "Expected under load. Raise the cache size only if the hit rate in Metrics drops.");
  }

  return findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/** Variables shown in the Infrastructure tab: names and presence only, never values. */
const ENV_CATALOGUE = [
  { name: "DATABASE_URL", scope: "all", required: true },
  { name: "JWT_SECRET", scope: "all", required: true },
  { name: "MAGIC_LINK_SECRET", scope: "all", required: true },
  { name: "BASE_URL", scope: "production", required: true },
  { name: "ADMIN_EMAILS", scope: "all", required: false },
  { name: "AI_PROVIDER_CHAIN", scope: "all", required: false },
  { name: "ANTHROPIC_API_KEY", scope: "all", required: false },
  { name: "OPENAI_API_KEY", scope: "all", required: false },
  { name: "GOOGLE_AI_API_KEY", scope: "all", required: false },
  { name: "SMTP_HOST", scope: "production", required: false },
  { name: "SMTP_PORT", scope: "production", required: false },
  { name: "SMTP_USER", scope: "production", required: false, alternative: "SMTP_USERNAME" },
  { name: "SMTP_PASS", scope: "production", required: false, alternative: "SMTP_PASSWORD" },
  { name: "SMTP_FROM", scope: "production", required: false },
  { name: "AI_MOCK", scope: "local-only", required: false },
  { name: "TEST_DATABASE_URL", scope: "local-only", required: false },
];

/**
 * @returns {Array<{name:string, scope:string, required:boolean, set:boolean}>}
 */
export function getEnvironmentChecks() {
  return ENV_CATALOGUE.map((v) => ({
    name: v.name,
    scope: v.scope,
    required: v.required,
    set: isSet(v.name) || (v.alternative ? isSet(v.alternative) : false),
    ...(v.alternative ? { alternative: v.alternative } : {}),
  }));
}
