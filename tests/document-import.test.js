// Parsing really runs in the worker (document-sandbox.js) here: nothing is mocked.
import { describe, it, expect } from "vitest";
import {
  extractDocument, detectKind, inspectZip, titleFromFileName, cleanFileName, DocumentImportError,
  MAX_DOCX_UNCOMPRESSED_BYTES, MAX_DOCX_DOCUMENT_XML_BYTES,
} from "@/lib/document-import.js";
import { itemsToLines, dropPageFurniture, linesToBlocks, parseDocument, tidy } from "@/lib/document-parse.js";
import { parseGateState } from "@/lib/document-sandbox.js";
import { parseArticleBlocks } from "@/lib/article-blocks.js";
import { makePdf, makeDocx, makeDenseDocx, makeFlateBombPdf, PROSE } from "./fixtures/documents.js";

const blocksOf = async (bytes, opts) => parseArticleBlocks((await extractDocument(bytes, opts)).text);

async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

describe("detectKind", () => {
  it("reads the signature, not the name", () => {
    const enc = (s) => new TextEncoder().encode(s);
    expect(detectKind(enc("%PDF-1.7\n..."))).toBe("pdf");
    expect(detectKind(enc("junk before header %PDF-1.4"))).toBe("pdf");
    expect(detectKind(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]))).toBe("zip");
    expect(detectKind(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toBe("ole");
    expect(detectKind(enc("{\\rtf1 hello"))).toBe("rtf");
    expect(detectKind(enc("<html>hello</html>"))).toBeNull();
    expect(detectKind(new Uint8Array(0))).toBeNull();
  });
});

describe("PDF extraction", () => {
  it("rebuilds headings, paragraphs and rejoins hyphenated words", async () => {
    const pdf = makePdf([[
      { text: PROSE, y: 740 },
      { text: "Caching basics", y: 710, size: 22 },
      { text: "A cache keeps a copy of data close to where it is used, so re-", y: 680 },
      { text: "peated reads are fast and cheap for everyone involved.", y: 666 },
      { text: PROSE, y: 630 },
    ]]);
    const blocks = await blocksOf(pdf, { fileName: "notes.pdf" });
    expect(blocks[0]).toEqual({ type: "paragraph", text: PROSE });
    expect(blocks[1]).toEqual({ type: "heading", level: 1, text: "Caching basics" });
    expect(blocks[2]).toEqual({
      type: "paragraph",
      text: "A cache keeps a copy of data close to where it is used, so repeated reads are fast and cheap for everyone involved.",
    });
    expect(blocks[3]).toEqual({ type: "paragraph", text: PROSE });
  });

  it("an opening heading becomes the title and isn't repeated in the text", async () => {
    const result = await extractDocument(makePdf([[{ text: "Leader election", y: 720, size: 20 }, { text: PROSE, y: 690 }]]));
    expect(result.title).toBe("Leader election");
    expect(parseArticleBlocks(result.text)).toEqual([{ type: "paragraph", text: PROSE }]);
  });

  it("drops running headers, footers and page numbers; joins a sentence split by a page break", async () => {
    const page = (n, body) => [
      { text: "Distributed Systems Notes", y: 760 },
      ...body,
      { text: `Page ${n} of 4`, y: 40 },
    ];
    const pdf = makePdf([
      page(1, [{ text: PROSE, y: 700 }, { text: "This sentence carries on over", y: 670 }]),
      page(2, [{ text: "the page break without stopping.", y: 700 }]),
      page(3, [{ text: PROSE, y: 700 }]),
      page(4, [{ text: PROSE, y: 700 }, { text: "4", y: 60 }]),
    ]);
    const { text } = await extractDocument(pdf);
    expect(text).not.toMatch(/Distributed Systems Notes|Page \d of 4/);
    expect(text).not.toMatch(/(^|\n)4(\n|$)/);
    expect(text).toContain("This sentence carries on over the page break without stopping.");
  });

  it("turns bullet lines into a list, including a wrapped item", async () => {
    const pdf = makePdf([[
      { text: PROSE, y: 720 },
      { text: "• fast reads", y: 700 },
      { text: "• fewer database trips when the", y: 686 },
      { text: "cache is warm", y: 672 },
      { text: "• simpler code", y: 658 },
    ]]);
    const blocks = await blocksOf(pdf);
    expect(blocks[1]).toEqual({ type: "list", ordered: false, items: ["fast reads", "fewer database trips when the cache is warm", "simpler code"] });
  });

  it("uses the PDF's title, but not generator junk", async () => {
    const lines = [[{ text: PROSE, y: 700 }]];
    expect((await extractDocument(makePdf(lines, { title: "Raft, Explained" }), { fileName: "x.pdf" })).title).toBe("Raft, Explained");
    expect((await extractDocument(makePdf(lines, { title: "Microsoft Word - draft3.docx" }), { fileName: "raft_notes.pdf" })).title).toBe("raft notes");
    const headed = [[{ text: "Leader election", y: 720, size: 20 }, { text: PROSE, y: 690 }]];
    expect((await extractDocument(makePdf(headed), { fileName: "x.pdf" })).title).toBe("Leader election");
  });

  it("a PDF without text (scanned pages) is unreadable, with a hint", async () => {
    const err = await rejection(extractDocument(makePdf([[]])));
    expect(err).toBeInstanceOf(DocumentImportError);
    expect(err.code).toBe("file_unreadable");
    expect(err.message).toMatch(/scanned/);
  });

  it("a password-protected PDF says so", async () => {
    const err = await rejection(extractDocument(makePdf([[{ text: PROSE, y: 700 }]], { encrypt: true })));
    expect(err.code).toBe("file_unreadable");
    expect(err.message).toMatch(/password/);
  });

  it("a damaged PDF is unreadable, never a crash", async () => {
    const err = await rejection(extractDocument(new TextEncoder().encode("%PDF-1.4\nthis is not really a pdf")));
    expect(err).toBeInstanceOf(DocumentImportError);
    expect(err.code).toBe("file_unreadable");
  });

  it("stops at the deadline but keeps the pages already read", async () => {
    const pdf = makePdf([[{ text: PROSE, y: 700 }], [{ text: "Second page text that should be skipped entirely.", y: 700 }]]);
    let calls = 0;
    // First call sets the deadline; later calls say time is up. In-process, because the
    // clock can't be faked inside the worker.
    const now = () => (calls++ < 2 ? 0 : 10 ** 12);
    const { text } = await parseDocument(pdf, "pdf", { deadlineMs: 1000, now });
    expect(text).toContain(PROSE);
    expect(text).not.toContain("Second page");
  });
});

