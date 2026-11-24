import { describe, it, expect } from "vitest";
import { resolveBlock, KIND_LABEL } from "@/lib/client/bookmarks.js";

const blocks = ["Intro paragraph.", "Quorum reads ask several replicas.", "Anti-entropy repair runs in the background."];

describe("resolveBlock (finding a bookmark again)", () => {
  it("keeps the saved block while it still contains the quote", () => {
    expect(resolveBlock({ blockIndex: 1, quote: "several replicas" }, blocks)).toBe(1);
  });
  it("follows the quote after the article was edited (blocks moved)", () => {
    const edited = ["New first paragraph.", ...blocks];
    expect(resolveBlock({ blockIndex: 1, quote: "several  Replicas" }, edited)).toBe(2);
  });
  it("matches a long quote by its start (a selection that crossed into the next block)", () => {
    const quote = `Anti-entropy repair runs in the background. ${"and more ".repeat(20)}`;
    expect(resolveBlock({ blockIndex: 0, quote }, blocks)).toBe(2);
  });
  it("falls back to the saved index, clamped, when the quote is gone", () => {
    expect(resolveBlock({ blockIndex: 9, quote: "deleted text" }, blocks)).toBe(2);
    expect(resolveBlock({ blockIndex: 0, quote: "x" }, [])).toBe(-1);
  });
  it("has a label for every kind", () => {
    expect(Object.keys(KIND_LABEL)).toEqual(["revisit", "important"]);
  });
});
