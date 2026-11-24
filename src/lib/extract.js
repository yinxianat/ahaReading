/**
 * Dependency-free readable-text extraction from HTML: title + structured blocks.
 * Not a full Readability port — it removes chrome (script/style/nav/header/footer/aside/
 * forms), prefers <article>/<main> when present, and keeps headings, lists and
 * <pre> code verbatim, written in the plain-text block format of article-blocks.js.
 */
import { serializeArticleBlocks, parseArticleBlocks } from "./article-blocks.js";

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ",
  mdash: "—", ndash: "–", hellip: "…", lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“", rdquo: "”", bdquo: "„",
  laquo: "«", raquo: "»", lsaquo: "‹", rsaquo: "›", middot: "·", bull: "•", deg: "°", times: "×", divide: "÷",
  copy: "©", reg: "®", trade: "™", sect: "§", para: "¶", dagger: "†", Dagger: "‡", prime: "′", Prime: "″",
  euro: "€", pound: "£", yen: "¥", cent: "¢", plusmn: "±", frac12: "½", frac14: "¼", frac34: "¾",
  larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔", le: "≤", ge: "≥", ne: "≠", asymp: "≈", minus: "−",
  iexcl: "¡", iquest: "¿", shy: "", zwj: "", zwnj: "",
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", Aacute: "Á", Eacute: "É",
  agrave: "à", egrave: "è", ograve: "ò", acirc: "â", ecirc: "ê", ocirc: "ô", auml: "ä", euml: "ë",
  ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß", ccedil: "ç", ntilde: "ñ", oslash: "ø", aring: "å",
};

/**
 * Decode HTML entities (named subset + all numeric forms).
 * @param {string} text
 * @returns {string}
 */
export function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      // Reject surrogates, out-of-range and NUL — they'd produce invalid strings.
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "�";
      return String.fromCodePoint(code);
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : match;
  });
}

const DROP_WITH_CONTENT = ["script", "style", "noscript", "template", "svg", "math", "iframe", "object", "canvas", "nav", "header", "footer", "aside", "form", "button", "select", "textarea", "figure", "menu", "dialog"];
const BLOCK_TAGS = "p|div|section|article|main|h[1-6]|li|ul|ol|dl|dt|dd|blockquote|pre|tr|table|br|hr|figcaption|caption";

function stripTags(html) {
  return html.replace(/<[^>]*>/g, "");
}

// Elements whose content is raw text: skipped whole, so code like `a<b ? "x" : y` inside them
// is never mistaken for a tag.
const RAW_TEXT_TAGS = new Set(["script", "style", "textarea", "noscript", "template", "xmp", "iframe", "noembed", "noframes"]);

/**
 * Blank out `<` and `>` inside quoted attribute values, e.g.
 * `<div data-json="{&#34;text&#34;:&#34;&lt;p>Hi&lt;/p>&#34;}">`. Every later step finds
 * tags with `<[^>]*>`, which would otherwise end the tag at the first `>` inside the value
 * and leak the rest of the attribute into the article text. One linear pass.
 * @param {string} html
 * @returns {string}
 */
export function neutralizeAttributeBrackets(html) {
  const lower = html.toLowerCase();
  const out = [];
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, lt));
    // "<" not followed by a tag-name start is just text ("a < b").
    if (!/[A-Za-z/!?]/.test(html[lt + 1] || "")) {
      out.push("<");
      i = lt + 1;
      continue;
    }
    let j = lt + 1;
    let quote = null;
    let lastSignificant = "";
    let changed = false;
    const tag = ["<"];
    for (; j < n; j++) {
      const c = html[j];
      if (quote) {
        if (c === quote) quote = null;
        if (c === "<" || c === ">") {
          tag.push(" ");
          changed = true;
        } else tag.push(c);
        continue;
      }
      // A quote only opens a value right after "=", so a stray apostrophe can't swallow the page.
      if ((c === '"' || c === "'") && lastSignificant === "=") quote = c;
      tag.push(c);
      if (c === ">") break;
      if (!/\s/.test(c)) lastSignificant = c;
    }
    out.push(changed ? tag.join("") : html.slice(lt, Math.min(j + 1, n)));
    if (j >= n) break;
    i = j + 1;
    const name = (/^<([A-Za-z][A-Za-z0-9-]*)/.exec(html.slice(lt, lt + 40)) || [])[1]?.toLowerCase();
    if (name && RAW_TEXT_TAGS.has(name) && html[j - 1] !== "/") {
      const close = lower.indexOf(`</${name}`, i);
      const end = close < 0 ? n : close;
      out.push(html.slice(i, end));
      i = end;
    }
  }
  return out.join("");
}