describe("PDF layout helpers", () => {
  it("itemsToLines splits on EOL and on a baseline jump", () => {
    const lines = itemsToLines([
      { str: "Hello ", transform: [1, 0, 0, 12, 72, 700], height: 12 },
      { str: "world", transform: [1, 0, 0, 12, 110, 700], height: 12, hasEOL: true },
      { str: "Next line", transform: [1, 0, 0, 12, 72, 680], height: 12 },
      { str: "No EOL but lower", transform: [1, 0, 0, 12, 72, 660], height: 12 },
      { type: "beginMarkedContent" },
    ]);
    expect(lines.map((l) => l.text)).toEqual(["Hello world", "Next line", "No EOL but lower"]);
  });

  it("[QA4-7] dropPageFurniture keeps long numbered lines that open every page", () => {
    const pages = [1, 2, 3, 4].map((n) => [
      { text: `Paragraph ${n * 12}. In distributed systems, replicas agree on a value through a quorum.` },
      { text: "Body text in the middle of the page." },
      { text: `Draft ${n}` },
    ]);
    const kept = dropPageFurniture(pages).flat().map((l) => l.text);
    expect(kept.filter((t) => t.startsWith("Paragraph"))).toHaveLength(4);
    // A short running footer that only differs by number is still page furniture.
    expect(kept.some((t) => t.startsWith("Draft"))).toBe(false);
  });

  it("[QA4-6] bullets from Word's PDF export (Symbol-font glyphs) become a list", () => {
    const line = (text, y) => ({ text, y, h: 12 });
    const blocks = linesToBlocks([[line(PROSE, 700), line("\uf0b7 Quorum: a majority of servers", 680), line("\uf0b7Term: a numbered election period", 666), line("\u27a2 Log: the ordered commands", 652)]]);
    expect(blocks[1]).toEqual({ type: "list", ordered: false, items: ["Quorum: a majority of servers", "Term: a numbered election period", "Log: the ordered commands"] });
  });

  it("dropPageFurniture keeps a line that only repeats on a couple of pages", () => {
    const pages = [["Intro", "x"], ["Intro", "y"], ["z", "w"], ["v", "u"]].map((p) => p.map((text) => ({ text })));
    expect(dropPageFurniture(pages).flat().map((l) => l.text)).toContain("Intro");
  });

  it("a paragraph that starts with # is not read back as a heading", () => {
    const blocks = linesToBlocks([[{ text: "# not a heading, just text", y: 700, h: 12 }]]);
    const parsed = parseArticleBlocks(blocks.map((b) => b.text).join("\n\n"));
    expect(parsed[0].type).toBe("paragraph");
  });
});

