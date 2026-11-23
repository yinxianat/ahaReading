/**
 * Admin email alerts on two channels (spec 17):
 *   alertError — raised by the logger when something breaks. Deduplicated per
 *                source+message: one outage produces one email, not one per request.
 *   alertEvent — raised explicitly for things worth knowing (new signup). Capped at
 *                EVENT_ALERTS_PER_HOUR per title; the rest are counted and reported
 *                in the next email, so a sign-up flood cannot bury real alerts.
 *
 * Never throws, and never calls the logger (the logger calls us). Failures go
 * to stderr. Imports only leaves: mailer, redact, env.
 */
import { sendMail } from "./mailer.js";
import { redact } from "./redact.js";
import { getAdminEmails } from "./env.js";

export const DEDUP_WINDOW_MS = 15 * 60 * 1000;
export const REPEAT_AFTER_DELIVERY_MS = 6 * 60 * 60 * 1000;
export const EVENT_ALERTS_PER_HOUR = 10;
const HOUR_MS = 60 * 60 * 1000;
const attempted = new Map();
const delivered = new Map();
const eventWindows = new Map(); // title -> {start, sent, suppressed}

function envTag() {
  const env = process.env.NODE_ENV;
  return env === "production" ? "" : `[${(env || "development").toUpperCase()}] `;
}

function alertsEnabled() {
  return process.env.ALERTS_ENABLED !== "false";
}

function suppressed(key, now) {
  for (const [k, at] of attempted) if (now - at > REPEAT_AFTER_DELIVERY_MS) attempted.delete(k);
  for (const [k, at] of delivered) if (now - at > REPEAT_AFTER_DELIVERY_MS) delivered.delete(k);
  const lastAttempt = attempted.get(key);
  if (lastAttempt !== undefined && now - lastAttempt < DEDUP_WINDOW_MS) return true;
  const lastDelivered = delivered.get(key);
  return lastDelivered !== undefined && now - lastDelivered < REPEAT_AFTER_DELIVERY_MS;
}

async function deliver(subject, text) {
  const admins = getAdminEmails();
  if (admins.length === 0) return { sent: false, reason: "no_admin_configured" };
  const result = await sendMail({ to: admins.join(", "), subject: `${envTag()}${subject}`, text });
  if (result.delivered || result.loggedToConsole) return { sent: true };
  console.error(`[alerts] admin alert not delivered: ${result.error}`);
  return { sent: false, reason: result.error };
}

/**
 * Alert admins about an error. Deduplicated: the same source+message alerts at
 * most once per 15 minutes, and once per 6 hours after a delivered alert.
 * @param {string} source
 * @param {string} message constant template
 * @param {unknown} [detail] redacted before sending
 * @returns {Promise<{sent:boolean, reason?:string}>}
 */
export async function alertError(source, message, detail = null) {
  try {
    if (!alertsEnabled()) return { sent: false, reason: "alerts_disabled" };
    const key = `${source}:${message}`;
    const now = Date.now();
    if (suppressed(key, now)) return { sent: false, reason: "deduplicated" };
    attempted.set(key, now);

    const body = [
      `Source: ${source}`,
      `Message: ${message}`,
      detail ? `Detail: ${redact(detail)}` : null,
      `Time: ${new Date(now).toISOString()}`,
      "Open /admin for the full error log.",
    ].filter(Boolean).join("\n\n");
    const result = await deliver(`AhaReading alert: ${source}: ${message}`, body);
    if (result.sent) delivered.set(key, Date.now());
    return result;
  } catch (err) {
    console.error(`[alerts] alertError failed: ${err?.message}`);
    return { sent: false, reason: "delivery_failed" };
  }
}

/**
 * Alert admins about a notable event. At most EVENT_ALERTS_PER_HOUR per title;
 * the overflow is counted and mentioned in the first email of the next hour.
 * @param {string} title constant title, e.g. "New user signup"
 * @param {unknown} [detail] redacted before sending
 * @returns {Promise<{sent:boolean, reason?:string}>}
 */
export async function alertEvent(title, detail = null) {
  try {
    if (!alertsEnabled()) return { sent: false, reason: "alerts_disabled" };
    const now = Date.now();
    let win = eventWindows.get(title);
    let carried = 0;
    if (!win || now - win.start >= HOUR_MS) {
      carried = win?.suppressed ?? 0;
      win = { start: now, sent: 0, suppressed: 0 };
      eventWindows.set(title, win);
    }
    if (win.sent >= EVENT_ALERTS_PER_HOUR) {
      win.suppressed += 1;
      return { sent: false, reason: "rate_limited" };
    }
    win.sent += 1;
    const body = [
      title,
      detail ? redact(detail) : null,
      carried > 0 ? `${carried} more "${title}" event(s) in the previous hour were not emailed (hourly cap ${EVENT_ALERTS_PER_HOUR}).` : null,
      `Time: ${new Date(now).toISOString()}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    return await deliver(`AhaReading: ${title}`, body);
  } catch (err) {
    console.error(`[alerts] alertEvent failed: ${err?.message}`);
    return { sent: false, reason: "delivery_failed" };
  }
}

/** Test seam. */
export function _resetAlerts() {
  attempted.clear();
  delivered.clear();
  eventWindows.clear();
}
