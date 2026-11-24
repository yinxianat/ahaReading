// Bookmarks and reading progress, against the test database.
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
import { GET as listBookmarks, POST as createBookmark } from "@/app/api/bookmarks/route.js";
import { PATCH as patchBookmark, DELETE as deleteBookmark } from "@/app/api/bookmarks/[id]/route.js";
import { PUT as putProgress } from "@/app/api/articles/[id]/progress/route.js";
import { GET as listArticles } from "@/app/api/articles/route.js";
import { GET as getArticle, DELETE as deleteArticle } from "@/app/api/articles/[id]/route.js";
import { MAX_BOOKMARKS_PER_ARTICLE } from "@/lib/limits.js";

const EMAIL_PREFIX = "feat-bookmarks-";
let alice;
let bob;
let article;

const asUser = (u) => (state.user = { id: u.id, email: u.email, locale: "en", helpLevel: 1 });
const json = (method, url, body) =>
  new Request(`http://localhost${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const ctx = (id) => ({ params: Promise.resolve({ id }) });
const create = (body) => createBookmark(json("POST", "/api/bookmarks", { articleId: article.id, blockIndex: 2, quote: "quorum reads", kind: "revisit", ...body }));
const list = async (query = "") => (await listBookmarks(new Request(`http://localhost/api/bookmarks${query}`))).json();

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
  alice = await prisma.user.create({ data: { email: `${EMAIL_PREFIX}alice@example.test` } });
  bob = await prisma.user.create({ data: { email: `${EMAIL_PREFIX}bob@example.test` } });
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
  await prisma.$disconnect();
});
beforeEach(async () => {
  state.limited = null;
  asUser(alice);
  await prisma.bookmark.deleteMany({ where: { userId: { in: [alice.id, bob.id] } } });
  article = await prisma.article.create({ data: { userId: alice.id, title: "Availability notes", content: "a\n\nb\n\nquorum reads ask several replicas" } });
});

