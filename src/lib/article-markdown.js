/**
 * Markdown articles → reader units (the original reading format, design §1).
 *
 * Each unit is one selectable block (`[data-p]`): a paragraph, heading, list item, code block,
 * quoted paragraph or table row. A unit has
 *   - `text`: exactly the characters the reader renders, in order. Selection offsets, concept
 *     marks, bookmarks, reading progress and the AI all use this, so it must equal the rendered
 *     element's textContent;
 *   - `spans`: formatting runs over `text` ({start, end, kind: strong|em|del|code|link|image|br, href?}).
 * Only `marked`'s tokenizer is used; its HTML output never is. Raw HTML is dropped; links keep
 * only http(s)/mailto targets; entities are decoded; everything is rendered as text by React.
 * Pure and client-safe.
 */
import { Lexer } from "marked";
import { decodeEntities } from "./entities.js";

/** Visible separator between table cells; part of `text` (rendered visually hidden). */
export const CELL_SEPARATOR = " · ";

/**
 * @param {unknown} href
 * @returns {string|null} the URL when it's http(s) or mailto, else null
 */
export function safeHref(href) {
  if (typeof href !== "string") return null;
  const trimmed = href.trim();
  if (!/^(https?:\/\/|mailto:)/i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function clean(text) {
  // Soft line breaks read as spaces; invisible/control characters never reach the page.
  return decodeEntities(text)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁠-⁩﻿]/g, "")
    .replace(/\s*\n\s*/g, " ");
}

/** Walk inline tokens into acc = {text, spans}. */
function inline(tokens, acc) {
  for (const t of tokens || []) {
    switch (t.type) {
      case "text":
        if (t.tokens?.length) inline(t.tokens, acc);
        else acc.text += clean(t.text || "");
        break;
      case "escape":
        acc.text += t.text || "";
        break;
      case "strong":
      case "em":
      case "del": {
        const start = acc.text.length;
        inline(t.tokens, acc);
        if (acc.text.length > start) acc.spans.push({ start, end: acc.text.length, kind: t.type });
        break;
      }
      case "codespan": {
        const start = acc.text.length;
        acc.text += decodeEntities(t.text || "");
        if (acc.text.length > start) acc.spans.push({ start, end: acc.text.length, kind: "code" });
        break;
      }
      case "link": {
        const start = acc.text.length;
        inline(t.tokens, acc);
        const href = safeHref(t.href);
        if (href && acc.text.length > start) acc.spans.push({ start, end: acc.text.length, kind: "link", href });
        break;
      }
      case "image": {
        // Remote images aren't loaded (design D1): show the description, linking to the image.
        const alt = { text: "", spans: [] };
        inline(t.tokens, alt);
        const label = `Image: ${alt.text.trim() || "untitled"}`;
        const start = acc.text.length;
        acc.text += label;
        const href = safeHref(t.href);
        acc.spans.push({ start, end: acc.text.length, kind: "image", ...(href ? { href } : {}) });
        break;
      }
      case "br": {
        const start = acc.text.length;
        acc.text += "\n";
        acc.spans.push({ start, end: start + 1, kind: "br" });
        break;
      }
      case "checkbox":
        acc.text += t.checked ? "☑ " : "☐ ";
        break;
      case "html":
        break; // raw HTML is never shown
      default:
        if (t.tokens) inline(t.tokens, acc);
        else if (typeof t.text === "string") acc.text += clean(t.text);
    }
  }
  return acc;
}

function unitFrom(type, tokens, extra = {}) {
  const acc = inline(tokens, { text: "", spans: [] });
  const lead = acc.text.length - acc.text.trimStart().length;
  const text = acc.text.trim();
  if (!text) return null;
  const spans = acc.spans
    .map((s) => ({ ...s, start: s.start - lead, end: Math.min(s.end - lead, text.length) }))
    .filter((s) => s.end > s.start && s.start >= 0);
  return { type, text, spans, ...extra };
}

/**
 * Markdown → reader units.
 * @param {string} markdown
 * @returns {Array<object>} units: {type: "p"|"h"|"li"|"code"|"quote"|"row", text, spans, ...}
 */
