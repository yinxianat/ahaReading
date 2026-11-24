// /api/articles against the test database; the URL guard is real, only the network is faked.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const state = vi.hoisted(() => ({ user: null, limited: null, pages: {} }));

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
vi.mock("@/lib/url-guard.js", async (importOriginal) => {
  const real = await importOriginal();
  // Real guard + redirect logic; DNS answers "public" for *.example and the transport serves state.pages.
  const lookup = async (host) => [{ address: host.endsWith(".internal") ? "10.0.0.9" : "93.184.216.34", family: 4 }];
  const transport = async (url) => {
    const page = state.pages[url.href];
    if (!page) throw Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" });
    return page;
  };
  return { ...real, safeFetch: (raw, opts = {}) => real.safeFetch(raw, { lookup, transport, ...opts }) };
});

import prisma from "@/lib/db.js";
import { GET as listArticles, POST as createArticle } from "@/app/api/articles/route.js";
import { GET as getArticle, DELETE as deleteArticle, PATCH as patchArticle } from "@/app/api/articles/[id]/route.js";

const EMAIL_PREFIX = "feat-articles-";
let alice;
let bob;

const asUser = (u) => (state.user = { id: u.id, email: u.email, locale: "en", helpLevel: 1 });
const post = (body, raw) => createArticle(new Request("http://localhost/api/articles", { method: "POST", headers: { "content-type": "application/json" }, body: raw ?? JSON.stringify(body) }));
const ctx = (id) => ({ params: Promise.resolve({ id }) });
const html = (body, type = "text/html; charset=utf-8") => ({ status: 200, headers: { "content-type": type }, body: Buffer.from(body) });
const LONG = "React compares the previous and next virtual trees and applies the minimum set of DOM changes.";

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
  alice = await prisma.user.create({ data: { email: `${EMAIL_PREFIX}alice@example.test` } });
  bob = await prisma.user.create({ data: { email: `${EMAIL_PREFIX}bob@example.test` } });
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
  await prisma.$disconnect();
});
beforeEach(() => {
  state.limited = null;
  state.pages = {};
  asUser(alice);
});

describe("POST /api/articles (paste)", () => {
  it("401 / 400 malformed / 429", async () => {
    state.user = null;
    expect((await post({ text: "hi" })).status).toBe(401);
    asUser(alice);
    expect((await post(null, "{bad")).status).toBe(400);
    state.limited = 4;
    expect((await post({ text: "hi" })).status).toBe(429);
  });

  it("creates from text with an optional title (defaults to first line)", async () => {
    const res = await post({ text: "First line here\n\nSecond paragraph." });
    expect(res.status).toBe(201);
    const { article } = await res.json();
    expect(article).toMatchObject({ title: "First line here", url: null, domain: null, content: "First line here\n\nSecond paragraph." });
    const titled = await (await post({ text: "Body", title: "  My title  " })).json();
    expect(titled.article.title).toBe("My title");
  });

  it("validates text and title", async () => {
    for (const bad of [{}, { text: "" }, { text: 5 }, { text: "x", title: 5 }, { text: "x".repeat(200_001) }, { text: "x", title: "t".repeat(301) }, { text: "x", url: "https://a.example" }]) {
      const res = await post(bad);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_input");
    }
  });
});

