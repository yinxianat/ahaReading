/**
 * Article content → flat display blocks for the reader (PO-6). The format is
 * owned by src/lib/article-blocks.js (shared with the server's extractor and
 * paste handler); this module only flattens lists so every list item is its
 * own `[data-p]` block that selection offsets can index into. Content stays
 * plain text: nothing here or in the renderer ever interprets HTML.
 */
import { parseArticleBlocks } from "@/lib/article-blocks.js";
import { markdownUnits } from "@/lib/article-markdown.js";

/**
 * @typedef {object} Block
 * @property {"p"|"h"|"li"|"code"|"quote"|"row"} type ("quote" and "row" only in Markdown articles)
 * @property {Array<{start:number,end:number,kind:string,href?:string}>} [spans] formatting (Markdown articles)
 * @property {string} text what is shown and what selection offsets index into
 * @property {number} [level] heading level 1–3
 * @property {boolean} [ordered] item of a numbered list
 * @property {number} [number] position in its list (ordered lists)
 * @property {number} [list] index of the list the item belongs to (adjacent lists stay separate)
 */

/**
 * @param {string} content article content as stored
 * @param {"blocks"|"markdown"} [format] how it is stored (Article.format)
 * @returns {Block[]}
 */
export function parseArticle(content, format = "blocks") {
  if (format === "markdown") return markdownUnits(content);
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
