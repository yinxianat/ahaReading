// [PO-6] The stored article format: parse/serialise round trip and backward compatibility.
import { describe, it, expect } from "vitest";
import { parseArticleBlocks, serializeArticleBlocks, articlePlainText } from "@/lib/article-blocks.js";

describe("parseArticleBlocks", () => {
  it("reads legacy all-paragraph content unchanged (single newlines join)", () => {
    expect(parseArticleBlocks("First para\nwrapped\n\nSecond")).toEqual([
      { type: "paragraph", text: "First para wrapped" },
      { type: "paragraph", text: "Second" },
    ]);
  });
  it("reads headings, lists and fences", () => {
    expect(parseArticleBlocks("# Title\n\n### Sub\n\n- a\n- b\n\n1. x\n2. y\n\n```sh\nls -la\n\npwd\n```")).toEqual([
      { type: "heading", level: 1, text: "Title" },
      { type: "heading", level: 3, text: "Sub" },
      { type: "list", ordered: false, items: ["a", "b"] },
      { type: "list", ordered: true, items: ["x", "y"] },
      { type: "code", lang: "sh", text: "ls -la\n\npwd" },
    ]);
  });
  it("an unterminated fence (content cut at the cap) runs to the end", () => {
    expect(parseArticleBlocks("```\nline 1\n\nline 2")).toEqual([{ type: "code", lang: null, text: "line 1\n\nline 2" }]);
  });
  it("code containing ``` gets a longer fence and round-trips", () => {
    const blocks = [{ type: "code", lang: null, text: "echo ```\n```inner" }, { type: "paragraph", text: "after" }];
    const text = serializeArticleBlocks(blocks);
    expect(text.startsWith("````\n")).toBe(true);
    expect(parseArticleBlocks(text)).toEqual(blocks);
  });
  it("never produces HTML — markers only, plain text out", () => {
    expect(articlePlainText("## <b>x</b>\n\n- one\n- two")).toBe("<b>x</b>\n\none two");
  });
});
