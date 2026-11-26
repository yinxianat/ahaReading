import { describe, it, expect } from "vitest";
import { explanationBlocks } from "@/lib/client/explanation-blocks.js";

describe("explanationBlocks (how AI text is laid out)", () => {
  it("numbered items separated by blank lines become one list", () => {
    expect(explanationBlocks("Next topics:\n\n1. **Quorum**: a majority.\n\n2. Leases, which\ncontinue here.\n\n3) Clocks.\n\nThat's all.")).toEqual([
      { type: "p", text: "Next topics:" },
      { type: "ol", start: 1, items: ["**Quorum**: a majority.", "Leases, which continue here.", "Clocks."] },
      { type: "p", text: "That's all." },
    ]);
  });

  it("a block of numbered lines is a list; numbering can start later", () => {
    expect(explanationBlocks("2. b\n3. c")).toEqual([{ type: "ol", start: 2, items: ["b", "c"] }]);
  });

  it("an intro line and its numbered items in one block: a paragraph, then the list", () => {
    expect(explanationBlocks("Related ideas:\n1. First.\n2. Second.")).toEqual([
      { type: "p", text: "Related ideas:" },
      { type: "ol", start: 1, items: ["First.", "Second."] },
    ]);
  });

  it("bullets, paragraphs, and text that only looks numbered", () => {
    expect(explanationBlocks("- a\n- b\n\n- c\n\nIn 2024. it changed.\nSame paragraph.")).toEqual([
      { type: "ul", items: ["a", "b", "c"] },
      { type: "p", text: "In 2024. it changed. Same paragraph." },
    ]);
  });
});
