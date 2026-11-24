/**
 * Document bytes → {title, text} in the article-blocks.js format. This is the part
 * that runs pdf.js and mammoth, so it only ever runs inside the parse worker
 * (document-worker.mjs), where memory and time are capped; document-import.js does
 * the cheap checks first and never calls it on the server's main thread.
 *
 * Plain Node ESM with relative imports only: the worker loads it without the Next
 * bundler, so no "@/" aliases here or in anything it imports.
 *
 * PDFs have no paragraphs, only positioned text lines, so structure is rebuilt:
 * vertical gaps split paragraphs, larger text becomes headings, bullet lines become
 * lists, short lines repeated at the top/bottom of most pages (running headers,
 * footers) and bare page numbers are dropped, and words hyphenated across lines are
 * rejoined.
 */
import { serializeArticleBlocks } from "./article-blocks.js";
import { extractReadable } from "./extract.js";
import { MAX_ARTICLE_CHARS } from "./limits.js";
import { DocumentImportError, UNWANTED_CHARS } from "./document-shared.js";

export const MAX_PDF_PAGES = 500;
/** Text items read from one PDF page at most (a page of tiny empty items is an attack, not prose). */
export const MAX_PDF_PAGE_ITEMS = 100_000;
// Reading stops a little past the article cap; the rest would be cut off anyway.
const PDF_TEXT_BUDGET = MAX_ARTICLE_CHARS + 10_000;

// Look-alike code points PDF fonts map CJK and ligature glyphs to (Kangxi radicals for
// 文/人/日…, CJK compatibility ideographs, ﬁ/ﬂ). NFKC folds them to the normal
// characters, so search, duplicate checks and caching see "文", not "⽂". Only these
// ranges: NFKC on everything would also rewrite ，→, …→... and x²→x2.
const COMPAT_LOOKALIKES = /[\u2e80-\u2fdf\uf900-\ufaff\ufb00-\ufb06]|[\u{2f800}-\u{2fa1f}]/gu;

/**
 * Text safe to store: no hidden characters, CJK look-alikes folded, spaces collapsed.
 * @param {unknown} text
 * @returns {string}
 */
export function tidy(text) {
  return String(text || "")
    .replace(UNWANTED_CHARS, "")
    .replace(COMPAT_LOOKALIKES, (c) => c.normalize("NFKC"))
    .replace(/[ \t\u00a0]+/g, " ")
    .trim();
}

// ─── Word (.docx) ───────────────────────────────────────────────────────

const DOCX_STYLE_MAP = [
  // Word's "Title" style is the document title; mammoth would make it a plain paragraph.
  "p[style-name='Title'] => h1:fresh",
  "p.Title => h1:fresh",
  "p[style-name='Subtitle'] => p:fresh",
  "p.Subtitle => p:fresh",
];

async function extractDocx(bytes) {
  const mammoth = (await import("mammoth")).default;
  let html;
  try {
    const result = await mammoth.convertToHtml(
      { buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) },
      {
        styleMap: DOCX_STYLE_MAP,
        // Images are never shown, so never decode them (mammoth inlines them as base64 otherwise).
        convertImage: mammoth.images.imgElement(async () => ({ src: "" })),
      }
    );
    html = result.value;
  } catch (err) {
    throw new DocumentImportError("file_unreadable", "We couldn't open this Word file. It may be damaged or password-protected. Save it again (or as a PDF) and retry.", `mammoth: ${err?.message || err}`.slice(0, 200));
  }
  // Footnotes end with a "↑" back-link, which means nothing without the link.
  html = html.replace(/\s*<a href="#(?:footnote|endnote)-ref-[^"]*">↑<\/a>/g, "");
  const extracted = extractReadable(`<html><body>${html}</body></html>`);
  return { title: extracted.title, text: extracted.text };
}

// ─── PDF ────────────────────────────────────────────────────────────────

/**
 * Group pdf.js text items into lines: {text, y, h}. A line ends at hasEOL or when the
 * baseline jumps by more than half a line height (no EOL marker between them).
 * @param {Array<{str?:string, transform?:number[], height?:number, hasEOL?:boolean}>} items
 * @returns {Array<{text:string, y:number, h:number}>}
 */
export function itemsToLines(items) {
  const lines = [];
  let cur = null;
  const flush = () => {
    if (cur) {
      const text = tidy(cur.text);
      if (text) lines.push({ text, y: cur.y, h: cur.h || 0 });
    }
    cur = null;
  };
  for (const item of items) {
    if (typeof item?.str !== "string") continue;
    const y = Number(item.transform?.[5]);
    const h = Math.abs(Number(item.height) || Number(item.transform?.[3]) || 0);
    if (cur && Number.isFinite(y) && Number.isFinite(cur.y) && cur.text.trim() && Math.abs(y - cur.y) > Math.max(h, cur.h, 1) * 0.5) flush();
    if (!cur) cur = { text: "", y, h };
    cur.text += item.str;
    if (item.str.trim()) cur.h = Math.max(cur.h, h);
    if (item.hasEOL) flush();
  }
  flush();
  return lines;
}

