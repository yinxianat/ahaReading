// POST /api/articles/upload against the test database; documents are built at runtime.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const state = vi.hoisted(() => ({ user: null, limited: null }));

vi.mock("@/lib/db.js", async () => ({ default: await (await import("./test-db.js")).createTestPrisma() }));
vi.mock("@/lib/auth.js", () => ({
  requireUser: vi.fn(async () =>
    state.user ? { user: state.user } : { response: Response.json({ error: "unauthenticated", message: "Sign in again." }, { status: 401 }) }
  ),
}));
vi.mock("@/lib/rate-limit.js", async (importOriginal) => ({
  ...(await importOriginal()),
  checkRateLimit: vi.fn(() => (state.limited ? { allowed: false, retryAfter: state.limited } : { allowed: true })),
}));
vi.mock("@/lib/logger.js", () => {
  const logger = { warn: vi.fn(async () => {}), error: vi.fn(async () => {}), critical: vi.fn(async () => {}) };
  return { logger, default: logger };
});

import prisma from "@/lib/db.js";
import { POST as upload } from "@/app/api/articles/upload/route.js";
import { GET as listArticles } from "@/app/api/articles/route.js";
import { GET as getArticle } from "@/app/api/articles/[id]/route.js";
import { MAX_UPLOAD_BYTES } from "@/lib/limits.js";
import { parseArticleBlocks } from "@/lib/article-blocks.js";
import { makePdf, makeDocx, makeDenseDocx, makeFlateBombPdf, PROSE } from "./fixtures/documents.js";
import { logger } from "@/lib/logger.js";
import { readUploadBody } from "@/lib/upload-body.js";

const EMAIL_PREFIX = "feat-upload-";
const PDF = "application/pdf";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
let alice;
let bob;

const asUser = (u) => (state.user = { id: u.id, email: u.email, locale: "en", helpLevel: 1 });
const send = (body, { type = PDF, name, headers = {} } = {}) =>
  upload(
    new Request("http://localhost/api/articles/upload", {
      method: "POST",
      headers: { ...(type ? { "content-type": type } : {}), ...(name !== undefined ? { "x-file-name": encodeURIComponent(name) } : {}), ...headers },
      body,
    })
  );
const ctx = (id) => ({ params: Promise.resolve({ id }) });
const samplePdf = () =>
  makePdf([[{ text: "Raft in one page", y: 720, size: 22 }, { text: PROSE, y: 690 }, { text: "Leaders replicate a log to followers.", y: 660 }]]);

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
  alice = await prisma.user.create({ data: { email: `${EMAIL_PREFIX}alice@example.test` } });
  bob = await prisma.user.create({ data: { email: `${EMAIL_PREFIX}bob@example.test` } });
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
});
beforeEach(() => {
  asUser(alice);
  state.limited = null;
  vi.mocked(logger.error).mockClear();
  vi.mocked(logger.warn).mockClear();
});

// A body that sends one chunk, then waits for `gate` and either ends or fails (a dropped connection).
function heldBody(first, gate) {
  let sent = false;
  return new ReadableStream({
    async pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(first);
        return;
      }
      const outcome = await gate;
      if (outcome === "fail") controller.error(new Error("aborted"));
      else controller.close();
    },
  });
}
const streamed = (stream) =>
  upload(new Request("http://localhost/api/articles/upload", { method: "POST", headers: { "content-type": PDF }, body: stream, duplex: "half" }));

