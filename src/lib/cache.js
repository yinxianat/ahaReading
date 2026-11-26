import { createHash } from "node:crypto";

/**
 * In-memory LRU cache with TTL for AI responses (single Railway instance; swap for Redis
 * if we ever run more than one). A Map keeps insertion order, so re-inserting on every
 * hit makes the first key the least recently used.
 */
const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const KEY_VERSION = "v1";

let maxEntries = DEFAULT_MAX_ENTRIES;
let ttlMs = DEFAULT_TTL_MS;
const store = new Map();
const counters = { hits: 0, misses: 0, evictions: 0 };

function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Cache key for an explanation. Only provider-independent inputs: the same question gets
 * the same answer whichever provider served it. JSON encoding avoids delimiter collisions.
 * @param {string} highlightedText
 * @param {string} surroundingText
 * @param {number} helpLevel
 * @param {string} language
 * @param {{kind: string, previous: string}|null} [followUp] follow-up mode and the explanation it continues
 * @returns {string}
 */
export function computeCacheKey(highlightedText, surroundingText, helpLevel, language, followUp = null) {
  // A follow-up continues a specific earlier explanation, so that text is part of the question.
  const extra = followUp ? [followUp.kind, sha256(followUp.previous)] : [];
  return `explain:${sha256(JSON.stringify([KEY_VERSION, highlightedText, surroundingText, helpLevel, language, ...extra]))}`;
}

/**
 * Cache key for a zh translation of an explanation text.
 * @param {string} text
 * @returns {string}
 */
export function computeTranslationKey(text) {
  return `translate:${sha256(JSON.stringify([KEY_VERSION, text, "zh"]))}`;
}

function isValidEntry(entry) {
  return entry && typeof entry === "object" && typeof entry.expiresAt === "number" && entry.value !== undefined && entry.value !== null;
}

/**
 * @param {string} key
 * @returns {any|null} cached value, or null on miss/expiry/corruption
 */
export function getFromCache(key) {
  const entry = store.get(key);
  if (!entry) {
    counters.misses++;
    return null;
  }
  if (!isValidEntry(entry) || Date.now() > entry.expiresAt) {
    store.delete(key);
    counters.misses++;
    return null;
  }
  // Refresh recency: move to the end of the Map's order.
  store.delete(key);
  store.set(key, entry);
  counters.hits++;
  return entry.value;
}

/**
 * @param {string} key
 * @param {any} value non-null value to cache
 */
export function setCache(key, value) {
  if (value === undefined || value === null) return;
  if (store.has(key)) store.delete(key);
  while (store.size >= maxEntries) {
    const oldest = store.keys().next().value;
    store.delete(oldest);
    counters.evictions++;
  }
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/** Cache stats for diagnostics/metrics. */
export function getCacheStats() {
  const now = Date.now();
  let active = 0;
  let expired = 0;
  for (const entry of store.values()) {
    if (isValidEntry(entry) && now <= entry.expiresAt) active++;
    else expired++;
  }
  return { active, expired, total: store.size, maxEntries, ttlMs, ...counters };
}

/**
 * Clear the cache; optional limits are for tests.
 * @param {{maxEntries?: number, ttlMs?: number}} [options]
 */
export function resetCache({ maxEntries: max, ttlMs: ttl } = {}) {
  store.clear();
  counters.hits = counters.misses = counters.evictions = 0;
  maxEntries = Number.isInteger(max) && max > 0 ? max : DEFAULT_MAX_ENTRIES;
  ttlMs = Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TTL_MS;
}

/** Test hook: put a raw (possibly corrupted) entry into the store. */
export function _setRawEntryForTests(key, entry) {
  store.set(key, entry);
}
