/**
 * Captures Chromium's beforeinstallprompt so Settings can offer "Install app".
 */

let deferred = null;
const listeners = new Set();

/** Call once on app start. */
export function captureInstallPrompt() {
  if (typeof window === "undefined") return;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e;
    listeners.forEach((l) => l());
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    listeners.forEach((l) => l());
  });
}

/** @returns {any|null} the deferred prompt event */
export function getInstallPrompt() {
  return deferred;
}

/** @param {() => void} cb */
export function subscribeInstallPrompt(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** @returns {"standalone"|"ios"|"other"} */
export function installContext() {
  if (typeof window === "undefined") return "other";
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true;
  if (standalone) return "standalone";
  if (/iPhone|iPad|iPod/.test(navigator.userAgent)) return "ios";
  return "other";
}
