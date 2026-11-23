/**
 * Selection snapshots for the reader (UX-SPEC 4.1). A snapshot is taken while
 * the native selection exists and is what every action uses later — iOS
 * clears the selection when a button is tapped, so nothing re-reads
 * getSelection() at tap time.
 */

export const MAX_HIGHLIGHT = 1000;
const MAX_CONTEXT = 3000;

/**
 * @typedef {object} Snapshot
 * @property {string} highlightedText whitespace-collapsed, trimmed
 * @property {string} surroundingText containing paragraph(s), ≤ 3000 chars
 * @property {{top:number,left:number,right:number,bottom:number,width:number,height:number}|null} rect last line rect (viewport)
 * @property {[number, number]} paragraphIndexes
 * @property {Object<number, [number, number]>} ranges char offsets per paragraph
 * @property {boolean} tooLong
 * @property {"select"|"tap"|"concept"} source
 */

function paragraphOf(node, root) {
  let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  while (el && el !== root) {
    if (el.dataset && el.dataset.p !== undefined) return el;
    el = el.parentElement;
  }
  return null;
}

function offsetWithin(paragraph, container, offset) {
  const range = document.createRange();
  range.setStart(paragraph, 0);
  try {
    range.setEnd(container, offset);
  } catch {
    return 0;
  }
  return range.toString().length;
}

/** Collapse whitespace the way the API expects. */
export function collapse(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

/**
 * Cut a window of `max` chars centred on [start, end), at word boundaries.
 * @param {string} text
 * @param {number} start
 * @param {number} end
 * @param {number} [max]
 * @returns {string}
 */
export function contextWindow(text, start, end, max = MAX_CONTEXT) {
  if (text.length <= max) return text;
  const centre = Math.floor((start + end) / 2);
  let from = Math.max(0, centre - Math.floor(max / 2));
  let to = Math.min(text.length, from + max);
  from = Math.max(0, to - max);
  if (from > 0) {
    const space = text.indexOf(" ", from);
    if (space !== -1 && space < start) from = space + 1;
  }
  if (to < text.length) {
    const space = text.lastIndexOf(" ", to);
    if (space > end) to = space;
  }
  return text.slice(from, to).trim();
}

/**
 * Build a snapshot from the current window selection, or null when the
 * selection is empty or not entirely inside `root`.
 * @param {HTMLElement} root the article body
 * @returns {Snapshot|null}
 */
export function snapshotFromSelection(root) {
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  if (!root || !sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  if (!root.contains(sel.anchorNode) || !root.contains(sel.focusNode)) return null;
  const range = sel.getRangeAt(0);
  const highlightedText = collapse(sel.toString());
  if (!highlightedText) return null;

  const startP = paragraphOf(range.startContainer, root);
  const endP = paragraphOf(range.endContainer, root) || startP;
  if (!startP) return null;
  const startIdx = Number(startP.dataset.p);
  const endIdx = Number(endP.dataset.p);

  const ranges = {};
  const texts = [];
  for (let i = startIdx; i <= endIdx; i++) {
    const p = root.querySelector(`[data-p="${i}"]`);
    if (!p) continue;
    const text = p.textContent || "";
    texts.push(text);
    const s = i === startIdx ? offsetWithin(p, range.startContainer, range.startOffset) : 0;
    const e = i === endIdx ? offsetWithin(p, range.endContainer, range.endOffset) : text.length;
    if (e > s) ranges[i] = [s, e];
  }
  const joined = texts.join("\n\n");
  const firstRange = ranges[startIdx] || [0, 0];
  const surroundingText = contextWindow(joined, firstRange[0], firstRange[0] + highlightedText.length);

  const rects = range.getClientRects();
  const last = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
  const rect = last
    ? { top: last.top, left: last.left, right: last.right, bottom: last.bottom, width: last.width, height: last.height }
    : null;

  return {
    highlightedText,
    surroundingText,
    rect,
    paragraphIndexes: [startIdx, endIdx],
    ranges,
    tooLong: highlightedText.length > MAX_HIGHLIGHT,
    source: "select",
  };
}

/**
 * Sentence boundaries in a paragraph.
 * @param {string} text
 * @param {string} [locale]
 * @returns {Array<[number, number]>}
 */
export function sentenceSpans(text, locale = "en") {
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    const seg = new Intl.Segmenter(locale, { granularity: "sentence" });
    return Array.from(seg.segment(text), (s) => [s.index, s.index + s.segment.length]);
  }
  const spans = [];
  const re = /[^.!?。！？]+[.!?。！？]*\s*/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[0].length === 0) break;
    spans.push([m.index, m.index + m[0].length]);
  }
  return spans.length ? spans : [[0, text.length]];
}

/**
 * Character offset under a viewport point inside `paragraph`.
 * @param {HTMLElement} paragraph
 * @param {number} x
 * @param {number} y
 * @returns {number|null}
 */
export function offsetAtPoint(paragraph, x, y) {
  let node = null;
  let offset = 0;
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (pos) {
      node = pos.offsetNode;
      offset = pos.offset;
    }
  } else if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    if (r) {
      node = r.startContainer;
      offset = r.startOffset;
    }
  }
  if (!node || !paragraph.contains(node)) return null;
  return offsetWithin(paragraph, node, offset);
}

/**
 * Snapshot for the sentence at `offset` in paragraph `index` (tap mode, or a
 * saved-concept "Explain again").
 * @param {string} paragraphText
 * @param {number} index
 * @param {number} start
 * @param {number} end
 * @param {"tap"|"concept"} source
 * @returns {Snapshot|null}
 */
export function snapshotFromRange(paragraphText, index, start, end, source) {
  const raw = paragraphText.slice(start, end);
  const highlightedText = collapse(raw);
  if (!highlightedText) return null;
  const lead = raw.length - raw.trimStart().length;
  const trail = raw.length - raw.trimEnd().length;
  return {
    highlightedText,
    surroundingText: contextWindow(paragraphText, start, end),
    rect: null,
    paragraphIndexes: [index, index],
    ranges: { [index]: [start + lead, end - trail] },
    tooLong: highlightedText.length > MAX_HIGHLIGHT,
    source,
  };
}
