/**
 * Article content → flat display blocks for the reader (PO-6). The format is
 * owned by src/lib/article-blocks.js (shared with the server's extractor and
 * paste handler); this module only flattens lists so every list item is its
 * own `[data-p]` block that selection offsets can index into. Content stays
 * plain text: nothing here or in the renderer ever interprets HTML.
 */
import { parseArticleBlocks } from "@/lib/article-blocks.js";

/**
 * @typedef {object} Block
 * @property {"p"|"h"|"li"|"code"} type
 * @property {string} text what is shown and what selection offsets index into
 * @property {number} [level] heading level 1–3
 * @property {boolean} [ordered] item of a numbered list
 * @property {number} [number] position in its list (ordered lists)
 * @property {number} [list] index of the list the item belongs to (adjacent lists stay separate)
 */

/**
 * @param {string} content article content as stored
 * @returns {Block[]}
 */
export function parseArticle(content) {
  const out = [];
  parseArticleBlocks(content).forEach((b, i) => {
    if (b.type === "heading") out.push({ type: "h", text: b.text, level: b.level });
    else if (b.type === "code") {
      if (b.text) out.push({ type: "code", text: b.text });
    } else if (b.type === "list") {
      b.items.forEach((text, n) => {
        if (text) out.push({ type: "li", text, ordered: b.ordered, number: n + 1, list: i });
      });
    } else if (b.text) out.push({ type: "p", text: b.text });
  });
  return out;
}
