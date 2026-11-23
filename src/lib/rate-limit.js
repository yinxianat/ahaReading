/**
 * In-memory sliding-window rate limiter (spec 14.1) and per-key daily quotas.
 * Per-process: on a single Railway instance that is the whole fleet; a second
 * instance doubles limits. Both maps are bounded, so a flood of distinct keys
 * evicts the least recently used entries instead of growing the heap.
 */

export const MAX_KEYS = 50_000;
const windows = new Map();
const daily = new Map();
const CLEANUP_INTERVAL_MS = 60_000;
let lastCleanup = Date.now();

function cleanup(now) {
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;
  for (const [key, entry] of windows) {
    if (entry.timestamps.length === 0 || entry.timestamps.at(-1) < now - entry.windowMs) {
      windows.delete(key);
    }
  }
  const today = utcDay(now);
  for (const [key, entry] of daily) if (entry.day !== today) daily.delete(key);
}

// Map iteration order is insertion order, so re-inserting on use makes the first key the LRU.
function touch(map, key, value) {
  map.delete(key);
  if (map.size >= MAX_KEYS) map.delete(map.keys().next().value);
  map.set(key, value);
}

/**
 * Record one request against `key` and report whether it is allowed.
 * @param {string} key e.g. "explain:user:abc"
 * @param {{maxRequests:number, windowMs:number}} options
 * @returns {{allowed:boolean, retryAfter?:number}} retryAfter in whole seconds (>= 1)
 */
export function checkRateLimit(key, { maxRequests, windowMs }) {
  const now = Date.now();
  cleanup(now);

  const entry = windows.get(key) ?? { timestamps: [], windowMs };
  entry.windowMs = windowMs;
  entry.timestamps = entry.timestamps.filter((t) => t > now - windowMs);
  touch(windows, key, entry);

  if (entry.timestamps.length >= maxRequests) {
    const retryAfter = Math.max(1, Math.ceil((entry.timestamps[0] + windowMs - now) / 1000));
    return { allowed: false, retryAfter };
  }
  entry.timestamps.push(now);
  return { allowed: true };
}

function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function secondsToUtcMidnight(now) {
  const d = new Date(now);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1, Math.ceil((midnight - now) / 1000));
}

/**
 * Count one unit against a per-UTC-day quota.
 * @param {string} key
 * @param {number} limit units allowed per UTC day
 * @returns {{allowed:boolean, used:number, retryAfter?:number}} retryAfter = seconds until UTC midnight
 */
export function consumeDailyQuota(key, limit) {
  const now = Date.now();
  cleanup(now);
  const day = utcDay(now);
  const current = daily.get(key);
  const entry = current && current.day === day ? current : { day, used: 0 };
  touch(daily, key, entry);
  if (entry.used >= limit) return { allowed: false, used: entry.used, retryAfter: secondsToUtcMidnight(now) };
  entry.used += 1;
  return { allowed: true, used: entry.used };
}

const DOTLESS_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/**
 * Rate-limit identity of an email address: one key per real mailbox, so
 * `a+1@gmail.com`, `a.b@gmail.com` and `A@GMAIL.COM` share a bucket.
 * Never used to address mail — only to count requests.
 * @param {string} email
 * @returns {string}
 */
export function mailboxKey(email) {
  const lower = String(email).trim().toLowerCase();
  const at = lower.lastIndexOf("@");
  if (at < 1) return lower;
  let local = lower.slice(0, at).split("+")[0];
  let domain = lower.slice(at + 1);
  if (DOTLESS_DOMAINS.has(domain)) {
    local = local.replace(/\./g, "");
    domain = "gmail.com";
  }
  return `${local || lower.slice(0, at)}@${domain}`;
}

/** Test seam: forget every window and quota. */
export function _resetRateLimits() {
  windows.clear();
  daily.clear();
}

/** Test seam. @returns {{windows:number, daily:number}} */
export function _rateLimitSizes() {
  return { windows: windows.size, daily: daily.size };
}