const PAGE_NUMBER = /^(page\s*)?[-\u2013\u2014(]?\s*\d{1,4}\s*[-\u2013\u2014)]?(\s*(of|\/)\s*\d{1,4})?$/i;
// Word's PDF export draws bullets with Symbol/Wingdings glyphs in the private-use area
// (often with no space after them); the rest are ordinary bullet characters and markers.
const BULLET = /^([\uf0a7\uf0b7\uf076\uf0d8\uf0fc\uf06e\uf0a8]\s*|[\u2022\u25e6\u25aa\u25ab\u25cf\u25cb\u25a0\u25a1\u2023\u2043\u27a2\u27a4\u2713\u2714\-*\u2013\u00b7]\s+|\(?\d{1,3}[.)]\s+|\(?[a-z][.)]\s+)/i;
const NUMBERED = /^\(?\d{1,3}[.)]\s+/;
// Running headers and footers are short ("Chapter 2 · Consensus", "Draft 3"); a long
// line that repeats with different numbers is body text and must never be dropped.
const MAX_FURNITURE_CHARS = 60;

function repeatKey(text) {
  return text.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ");
}

/**
 * Drop running headers/footers (short lines with the same text, digits ignored, in the
 * top or bottom two lines of at least 3 pages and half of all pages) and bare page numbers.
 * @param {Array<Array<{text:string}>>} pages
 */
export function dropPageFurniture(pages) {
  const edgeCounts = new Map();
  for (const lines of pages) {
    const edges = new Set([...lines.slice(0, 2), ...lines.slice(-2)].filter((l) => l.text.length <= MAX_FURNITURE_CHARS).map((l) => repeatKey(l.text)));
    for (const key of edges) edgeCounts.set(key, (edgeCounts.get(key) || 0) + 1);
  }
  const threshold = Math.max(3, Math.ceil(pages.length / 2));
  const repeated = new Set([...edgeCounts].filter(([, n]) => n >= threshold).map(([k]) => k));
  return pages.map((lines) =>
    lines.filter((l, i) => {
      if (PAGE_NUMBER.test(l.text)) return false;
      const atEdge = i < 2 || i >= lines.length - 2;
      return !(atEdge && l.text.length <= MAX_FURNITURE_CHARS && repeated.has(repeatKey(l.text)));
    })
  );
}

// Body text size = the line height carrying the most characters (headings are few and short).
function bodySize(lines) {
  const chars = new Map();
  for (const l of lines) {
    if (!(l.h > 0)) continue;
    const key = Math.round(l.h * 2) / 2;
    chars.set(key, (chars.get(key) || 0) + l.text.length);
  }
  let best = 0;
  let most = -1;
  for (const [h, n] of chars) if (n > most) [best, most] = [h, n];
  return best;
}

function joinLines(a, b) {
  // "conver-" + "sation" → "conversation"; keep real dashes ("well-" + "Known" stays split).
  if (/[A-Za-z]-$/.test(a) && /^[a-z]/.test(b)) return a.slice(0, -1) + b;
  return `${a} ${b}`;
}

