import { describe, it, expect } from "vitest";
import { markdownToArticle, inlineToText } from "@/lib/markdown.js";
import { parseArticleBlocks } from "@/lib/article-blocks.js";

const blocksOf = (md) => parseArticleBlocks(markdownToArticle(md).text);

describe("inline Markdown becomes plain text", () => {
  it.each([
    ["**bold** and __bold__", "bold and bold"],
    ["*italic* and _italic_", "italic and italic"],
    ["~~gone~~ text", "gone text"],
    ["use `npm test` here", "use npm test here"],
    ["``a `tick` inside``", "a `tick` inside"],
    ["[the paper](https://raft.github.io \"Raft\")", "the paper"],
    ["[Wiki](https://en.wikipedia.org/wiki/Raft_(algorithm))", "Wiki"],
    ["![a diagram](d.png) ![](x.png)", "a diagram"],
    ["[ref link][1]", "ref link"],
    ["see <https://example.com>", "see https://example.com"],
    ["note[^1] here", "note here"],
    ["<b>html</b> &amp; entities", "html & entities"],
    ["snake_case_name and 2*3*4", "snake_case_name and 2*3*4"],
    ["\\*not italic\\*", "*not italic*"],
  ])("%s", (md, text) => {
    expect(inlineToText(md)).toBe(text);
  });
});

describe("markdownToArticle", () => {
  it("keeps headings, lists and code; title from the first top-level heading", () => {
    const r = markdownToArticle("# Raft\n\nIntro **text**.\n\n## Roles\n\n- Leader\n- Follower\n\n1. Elect\n2. Replicate\n\n```go\nfunc main() {\n\n}\n```\n");
    expect(r.title).toBe("Raft");
    expect(parseArticleBlocks(r.text)).toEqual([
      { type: "heading", level: 1, text: "Raft" },
      { type: "paragraph", text: "Intro text." },
      { type: "heading", level: 2, text: "Roles" },
      { type: "list", ordered: false, items: ["Leader", "Follower"] },
      { type: "list", ordered: true, items: ["Elect", "Replicate"] },
      { type: "code", lang: "go", text: "func main() {\n\n}" },
    ]);
  });

  it("front matter is removed and its title wins", () => {
    const r = markdownToArticle('---\ntitle: "Notes on *Raft*"\ntags: [a, b]\n---\n\n# Heading\n\nBody text here.');
    expect(r.title).toBe("Notes on Raft");
    expect(r.text).not.toMatch(/tags:|---/);
  });

  it("setext headings, deep headings capped at level 3, rules dropped", () => {
    expect(blocksOf("Title\n=====\n\nSub\n---\n\n#### Deep\n\n***\n\nText")).toEqual([
      { type: "heading", level: 1, text: "Title" },
      { type: "heading", level: 2, text: "Sub" },
      { type: "heading", level: 3, text: "Deep" },
      { type: "paragraph", text: "Text" },
    ]);
  });

  it("wrapped paragraphs and list items join; task lists show their state", () => {
    expect(blocksOf("Line one\nline two.\n\n- item\n  continues\n- [x] done\n- [ ] todo")).toEqual([
      { type: "paragraph", text: "Line one line two." },
      { type: "list", ordered: false, items: ["item continues", "☑ done", "☐ todo"] },
    ]);
  });

  it("tables become one readable line per row", () => {
    expect(blocksOf("| Term | Meaning |\n|---|:---:|\n| quorum | a *majority* |\n| lease | |")).toEqual([
      { type: "list", ordered: false, items: ["Term: quorum · Meaning: a majority", "Term: lease"] },
    ]);
  });

  it("block quotes read as paragraphs; indented code is kept", () => {
    expect(blocksOf("> quoted\n> more\n\n    indented code\n    line 2")).toEqual([
      { type: "paragraph", text: "quoted more" },
      { type: "code", lang: null, text: "indented code\nline 2" },
    ]);
  });

  it("HTML is stripped and never kept; scripts, styles and comments vanish entirely", () => {
    const r = markdownToArticle("<div>Hello <b>world</b></div>\n<script>alert(1)</script>\n<style>p{}</style>\n<!-- secret -->\nEnd text.");
    expect(r.text).toBe("Hello world\n\nEnd text.");
    expect(r.text).not.toMatch(/[<>]|alert|secret/);
  });

  it("reference definitions vanish; footnotes become notes", () => {
    expect(blocksOf("Text[^1] with [a][r].\n\n[r]: https://example.com\n[^1]: The note.")).toEqual([
      { type: "paragraph", text: "Text with a." },
      { type: "paragraph", text: "Note 1: The note." },
    ]);
  });

  it("text that looks like block syntax after cleaning stays a paragraph", () => {
    const blocks = blocksOf("**#** not a heading\n\n\\- not a list");
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "paragraph"]);
  });

  it("stays fast on hostile input (no regex can rescan the rest of the text)", () => {
    for (const bad of ["[a](".repeat(100000), "`x ".repeat(150000), "**a ".repeat(150000), "<!--".repeat(100000), "_x ".repeat(150000), "![a](((".repeat(60000)]) {
      const started = Date.now();
      markdownToArticle(bad);
      expect(Date.now() - started).toBeLessThan(1500);
    }
  });

  it("stays fast on one very long line of spaces (code blocks, fences, headings, tables)", () => {
    const spaces = " ".repeat(150_000);
    for (const bad of [`\n    ${spaces}a\n`, `\`\`\`\n${spaces}a\n\`\`\`\n`, `\`\`\`${spaces}\`\n`, `# a${spaces}x\n`, `a | b\n${spaces}x\n`]) {
      const started = Date.now();
      markdownToArticle(bad);
      expect(Date.now() - started).toBeLessThan(1500);
    }
  });

  it("closing hashes leave headings; a backtick in a fence's info string makes it inline code", () => {
    const blocks = blocksOf("## Title ##\n\n# C# #\n\n```a`b```\n\nafter");
    expect(blocks.slice(0, 2)).toEqual([
      { type: "heading", level: 2, text: "Title" },
      { type: "heading", level: 1, text: "C#" },
    ]);
    expect(blocks.slice(2).map((b) => b.type)).toEqual(["paragraph", "paragraph"]);
  });

  it("only the first part of a huge file is read", () => {
    const huge = "word ".repeat(200_000); // 1M chars, one paragraph
    expect(markdownToArticle(huge).text.length).toBeLessThanOrEqual(400_001);
  });
});
