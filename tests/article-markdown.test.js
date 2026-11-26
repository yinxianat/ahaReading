import { describe, it, expect } from "vitest";
import { markdownUnits, markdownPlainText, looksLikeMarkdown, safeHref, CELL_SEPARATOR } from "@/lib/article-markdown.js";

const units = (md) => markdownUnits(md);

describe("Markdown articles → reader units (original format kept)", () => {
  it("keeps bold, italics, strikethrough, inline code and links as spans over the exact rendered text", () => {
    const [u] = units("Some **bold**, *it*, ~~old~~, `a<b` and a [link](https://x.io).");
    expect(u.type).toBe("p");
    expect(u.text).toBe("Some bold, it, old, a<b and a link.");
    const at = (kind) => u.spans.filter((s) => s.kind === kind).map((s) => u.text.slice(s.start, s.end));
    expect(at("strong")).toEqual(["bold"]);
    expect(at("em")).toEqual(["it"]);
    expect(at("del")).toEqual(["old"]);
    expect(at("code")).toEqual(["a<b"]);
    expect(at("link")).toEqual(["link"]);
    expect(u.spans.find((s) => s.kind === "link").href).toBe("https://x.io/");
  });

  it("drops raw HTML and unsafe links; decodes entities", () => {
    const [u] = units('Tom &amp; Jerry <span onclick="x">hi</span> [bad](javascript:alert(1)) <script>alert(1)</script>');
    expect(u.text).not.toMatch(/<|onclick|script|javascript/);
    expect(u.text).toContain("Tom & Jerry hi bad");
    expect(u.spans.some((s) => s.kind === "link")).toBe(false);
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,x")).toBeNull();
    expect(safeHref("mailto:a@b.c")).toBe("mailto:a@b.c");
  });

  it("headings, nested lists with depth, task lists, quotes, code and images", () => {
    const list = units("# Title\n\n- a **b**\n  - nested\n- [x] done\n\n> quoted *q*\n\n```js\nconst a = 1;\n```\n\n![diagram](https://i.png)");
    expect(list.map((u) => [u.type, u.text])).toEqual([
      ["h", "Title"],
      ["li", "a b"],
      ["li", "nested"],
      ["li", "☑ done"],
      ["quote", "quoted q"],
      ["code", "const a = 1;"],
      ["p", "Image: diagram"],
    ]);
    expect(list[2].depth).toBe(1);
    expect(list[5].lang).toBe("js");
    expect(list[6].spans[0]).toMatchObject({ kind: "image", href: "https://i.png/" });
  });

  it("tables become one unit per row with cell boundaries and a readable separator", () => {
    const rows = units("| Term | Meaning |\n|---|:-:|\n| quorum | a **majority** |").filter((u) => u.type === "row");
    expect(rows.map((r) => [r.text, r.header])).toEqual([[`Term${CELL_SEPARATOR}Meaning`, true], [`quorum${CELL_SEPARATOR}a majority`, false]]);
    const [r] = rows.slice(1);
    expect(r.cells.map(([a, b]) => r.text.slice(a, b))).toEqual(["quorum", "a majority"]);
    expect(r.align).toEqual([null, "center"]);
  });

  it("hard line breaks are a newline in the text with a br span (matches what the browser counts)", () => {
    const [u] = units("line one  \nline two");
    expect(u.text).toBe("line one\nline two");
    expect(u.spans).toEqual([{ start: 8, end: 9, kind: "br" }]);
  });

  it("plain text for excerpts and the AI has no syntax", () => {
    expect(markdownPlainText("# T\n\nA **b** [c](https://d.io).\n\n- e")).toBe("T\n\nA b c.\n\ne");
  });
});

describe("looksLikeMarkdown (pasted text)", () => {
  it.each([
    ["# Heading\n\ntext", true],
    ["```\ncode\n```", true],
    ["| a | b |\n|---|---|\n| 1 | 2 |", true],
    ["Some **bold** and a [link](https://x.io)", true],
    ["- item one\n- item two with `code`", true],
    ["Plain prose. It costs 2*3 dollars and uses snake_case_names.", false],
    ["Just one *star* here", false],
  ])("%j → %s", (text, expected) => {
    expect(looksLikeMarkdown(text)).toBe(expected);
  });
});
