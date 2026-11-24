import { describe, it, expect } from "vitest";
import { extractReadable, decodeEntities, normalizePlainText } from "@/lib/extract.js";
import { parseArticleBlocks } from "@/lib/article-blocks.js";

const PAGE = `<!doctype html><html><head>
<title>Fallback &amp; Title</title>
<meta property="og:title" content="Understanding React &ndash; Reconciliation">
<style>body{color:red}</style><script>alert("x")</script>
</head><body>
<header><nav><a href="/">Home</a> <a href="/about">About</a></nav></header>
<aside>Subscribe to our newsletter!</aside>
<article>
  <h1>Understanding Reconciliation</h1>
  <p>React uses the <em>DOM reconciliation</em> algorithm to efficiently update the page &mdash; it compares trees.</p>
  <!-- a comment that should vanish -->
  <p>When state changes, React builds a new virtual tree&hellip; then &#8220;diffs&#8221; it against the old one &#x2014; quickly.</p>
  <ul><li>First item in a list that explains keys</li><li>Second item</li></ul>
  <script>var tracking = "should not appear";</script>
  <p>Caf&eacute; &lt;code&gt; &nbsp; spaced&nbsp;&nbsp;text and more words to make this article long enough.</p>
</article>
<footer>Copyright 2026</footer>
</body></html>`;

describe("extractReadable", () => {
  const out = extractReadable(PAGE);

  it("prefers og:title, decoding entities", () => {
    expect(out.title).toBe("Understanding React – Reconciliation");
  });

  it("keeps article paragraphs and list items as separate paragraphs", () => {
    expect(out.paragraphs[0]).toBe("# Understanding Reconciliation");
    expect(out.blocks[0]).toEqual({ type: "heading", level: 1, text: "Understanding Reconciliation" });
    expect(out.paragraphs).toContain("React uses the DOM reconciliation algorithm to efficiently update the page — it compares trees.");
    expect(out.paragraphs).toContain("When state changes, React builds a new virtual tree… then “diffs” it against the old one — quickly.");
    expect(out.blocks.find((b) => b.type === "list")?.items).toContain("First item in a list that explains keys");
  });

  it("drops scripts, styles, nav, aside, footer and comments", () => {
    for (const junk of ["alert", "tracking", "color:red", "Home", "Subscribe", "Copyright", "comment"]) {
      expect(out.text).not.toContain(junk);
    }
  });

  it("decodes entities and collapses whitespace", () => {
    expect(out.text).toContain("Café <code> spaced text");
  });

  it("falls back to <title> then <h1>", () => {
    expect(extractReadable("<html><head><title>Only Title</title></head><body><p>Hello there</p></body></html>").title).toBe("Only Title");
    expect(extractReadable("<body><h1>Heading <b>One</b></h1><p>Body text</p></body>").title).toBe("Heading One");
  });

  it("handles empty / garbage input", () => {
    expect(extractReadable("")).toEqual({ title: "", paragraphs: [], blocks: [], text: "" });
    expect(extractReadable(null).text).toBe("");
    expect(extractReadable("just plain words without tags").text).toBe("just plain words without tags");
  });
});

describe("decodeEntities", () => {
  it("decodes named, decimal and hex entities; leaves unknown ones", () => {
    expect(decodeEntities("&lt;&gt;&amp;&quot;&#39;&#x41;&#66;&copy;&unknown;")).toBe(`<>&"'AB©&unknown;`);
  });
  it("replaces invalid code points safely", () => {
    expect(decodeEntities("&#0;&#xD800;&#x110000;")).toBe(String.fromCharCode(0xfffd).repeat(3));
  });
});

describe("normalizePlainText", () => {
  it("splits on blank lines and trims", () => {
    expect(normalizePlainText("  Para one\r\nstill one  \r\n\r\n\r\n Para two ").paragraphs).toEqual(["Para one\nstill one", "Para two"]);
  });
});

