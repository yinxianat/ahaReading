/**
 * Readable HTML → Markdown, so web pages and Word files keep their formatting (design §1).
 *
 * A small, lenient parser builds an element tree (no DOM needed, runs on the server and in the
 * parse worker), then writes Markdown: headings, paragraphs, **bold**, *italics*, ~~strike~~,
 * `code`, links, images (as ![alt](src)), nested lists, block quotes, fenced code with its
 * language, GFM tables, and rules. Text is escaped so characters that mean something in Markdown
 * show literally. Only http(s)/mailto links survive; relative ones resolve against `baseUrl`.
 * The caller removes scripts/navigation first and neutralises `<`/`>` inside attributes.
 * Relative imports only (the parse worker loads this file directly).
 */
import { decodeEntities } from "./entities.js";

const VOID = new Set(["br", "img", "hr", "input", "meta", "link", "source", "wbr", "area", "col", "embed", "param", "track"]);
const BLOCK = new Set([
  "p", "div", "section", "article", "main", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "hr", "dl", "dt", "dd", "figcaption", "caption", "address", "center", "details", "summary",
]);
const HEADING = /^h([1-6])$/;
// Deeper nesting is flattened, so hostile pages can't blow the stack or go quadratic.
const MAX_DEPTH = 48;

function attr(attrs, name) {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(attrs || "");
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? "") : "";
}

/** Lenient HTML → element tree. Unknown closing tags are ignored; unclosed ones close at the end. */
export function parseHtml(html) {
  const root = { tag: "root", attrs: "", children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const closeTo = (tags) => {
    for (let i = stack.length - 1; i > 0; i--) {
      if (tags.includes(stack[i].tag)) {
        stack.length = i;
        return true;
      }
      if (["ul", "ol", "table", "blockquote"].includes(stack[i].tag)) return false;
    }
    return false;
  };
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>|([^<]+)|</g;
  let m;
  while ((m = re.exec(html))) {
    if (m[4] !== undefined) {
      top().children.push({ text: m[4] });
      continue;
    }
    if (!m[2]) {
      if (m[0] === "<") top().children.push({ text: "<" });
      continue;
    }
    const tag = m[2].toLowerCase();
    if (m[1]) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    // Implied closes: a new paragraph/item/row/cell ends the previous one.
    if (tag === "li") closeTo(["li"]);
    else if (tag === "tr") closeTo(["tr"]);
    else if (tag === "td" || tag === "th") closeTo(["td", "th"]);
    else if (tag === "dt" || tag === "dd") closeTo(["dt", "dd"]);
    if (BLOCK.has(tag) && top().tag === "p") stack.pop();
    const node = { tag, attrs: m[3] || "", children: [] };
    top().children.push(node);
    if (!VOID.has(tag) && !/\/\s*$/.test(m[3] || "") && stack.length < MAX_DEPTH) stack.push(node);
  }
  return root;
}

function resolveHref(href, baseUrl) {
  if (!href) return null;
  try {
    const url = baseUrl ? new URL(href, baseUrl) : new URL(href);
    if (!["http:", "https:", "mailto:"].includes(url.protocol)) return null;
    return url.href.replace(/[()\s<>]/g, (c) => encodeURIComponent(c));
  } catch {
    return null;
  }
}

/** Text that shows literally in Markdown. */
function escapeText(s) {
  return s.replace(/([\\`*_[\]<>|~#])/g, "\\$1");
}

function wrap(marker, inner) {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
  return m[2] ? `${m[1]}${marker}${m[2]}${marker}${m[3]}` : inner;
}

function textOf(node) {
  if (node.text !== undefined) return decodeEntities(node.text);
  if (node.tag === "br") return "\n";
  return (node.children || []).map(textOf).join("");
}

function inline(nodes, ctx) {
  let out = "";
  for (const n of nodes) {
    if (n.text !== undefined) {
      out += escapeText(decodeEntities(n.text).replace(/\s+/g, " "));
      continue;
    }
    const kids = () => inline(n.children, ctx);
    switch (n.tag) {
      case "strong":
      case "b":
        out += wrap("**", kids());
        break;
      case "em":
      case "i":
        out += wrap("*", kids());
        break;
      case "del":
      case "s":
      case "strike":
        out += wrap("~~", kids());
        break;
      case "code":
      case "kbd":
      case "samp":
      case "tt": {
        const code = textOf(n).replace(/\s+/g, " ").trim();
        if (!code) break;
        const ticks = "`".repeat(Math.max(...[0, ...(code.match(/`+/g) || []).map((t) => t.length)]) + 1);
        const pad = code.startsWith("`") || code.endsWith("`") ? " " : "";
        out += `${ticks}${pad}${code}${pad}${ticks}`;
        break;
      }
      case "a": {
        const inner = kids();
        const href = resolveHref(attr(n.attrs, "href"), ctx.baseUrl);
        out += href && inner.trim() ? `[${inner.trim()}](${href})` : inner;
        break;
      }
      case "img": {
        const alt = escapeText(attr(n.attrs, "alt").replace(/\s+/g, " ").trim());
        const src = resolveHref(attr(n.attrs, "src"), ctx.baseUrl);
        if (src && alt) out += `![${alt}](${src})`;
        else if (alt) out += alt;
        break;
      }
      case "br":
        out += ctx.inTable ? " " : "  \n";
        break;
      default:
        if (BLOCK.has(n.tag)) out += ` ${kids()} `;
        else out += kids();
    }
  }
  return out;
}

// A paragraph line that would read as a list item or numbered item is escaped.
function guardLines(text) {
  return text
    .split("\n")
    .map((l) => l.replace(/^(\s*)([-+])(\s)/, "$1\\$2$3").replace(/^(\s*)(\d{1,9})([.)])(\s)/, "$1$2\\$3$4"))
    .join("\n");
}