describe("bookmarks", () => {
  it("create, list (newest first, with counts and article title), filter by kind and article", async () => {
    const first = await create({ note: "  check the math  " });
    expect(first.status).toBe(201);
    const a = (await first.json()).bookmark;
    expect(a).toMatchObject({ articleId: article.id, articleTitle: "Availability notes", blockIndex: 2, quote: "quorum reads", kind: "revisit", note: "check the math" });
    await create({ kind: "important", quote: "  several\n replicas  ", blockIndex: 2, note: "" });

    const all = await list();
    expect(all.bookmarks.map((b) => b.kind)).toEqual(["important", "revisit"]);
    expect(all.bookmarks[0]).toMatchObject({ quote: "several replicas", note: null });
    expect(all.counts).toEqual({ all: 2, revisit: 1, important: 1 });
    expect((await list("?kind=important")).bookmarks).toHaveLength(1);
    expect((await list(`?articleId=${article.id}`)).bookmarks).toHaveLength(2);
    expect((await listBookmarks(new Request("http://localhost/api/bookmarks?kind=bogus"))).status).toBe(400);
  });

  it("a long selection is kept as a 300-character quote", async () => {
    const res = await (await create({ quote: "word ".repeat(200) })).json();
    expect(res.bookmark.quote.length).toBe(300);
  });

  it("edit kind and note; delete", async () => {
    const { bookmark } = await (await create({})).json();
    const res = await patchBookmark(json("PATCH", `/api/bookmarks/${bookmark.id}`, { kind: "important", note: "exam topic" }), ctx(bookmark.id));
    expect((await res.json()).bookmark).toMatchObject({ kind: "important", note: "exam topic" });
    const cleared = await patchBookmark(json("PATCH", `/api/bookmarks/${bookmark.id}`, { note: "   " }), ctx(bookmark.id));
    expect((await cleared.json()).bookmark.note).toBeNull();
    expect((await patchBookmark(json("PATCH", `/api/bookmarks/${bookmark.id}`, {}), ctx(bookmark.id))).status).toBe(400);
    expect((await patchBookmark(json("PATCH", `/api/bookmarks/${bookmark.id}`, { kind: "later" }), ctx(bookmark.id))).status).toBe(400);
    expect((await deleteBookmark(json("DELETE", `/api/bookmarks/${bookmark.id}`), ctx(bookmark.id))).status).toBe(200);
    expect((await deleteBookmark(json("DELETE", `/api/bookmarks/${bookmark.id}`), ctx(bookmark.id))).status).toBe(404);
  });

  it("validates every field and names it", async () => {
    const field = async (body) => (await (await create(body)).json()).field;
    expect(await field({ articleId: undefined })).toBe("articleId");
    expect(await field({ blockIndex: -1 })).toBe("blockIndex");
    expect(await field({ blockIndex: 1.5 })).toBe("blockIndex");
    expect(await field({ quote: "   " })).toBe("quote");
    expect(await field({ kind: "favourite" })).toBe("kind");
    expect(await field({ note: "x".repeat(2001) })).toBe("note");
    expect(await field({ note: 5 })).toBe("note");
  });

  it("other users can't see, change, delete or bookmark into my articles; 401 without a session; rate limited", async () => {
    const { bookmark } = await (await create({})).json();
    asUser(bob);
    expect((await list()).bookmarks).toHaveLength(0);
    expect((await patchBookmark(json("PATCH", `/api/bookmarks/${bookmark.id}`, { note: "x" }), ctx(bookmark.id))).status).toBe(404);
    expect((await deleteBookmark(json("DELETE", `/api/bookmarks/${bookmark.id}`), ctx(bookmark.id))).status).toBe(404);
    expect((await create({})).status).toBe(404);
    state.user = null;
    expect((await listBookmarks(new Request("http://localhost/api/bookmarks"))).status).toBe(401);
    asUser(alice);
    state.limited = 9;
    expect((await create({})).status).toBe(429);
  });

  it("caps bookmarks per article", async () => {
    await prisma.bookmark.createMany({
      data: Array.from({ length: MAX_BOOKMARKS_PER_ARTICLE }, (_, i) => ({ userId: alice.id, articleId: article.id, blockIndex: 0, quote: `q${i}`, kind: "revisit" })),
    });
    const res = await create({});
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("too_many_bookmarks");
  });

  it("deleting the article deletes its bookmarks", async () => {
    await create({});
    await deleteArticle(new Request(`http://localhost/api/articles/${article.id}`, { method: "DELETE" }), ctx(article.id));
    expect(await prisma.bookmark.count({ where: { articleId: article.id } })).toBe(0);
  });
});

describe("reading progress", () => {
  const put = (id, body) => putProgress(json("PUT", `/api/articles/${id}/progress`, body), ctx(id));

  it("saves where the reader stopped; the article and Library list return it", async () => {
    expect((await put(article.id, { block: 7, percent: 41.6 })).status).toBe(204);
    const one = await (await getArticle(new Request(`http://localhost/api/articles/${article.id}`), ctx(article.id))).json();
    expect(one.article).toMatchObject({ readBlock: 7, readPercent: 42 });
    const all = await (await listArticles(new Request("http://localhost/api/articles"))).json();
    expect(all.articles.find((a) => a.id === article.id).readPercent).toBe(42);
  });

  it("validates input; owner only; rate limited", async () => {
    expect((await put(article.id, { block: -1, percent: 5 })).status).toBe(400);
    expect((await put(article.id, { block: 1, percent: 101 })).status).toBe(400);
    expect((await put(article.id, { block: 1 })).status).toBe(400);
    asUser(bob);
    expect((await put(article.id, { block: 1, percent: 5 })).status).toBe(404);
    asUser(alice);
    state.limited = 3;
    expect((await put(article.id, { block: 1, percent: 5 })).status).toBe(429);
  });
});
