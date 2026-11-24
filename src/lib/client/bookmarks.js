/**
 * Reader-side bookmark helpers: labels, finding a bookmark's block again after the
 * article was edited, and the block the reader is looking at.
 */

export const KIND_LABEL = { revisit: "Re-visit later", important: "Important" };
export const KIND_ICON = { revisit: "bookmark", important: "star" };

const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Which block a bookmark points at now. The saved index wins while that block still
 * contains the quote; otherwise the first block containing it (the article was edited);
 * otherwise the saved index, clamped to the article.
 * @param {{blockIndex:number, quote:string}} bookmark
 * @param {string[]} blockTexts text of each block, in order
 * @returns {number} block index, or -1 for an empty article
 */
export function resolveBlock(bookmark, blockTexts) {
  if (blockTexts.length === 0) return -1;
  const at = bookmark.blockIndex;
  const texts = blockTexts.map(norm);
  const quote = norm(bookmark.quote);
  // The start of the quote is enough; shorter starts also catch a selection that ran
  // past the end of its block into the next one.
  for (const length of [60, 40, 24]) {
    const probe = quote.slice(0, length);
    if (!probe) break;
    if (at >= 0 && at < texts.length && texts[at].includes(probe)) return at;
    const found = texts.findIndex((t) => t.includes(probe));
    if (found >= 0) return found;
    if (quote.length <= length) break;
  }
  return Math.min(Math.max(0, at), blockTexts.length - 1);
}

/**
 * The block at the top of the reading area (just under the sticky bar).
 * @param {HTMLElement|null} body element containing the `[data-p]` blocks
 * @param {number} [topOffset] px hidden under the sticky top bar
 * @returns {number} block index, or -1
 */
export function topVisibleBlock(body, topOffset = 60) {
  if (!body) return -1;
  for (const el of body.querySelectorAll("[data-p]")) {
    if (el.getBoundingClientRect().bottom > topOffset + 8) return Number(el.getAttribute("data-p"));
  }
  return -1;
}

/** @returns {number} 0..100, how far down the page the reader has scrolled */
export function scrollPercent() {
  const max = document.documentElement.scrollHeight - window.innerHeight;
  if (max <= 0) return 100;
  return Math.min(100, Math.max(0, Math.round((window.scrollY / max) * 100)));
}

/**
 * Scroll a block into view below the sticky bar and flash it so the eye finds it.
 * @param {HTMLElement|null} body
 * @param {number} index
 */
export function scrollToBlock(body, index) {
  const el = body?.querySelector(`[data-p="${index}"]`);
  if (!el) return false;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({ top: Math.max(0, el.getBoundingClientRect().top + window.scrollY - 76), behavior: reduce ? "auto" : "smooth" });
  el.classList.remove("flash");
  // Restart the animation even when the same block is chosen twice.
  void el.offsetWidth;
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 1800);
  return true;
}