describe("POST /api/articles/upload", () => {
  it("needs a session", async () => {
    state.user = null;
    expect((await send(samplePdf())).status).toBe(401);
  });

  it("a PDF becomes an article with its file name, listed in the Library", async () => {
    const res = await send(samplePdf(), { name: "raft-notes.pdf" });
    expect(res.status).toBe(201);
    const { article } = await res.json();
    expect(article).toMatchObject({ title: "Raft in one page", fileName: "raft-notes.pdf", url: null, domain: null });
    expect(parseArticleBlocks(article.content)[0]).toEqual({ type: "paragraph", text: PROSE });

    const list = await (await listArticles(new Request("http://localhost/api/articles"))).json();
    expect(list.articles.find((a) => a.id === article.id)).toMatchObject({ fileName: "raft-notes.pdf" });
    // Owner-only, like every article.
    asUser(bob);
    expect((await getArticle(new Request(`http://localhost/api/articles/${article.id}`), ctx(article.id))).status).toBe(404);
  });

  it("a Word file works too, even sent as octet-stream (browsers often don't know .docx)", async () => {
    const docx = await makeDocx([{ heading: "Vector clocks" }, { p: PROSE }]);
    const res = await send(docx, { type: "application/octet-stream", name: "clocks.docx" });
    expect(res.status).toBe(201);
    expect((await res.json()).article).toMatchObject({ title: "Vector clocks", fileName: "clocks.docx" });
  });

  it("the type comes from the bytes: a PDF named .docx is still read as a PDF", async () => {
    const res = await send(samplePdf(), { type: DOCX, name: "misnamed.docx" });
    expect(res.status).toBe(201);
  });

  it("refuses non-file content types (cross-site forms can send these without a preflight)", async () => {
    for (const type of ["text/plain", "multipart/form-data; boundary=x", "application/x-www-form-urlencoded", null]) {
      const res = await send(samplePdf(), { type });
      expect(res.status).toBe(415);
      expect((await res.json()).error).toBe("file_unsupported");
    }
  });

  it("refuses an oversized upload, whether declared or not", async () => {
    const declared = await send(samplePdf(), { headers: { "content-length": String(MAX_UPLOAD_BYTES + 1) } });
    expect(declared.status).toBe(413);
    const big = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    big.set(new TextEncoder().encode("%PDF-1.4\n"));
    const actual = await send(big);
    expect(actual.status).toBe(413);
    expect(await actual.json()).toMatchObject({ error: "file_too_large", field: "file" });
  });

  it("an empty body names the fix", async () => {
    const res = await send(new Uint8Array(0));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_input", field: "file" });
  });

  it("an old .doc is unsupported with advice; a scanned PDF is unreadable", async () => {
    const doc = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...new Array(64).fill(0)]);
    const legacy = await send(doc, { type: "application/msword", name: "old.doc" });
    expect(legacy.status).toBe(415);
    expect((await legacy.json()).message).toMatch(/\.docx or PDF/);

    const scanned = await send(makePdf([[]]), { name: "scan.pdf" });
    expect(scanned.status).toBe(422);
    expect((await scanned.json()).error).toBe("file_unreadable");
  });

  it("a hostile file name is cleaned before it is stored", async () => {
    const res = await send(samplePdf(), { name: "../../secret/\u0000evil.pdf" });
    expect((await res.json()).article.fileName).toBe("evil.pdf");
  });

  it("is rate limited", async () => {
    state.limited = 12;
    const res = await send(samplePdf());
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("12");
  });

  it("[QA4-1] a DOM-dense Word file is a 413 with a way out, and the server carries on", async () => {
    const res = await send(await makeDenseDocx(5 * 1024 * 1024), { type: DOCX, name: "dense.docx" });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: "file_too_large", field: "file", message: expect.stringMatching(/paste the part/) });
    expect(logger.error).not.toHaveBeenCalled();
    expect((await send(samplePdf(), { name: "after-dense.pdf" })).status).toBe(201);
  });

  it("[QA4-2] a Flate-bomb PDF is a 413, not gigabytes of memory", async () => {
    const res = await send(await makeFlateBombPdf(400), { name: "bomb.pdf" });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe("file_too_large");
    expect(logger.warn).toHaveBeenCalledWith("api", "Document upload rejected", { code: "file_too_large", reason: "worker_external_memory" });
  });

  it("[QA4-3] a dropped connection mid-upload is a quiet 400, never an ERROR log or alert", async () => {
    const res = await streamed(heldBody(new Uint8Array(1024).fill(65), Promise.resolve("fail")));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "upload_interrupted", field: "file" });
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith("api", "Upload body interrupted", { reason: "aborted" });
    // The per-user slot was released.
    expect((await send(samplePdf(), { name: "after-abort.pdf" })).status).toBe(201);
  });

  it("[QA4-8] a second upload while one is in flight gets its own code and sentence", async () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const first = streamed(heldBody(samplePdf(), gate));
    await new Promise((r) => setTimeout(r, 20));
    const second = await send(samplePdf(), { name: "second.pdf" });
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("5");
    expect(await second.json()).toEqual({ error: "upload_in_progress", message: "Another file is still uploading. Wait for it to finish, then try again.", retryAfter: 5 });
    release("close");
    expect((await first).status).toBe(201);
  });

  it("[QA4-9] the same file uploaded again reopens the article instead of duplicating it", async () => {
    const pdf = makePdf([[{ text: "Retry me", y: 720, size: 22 }, { text: PROSE, y: 690 }]]);
    const first = await send(pdf, { name: "retry.pdf" });
    expect(first.status).toBe(201);
    const again = await send(pdf, { name: "retry.pdf" });
    expect(again.status).toBe(200);
    expect((await again.json()).article.id).toBe((await first.json()).article.id);
    expect(await prisma.article.count({ where: { userId: alice.id, fileName: "retry.pdf" } })).toBe(1);
    // Another user's identical upload is their own article.
    asUser(bob);
    expect((await send(pdf, { name: "retry.pdf" })).status).toBe(201);
  });
});

describe("readUploadBody", () => {
  it("[QA4-3] a stalled body ends at the idle limit instead of holding the upload slot", async () => {
    const stalled = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10)); } });
    const started = Date.now();
    const result = await readUploadBody(new Request("http://x/", { method: "POST", body: stalled, duplex: "half" }), 100, { idleMs: 50 });
    expect(result).toEqual({ interrupted: "idle" });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("a trickling body ends at the overall deadline", async () => {
    const trickle = new ReadableStream({
      async pull(c) {
        await new Promise((r) => setTimeout(r, 20));
        c.enqueue(new Uint8Array(1));
      },
    });
    const result = await readUploadBody(new Request("http://x/", { method: "POST", body: trickle, duplex: "half" }), 10_000, { idleMs: 1000, deadlineMs: 150 });
    expect(result).toEqual({ interrupted: "idle" });
  });

  it("reads a normal body and stops past the cap", async () => {
    const req = (n) => new Request("http://x/", { method: "POST", body: new Uint8Array(n) });
    expect((await readUploadBody(req(50), 100)).bytes).toHaveLength(50);
    expect(await readUploadBody(req(101), 100)).toEqual({ tooLarge: true });
  });
});