export function markdownUnits(markdown) {
  let tokens;
  try {
    tokens = new Lexer({ gfm: true }).lex(String(markdown || ""));
  } catch {
    tokens = [{ type: "paragraph", tokens: [{ type: "text", text: String(markdown || "") }] }];
  }
  const units = [];
  let listId = 0;
  let quoteId = 0;
  let tableId = 0;

  const push = (u) => {
    if (u) units.push(u);
  };

  const list = (token, depth) => {
    const id = listId++;
    const start = Number(token.start) || 1;
    token.items.forEach((item, n) => {
      const own = [];
      const nested = [];
      for (const child of item.tokens || []) {
        if (child.type === "list") nested.push(child);
        else if (child.type === "paragraph" || child.type === "text") own.push(...(child.tokens || [{ type: "text", text: child.text }]), { type: "text", text: " " });
        else if (child.type === "checkbox") own.push(child);
        else if (child.type === "code") own.push({ type: "codespan", text: child.text }, { type: "text", text: " " });
      }
      push(unitFrom("li", own, { ordered: Boolean(token.ordered), number: start + n, list: id, depth }));
      for (const sub of nested) list(sub, depth + 1);
    });
  };

  const block = (token, quote = null) => {
    switch (token.type) {
      case "heading":
        push(unitFrom(quote === null ? "h" : "quote", token.tokens, quote === null ? { level: Math.min(Math.max(token.depth, 1), 3) } : { quote }));
        break;
      case "paragraph":
      case "text":
        push(unitFrom(quote === null ? "p" : "quote", token.tokens || [{ type: "text", text: token.text }], quote === null ? {} : { quote }));
        break;
      case "blockquote": {
        const id = quote ?? quoteId++;
        for (const child of token.tokens || []) block(child, id);
        break;
      }
      case "list":
        list(token, 0);
        break;
      case "code": {
        const text = String(token.text || "").replace(/^\n+|\s+$/g, "");
        if (text) units.push({ type: "code", text, spans: [], lang: /^[A-Za-z0-9_+.#-]{1,20}$/.test(token.lang || "") ? token.lang : null });
        break;
      }
      case "table": {
        const id = tableId++;
        const row = (cells, header) => {
          const acc = { text: "", spans: [] };
          const bounds = [];
          cells.forEach((cell, i) => {
            if (i > 0) acc.text += CELL_SEPARATOR;
            const start = acc.text.length;
            inline(cell.tokens, acc);
            bounds.push([start, acc.text.length]);
          });
          if (acc.text.replace(/[\s·]/g, "")) units.push({ type: "row", text: acc.text, spans: acc.spans, cells: bounds, header, table: id, align: token.align || [] });
        };
        row(token.header || [], true);
        for (const r of token.rows || []) row(r, false);
        break;
      }
      default:
        // space, hr, html, def: nothing to read
        break;
    }
  };

  for (const t of tokens) block(t);
  return units;
}

/**
 * Readable plain text of a Markdown article (excerpts, AI digests, search).
 * @param {string} markdown
 * @returns {string}
 */
export function markdownPlainText(markdown) {
  return markdownUnits(markdown)
    .map((u) => u.text)
    .join("\n\n");
}

/**
 * Does pasted text look like Markdown? Two or more distinct signals, or one strong one
 * (a fenced code block, a table, or a heading line).
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeMarkdown(text) {
  const s = String(text || "");
  if (/^```/m.test(s) || /^\s*\|.*\|\s*\n\s*\|?\s*:?-{3,}/m.test(s) || /^#{1,6} \S/m.test(s)) return true;
  const signals = [
    /\*\*[^*\n]+\*\*|__[^_\n]+__/, // bold
    /\[[^\]\n]+\]\((https?:|mailto:)[^)\s]+\)/, // link
    /^\s*[-*+] \S/m, // bullet list
    /^\s*\d{1,3}\. \S/m, // numbered list
    /^>\s?\S/m, // quote
    /`[^`\n]+`/, // inline code
    /(^|\s)_[^_\n]+_(\s|$)|(^|\s)\*[^*\n]+\*(\s|$)/, // italics
  ];
  return signals.filter((re) => re.test(s)).length >= 2;
}
