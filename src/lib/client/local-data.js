/**
 * Per-user data this device keeps (SEC-3): the service-worker API/page caches,
 * the offline review queue, the cached user and the paste draft. The SW keys
 * cached API responses by URL only, so without this a second person signing
 * in on the same device could be served the first person's Notebook offline.
 *
 * - Sign-out / account deletion → `clearLocalUserData()` (everything).
 * - Session ended (401) → `forgetSession()`: drop the caches, keep the queue
 *   and the owner id, so the same person signing back in still syncs.
 * - Any successful sign-in or /api/auth/me → `rememberSignedInUser(id)`:
 *   if the owner id differs, everything is wiped before the new user's data
 *   is cached.
 */
import { clearQueue } from "./offline-queue.js";

const OWNER_KEY = "aha.uid";
const USER_KEY = "aha.user";
const DRAFT_KEY = "aha.draft";
const ONBOARD_SKIP_KEY = "aha.onboardSkipped";
const WARM_KEY = "aha.warmed";

async function clearCaches() {
  try {
    if (typeof caches === "undefined") return;
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith("aha-api") || k.startsWith("aha-pages")).map((k) => caches.delete(k)));
  } catch {
    // Cache API unavailable (private mode, old browser): nothing cached either.
  }
}

function remove(storage, key) {
  try {
    storage.removeItem(key);
  } catch {
    // storage blocked
  }
}

/** Remove everything this device keeps for the signed-in user. */
export async function clearLocalUserData() {
  clearQueue();
  if (typeof window !== "undefined") {
    remove(localStorage, USER_KEY);
    remove(localStorage, OWNER_KEY);
    remove(sessionStorage, DRAFT_KEY);
    remove(sessionStorage, ONBOARD_SKIP_KEY);
    remove(sessionStorage, WARM_KEY);
  }
  await clearCaches();
}

/** The session ended: cached responses must not outlive it. */
export async function forgetSession() {
  if (typeof window !== "undefined") {
    remove(localStorage, USER_KEY);
    remove(sessionStorage, WARM_KEY);
  }
  await clearCaches();
}

/**
 * Record who is signed in on this device; wipe the previous user's data first
 * when it is someone else.
 * @param {string} userId
 * @returns {Promise<boolean>} true when another user's data was cleared
 */
export async function rememberSignedInUser(userId) {
  if (typeof window === "undefined" || !userId) return false;
  let previous = null;
  try {
    previous = localStorage.getItem(OWNER_KEY);
    if (!previous) {
      // Devices from before round 2 only have the cached user object.
      const cached = JSON.parse(localStorage.getItem(USER_KEY) || "null");
      previous = cached && typeof cached.id === "string" ? cached.id : null;
    }
  } catch {
    previous = null;
  }
  const changed = Boolean(previous) && previous !== userId;
  if (changed) await clearLocalUserData();
  try {
    localStorage.setItem(OWNER_KEY, userId);
  } catch {
    // storage blocked: nothing persists, so nothing can leak either
  }
  return changed;
}

/** Onboarding could not be saved and the user chose to continue (PO-4). */
export function markOnboardingSkipped() {
  try {
    sessionStorage.setItem(ONBOARD_SKIP_KEY, "1");
  } catch {
    // storage blocked: AuthGuard will show onboarding again, with its error + retry
  }
}

/** @returns {boolean} */
export function onboardingSkipped() {
  try {
    return sessionStorage.getItem(ONBOARD_SKIP_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Once per session: have the service worker save the Notebook and Review
 * pages and fetch their data, so they work offline before the first visit
 * (PO-12). No-op without a controlling service worker.
 * @param {string} userId the signed-in user (the warm-up is per user)
 */
export function warmOfflineCache(userId) {
  try {
    const controller = navigator.serviceWorker?.controller;
    if (!controller || !userId || sessionStorage.getItem(WARM_KEY) === userId) return;
    sessionStorage.setItem(WARM_KEY, userId);
    controller.postMessage({ type: "warm", paths: ["/read", "/notebook", "/review"] });
    // These pass through the SW's network-first handler, which caches them.
    for (const url of ["/api/notebook", "/api/review", "/api/articles"]) {
      fetch(url, { credentials: "same-origin", headers: { Accept: "application/json" } }).catch(() => {});
    }
  } catch {
    // storage or SW unavailable: offline simply covers visited pages only
  }
}