// Keep a paragraph from being read back as a heading/fence by the block parser.
function literal(text) {
  return text.replace(/^(#{1,3}) /, "$1\u00a0").replace(/^```/, "`` `");
}

/**
 * Rebuild blocks (headings, paragraphs, lists) from per-page lines.
 * @param {Array<Array<{text:string, y:number, h:number}>>} pages
 * @returns {Array<object>} article blocks
 */
export function linesToBlocks(pages) {
  const body = bodySize(pages.flat()) || 12;
  const blocks = [];
  let para = null; // {lines: string[], list: boolean}
  let prev = null;

  const flush = () => {
    if (!para) return;
    if (para.list) {
      const items = [];
      for (const line of para.lines) {
        if (BULLET.test(line)) items.push(line.replace(BULLET, ""));
        else if (items.length) items[items.length - 1] = joinLines(items[items.length - 1], line);
        else items.push(line);
      }
      blocks.push({ type: "list", ordered: NUMBERED.test(para.lines[0]), items: items.map(tidy).filter(Boolean) });
    } else {
      const text = tidy(para.lines.reduce((acc, l) => (acc ? joinLines(acc, l) : l), ""));
      if (text) blocks.push({ type: "paragraph", text: literal(text) });
    }
    para = null;
  };

  pages.forEach((lines, pageIndex) => {
    lines.forEach((line) => {
      const isHeading = line.h >= body * 1.25 && line.text.length <= 150 && !PAGE_NUMBER.test(line.text);
      if (isHeading) {
        flush();
        const level = line.h >= body * 1.6 ? 1 : 2;
        const last = blocks.at(-1);
        // A title wrapped over two lines is still one heading.
        if (last?.type === "heading" && last.level === level && prev?.heading && prev.page === pageIndex && Math.abs(prev.y - line.y) <= line.h * 1.6) {
          last.text = `${last.text} ${line.text}`;
        } else {
          blocks.push({ type: "heading", level, text: line.text });
        }
        prev = { ...line, heading: true, page: pageIndex };
        return;
      }

      const bullet = BULLET.test(line.text);
      let newParagraph = !para;
      if (para && prev) {
        if (prev.page !== pageIndex) {
          // Keep a sentence that runs over a page break together.
          const last = para.lines.at(-1);
          newParagraph = /[.!?:;"”’)\]]$/.test(last) || !/^[a-z]/.test(line.text);
        } else {
          const gap = prev.y - line.y;
          newParagraph = gap < 0 || gap > Math.max(prev.h, line.h, body) * 1.6;
        }
        // Bullets start a list; an unbulleted line right after one is that item wrapping.
        if (bullet && !para.list) newParagraph = true;
      }
      if (newParagraph) {
        flush();
        para = { lines: [], list: bullet };
      }
      para.lines.push(line.text);
      prev = { ...line, heading: false, page: pageIndex };
    });
  });
  flush();
  return blocks;
}

// One page's text items, streamed so reading can stop early: once the article has all the
// text it can hold, at the item cap, or at the deadline (`timedOut` says which). A stream
// left early is not cancelled (pdf.js then throws an unhandled "already closed" error);
// it waits on backpressure until doc.destroy() ends it.
async function readPageItems(page, { budget, deadline, now }) {
  if (typeof page.streamTextContent !== "function") return { items: (await page.getTextContent()).items, timedOut: false };
  const reader = page.streamTextContent().getReader();
  const items = [];
  let chars = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { items, timedOut: false };
    for (const item of value.items) {
      items.push(item);
      chars += typeof item.str === "string" ? item.str.length : 0;
    }
    if (chars > budget || items.length > MAX_PDF_PAGE_ITEMS) return { items, timedOut: false };
    if (now() > deadline) return { items, timedOut: true };
  }
}

async function extractPdf(bytes, { deadline, now }) {
  const { getDocumentProxy } = await import("unpdf");
  let doc;
  try {
    // Copy: pdf.js may detach the buffer it is given.
    doc = await getDocumentProxy(new Uint8Array(bytes), { isEvalSupported: false, disableFontFace: true, stopAtErrors: false });
  } catch (err) {
    if (err?.name === "PasswordException") {
      throw new DocumentImportError("file_unreadable", "This PDF is password-protected. Open it, save or print a copy without a password, and upload that.", "pdf_password");
    }
    throw new DocumentImportError("file_unreadable", "We couldn't open this PDF. It may be damaged. Try saving or exporting it again.", `pdf_open: ${err?.message || err}`.slice(0, 200));
  }
  try {
    const pageCount = Math.min(doc.numPages, MAX_PDF_PAGES);
    const pages = [];
    let chars = 0;
    for (let n = 1; n <= pageCount && chars <= PDF_TEXT_BUDGET; n++) {
      if (now() > deadline) {
        if (pages.length === 0) throw new DocumentImportError("file_unreadable", "This PDF took too long to read. Try a smaller file, or paste the text instead.", "pdf_deadline");
        break; // keep what was read; a very long PDF gets its first part
      }
      const page = await doc.getPage(n);
      const { items, timedOut } = await readPageItems(page, { budget: PDF_TEXT_BUDGET - chars, deadline, now });
      const lines = itemsToLines(items);
      pages.push(lines);
      chars += lines.reduce((sum, l) => sum + l.text.length + 1, 0);
      page.cleanup();
      if (timedOut) break;
    }
    let title = "";
    try {
      const meta = await doc.getMetadata();
      title = tidy(meta?.info?.Title);
    } catch {
      // metadata is optional
    }
    // Generator junk ("Microsoft Word - draft3.docx", "untitled") is no title.
    if (/^(untitled|microsoft word|document\d*$)|\.(docx?|pdf)$/i.test(title)) title = "";
    const blocks = linesToBlocks(dropPageFurniture(pages));
    // No usable metadata title: a heading at the very start is the document's title.
    if (!title && blocks[0]?.type === "heading") title = blocks[0].text;
    return { title, text: serializeArticleBlocks(blocks) };
  } catch (err) {
    if (err instanceof DocumentImportError) throw err;
    throw new DocumentImportError("file_unreadable", "We couldn't read the text in this PDF. Try exporting it again, or paste the text instead.", `pdf_read: ${err?.message || err}`.slice(0, 200));
  } finally {
    doc.destroy?.().catch?.(() => {});
  }
}

/**
 * Parse a document already identified (and, for a zip, size-checked) by document-import.js.
 * Only call this inside the parse worker: it has no memory bound of its own.
 * @param {Uint8Array} bytes
 * @param {"pdf"|"zip"} kind
 * @param {{deadlineMs: number, now?: () => number}} options PDFs keep the pages read before the deadline
 * @returns {Promise<{title: string, text: string}>}
 * @throws {DocumentImportError}
 */
export async function parseDocument(bytes, kind, { deadlineMs, now = Date.now }) {
  if (kind === "pdf") return extractPdf(bytes, { deadline: now() + deadlineMs, now });
  return extractDocx(bytes);
}