describe("[QA4-4] CJK look-alike characters from PDF fonts", () => {
  it("folds Kangxi radicals, compatibility ideographs and ligatures to the normal characters", () => {
    expect(tidy("中\u2f42字符")).toBe("中文字符");
    expect(tidy("\u2f08\u2f47")).toBe("人日");
    expect(tidy("\uf900")).toBe("\u8c48");
    expect(tidy("\ufb01nal \ufb02ow")).toBe("final flow");
    expect(itemsToLines([{ str: "中\u2f42", transform: [1, 0, 0, 12, 72, 700], height: 12 }])[0].text).toBe("中文");
  });

  it("leaves everything else alone (full NFKC would rewrite these)", () => {
    expect(tidy("你好，世界。x² ½ … ①")).toBe("你好，世界。x² ½ … ①");
  });
});

describe("Word (.docx) extraction", () => {
  it("[QA4-5] Word's Title style is the title, shown once; footnotes lose the back-link arrow", async () => {
    const docx = await makeDocx([
      { title: "Replication Handbook" },
      { subtitle: "Notes for new engineers" },
      { heading: "Chapter one" },
      { p: PROSE, footnote: "Ongaro and Ousterhout, 2014." },
    ]);
    const result = await extractDocument(docx, { fileName: "handbook.docx" });
    expect(result.title).toBe("Replication Handbook");
    const blocks = parseArticleBlocks(result.text);
    expect(blocks[0]).toEqual({ type: "paragraph", text: "Notes for new engineers" });
    expect(blocks.filter((b) => b.type === "heading").map((b) => b.text)).toEqual(["Chapter one"]);
    expect(result.text).toContain("Ongaro and Ousterhout, 2014.");
    expect(result.text).not.toContain("\u2191");
  });

  it("keeps headings, paragraphs and bullets; the first heading is the title", async () => {
    const docx = await makeDocx([
      { heading: "Consensus 101" },
      { p: PROSE },
      { heading: "Why it matters", level: 2 },
      { bullet: "safety" },
      { bullet: "liveness" },
      { p: "Tags like <script>alert(1)</script> stay plain text." },
    ]);
    const result = await extractDocument(docx, { fileName: "consensus.docx" });
    expect(result.kind).toBe("docx");
    expect(result.title).toBe("Consensus 101");
    const blocks = parseArticleBlocks(result.text);
    expect(blocks).toContainEqual({ type: "paragraph", text: PROSE });
    expect(blocks).toContainEqual({ type: "heading", level: 2, text: "Why it matters" });
    expect(blocks.find((b) => b.type === "list")?.items).toEqual(["safety", "liveness"]);
    expect(result.text).toContain("<script>alert(1)</script> stay plain text.");
  });

  it("a zip that isn't a Word document is unsupported", async () => {
    const zip = await makeDocx([], { omitDocument: true, extraFiles: { "xl/workbook.xml": "<workbook/>" } });
    const err = await rejection(extractDocument(zip));
    expect(err.code).toBe("file_unsupported");
    expect(err.message).toMatch(/isn't a Word document/);
  });

  it("refuses a zip bomb from the directory alone, before decompressing", async () => {
    const docx = await makeDocx([{ p: PROSE }]);
    // Claim an enormous uncompressed size for the first central-directory entry.
    const view = new DataView(docx.buffer);
    let p = docx.length - 22;
    while (view.getUint32(p, true) !== 0x06054b50) p--;
    const dir = view.getUint32(p + 16, true);
    view.setUint32(dir + 24, MAX_DOCX_UNCOMPRESSED_BYTES + 1, true);
    expect(() => inspectZip(docx)).toThrow(DocumentImportError);
    const err = await rejection(extractDocument(docx));
    expect(err.code).toBe("file_too_large");
  });

  it("a truncated zip is unreadable", async () => {
    const docx = await makeDocx([{ p: PROSE }]);
    const err = await rejection(extractDocument(docx.slice(0, docx.length - 40)));
    expect(err.code).toBe("file_unreadable");
  });

  it("an empty document says it has no text", async () => {
    const err = await rejection(extractDocument(await makeDocx([{ p: "hi" }])));
    expect(err.code).toBe("file_unreadable");
    expect(err.message).toMatch(/no text/);
  });
});

describe("unsupported files", () => {
  it("old .doc and .rtf name the fix", async () => {
    const doc = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...new Array(100).fill(0)]);
    const err = await rejection(extractDocument(doc));
    expect(err.code).toBe("file_unsupported");
    expect(err.message).toMatch(/\.docx or PDF/);
    expect((await rejection(extractDocument(new TextEncoder().encode("{\\rtf1 hi"))))).toMatchObject({ code: "file_unsupported" });
    expect((await rejection(extractDocument(new TextEncoder().encode("plain text file"))))).toMatchObject({ code: "file_unsupported" });
  });
});