describe("POST /api/articles (url)", () => {
  it("imports readable text and upserts by (user, url)", async () => {
    state.pages["https://blog.example/post"] = html(`<html><head><title>Post Title</title></head><body><nav>Menu</nav><p>${LONG}</p></body></html>`);
    const res = await post({ url: "https://blog.example/post#section" });
    expect(res.status).toBe(201);
    const { article } = await res.json();
    expect(article).toMatchObject({ title: "Post Title", domain: "blog.example", url: "https://blog.example/post", content: LONG });

    state.pages["https://blog.example/post"] = html(`<title>Updated</title><p>${LONG} More.</p>`);
    const again = await (await post({ url: "https://blog.example/post" })).json();
    expect(again.article.id).toBe(article.id);
    expect(again.article.title).toBe("Updated");
  });

  it("blocks private / non-http / odd-port URLs and redirects into the private network", async () => {
    for (const url of ["http://127.0.0.1/", "file:///etc/passwd", "http://blog.example:8080/", "http://169.254.169.254/latest/meta-data/", "http://db.internal/"]) {
      const res = await post({ url });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "url_blocked", field: "url" });
    }
    state.pages["https://blog.example/r"] = { status: 302, headers: { location: "http://10.0.0.1/admin" } };
    expect((await (await post({ url: "https://blog.example/r" })).json()).error).toBe("url_blocked");
  });

  it("url_unreachable and url_not_readable with fix-naming messages", async () => {
    const down = await (await post({ url: "https://down.example/" })).json();
    expect(down.error).toBe("url_unreachable");
    expect(down.message).toMatch(/paste the text/i);
    state.pages["https://files.example/a.pdf"] = html("%PDF", "application/pdf");
    expect((await (await post({ url: "https://files.example/a.pdf" })).json()).error).toBe("url_not_readable");
    state.pages["https://spa.example/"] = html("<div id=root></div><script>app()</script>");
    expect((await (await post({ url: "https://spa.example/" })).json()).error).toBe("url_not_readable");
    expect((await post({ url: 42 })).status).toBe(400);
  });
});

describe("GET/DELETE /api/articles", () => {
  it("lists only the caller's articles with excerpt and conceptCount, no content", async () => {
    const a = await (await post({ text: `${LONG}\n\n${"More text. ".repeat(50)}`, title: "Listed" })).json();
    await prisma.concept.create({ data: { userId: alice.id, articleId: a.article.id, term: "t", definition: "d" } });
    asUser(bob);
    await post({ text: "Bob's private article" });
    asUser(alice);

    const { articles } = await (await listArticles(new Request("http://localhost/api/articles"))).json();
    const listed = articles.find((x) => x.id === a.article.id);
    expect(listed).toMatchObject({ title: "Listed", conceptCount: 1 });
    expect(listed.excerpt.length).toBeLessThanOrEqual(240);
    expect(listed).not.toHaveProperty("content");
    expect(articles.some((x) => x.title === "Bob's private article")).toBe(false);
  });

  it("GET/DELETE by id are owner-only", async () => {
    asUser(bob);
    const bobArticle = (await (await post({ text: "secret" })).json()).article;
    asUser(alice);
    expect((await getArticle(new Request("http://localhost/x"), ctx(bobArticle.id))).status).toBe(404);
    expect((await deleteArticle(new Request("http://localhost/x", { method: "DELETE" }), ctx(bobArticle.id))).status).toBe(404);
    expect(await prisma.article.findUnique({ where: { id: bobArticle.id } })).toBeTruthy();

    const mine = (await (await post({ text: "mine" })).json()).article;
    const got = await (await getArticle(new Request("http://localhost/x"), ctx(mine.id))).json();
    expect(got.article.content).toBe("mine");
    expect((await deleteArticle(new Request("http://localhost/x", { method: "DELETE" }), ctx(mine.id))).status).toBe(200);
    expect((await getArticle(new Request("http://localhost/x"), ctx(mine.id))).status).toBe(404);
  });
});

describe("round-2 article input", () => {
  it("[QA-4] title cap is 200 (matches the form's maxLength)", async () => {
    expect((await post({ text: "hello", title: "t".repeat(200) })).status).toBe(201);
    const res = await post({ text: "hello", title: "t".repeat(201) });
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe("title");
  });

  it("[QA-2] NUL in text or title → 400 naming the field; other control chars are stripped", async () => {
    const text = await post(null, '{"text":"a\\u0000b"}');
    expect(text.status).toBe(400);
    expect((await text.json()).field).toBe("text");
    const title = await post(null, '{"text":"ok","title":"a\\u0000"}');
    expect((await title.json()).field).toBe("title");
    const bell = await (await post(null, '{"text":"ring\\u0007 the bell"}')).json();
    expect(bell.article.content).toBe("ring the bell");
  });

  it("[PO-6] pasted fenced code keeps its lines and blank lines; title skips markers", async () => {
    const res = await post({ text: "# Using fetch\n\nCall it like this:\n\n```js\nconst r = await fetch(url);\n\nconsole.log(r.status);\n```" });
    const { article } = await res.json();
    expect(article.title).toBe("Using fetch");
    expect(article.content).toContain("```js\nconst r = await fetch(url);\n\nconsole.log(r.status);\n```");
  });

  it("[PO-6] imported pages keep headings, lists and <pre> blocks", async () => {
    state.pages["https://docs.example/guide"] = html(
      `<html><head><title>Guide</title></head><body><article><h2>Install</h2><p>${LONG}</p><pre>npm install
npm test</pre><ul><li>one</li><li>two</li></ul></article></body></html>`
    );
    const { article } = await (await post({ url: "https://docs.example/guide" })).json();
    expect(article.content).toContain("## Install");
    expect(article.content).toContain("```\nnpm install\nnpm test\n```");
    expect(article.content).toContain("- one\n- two");
  });
});

