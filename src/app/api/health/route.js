import prisma from "@/lib/db.js";
import { isProduction, secretProblem } from "@/lib/env.js";
import { baseUrlProblem } from "@/lib/base-url.js";
import { smtpState } from "@/lib/mailer.js";
import { getConfigFindings, loadChainStatus, HEALTH_IMPACT } from "@/lib/diagnostics.js";
import { getSession, isAdminEmail, requireAdmin } from "@/lib/auth.js";
import { alertError } from "@/lib/alerts.js";

export const dynamic = "force-dynamic";

const DB_PROBE_TIMEOUT_MS = 3000;

// A count on a real table, not SELECT 1: an empty unmigrated database must fail.
// Bounded, so a blackholed database answers 503 in 3 s instead of hanging the healthcheck.
async function probeDatabase() {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ check: "timeout", fatal: "database_timeout" }), DB_PROBE_TIMEOUT_MS);
  });
  const probe = prisma.user.count().then(
    () => ({ check: "ok" }),
    (err) => {
      const missingSchema = err?.code === "P2021" || /42P01|does not exist/i.test(err?.message ?? "");
      return missingSchema ? { check: "no_schema", fatal: "migrations_not_applied" } : { check: "unreachable", fatal: "database_unreachable" };
    }
  );
  try {
    return await Promise.race([probe, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function wantsDetail(request) {
  if (!isProduction()) return true;
  try {
    const session = request ? await getSession(request) : null;
    if (!session || !isAdminEmail(session.email)) return false;
    // The token alone isn't enough: "Sign out of all devices" and account deletion revoke
    // it in the database. One read, and only for a caller whose token claims an admin.
    const admin = await requireAdmin(request);
    return !admin.response;
  } catch {
    return false;
  }
}

/**
 * Deploy healthcheck (spec 16, LESSONS 45/60). 503 when the app cannot work —
 * database unreachable/slow/unmigrated, a missing or short auth secret, or an
 * unusable BASE_URL in production. 200 "degraded" when it serves but something is
 * missing (no AI provider, SMTP absent or failing). The fatal/warning rules come
 * from the diagnostics catalogue (HEALTH_IMPACT). Names of problems only, never
 * values. In production, only a signed-in admin sees the checks and problem names;
 * everyone else gets just {status, timestamp} with the same status code, which is all
 * the platform healthcheck needs. Telling the internet "secret missing" or "database
 * empty" would point attackers at a misconfigured deploy.
 * @param {Request} [request]
 */
export async function GET(request) {
  const [db, chain] = await Promise.all([probeDatabase(), loadChainStatus()]);
  const findings = await getConfigFindings({ chain });

  const fatal = db.fatal ? [db.fatal] : [];
  const warnings = [];
  for (const f of findings) {
    if (HEALTH_IMPACT[f.code] === "fatal") fatal.push(f.code);
    else if (HEALTH_IMPACT[f.code] === "warning") warnings.push(f.code);
  }

  const secrets = ["JWT_SECRET", "MAGIC_LINK_SECRET"].map(secretProblem);
  const urlProblem = baseUrlProblem();
  const configured = chain ? chain.filter((p) => p.configured).map((p) => p.name) : null;
  const checks = {
    database: db.check,
    secrets: secrets.includes("missing") ? "missing" : secrets.includes("weak") ? "weak" : "ok",
    baseUrl: urlProblem ? (isProduction() ? urlProblem : "dev_fallback") : "ok",
    ai: configured === null ? "status_unavailable" : configured.length > 0 ? configured : "none",
    smtp: smtpState(),
  };
  const status = fatal.length > 0 ? "unhealthy" : warnings.length > 0 ? "degraded" : "ok";
  if (fatal.length > 0) alertError("system", "Health check returned 503", { fatal }).catch(() => {});

  const init = { status: fatal.length > 0 ? 503 : 200, headers: { "Cache-Control": "no-store" } };
  const timestamp = new Date().toISOString();
  if (!(await wantsDetail(request))) return Response.json({ status, timestamp }, init);
  return Response.json({ status, checks, fatal, warnings, timestamp }, init);
}
