/**
 * Offline queue for review submissions (UX-SPEC 5, spec 12.3). Each entry has a
 * clientId so the server can de-duplicate a replay (POST /api/review is
 * idempotent per clientId). Stored in localStorage: small, synchronous, and
 * available in every browser we support; IndexedDB buys nothing at ≤ a few
 * hundred tiny records.
 */
import { api } from "./api.js";

const KEY = "aha.reviewQueue";
const EVENT = "aha:review-queue";

function read() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(items) {
  try {
    if (items.length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    // storage full or blocked: the review is lost, nothing else we can do
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENT));
}

/** @returns {string} a random id for idempotent replays */
export function newClientId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** @returns {Array<{clientId:string, conceptId:string, quality:number, queuedAt:string}>} */
export function getQueue() {
  if (typeof window === "undefined") return [];
  return read();
}

/**
 * @param {{conceptId:string, quality:number, clientId:string}} review
 */
export function enqueueReview(review) {
  const items = read().filter((i) => i.clientId !== review.clientId);
  items.push({ ...review, queuedAt: new Date().toISOString() });
  write(items);
}

/** Drop everything (sign out). */
export function clearQueue() {
  write([]);
}

/**
 * Subscribe to queue changes (this tab and other tabs).
 * @param {() => void} callback
 * @returns {() => void} unsubscribe
 */
export function subscribeQueue(callback) {
  const onStorage = (e) => {
    if (e.key === KEY) callback();
  };
  window.addEventListener(EVENT, callback);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT, callback);
    window.removeEventListener("storage", onStorage);
  };
}

let flushing = null;

/**
 * Send queued reviews in order. Stops at the first network failure (still
 * offline); drops items the server rejects permanently.
 * @returns {Promise<{synced:number, skipped:number, remaining:number}>}
 */
export function flushQueue() {
  if (flushing) return flushing;
  flushing = (async () => {
    let synced = 0;
    let skipped = 0;
    for (const item of read()) {
      try {
        await api("/api/review", {
          method: "POST",
          body: { conceptId: item.conceptId, quality: item.quality, clientId: item.clientId },
          timeoutMs: 15000,
        });
        synced += 1;
      } catch (err) {
        const transient = err.code === "offline" || err.code === "timeout" || err.code === "unauthenticated" || err.status >= 500 || err.status === 429;
        if (transient) break;
        skipped += 1;
      }
      write(read().filter((i) => i.clientId !== item.clientId));
    }
    return { synced, skipped, remaining: read().length };
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}