describe("PATCH /api/articles/:id (edit)", () => {
  const patch = (id, body, raw) =>
    patchArticle(new Request(`http://localhost/api/articles/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: raw ?? JSON.stringify(body) }), ctx(id));
  const create = async (text = "Original first line\n\nOriginal body.", title) => (await (await post(title ? { text, title } : { text })).json()).article;

  it("renames and rewrites; edited text keeps paragraphs, headings and code", async () => {
    const a = await create();
    const renamed = await patch(a.id, { title: "  Better   title " });
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).article).toMatchObject({ title: "Better title", content: a.content });

    const text = "## Section\n\nNew paragraph\nwrapped.\n\n```js\nconst x = 1;\n\nconst y = 2;\n```";
    const rewritten = await (await patch(a.id, { text })).json();
    expect(rewritten.article.title).toBe("Better title");
    expect(rewritten.article.content).toBe("## Section\n\nNew paragraph\nwrapped.\n\n```js\nconst x = 1;\n\nconst y = 2;\n```");
  });

  it("a blank title is rebuilt from the text", async () => {
    const a = await create("Body text first line\n\nMore.", "Old title");
    const res = await (await patch(a.id, { title: "", text: "Brand new opening line\n\nRest." })).json();
    expect(res.article.title).toBe("Brand new opening line");
  });

  it("keeps uploaded/imported metadata, and saved concepts stay linked", async () => {
    const a = await prisma.article.create({ data: { userId: alice.id, title: "Doc", content: "Old text about caching.", fileName: "notes.pdf" } });
    const concept = await prisma.concept.create({ data: { userId: alice.id, articleId: a.id, term: "caching", definition: "d" } });
    const res = await (await patch(a.id, { text: "New text that still mentions caching." })).json();
    expect(res.article).toMatchObject({ fileName: "notes.pdf", content: "New text that still mentions caching." });
    expect((await prisma.concept.findUnique({ where: { id: concept.id } })).articleId).toBe(a.id);
  });

  it("validates input and names the field", async () => {
    const a = await create();
    expect((await patch(a.id, null, "{bad")).status).toBe(400);
    const empty = await patch(a.id, {});
    expect(empty.status).toBe(400);
    const blank = await (await patch(a.id, { text: "   " })).json();
    expect(blank).toMatchObject({ error: "invalid_input", field: "text" });
    expect((await (await patch(a.id, { title: "x".repeat(201) })).json()).field).toBe("title");
    expect((await (await patch(a.id, { title: 42 })).json()).field).toBe("title");
    expect((await (await patch(a.id, { text: "a\u0000b" })).json()).field).toBe("text");
    expect((await patch(a.id, { text: "x".repeat(200_001) })).status).toBe(400);
  });

  it("only the owner can edit; 401 without a session; rate limited", async () => {
    const a = await create();
    asUser(bob);
    expect((await patch(a.id, { title: "Hijack" })).status).toBe(404);
    expect((await prisma.article.findUnique({ where: { id: a.id } })).title).not.toBe("Hijack");
    expect((await patch("nope", { title: "x" })).status).toBe(404);
    state.user = null;
    expect((await patch(a.id, { title: "x" })).status).toBe(401);
    asUser(alice);
    state.limited = 7;
    expect((await patch(a.id, { title: "x" })).status).toBe(429);
  });
});