describe("[PO-6] structure survives extraction", () => {
  const html = `<article><h2>Setup</h2><p>Install it first, then run the snippet below to check it works.</p>
    <pre><code class="language-js">function add(a, b) {
  return a + b;
}

console.log(add(1, 2)); // 3 &lt;ok&gt;</code></pre>
    <ol><li>Clone</li><li>Install <b>deps</b><ul><li>npm ci</li></ul></li></ol>
    <p>${"Plenty of body text so the article container is preferred. ".repeat(5)}</p></article>`;
  const out = extractReadable(html);

  it("keeps headings as heading blocks", () => {
    expect(out.blocks[0]).toEqual({ type: "heading", level: 2, text: "Setup" });
  });
  it("keeps <pre> code verbatim: indentation, blank lines, decoded entities, language", () => {
    const code = out.blocks.find((b) => b.type === "code");
    expect(code).toEqual({ type: "code", lang: "js", text: "function add(a, b) {\n  return a + b;\n}\n\nconsole.log(add(1, 2)); // 3 <ok>" });
  });
  it("keeps lists as one block, flattening nested items", () => {
    expect(out.blocks.find((b) => b.type === "list")).toEqual({ type: "list", ordered: true, items: ["Clone", "Install deps", "npm ci"] });
  });
  it("stored text parses back to the same blocks", () => {
    expect(parseArticleBlocks(out.text)).toEqual(out.blocks);
  });
  it("strips NUL and control characters from imported pages", () => {
    expect(extractReadable("<p>bad\u0000 byte\u0007 here</p>").text).toBe("bad byte here");
  });
});

describe("[PO-6] pasted text keeps paragraphs and fenced code", () => {
  it("keeps a fenced block verbatim, blank lines included", () => {
    const pasted = "Intro line\n\n```python\ndef f():\n\n    return 1\n```\n\nOutro";
    const { text } = normalizePlainText(pasted);
    expect(parseArticleBlocks(text)).toEqual([
      { type: "paragraph", text: "Intro line" },
      { type: "code", lang: "python", text: "def f():\n\n    return 1" },
      { type: "paragraph", text: "Outro" },
    ]);
  });
});

describe("attributes that contain markup (CMS data layers)", () => {
  it("a '>' inside a quoted attribute never leaks the attribute into the text", async () => {
    const { extractReadable } = await import("@/lib/extract.js");
    const layer = `{&#34;text-1&#34;:{&#34;xdm:text&#34;:&#34;&lt;p>Kyndryl helps with resilience, agility, innovation and business results.&lt;/p>\\r\\n&#34;}}`;
    const html = `<html><body><main>
      <div data-cmp-data-layer="${layer}" class="cmp-text-v2 kd-type--body-medium " id="text-b01845f994">
        <p>Modernization is becoming a continuous business imperative for every enterprise.</p>
      </div>
      <p title='a > b' data-x="1 > 0">Second paragraph with an attribute holding a greater-than sign.</p>
    </main></body></html>`;
    const { text } = extractReadable(html);
    expect(text).toContain("Modernization is becoming a continuous business imperative for every enterprise.");
    expect(text).toContain("Second paragraph with an attribute holding a greater-than sign.");
    expect(text).not.toMatch(/class=|id=|&#34;|<\/?p>|data-cmp|\\r\\n|kd-type/);
  });

  it("scripts with '<' and quotes stay removed; text like 'a < b' survives", async () => {
    const { extractReadable, neutralizeAttributeBrackets } = await import("@/lib/extract.js");
    const html = `<body><script>if (a<b && s === "</div><p>leak</p>") x = '>';</script>
      <p>Latency stays low when a < b and the cache is warm, which keeps reads fast.</p></body>`;
    const { text } = extractReadable(html);
    expect(text).toBe("Latency stays low when a < b and the cache is warm, which keeps reads fast.");
    // Unchanged when there's nothing to fix.
    const plain = `<p class="x">Hi</p><img alt="cat">`;
    expect(neutralizeAttributeBrackets(plain)).toBe(plain);
    // An apostrophe that isn't an attribute value doesn't swallow the document.
    expect(neutralizeAttributeBrackets(`<p it's>One</p><p>Two</p>`)).toBe(`<p it's>One</p><p>Two</p>`);
  });
});
