/**
 * How AI explanation text is laid out (pure; rendered by reader/ExplanationText.js).
 */

const BULLET = /^([-•*])\s+/;
const NUMBERED = /^(\d{1,3})[.)]\s+/;

/**
 * Split AI text into paragraphs and lists. A blank line ends a paragraph. Inside a block,
 * "1." / "1)" lines start numbered items and "- " / "• " lines start bullets; a plain line
 * right after an item continues it, and plain lines before any item are a paragraph
 * ("Related ideas:\n1. …\n2. …"). The prompts put a blank line between numbered items,
 * so lists separated only by blank lines are joined (numbering kept from the first item).
 * @param {string} text
 * @returns {Array<{type:"p", text:string} | {type:"ul", items:string[]} | {type:"ol", start:number, items:string[]}>}
 */
export function explanationBlocks(text) {
  const out = [];
  const blocks = String(text || "")
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  for (const block of blocks) {
    let para = [];
    let inList = false; // the last thing in `out` is a list started (or continued) in this block
    const flushPara = () => {
      if (para.length) out.push({ type: "p", text: para.join(" ") });
      para = [];
    };
    for (const line of block.split("\n").map((l) => l.trim()).filter(Boolean)) {
      const numbered = NUMBERED.exec(line);
      const type = numbered ? "ol" : BULLET.test(line) ? "ul" : null;
      if (type) {
        flushPara();
        const item = line.replace(type === "ol" ? NUMBERED : BULLET, "");
        const last = out[out.length - 1];
        if (last?.type === type) last.items.push(item);
        else out.push(type === "ol" ? { type, start: Number(numbered[1]), items: [item] } : { type, items: [item] });
        inList = true;
      } else if (inList) {
        const items = out[out.length - 1].items;
        items[items.length - 1] += ` ${line}`;
      } else {
        para.push(line);
      }
    }
    flushPara();
  }
  return out;
}
