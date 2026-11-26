/**
 * Markdown (.md) → readable article blocks (the plain format of article-blocks.js).
 *
 * Readers see text, not syntax: headings, lists and code blocks keep their structure;
 * emphasis/code markers are dropped (`**bold**` → bold); links keep their text and lose
 * the URL; images keep their alt text; tables become one "Header: value · …" line per
 * row; front matter is removed (its `title:` becomes the title); HTML is stripped, never
 * rendered. One pass over the lines with simple, non-nested regexes, so time is linear
 * in the file size. Pure, no I/O.
 */
import { serializeArticleBlocks } from "./article-blocks.js";
import { decodeEntities } from "./extract.js";
import { MAX_ARTICLE_CHARS } from "./limits.js";

// Only this much is ever stored, so read a little more than that and no further.
const MAX_SOURCE_CHARS = MAX_ARTICLE_CHARS * 2;

// Line patterns are anchored and never put two runs that can match the same characters
// side by side (like `\s*[^`]*` or `.*?[ \t]+`): those backtrack quadratically on a long
// line of spaces, and this runs in the request process. Trailing parts are checked in code.
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([A-Za-z0-9_+.#-]{0,20})(.*)$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const LIST_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const QUOTE = /^ {0,3}>[ \t]?/;
// Tested against the trimmed line.
const TABLE_DIVIDER = /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|?$/;
const REF_DEFINITION = /^ {0,3}\[(?!\^)[^\]]+\]:[ \t]*\S/;
const FOOTNOTE_DEFINITION = /^ {0,3}\[\^([^\]]+)\]:[ \t]*(.*)$/;
// Invisible/control characters (keeps tab and newline).
const UNWANTED = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁠-⁩﻿]/g;

/**
 * Inline Markdown → plain text.
 * @param {string} text
 * @returns {string}
 */
