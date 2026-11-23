/**
 * Human relative times in the viewer's locale and time zone (spec rule 5:
 * timestamps are UTC on the wire, converted only here).
 */

const UNITS = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

/**
 * "2 days ago", "in 3 hours", "tomorrow".
 * @param {string|number|Date|null|undefined} value
 * @param {number} [now] ms epoch; pass a stable value from state to keep renders pure
 * @returns {string}
 */
export function relativeTime(value, now = Date.now()) {
  if (value == null) return "";
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) return "";
  const seconds = Math.round((t - now) / 1000);
  const abs = Math.abs(seconds);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (abs < 45) return seconds <= 0 ? "just now" : "in a moment";
  for (const [unit, size] of UNITS) {
    if (abs >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return rtf.format(Math.round(seconds / 60), "minute");
}

/**
 * "in 3 hours" / "tomorrow at 9:00" / "in 2 days" for next-review lines.
 * @param {string|number|Date|null|undefined} value
 * @param {number} [now]
 * @returns {string}
 */
export function nextReviewPhrase(value, now = Date.now()) {
  if (value == null) return "";
  const d = new Date(value);
  const t = d.getTime();
  if (!Number.isFinite(t)) return "";
  if (t <= now) return "now";
  const today = new Date(now);
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const dayAfter = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 2);
  if (t - now < 12 * 3600 * 1000) return relativeTime(value, now);
  if (t >= tomorrow.getTime() && t < dayAfter.getTime()) {
    return `tomorrow at ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  }
  return relativeTime(value, now);
}

/**
 * @param {string|number|Date|null|undefined} value
 * @returns {string} local date, e.g. "Nov 20, 2026"
 */
export function formatDate(value) {
  if (value == null) return "";
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * @param {string|number|Date|null|undefined} value
 * @returns {string} local date and time
 */
export function formatDateTime(value) {
  if (value == null) return "";
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
