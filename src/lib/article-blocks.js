/**
 * Article content format (PO-6), shared by the server (which writes it) and the reader
 * (which renders it). Pure, no imports, client-safe. Always plain text: the reader
 * renders every block as React text nodes, never HTML.
 *
 * Content is blocks separated by blank lines:
 *   # Heading / ## Heading / ### Heading   → {type:"heading", level:1..3, text}
 *   lines all starting "- " or "1. "        → {type:"list", ordered, items:[text]}
 *   ```lang … ```  (3+ backticks; the closing line repeats the opening run;
 *                   blank lines inside are kept)  → {type:"code", lang|null, text}
 *   anything else                           → {type:"paragraph", text} (single newlines
 *                                             inside a paragraph read as spaces)
 * Content saved before this format existed is all paragraphs, so it parses unchanged.
 */

const FENCE_OPEN = /^(`{3,})([A-Za-z0-9_+.#-]{0,20})\s*$/;
const HEADING = /^(#{1,3}) +(\S.*)$/;
const UNORDERED_ITEM = /^[-*•] +(.*)$/;
const ORDERED_ITEM = /^\d{1,3}[.)] +(.*)$/;

/**
 * @typedef {{type:"paragraph", text:string} | {type:"heading", level:1|2|3, text:string}
 *   | {type:"list", ordered:boolean, items:string[]} | {type:"code", lang:string|null, text:string}} ArticleBlock
 */

function textBlock(lines) {
  if (lines.length === 1) {
    const h = HEADING.exec(lines[0].trim());
    if (h) return { type: "heading", level: h[1].length, text: h[2].trim() };
  }
  const trimmed = lines.map((l) => l.trim());
  if (trimmed.every((l) => UNORDERED_ITEM.test(l))) {
    return { type: "list", ordered: false, items: trimmed.map((l) => UNORDERED_ITEM.exec(l)[1].trim()) };
  }
  if (trimmed.length > 1 && trimmed.every((l) => ORDERED_ITEM.test(l))) {
    return { type: "list", ordered: true, items: trimmed.map((l) => ORDERED_ITEM.exec(l)[1].trim()) };
  }
  return { type: "paragraph", text: trimmed.join(" ").replace(/\s+/g, " ").trim() };
}

/**
 * Parse stored article content into blocks.
 * @param {unknown} content
 * @returns {ArticleBlock[]}
 */
export function parseArticleBlocks(content) {
  const lines = String(content ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let pending = [];
  const flush = () => {
    if (pending.length) {
      const block = textBlock(pending);
      if (block.type !== "paragraph" || block.text) blocks.push(block);
    }
    pending = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE_OPEN.exec(line.trim());
    if (fence) {
      flush();
      const close = fence[1];
      const body = [];
      i += 1;
      while (i < lines.length && lines[i].trim() !== close) body.push(lines[i++]);
      // An unterminated fence (e.g. content cut at the size cap) runs to the end.
      blocks.push({ type: "code", lang: fence[2] || null, text: body.join("\n").replace(/\s+$/, "") });
      continue;
    }
    if (line.trim() === "") flush();
    else pending.push(line);
  }
  flush();
  return blocks;
}

function fenceFor(code) {
  const longest = Math.max(0, ...(code.match(/`+/g) || []).map((run) => run.length));
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * Serialise blocks back to the stored format (inverse of parseArticleBlocks).
 * @param {ArticleBlock[]} blocks
 * @returns {string}
 */
export function serializeArticleBlocks(blocks) {
  return blocks
    .map((b) => {
      if (b.type === "heading") return `${"#".repeat(Math.min(3, Math.max(1, b.level)))} ${b.text}`;
      if (b.type === "list") return b.items.map((item, i) => (b.ordered ? `${i + 1}. ${item}` : `- ${item}`)).join("\n");
      if (b.type === "code") {
        const fence = fenceFor(b.text);
        return `${fence}${b.lang || ""}\n${b.text}\n${fence}`;
      }
      return b.text;
    })
    .filter((s) => s.length > 0)
    .join("\n\n");
}

/**
 * Readable plain text of the content (no markers), e.g. for excerpts.
 * @param {unknown} content
 * @returns {string}
 */
export function articlePlainText(content) {
  return parseArticleBlocks(content)
    .map((b) => (b.type === "list" ? b.items.join(" ") : b.text))
    .join("\n\n");
}