export function inlineToText(text) {
  // \u0001/\u0002 mark protected spans below, so none may come from the source.
  let s = String(text).replace(/[\u0001\u0002]/g, "");
  // Protect escaped characters and code spans first, so their contents stay literal.
  const kept = [];
  const keep = (value) => `\u0001${kept.push(value) - 1}\u0002`;
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|~<>])/g, (_, ch) => keep(ch));
  // Every pattern below stops at the next delimiter ([^`], [^*], [^\]] …), so a line full of
  // unmatched markers can't make a regex rescan the rest of the text: work stays linear.
  s = s.replace(/``([^`]+(?:`[^`]+)*)``|`([^`]+)`/g, (_, a, b) => keep((a ?? b).trim()));
  s = s
    .replace(/!\[([^\][]*)\]\([^()[\]\s]*(?:\([^()\s]*\)[^()[\]\s]*)*(?:\s+"[^"\n]*")?\)/g, "$1") // image → its alt text
    .replace(/!\[([^\][]*)\]\[[^\][]*\]/g, "$1")
    .replace(/\[([^\][]+)\]\([^()[\]\s]*(?:\([^()\s]*\)[^()[\]\s]*)*(?:\s+"[^"\n]*")?\)/g, "$1") // [text](url "title") → text
    .replace(/\[([^\][]+)\]\[[^\][]*\]/g, "$1") // [text][ref] → text
    .replace(/\[\^[^\]]+\]/g, "") // footnote reference
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, "$1") // <https://…> → the address
    .replace(/<\/?[A-Za-z][^<>]*>/g, "") // inline HTML tags
    .replace(/\*\*([^*]+)\*\*/g, "$1") // **bold**
    .replace(/__([^_]+)__/g, "$1") // __bold__
    .replace(/(^|[^\w*])\*([^*\s][^*]*)\*(?!\w)/g, "$1$2") // *italic*
    .replace(/(^|[^\w])_([^_\s][^_]*)_(?!\w)/g, "$1$2") // _italic_ (not inside snake_case)
    .replace(/~~([^~]+)~~/g, "$1"); // strikethrough
  s = decodeEntities(s);
  s = s.replace(/\u0001(\d+)\u0002/g, (_, i) => kept[Number(i)]);
  return s.replace(UNWANTED, "").replace(/[ \t ]+/g, " ").trim();
}

/** Heading text without its optional closing `#`s ("## Title ##" → "Title"). Linear. */
function stripClosingHashes(text) {
  const t = text.trimEnd();
  let j = t.length;
  while (j > 0 && t[j - 1] === "#") j -= 1;
  if (j === t.length || (j > 0 && t[j - 1] !== " " && t[j - 1] !== "\t")) return t;
  return t.slice(0, j).trimEnd();
}

// Keep plain text from being read back as a heading/list/fence by the block parser.
function literal(text) {
  return text.replace(/^(#{1,3}) /, "$1 ").replace(/^([-*•]) /, "$1 ").replace(/^(\d{1,3}[.)]) /, "$1 ").replace(/^```/, "`` `");
}

/**
 * Remove every `open … close` span (case-insensitive); an unclosed one runs to the end.
 * indexOf scanning, so the cost is linear however many spans there are.
 */
function cutBetween(text, open, close) {
  const lower = text.toLowerCase();
  let out = "";
  let at = 0;
  for (;;) {
    const start = lower.indexOf(open, at);
    if (start < 0) return out + text.slice(at);
    out += text.slice(at, start);
    const end = lower.indexOf(close, start + open.length);
    if (end < 0) return out;
    at = end + close.length;
  }
}

function splitRow(line) {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((cell) => inlineToText(cell.replace(/\\\|/g, "|")));
}

function frontMatter(lines) {
  if (lines[0]?.trim() !== "---") return { start: 0, title: "" };
  const end = lines.slice(1, 200).findIndex((l) => /^(---|\.\.\.)\s*$/.test(l));
  if (end < 0) return { start: 0, title: "" };
  let title = "";
  for (const l of lines.slice(1, end + 1)) {
    const m = /^title:\s*(.+?)\s*$/i.exec(l);
    if (m) title = m[1].replace(/^(["'])(.*)\1$/, "$2");
  }
  return { start: end + 2, title: inlineToText(title) };
}

/**
 * Convert Markdown to the article block format.
 * @param {string} source Markdown text
 * @returns {{title: string, text: string}} `title` from front matter or the first top-level heading ("" if none)
 */
export function markdownToArticle(source) {
  let src = String(source || "").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (src.length > MAX_SOURCE_CHARS) src = src.slice(0, src.lastIndexOf("\n", MAX_SOURCE_CHARS) + 1 || MAX_SOURCE_CHARS);
  // HTML comments and embedded scripts/styles are dropped whole: their text isn't reading material.
  src = cutBetween(src, "<!--", "-->");
  src = cutBetween(src, "<script", "</script>");
  src = cutBetween(src, "<style", "</style>");
  const all = src.split("\n");
  const fm = frontMatter(all);
  const lines = all.slice(fm.start);

  const blocks = [];
  let para = [];
  let list = null; // {ordered, items: string[]}
  let lastWasBlank = true;
  let heading1 = "";

  const flushPara = () => {
    const text = inlineToText(para.join(" "));
    if (text) blocks.push({ type: "paragraph", text: literal(text) });
    para = [];
  };
  const flushList = () => {
    if (list) {
      const items = list.items.map(inlineToText).filter(Boolean);
      if (items.length) blocks.push({ type: "list", ordered: list.ordered, items });
    }
    list = null;
  };
  const flushAll = () => {
    flushPara();
    flushList();
  };
  const heading = (level, text) => {
    const clean = inlineToText(text);
    if (!clean) return;
    if (level === 1 && !heading1) heading1 = clean;
    blocks.push({ type: "heading", level: Math.min(level, 3), text: clean });
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\t/g, "    ");
    const blank = !line.trim();

    // Fenced code: verbatim until the matching fence.
    const fence = FENCE.exec(line);
    // A backtick fence's info string can't contain a backtick (that's inline code).
    if (fence && !(fence[1][0] === "`" && fence[3].includes("`"))) {
      flushAll();
      const marker = fence[1];
      const body = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`).test(lines[i])) {
        body.push(lines[i].replace(UNWANTED, ""));
        i += 1;
      }
      const code = body.join("\n").replace(/^\n+/, "").trimEnd();
      if (code) blocks.push({ type: "code", lang: fence[2] || null, text: code });
      lastWasBlank = false;
      continue;
    }

    if (blank) {
      flushPara();
      lastWasBlank = true;
      continue;
    }

    // Indented code (not inside a list or paragraph).
    if (/^ {4}/.test(line) && lastWasBlank && !list && para.length === 0) {
      const body = [];
      while (i < lines.length && (/^( {4}|\t)/.test(lines[i]) || !lines[i].trim())) {
        body.push(lines[i].replace(/^( {4}|\t)/, "").replace(UNWANTED, ""));
        i += 1;
      }
      i -= 1;
      const code = body.join("\n").trimEnd();
      if (code) blocks.push({ type: "code", lang: null, text: code });
      lastWasBlank = false;
      continue;
    }

    // Setext heading: the line under a paragraph line.
    const setext = SETEXT.exec(line);
    if (setext && para.length > 0 && !list) {
      const text = para.join(" ");
      para = [];
      heading(setext[1][0] === "=" ? 1 : 2, text);
      lastWasBlank = false;
      continue;
    }
    if (RULE.test(line)) {
      flushAll();
      lastWasBlank = true;
      continue;
    }
    const atx = ATX.exec(line);
    if (atx) {
      flushAll();
      heading(atx[1].length, stripClosingHashes(atx[2] || ""));
      lastWasBlank = false;
      continue;
    }
    if (REF_DEFINITION.test(line)) continue;
    const footnote = FOOTNOTE_DEFINITION.exec(line);
    if (footnote) {
      flushAll();
      const text = inlineToText(footnote[2]);
      if (text) blocks.push({ type: "paragraph", text: literal(`Note ${footnote[1]}: ${text}`) });
      lastWasBlank = false;
      continue;
    }

    // Table: header row followed by a |---| divider.
    if (line.includes("|") && TABLE_DIVIDER.test((lines[i + 1] || "").trim())) {
      flushAll();
      const header = splitRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        const cells = splitRow(lines[i]);
        const parts = cells.map((c, k) => (c ? (header[k] ? `${header[k]}: ${c}` : c) : "")).filter(Boolean);
        if (parts.length) rows.push(parts.join(" · "));
        i += 1;
      }
      i -= 1;
      if (rows.length) blocks.push({ type: "list", ordered: false, items: rows });
      else if (header.some(Boolean)) blocks.push({ type: "paragraph", text: literal(header.filter(Boolean).join(" · ")) });
      lastWasBlank = false;
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item && !(para.length > 0 && !list && /^\d/.test(item[2]) && item[2] !== "1." && item[2] !== "1)")) {
      flushPara();
      const ordered = /^\d/.test(item[2]);
      if (!list || (list.ordered !== ordered && item[1].length === 0)) {
        flushList();
        list = { ordered, items: [] };
      }
      // Task lists: "[ ] todo" / "[x] done".
      const text = item[3].replace(/^\[ \]\s+/, "☐ ").replace(/^\[[xX]\]\s+/, "☑ ");
      list.items.push(text);
      lastWasBlank = false;
      continue;
    }
    // A line under a list item (indented, or a lazy continuation without a blank line).
    if (list && (/^ {2,}/.test(line) || !lastWasBlank)) {
      list.items[list.items.length - 1] += ` ${line.replace(QUOTE, "").trim()}`;
      lastWasBlank = false;
      continue;
    }
    flushList();

    // Block quotes and HTML blocks read as plain paragraphs.
    let text = line;
    while (QUOTE.test(text)) text = text.replace(QUOTE, "");
    para.push(text.trim());
    lastWasBlank = false;
  }
  flushAll();

  return { title: fm.title || heading1, text: serializeArticleBlocks(blocks) };
}

/**
 * Keep an uploaded Markdown file as Markdown (design §1): drop front matter, HTML comments and
 * embedded scripts/styles, cap the length at a line boundary, and find the title. Raw HTML that
 * remains is harmless: the reader never renders it.
 * @param {string} source
 * @returns {{title: string, markdown: string}}
 */
export function prepareMarkdownSource(source) {
  let src = String(source || "").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (src.length > MAX_ARTICLE_CHARS) src = src.slice(0, src.lastIndexOf("\n", MAX_ARTICLE_CHARS) + 1 || MAX_ARTICLE_CHARS);
  src = cutBetween(src, "<!--", "-->");
  src = cutBetween(src, "<script", "</script>");
  src = cutBetween(src, "<style", "</style>");
  const lines = src.split("\n");
  const fm = frontMatter(lines);
  const markdown = lines.slice(fm.start).join("\n").replace(UNWANTED, "").trim();
  return { title: markdownToArticle(src).title, markdown };
}