describe("file names", () => {
  it("titleFromFileName drops path and extension", () => {
    expect(titleFromFileName("C:\\Users\\me\\Raft_paper.pdf")).toBe("Raft paper");
    expect(titleFromFileName("notes.DOCX")).toBe("notes");
    expect(titleFromFileName("")).toBe("Uploaded document");
  });

  it("cleanFileName decodes, strips paths/controls, caps length", () => {
    expect(cleanFileName(encodeURIComponent("../../etc/Raft 论文.pdf"))).toBe("Raft 论文.pdf");
    expect(cleanFileName(encodeURIComponent("a\u0000b\nc.pdf"))).toBe("abc.pdf");
    expect(cleanFileName("%E0%A4%A")).toBe("");
    expect(cleanFileName(null)).toBe("");
    expect(cleanFileName(encodeURIComponent(`${"x".repeat(300)}.pdf`)).length).toBe(200);
  });

  it("[QA4-11] cleanFileName drops bidi overrides and never splits an emoji", () => {
    // U+202E would make "\u202Efdp.exe" display as "exe.pdf".
    expect(cleanFileName(encodeURIComponent("\u202efdp.exe"))).toBe("fdp.exe");
    expect(cleanFileName(encodeURIComponent("a\u200bb\u2066c\ufeff.pdf"))).toBe("abc.pdf");
    const name = cleanFileName(encodeURIComponent(`${"x".repeat(199)}\u{1f4c4}\u{1f4c4}.pdf`));
    expect(Array.from(name)).toHaveLength(200);
    expect(name.endsWith("\u{1f4c4}")).toBe(true);
  });
});

describe("[QA4-1, QA4-2] hostile documents are contained by the parse worker", () => {
  // Event-loop lag on this thread while a parse runs: the parse is elsewhere, so it stays tiny.
  async function measured(promise) {
    let maxLag = 0;
    let last = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      maxLag = Math.max(maxLag, now - last - 10);
      last = now;
    }, 10);
    const started = Date.now();
    try {
      return { err: await rejection(promise), ms: Date.now() - started, maxLag };
    } finally {
      clearInterval(timer);
    }
  }

  it("a DOM-dense document.xml under the byte cap is refused quickly, without touching this thread", async () => {
    // ~5 MB of tiny paragraphs: 16 KB on the wire; over 1 GB of RSS when it was parsed in-process.
    const docx = await makeDenseDocx(5 * 1024 * 1024);
    expect(docx.length).toBeLessThan(64 * 1024);
    const { err, ms, maxLag } = await measured(extractDocument(docx));
    expect(err).toBeInstanceOf(DocumentImportError);
    expect(err).toMatchObject({ code: "file_too_large", detail: "worker_heap" });
    expect(err.message).toMatch(/paste the part you want to read/);
    expect(ms).toBeLessThan(10_000);
    expect(maxLag).toBeLessThan(500);
    expect(parseGateState()).toEqual({ active: 0, waiting: 0 });
  });

  it("a bigger one is refused from the zip directory alone, before any parsing", async () => {
    const docx = await makeDenseDocx(MAX_DOCX_DOCUMENT_XML_BYTES + 1024);
    const started = Date.now();
    expect(() => inspectZip(docx)).toThrow(DocumentImportError);
    const err = await rejection(extractDocument(docx));
    expect(err).toMatchObject({ code: "file_too_large", detail: "docx_xml_too_large" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("a Flate-bomb PDF is stopped at the worker's memory cap", async () => {
    // 400 KB on the wire, 400 MB once decoded (it used to be decoded in full on this thread).
    const pdf = await makeFlateBombPdf(400);
    expect(pdf.length).toBeLessThan(1024 * 1024);
    const rssBefore = process.memoryUsage.rss();
    let peakRss = rssBefore;
    const sampler = setInterval(() => (peakRss = Math.max(peakRss, process.memoryUsage.rss())), 10);
    const { err, maxLag } = await measured(extractDocument(pdf)).finally(() => clearInterval(sampler));
    expect(err).toMatchObject({ code: "file_too_large", detail: "worker_external_memory" });
    expect(maxLag).toBeLessThan(500);
    // Worker heap + its capped external memory + slack; far below the 400 MB decode.
    expect(peakRss - rssBefore).toBeLessThan(350 * 1024 * 1024);
  });

  it("the cap counts per worker: a smaller limit stops a smaller bomb", async () => {
    const pdf = await makeFlateBombPdf(64);
    const err = await rejection(extractDocument(pdf, { sandbox: { maxExternalBytes: 16 * 1024 * 1024 } }));
    expect(err).toMatchObject({ code: "file_too_large", detail: "worker_external_memory" });
  });

  it("a normal document still parses after a worker was killed", async () => {
    const { title } = await extractDocument(makePdf([[{ text: "After the storm", y: 720, size: 22 }, { text: PROSE, y: 690 }]]));
    expect(title).toBe("After the storm");
  });
});
