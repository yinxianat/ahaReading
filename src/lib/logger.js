/**
 * Persistent, deduplicated error log (spec 15.1).
 *
 * Rules: logging never throws; logging never recurses (persistence failures go
 * to stderr only, and a circuit breaker stops DB writes after repeated
 * failures); `message` is a constant template — varying data goes in `detail`
 * so one fault keeps one fingerprint. A recurrence clears `resolvedAt`, so a
 * resolved problem that comes back is visible again. The first detail is kept
 * beside the latest one, and alert dedup is claimed on the row (`alertedAt`), so
 * a restart or a second instance does not re-send an alert already sent.
 */
import { createHash } from "node:crypto";
import prisma from "./db.js";
import { redact } from "./redact.js";
import { alertError, DEDUP_WINDOW_MS, REPEAT_AFTER_DELIVERY_MS } from "./alerts.js";

const FAILURE_THRESHOLD = 5;
const COOLDOWN_MS = 60_000;
let consecutiveFailures = 0;
let circuitOpenUntil = 0;

const CONSOLE = { WARN: "warn", ERROR: "error", CRITICAL: "error" };

/**
 * @param {string} source
 * @param {string} message
 * @returns {string} sha1 hex of source + first 200 chars of message
 */
export function fingerprint(source, message) {
  return createHash("sha1").update(`${source}::${String(message).slice(0, 200)}`).digest("hex");
}

function shouldAlert(level, source) {
  // Anyone can POST /api/client-error, so client reports never page the admin.
  return level !== "WARN" && source !== "client";
}

// One atomic claim per fingerprint per REPEAT window, shared by every process.
// Returns false only when another claim is live; a failed query means "alert anyway"
// (in-memory dedup still applies), since a duplicate email beats a missed outage.
async function claimAlert(fp, now) {
  try {
    const claimed = await prisma.logEntry.updateMany({
      where: { fingerprint: fp, OR: [{ alertedAt: null }, { alertedAt: { lt: new Date(now - REPEAT_AFTER_DELIVERY_MS) } }] },
      data: { alertedAt: new Date(now) },
    });
    return typeof claimed?.count === "number" ? claimed.count === 1 : true;
  } catch {
    return true;
  }
}

// Undelivered: move the claim back so the next occurrence after DEDUP_WINDOW_MS retries.
function releaseClaim(fp, now) {
  prisma.logEntry
    .updateMany({
      where: { fingerprint: fp, alertedAt: new Date(now) },
      data: { alertedAt: new Date(now - REPEAT_AFTER_DELIVERY_MS + DEDUP_WINDOW_MS) },
    })
    .catch(() => {});
}

const NOT_RETRIABLE = new Set(["deduplicated", "alerts_disabled", "no_admin_configured"]);

function sendAlert(source, message, detail, claim) {
  alertError(source, message, detail)
    .then((result) => {
      if (claim && !result?.sent && !NOT_RETRIABLE.has(result?.reason)) releaseClaim(claim.fp, claim.now);
    })
    .catch(() => {});
}

async function log(level, source, message, detail) {
  try {
    const safeSource = String(source || "system").slice(0, 50);
    const safeMessage = String(message || "Unspecified error").slice(0, 500);
    const safeDetail = detail === undefined || detail === null ? null : redact(detail);
    console[CONSOLE[level]](`[${level}] [${safeSource}] ${safeMessage}${safeDetail ? ` | ${safeDetail}` : ""}`);

    const alertable = shouldAlert(level, safeSource);
    const persist = process.env.LOG_PERSISTENCE !== "false" && Date.now() >= circuitOpenUntil;
    if (!persist) {
      if (alertable) sendAlert(safeSource, safeMessage, safeDetail, null);
      return;
    }

    const fp = fingerprint(safeSource, safeMessage);
    const now = Date.now();
    try {
      await prisma.logEntry.upsert({
        where: { fingerprint: fp },
        create: {
          level, source: safeSource, message: safeMessage, detail: safeDetail, firstDetail: safeDetail,
          fingerprint: fp, lastSeenAt: new Date(now),
        },
        update: { level, detail: safeDetail, count: { increment: 1 }, resolvedAt: null, lastSeenAt: new Date(now) },
      });
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures += 1;
      console.error(`[WARN] [logger] could not persist log entry | ${redact(err?.message)}`);
      if (alertable) sendAlert(safeSource, safeMessage, safeDetail, null);
      if (consecutiveFailures >= FAILURE_THRESHOLD) {
        circuitOpenUntil = Date.now() + COOLDOWN_MS;
        consecutiveFailures = 0;
        console.error(`[CRITICAL] [logger] persistence disabled for ${COOLDOWN_MS}ms after ${FAILURE_THRESHOLD} consecutive failures`);
        alertError("system", "Log persistence circuit breaker opened", { cooldownMs: COOLDOWN_MS }).catch(() => {});
      }
      return;
    }

    if (alertable && (await claimAlert(fp, now))) sendAlert(safeSource, safeMessage, safeDetail, { fp, now });
  } catch {
    // Even console formatting failed; there is nowhere safer to report it.
  }
}

/**
 * Logger. Each method resolves when the entry is persisted (or skipped);
 * callers may await or fire-and-forget. Never rejects.
 * @type {{warn:(source:string,message:string,detail?:unknown)=>Promise<void>, error:(source:string,message:string,detail?:unknown)=>Promise<void>, critical:(source:string,message:string,detail?:unknown)=>Promise<void>}}
 */
export const logger = {
  warn: (source, message, detail) => log("WARN", source, message, detail),
  error: (source, message, detail) => log("ERROR", source, message, detail),
  critical: (source, message, detail) => log("CRITICAL", source, message, detail),
};

export default logger;

/** Test seam: close the circuit. */
export function _resetLogger() {
  consecutiveFailures = 0;
  circuitOpenUntil = 0;
}

/** Test seam. @returns {{consecutiveFailures:number, open:boolean}} */
export function _loggerState() {
  return { consecutiveFailures, open: Date.now() < circuitOpenUntil };
}