function paragraph(nodes, ctx) {
  const text = inline(nodes, ctx)
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "  \n")
    .trim();
  return text ? guardLines(text) : "";
}

/** Children → Markdown blocks; runs of inline content become paragraphs. */
function flow(children, ctx) {
  const blocks = [];
  let run = [];
  const flush = () => {
    const p = paragraph(run, ctx);
    if (p) blocks.push(p);
    run = [];
  };
  for (const n of children) {
    if (n.text !== undefined || !BLOCK.has(n.tag)) {
      run.push(n);
      continue;
    }
    flush();
    const b = blockOf(n, ctx);
    if (b) blocks.push(b);
  }
  flush();
  return blocks;
}

function list(node, ctx) {
  const ordered = node.tag === "ol";
  let number = Number.parseInt(attr(node.attrs, "start"), 10) || 1;
  const items = [];
  for (const li of node.children) {
    if (li.text !== undefined && !li.text.trim()) continue;
    const kids = li.tag === "li" ? li.children : [li];
    const marker = ordered ? `${number++}. ` : "- ";
    const indent = " ".repeat(marker.length);
    const parts = flow(kids, ctx);
    if (!parts.length) continue;
    const [first, ...rest] = parts;
    let item = marker + first.replace(/\n/g, `\n${indent}`);
    for (const part of rest) {
      const nested = /^(\s*)([-*+]|\d+\.) /.test(part);
      item += (nested ? "\n" : "\n\n") + part.replace(/^/gm, indent);
    }
    items.push(item);
  }
  return items.join("\n");
}

function table(node, ctx) {
  const rows = [];
  const collect = (n) => {
    for (const c of n.children || []) {
      if (c.tag === "tr") rows.push(c);
      else if (["thead", "tbody", "tfoot"].includes(c.tag)) collect(c);
    }
  };
  collect(node);
  const cells = rows
    .map((tr) => tr.children.filter((c) => c.tag === "td" || c.tag === "th").map((c) => inline(c.children, { ...ctx, inTable: true }).replace(/\s+/g, " ").trim().replace(/(?<!\\)\|/g, "\\|")))
    .filter((r) => r.some(Boolean));
  if (!cells.length) return "";
  const width = Math.max(...cells.map((r) => r.length));
  const line = (r) => `| ${Array.from({ length: width }, (_, i) => r[i] || " ").join(" | ")} |`;
  return [line(cells[0]), `| ${Array(width).fill("---").join(" | ")} |`, ...cells.slice(1).map(line)].join("\n");
}

function blockOf(node, ctx) {
  const heading = HEADING.exec(node.tag);
  if (heading) {
    const text = paragraph(node.children, ctx).replace(/ {2}\n/g, " ");
    return text ? `${"#".repeat(Math.min(Number(heading[1]), 3))} ${text}` : "";
  }
  switch (node.tag) {
    case "ul":
    case "ol":
      return list(node, ctx);
    case "li":
      return list({ tag: "ul", attrs: "", children: [node] }, ctx);
    case "blockquote": {
      const inner = flow(node.children, ctx).join("\n\n");
      return inner ? inner.replace(/^/gm, "> ").replace(/^> $/gm, ">") : "";
    }
    case "pre": {
      const code = textOf(node).replace(/^\n+|\s+$/g, "");
      if (!code.trim()) return "";
      const codeEl = node.children.find((c) => c.tag === "code");
      const cls = `${attr(node.attrs, "class")} ${codeEl ? attr(codeEl.attrs, "class") : ""}`;
      const lang = (/\b(?:language|lang)-([A-Za-z0-9_+#.-]{1,20})/.exec(cls) || [])[1] || "";
      const fence = "`".repeat(Math.max(3, ...(code.match(/`{3,}/g) || []).map((t) => t.length + 1)));
      return `${fence}${lang}\n${code}\n${fence}`;
    }
    case "table":
      return table(node, ctx);
    case "hr":
      return "---";
    case "dt": {
      const text = paragraph(node.children, ctx);
      return text ? `**${text}**` : "";
    }
    default:
      return flow(node.children, ctx).join("\n\n");
  }
}

/**
 * @param {string} html body HTML (scripts/nav already removed)
 * @param {{baseUrl?: string}} [options] page address, for relative links and images
 * @returns {string} Markdown
 */
export function htmlToMarkdown(html, { baseUrl } = {}) {
  const tree = parseHtml(String(html || ""));
  return flow(tree.children, { baseUrl })
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