// NUL and other C0 controls (except tab/newline) never reach the database.
function stripControls(text) {
  return String(text).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function clean(text) {
  return stripControls(decodeEntities(text)).replace(/\s+/g, " ").trim();
}

// Placeholders in the Unicode private-use area survive tag stripping and whitespace
// cleaning, so structured blocks can be cut out first and put back as whole blocks.
const MARK = "\uE000";
const MARK_RE = /^\uE000([PLH])(\d+)\uE000(.*)$/s;

function firstMatch(html, re) {
  const m = re.exec(html);
  return m ? clean(stripTags(m[1])) : "";
}

function metaContent(html, prop) {
  const re = new RegExp(`<meta\\b[^>]*(?:property|name)=["']${prop}["'][^>]*>`, "i");
  const tag = (re.exec(html) || [])[0];
  if (!tag) return "";
  return clean((/content=["']([^"']*)["']/i.exec(tag) || [])[1] || "");
}

function cutBlocks(body, stash) {
  let html = body.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_, inner) => {
    const lang = (/class=["'][^"']*\b(?:language|lang)-([A-Za-z0-9_+#-]{1,20})/i.exec(inner) || [])[1] || null;
    const code = stripControls(decodeEntities(inner.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "")))
      .replace(/^\n+|\s+$/g, "");
    stash.push({ type: "code", lang, text: code });
    return `\n\n${MARK}P${stash.length - 1}${MARK}\n\n`;
  });
  // Innermost lists first, so a nested list becomes items of its own block.
  for (let pass = 0; pass < 5; pass++) {
    const before = html;
    html = html.replace(/<(ul|ol)\b[^>]*>((?:(?!<(?:ul|ol)\b)[\s\S])*?)<\/\1\s*>/gi, (_, tag, inner) => {
      // A nested list (already a placeholder) is flattened into this list after its parent item.
      const items = [];
      for (const m of inner.matchAll(/<li\b[^>]*>([\s\S]*?)(?=<li\b|$)/gi)) {
        const nested = [];
        const own = clean(stripTags(m[1].replace(/\uE000([PLH])(\d+)\uE000/g, (_, kind, n) => {
          if (kind === "L") nested.push(...stash[Number(n)].items);
          return " ";
        })));
        items.push(own, ...nested);
      }
      items.splice(0, items.length, ...items.filter((t) => /[\p{L}\p{N}]/u.test(t)));
      if (items.length === 0) return " ";
      stash.push({ type: "list", ordered: tag.toLowerCase() === "ol", items });
      return `\n\n${MARK}L${stash.length - 1}${MARK}\n\n`;
    });
    if (html === before) break;
  }
  return html.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_, level, inner) => {
    return `\n\n${MARK}H${Math.min(3, Number(level))}${MARK}${stripTags(inner)}\n\n`;
  });
}

function toBlock(paragraph, stash) {
  const m = MARK_RE.exec(paragraph);
  if (!m) return /[\p{L}\p{N}]/u.test(paragraph) && paragraph.length >= 2 ? { type: "paragraph", text: paragraph } : null;
  if (m[1] === "H") {
    const text = m[3].trim();
    return text ? { type: "heading", level: Number(m[2]), text } : null;
  }
  const block = stash[Number(m[2])];
  return block && (block.type !== "code" || block.text) ? block : null;
}

/**
 * Extract a title and readable blocks from an HTML document.
 * @param {string} html
 * @returns {{title: string, paragraphs: string[], blocks: Array<object>, text: string}}
 *   `text` is the stored content format; `paragraphs` is each block serialised.
 */
export function extractReadable(html) {
  let doc = String(html || "");
  doc = doc.replace(/<!--[\s\S]*?-->/g, " ").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, " ").replace(/\uE000/g, "");
  doc = neutralizeAttributeBrackets(doc);

  const title =
    metaContent(doc, "og:title") || firstMatch(doc, /<title\b[^>]*>([\s\S]*?)<\/title>/i) || firstMatch(doc, /<h1\b[^>]*>([\s\S]*?)<\/h1>/i);

  let body = (/<body\b[^>]*>([\s\S]*)<\/body>/i.exec(doc) || [])[1] || doc;
  body = body.replace(/<head\b[\s\S]*?<\/head>/gi, " ");
  for (const tag of DROP_WITH_CONTENT) {
    body = body.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), " ");
    body = body.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, "gi"), " ");
  }

  // Prefer the main content container when the page marks one.
  const main = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(body) || /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(body);
  if (main && stripTags(main[1]).trim().length > 200) body = main[1];

  const stash = [];
  const marked = cutBlocks(body, stash).replace(new RegExp(`<\\/?(?:${BLOCK_TAGS})\\b[^>]*>`, "gi"), "\n\n");
  const blocks = stripTags(marked)
    .split(/\n\s*\n/)
    .map(clean)
    .map((p) => toBlock(p, stash))
    .filter(Boolean);

  const paragraphs = blocks.map((b) => serializeArticleBlocks([b]));
  return { title: title.slice(0, 200), paragraphs, blocks, text: serializeArticleBlocks(blocks) };
}

/**
 * Normalize pasted plain text: blank-line paragraphs, with ``` fenced code blocks kept
 * verbatim (indentation and blank lines inside included). Control characters are removed.
 * @param {string} text
 * @returns {{paragraphs: string[], text: string}}
 */
export function normalizePlainText(text) {
  const lines = stripControls(text || "").split("\n");
  const out = [];
  let prose = [];
  const flushProse = () => {
    const joined = prose.join("\n");
    for (const p of joined.split(/\n\s*\n/)) {
      const tidy = p.replace(/[ \t\u00a0]+/g, " ").replace(/ *\n */g, "\n").trim();
      if (tidy) out.push(tidy);
    }
    prose = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s*(`{3,})([A-Za-z0-9_+.#-]{0,20})\s*$/.exec(lines[i]);
    if (!open) {
      prose.push(lines[i]);
      continue;
    }
    flushProse();
    const body = [];
    i += 1;
    while (i < lines.length && lines[i].trim() !== open[1]) body.push(lines[i++].replace(/\s+$/, ""));
    const code = body.join("\n").replace(/^\n+|\n+$/g, "");
    if (code) out.push(serializeArticleBlocks([{ type: "code", lang: open[2] || null, text: code }]));
  }
  flushProse();
  return { paragraphs: out, text: out.join("\n\n") };
}

export { parseArticleBlocks };
