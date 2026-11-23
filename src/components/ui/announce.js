/**
 * Screen-reader announcements through the two live regions mounted in the
 * root layout (#live-status polite, #live-alert assertive).
 * @param {string} message
 * @param {{assertive?:boolean}} [options]
 */
export function announce(message, { assertive = false } = {}) {
  if (typeof document === "undefined") return;
  const el = document.getElementById(assertive ? "live-alert" : "live-status");
  if (!el) return;
  el.textContent = "";
  // A fresh text node on the next frame makes repeated identical messages re-announce.
  requestAnimationFrame(() => {
    el.textContent = message;
  });
}
