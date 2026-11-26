import { describe, it, expect } from "vitest";
import { htmlToMarkdown } from "@/lib/html-to-markdown.js";
import { extractReadableMarkdown } from "@/lib/extract.js";
import { markdownUnits, CELL_SEPARATOR } from "@/lib/article-markdown.js";

const units = (html, opts) => markdownUnits(htmlToMarkdown(html, opts));
const spanText = (u, kind) => u.spans.filter((s) => s.kind === kind).map((s) => u.text.slice(s.start, s.end));

describe("web pages and Word HTML → Markdown (original format kept)", () => {
  it("keeps bold, italics, strike, code and links; relative links resolve; unsafe links drop", () => {
    const [u] = units('<p>A <strong>fact</strong> and <em>dim</em>, <s>old</s>, <code>SUM(x)</code>, <a href="/docs">guide</a>, <a href="javascript:alert(1)">bad</a>.</p>', {
      baseUrl: "https://example.com/blog/post",
    });
    expect(u.text).toBe("A fact and dim, old, SUM(x), guide, bad.");
    expect(spanText(u, "strong")).toEqual(["fact"]);
    expect(spanText(u, "em")).toEqual(["dim"]);
    expect(spanText(u, "del")).toEqual(["old"]);
    expect(spanText(u, "code")).toEqual(["SUM(x)"]);
    expect(u.spans.filter((s) => s.kind === "link").map((s) => s.href)).toEqual(["https://example.com/docs"]);
  });

  it("text that looks like Markdown or HTML reads literally", () => {
    const [a, b] = units("<p>5 * 3 and snake_case, #tag | pipe, [x](https://y.io) &lt;b&gt;hi&lt;/b&gt;</p><p>1. not a list</p>");
    expect(a.type).toBe("p");
    expect(a.text).toBe("5 * 3 and snake_case, #tag | pipe, [x](https://y.io) <b>hi</b>");
    // Only the bare URL becomes a link (GFM autolink); nothing else is formatted.
    expect(a.spans.map((s) => [s.kind, a.text.slice(s.start, s.end)])).toEqual([["link", "https://y.io"]]);
    expect([b.type, b.text]).toEqual(["p", "1. not a list"]);
  });

  it("headings, nested and numbered lists, quotes, fenced code with its language", () => {
    const html = `<h1>T</h1><h4>Deep</h4><ul><li>dims<ul><li>date</li></ul></li><li>facts</li></ul><ol start="3"><li>three</li><li>four</li></ol>
      <blockquote><p>Quote <b>bold</b></p></blockquote><pre><code class="language-sql">SELECT *
  FROM t WHERE a &lt; 3;</code></pre>`;
    const list = units(html);
    expect(list.map((u) => [u.type, u.text])).toEqual([
      ["h", "T"],
      ["h", "Deep"],
      ["li", "dims"],
      ["li", "date"],
      ["li", "facts"],
      ["li", "three"],
      ["li", "four"],
      ["quote", "Quote bold"],
      ["code", "SELECT *\n  FROM t WHERE a < 3;"],
    ]);
    expect(list[3].depth).toBe(1);
    expect(list[5]).toMatchObject({ ordered: true, number: 3 });
    expect(list[8].lang).toBe("sql");
  });

  it("tables become GFM tables (cells with pipes are escaped); images keep their description", () => {
    const rows = units("<table><tr><th>Col</th><th>Type</th></tr><tr><td>id</td><td><b>int</b> | key</td></tr></table>").filter((u) => u.type === "row");
    expect(rows.map((r) => r.text)).toEqual([`Col${CELL_SEPARATOR}Type`, `id${CELL_SEPARATOR}int | key`]);
    const [img] = units('<p><img src="/a.png" alt="Star schema"></p>', { baseUrl: "https://e.com/x" });
    expect(img.text).toBe("Image: Star schema");
    expect(img.spans[0].href).toBe("https://e.com/a.png");
  });

  it("drops scripts, navigation and attribute tricks; prefers the article", () => {
    const body = "Real article text about warehouses and star schemas. ".repeat(6);
    const page = `<html><head><title>Page</title></head><body><nav><a href="/">Home</a></nav>
      <div data-x="<p>leak</p>">x</div><article><p>${body}</p><script>alert(1)</script></article><footer>foot</footer></body></html>`;
    const { title, markdown } = extractReadableMarkdown(page, { baseUrl: "https://e.com/" });
    expect(title).toBe("Page");
    expect(markdown).not.toMatch(/Home|leak|alert|foot/);
    expect(markdownUnits(markdown)[0].text).toBe(body.trim());
  });

  it("deeply nested or huge input stays fast", () => {
    const deep = "<div><b>".repeat(20000) + "x" + "</b></div>".repeat(20000);
    const wide = "<p>a <b>b</b> <a href='https://x.io'>c</a></p>".repeat(20000);
    const t = Date.now();
    expect(htmlToMarkdown(deep)).toContain("x");
    expect(markdownUnits(htmlToMarkdown(wide)).length).toBe(20000);
    expect(Date.now() - t).toBeLessThan(5000);
  });
});
