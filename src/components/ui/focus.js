/**
 * Focus trap helpers for dialogs and modal sheets.
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** @param {HTMLElement} root */
export function focusables(root) {
  return Array.from(root.querySelectorAll(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
}

/**
 * Keep Tab inside `root`. Call from a keydown handler.
 * @param {KeyboardEvent} e
 * @param {HTMLElement} root
 */
export function trapTab(e, root) {
  if (e.key !== "Tab" || !root) return;
  const list = focusables(root);
  if (list.length === 0) {
    e.preventDefault();
    return;
  }
  const first = list[0];
  const last = list[list.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}
