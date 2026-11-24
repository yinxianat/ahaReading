// /api/notebook and /api/review against the test database, with mocked auth.
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
vi.mock("@/lib/alerts.js", () => ({ alertError: vi.fn(async () => {}) }));

import prisma from "@/lib/db.js";
import { GET as listNotebook, POST as saveConcept } from "@/app/api/notebook/route.js";
import { GET as getConcept, PATCH as patchConcept, DELETE as deleteConcept } from "@/app/api/notebook/[id]/route.js";
import { GET as getReview, POST as postReview } from "@/app/api/review/route.js";

const EMAIL_PREFIX = "feat-notebook-";
let alice;
let bob;
let article;

const asUser = (u) => (state.user = { id: u.id, email: u.email, locale: "en", helpLevel: 1 });
const json = (method, url, body, raw) =>
  new Request(`http://localhost${url}`, { method, headers: { "content-type": "application/json" }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
const get = (url) => new Request(`http://localhost${url}`);
const ctx = (id) => ({ params: Promise.resolve({ id }) });

async function makeExplanation(user, overrides = {}) {
  return prisma.explanation.create({
    data: { userId: user.id, highlightedText: "reconciliation", surroundingText: "", helpLevel: 1, explanation: "How React updates only what changed.", ...overrides },
  });
}
async function save(explanation, extra = {}) {
  return saveConcept(json("POST", "/api/notebook", { explanationId: explanation.id, ...extra }));
}

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
  alice = await prisma.user.create({ data: { email: `${EMAIL_PREFIX}alice@example.test` } });
  bob = await prisma.user.create({ data: { email: `${EMAIL_PREFIX}bob@example.test` } });
  article = await prisma.article.create({ data: { userId: alice.id, title: "React Internals", content: "..." } });
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
  await prisma.$disconnect();
});
beforeEach(() => {
  state.limited = null;
  asUser(alice);
});

describe("POST /api/notebook", () => {
  it("401 without a session; 400 on malformed JSON", async () => {
    state.user = null;
    expect((await saveConcept(json("POST", "/api/notebook", {}))).status).toBe(401);
    asUser(alice);
    expect((await saveConcept(json("POST", "/api/notebook", null, "{oops"))).status).toBe(400);
  });

  it("saves with normalized tags, copies translation, initializes SRS; 409 on second save", async () => {
    const ex = await makeExplanation(alice, { articleId: article.id, translationZh: "协调" });
    const res = await save(ex, { tags: ["  React ", "react", "Performance  Tuning", ""], userNotes: "  my note " });
    expect(res.status).toBe(201);
    const { concept } = await res.json();
    expect(concept).toMatchObject({
      term: "reconciliation",
      definition: "How React updates only what changed.",
      definitionZh: "协调",
      userNotes: "my note",
      tags: ["react", "performance tuning"],
      articleId: article.id,
      articleTitle: "React Internals",
      reviewCount: 0,
    });
    const due = new Date(concept.nextReviewAt).getTime() - Date.now();
    expect(due).toBeGreaterThan(23 * 3600_000);
    expect(due).toBeLessThan(25 * 3600_000);

    const dup = await save(ex);
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ error: "already_saved", conceptId: concept.id });
  });

  it("validates tags and notes", async () => {
    const ex = await makeExplanation(alice);
    for (const tags of ["react", [1], ["x".repeat(51)], Array.from({ length: 11 }, (_, i) => `t${i}`)]) {
      const res = await save(ex, { tags });
      expect(res.status).toBe(400);
      expect((await res.json()).field).toBe("tags");
    }
    expect((await save(ex, { userNotes: "x".repeat(5001) })).status).toBe(400);
    expect((await save(ex, { userNotes: 5 })).status).toBe(400);
    // 10 tags after dedupe is fine
    const ok = await save(ex, { tags: [...Array.from({ length: 10 }, (_, i) => `t${i}`), "T0"] });
    expect(ok.status).toBe(201);
  });

  it("404 for another user's explanation; 429 when limited", async () => {
    const bobEx = await makeExplanation(bob);
    expect((await save(bobEx)).status).toBe(404);
    state.limited = 5;
    expect((await save(bobEx)).status).toBe(429);
  });
});

describe("GET /api/notebook", () => {
  let ids;
  beforeAll(async () => {
    await prisma.concept.deleteMany({ where: { userId: alice.id } });
    ids = [];
    for (let i = 0; i < 5; i++) {
      const c = await prisma.concept.create({
        data: {
          userId: alice.id,
          term: `Term ${i}`,
          definition: i === 2 ? "Contains the Needle word" : "plain",
          userNotes: i === 4 ? "a NOTE with needle" : null,
          tags: i % 2 === 0 ? ["even", "all"] : ["odd", "all"],
          articleId: i < 2 ? article.id : null,
          createdAt: new Date(Date.now() - (10 - i) * 1000),
        },
      });
      ids.push(c.id);
    }
    await prisma.concept.create({ data: { userId: bob.id, term: "Bob needle", definition: "needle", tags: ["all", "bobtag"] } });
  });

  it("lists newest first with tag counts (only the caller's)", async () => {
    const res = await (await listNotebook(get("/api/notebook"))).json();
    expect(res.concepts.map((c) => c.id)).toEqual([...ids].reverse());
    expect(res.tags).toEqual([
      { tag: "all", count: 5 },
      { tag: "even", count: 3 },
      { tag: "odd", count: 2 },
    ]);
    expect(res.nextCursor).toBeNull();
  });

  it("searches term/definition/notes case-insensitively", async () => {
    const res = await (await listNotebook(get("/api/notebook?search=NEEDLE"))).json();
    expect(res.concepts.map((c) => c.id).sort()).toEqual([ids[2], ids[4]].sort());
    const term = await (await listNotebook(get("/api/notebook?search=term%203"))).json();
    expect(term.concepts.map((c) => c.id)).toEqual([ids[3]]);
  });

  it("filters by tag (normalized) and article", async () => {
    const odd = await (await listNotebook(get("/api/notebook?tag=%20ODD%20"))).json();
    expect(odd.concepts.map((c) => c.id).sort()).toEqual([ids[1], ids[3]].sort());
    const byArticle = await (await listNotebook(get(`/api/notebook?articleId=${article.id}`))).json();
    expect(byArticle.concepts.map((c) => c.id).sort()).toEqual([ids[0], ids[1]].sort());
  });

  it("paginates with an opaque cursor", async () => {
    const p1 = await (await listNotebook(get("/api/notebook?limit=2"))).json();
    expect(p1.concepts.map((c) => c.id)).toEqual([ids[4], ids[3]]);
    const p2 = await (await listNotebook(get(`/api/notebook?limit=2&cursor=${p1.nextCursor}`))).json();
    expect(p2.concepts.map((c) => c.id)).toEqual([ids[2], ids[1]]);
    const p3 = await (await listNotebook(get(`/api/notebook?limit=2&cursor=${p2.nextCursor}`))).json();
    expect(p3.concepts.map((c) => c.id)).toEqual([ids[0]]);
    expect(p3.nextCursor).toBeNull();
    expect((await listNotebook(get("/api/notebook?cursor=garbage"))).status).toBe(400);
  });

  it("GET/PATCH/DELETE by id are owner-only", async () => {
    const bobConcept = await prisma.concept.findFirst({ where: { userId: bob.id } });
    expect((await getConcept(get("/x"), ctx(bobConcept.id))).status).toBe(404);
    expect((await patchConcept(json("PATCH", "/x", { userNotes: "hijack" }), ctx(bobConcept.id))).status).toBe(404);
    expect((await deleteConcept(json("DELETE", "/x"), ctx(bobConcept.id))).status).toBe(404);
    expect((await prisma.concept.findUnique({ where: { id: bobConcept.id } })).userNotes).toBeNull();

    const mine = await (await getConcept(get("/x"), ctx(ids[0]))).json();
    expect(mine.concept.articleTitle).toBe("React Internals");
    const patched = await (await patchConcept(json("PATCH", "/x", { userNotes: "new", tags: ["New Tag"], term: "Renamed" }), ctx(ids[0]))).json();
    expect(patched.concept).toMatchObject({ userNotes: "new", tags: ["new tag"], term: "Renamed" });
    expect((await patchConcept(json("PATCH", "/x", {}), ctx(ids[0]))).status).toBe(400);
    expect((await patchConcept(json("PATCH", "/x", { term: 3 }), ctx(ids[0]))).status).toBe(400);
    expect((await patchConcept(json("PATCH", "/x", null, "{bad"), ctx(ids[0]))).status).toBe(400);
    expect((await deleteConcept(json("DELETE", "/x"), ctx(ids[0]))).status).toBe(200);
    expect((await getConcept(get("/x"), ctx(ids[0]))).status).toBe(404);
  });
});

describe("/api/review", () => {
  let dueOld;
  let dueNew;
  let future;
  beforeAll(async () => {
    await prisma.concept.deleteMany({ where: { userId: alice.id } });
    dueOld = await prisma.concept.create({ data: { userId: alice.id, term: "old", definition: "d", nextReviewAt: new Date(Date.now() - 86_400_000 * 3) } });
    dueNew = await prisma.concept.create({ data: { userId: alice.id, term: "new", definition: "d", nextReviewAt: new Date(Date.now() - 1000) } });
    future = await prisma.concept.create({ data: { userId: alice.id, term: "future", definition: "d", nextReviewAt: new Date(Date.now() + 86_400_000) } });
  });

  it("GET returns due concepts, most overdue first", async () => {
    const res = await (await getReview(get("/api/review"))).json();
    expect(res.due.map((c) => c.id)).toEqual([dueOld.id, dueNew.id]);
    expect(res.dueCount).toBe(2);
  });

  it("POST applies SM-2, records history, and is idempotent per clientId", async () => {
    const first = await postReview(json("POST", "/api/review", { conceptId: dueOld.id, quality: 5, clientId: "offline-abc_1" }));
    expect(first.status).toBe(200);
    const a = await first.json();
    expect(a.concept.reviewCount).toBe(1);
    const stored = await prisma.concept.findUnique({ where: { id: dueOld.id } });
    expect(stored.easeFactor).toBe(2.6);
    expect(stored.interval).toBe(1);

    const replay = await postReview(json("POST", "/api/review", { conceptId: dueOld.id, quality: 5, clientId: "offline-abc_1" }));
    expect(replay.status).toBe(200);
    const b = await replay.json();
    expect(b.nextReviewAt).toBe(a.nextReviewAt);
    expect(b.concept.reviewCount).toBe(1);
    expect(await prisma.reviewCard.count({ where: { userId: alice.id, conceptId: dueOld.id } })).toBe(1);

    const second = await (await postReview(json("POST", "/api/review", { conceptId: dueOld.id, quality: 4 }))).json();
    expect(second.concept.reviewCount).toBe(2);
    expect((await prisma.concept.findUnique({ where: { id: dueOld.id } })).interval).toBe(6);
  });

  it("[ENG-13] a lapse resets repetitions, so the next success is 1 day, not ×EF", async () => {
    const c = await prisma.concept.create({
      data: { userId: alice.id, term: "lapser", definition: "d", nextReviewAt: new Date(Date.now() - 1000), interval: 30, repetitions: 4, reviewCount: 4 },
    });
    await postReview(json("POST", "/api/review", { conceptId: c.id, quality: 1 }));
    let stored = await prisma.concept.findUnique({ where: { id: c.id } });
    expect(stored).toMatchObject({ interval: 1, repetitions: 0, reviewCount: 5 });
    await postReview(json("POST", "/api/review", { conceptId: c.id, quality: 4 }));
    stored = await prisma.concept.findUnique({ where: { id: c.id } });
    expect(stored).toMatchObject({ interval: 1, repetitions: 1, reviewCount: 6 });
    await postReview(json("POST", "/api/review", { conceptId: c.id, quality: 4 }));
    expect((await prisma.concept.findUnique({ where: { id: c.id } })).interval).toBe(6);
  });

  it("[PO-13] GET returns streak, reviewed-today and mastered stats", async () => {
    // Own user: the shared concepts above already carry reviews from earlier tests.
    const carol = await prisma.user.create({ data: { email: `${EMAIL_PREFIX}carol@example.test` } });
    const previous = state.user;
    asUser(carol);
    try {
      expect((await (await getReview(get("/api/review"))).json()).stats).toEqual({ streakDays: 0, reviewedToday: 0, mastered: 0 });

      const mk = (term, data = {}) => prisma.concept.create({ data: { userId: carol.id, term, definition: "d", nextReviewAt: new Date(Date.now() - 1000), ...data } });
      const [a, b, solid] = await Promise.all([mk("a"), mk("b"), mk("solid", { interval: 21, nextReviewAt: new Date(Date.now() + 86_400_000) })]);
      const day = 86_400_000;
      // Yesterday and the day before, plus two today: a 3-day streak.
      for (const at of [Date.now() - 2 * day, Date.now() - day]) {
        await prisma.reviewCard.create({ data: { userId: carol.id, conceptId: solid.id, quality: 4, reviewedAt: new Date(at) } });
      }
      expect((await postReview(json("POST", "/api/review", { conceptId: a.id, quality: 4 }))).status).toBe(200);
      expect((await postReview(json("POST", "/api/review", { conceptId: b.id, quality: 4 }))).status).toBe(200);
      const res = await (await getReview(get("/api/review"))).json();
      expect(res.stats).toEqual({ streakDays: 3, reviewedToday: 2, mastered: 1 });
      // countOnly stays lean.
      expect(await (await getReview(get("/api/review?countOnly=1"))).json()).not.toHaveProperty("stats");
    } finally {
      state.user = previous;
    }
  });

  it("concurrent duplicates of the same clientId produce one review", async () => {
    const send = () => postReview(json("POST", "/api/review", { conceptId: future.id, quality: 3, clientId: "race-1" }));
    const results = await Promise.all([send(), send(), send()]);
    for (const r of results) expect(r.status).toBe(200);
    expect(await prisma.reviewCard.count({ where: { userId: alice.id, clientId: "race-1" } })).toBe(1);
    expect((await prisma.concept.findUnique({ where: { id: future.id } })).reviewCount).toBe(1);
  });

  it("rejects bad input, other users' concepts, and rate-limits", async () => {
    for (const bad of [{ conceptId: dueNew.id, quality: 6 }, { conceptId: dueNew.id, quality: 2.5 }, { conceptId: dueNew.id, quality: "5" }, { quality: 3 }, { conceptId: dueNew.id, quality: 3, clientId: "has spaces" }]) {
      expect((await postReview(json("POST", "/api/review", bad))).status).toBe(400);
    }
    expect((await postReview(json("POST", "/api/review", null, "nope"))).status).toBe(400);
    asUser(bob);
    expect((await postReview(json("POST", "/api/review", { conceptId: dueNew.id, quality: 5 }))).status).toBe(404);
    // Bob reusing Alice's clientId must not read Alice's concept.
    expect((await postReview(json("POST", "/api/review", { conceptId: dueNew.id, quality: 5, clientId: "offline-abc_1" }))).status).toBe(404);
    asUser(alice);
    state.limited = 9;
    expect((await postReview(json("POST", "/api/review", { conceptId: dueNew.id, quality: 5 }))).status).toBe(429);
    state.user = null;
    expect((await getReview(get("/api/review"))).status).toBe(401);
  });
});

describe("round-2 notebook behaviour", () => {
  beforeAll(async () => {
    await prisma.concept.deleteMany({ where: { userId: { in: [alice.id, bob.id] } } });
  });

  it("[QA-3] same term from the same article via a NEW explanation → 409 already_saved with the existing id", async () => {
    const first = await save(await makeExplanation(alice, { articleId: article.id, highlightedText: "Eventual  Consistency" }));
    expect(first.status).toBe(201);
    const { concept } = await first.json();
    expect(concept.term).toBe("Eventual Consistency");
    const again = await save(await makeExplanation(alice, { articleId: article.id, highlightedText: " eventual consistency " }));
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: "already_saved", conceptId: concept.id });
    // Same term from another article (or none) is a different concept.
    expect((await save(await makeExplanation(alice, { highlightedText: "eventual consistency" }))).status).toBe(201);
    expect((await save(await makeExplanation(alice, { highlightedText: "EVENTUAL consistency" }))).status).toBe(409);
    // Another user is unaffected.
    asUser(bob);
    expect((await save(await makeExplanation(bob, { highlightedText: "eventual consistency" }))).status).toBe(201);
  });

  it("[QA-3] two explanations of one term saved at the same time → exactly one concept", async () => {
    const [a, b] = await Promise.all([
      makeExplanation(alice, { articleId: article.id, highlightedText: "race term" }),
      makeExplanation(alice, { articleId: article.id, highlightedText: "Race Term" }),
    ]);
    const results = await Promise.all([save(a), save(b)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await prisma.concept.count({ where: { userId: alice.id, articleId: article.id, term: { equals: "race term", mode: "insensitive" } } })).toBe(1);
  });

  it("[PO-11] an edited term replaces the highlight as the card front (and is what duplicates compare)", async () => {
    const ex = await makeExplanation(alice, { highlightedText: "The whole long sentence about memoization caching results." });
    const res = await save(ex, { term: "  memoization " });
    expect(res.status).toBe(201);
    expect((await res.json()).concept.term).toBe("memoization");
    expect((await save(ex, { term: "" })).status).toBe(400); // empty term is invalid input
    const other = await makeExplanation(alice, { highlightedText: "x" });
    expect((await save(other, { term: 5 })).status).toBe(400);
    expect((await save(other, { term: "Memoization" })).status).toBe(409);
  });

  it("[PO-9] concepts expose explanationId so the client can translate after saving", async () => {
    const ex = await makeExplanation(alice, { highlightedText: "translate later" });
    const { concept } = await (await save(ex)).json();
    expect(concept.explanationId).toBe(ex.id);
  });

  it("[PO-10] search also matches the Chinese definition", async () => {
    const ex = await makeExplanation(alice, { highlightedText: "cache", translationZh: "缓存是一种存储方式" });
    const { concept } = await (await save(ex)).json();
    const res = await (await listNotebook(get(`/api/notebook?search=${encodeURIComponent("缓存")}`))).json();
    expect(res.concepts.map((c) => c.id)).toContain(concept.id);
  });

  it("[QA-2] NUL in search/tag/articleId/cursor → 400; NUL in notes/tags/term → 400", async () => {
    for (const q of ["search=%00", "tag=%00", "articleId=%00", "cursor=%00"]) {
      expect((await listNotebook(get(`/api/notebook?${q}`))).status, q).toBe(400);
    }
    const ex = await makeExplanation(alice, { highlightedText: "nul guard" });
    for (const extra of [{ userNotes: "a\u0000" }, { tags: ["a\u0000"] }, { term: "t\u0000" }]) expect((await save(ex, extra)).status).toBe(400);
  });

  it("[ENG-15] cursor pages omit the tag aggregate", async () => {
    const p1 = await (await listNotebook(get("/api/notebook?limit=1"))).json();
    expect(Array.isArray(p1.tags)).toBe(true);
    const p2 = await (await listNotebook(get(`/api/notebook?limit=1&cursor=${p1.nextCursor}`))).json();
    expect(p2.tags).toBeUndefined();
    expect(p2.concepts).toHaveLength(1);
  });
});

describe("round-2 review behaviour", () => {
  it("[ENG-16] GET ?countOnly=1 returns only the badge numbers", async () => {
    await prisma.concept.create({ data: { userId: alice.id, term: "count me", definition: "d", nextReviewAt: new Date(Date.now() - 1000) } });
    const res = await (await getReview(get("/api/review?countOnly=1"))).json();
    expect(Object.keys(res).sort()).toEqual(["dueCount", "nextDueAt"]);
    expect(res.dueCount).toBeGreaterThan(0);
  });

  it("[ENG-12] two different reviews of one card at once both apply in sequence (no lost update)", async () => {
    const c = await prisma.concept.create({ data: { userId: alice.id, term: "two devices", definition: "d", nextReviewAt: new Date() } });
    const results = await Promise.all([
      postReview(json("POST", "/api/review", { conceptId: c.id, quality: 5, clientId: "device-a" })),
      postReview(json("POST", "/api/review", { conceptId: c.id, quality: 5, clientId: "device-b" })),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const stored = await prisma.concept.findUnique({ where: { id: c.id } });
    expect(stored.reviewCount).toBe(2);
    // SM-2 from (1, 2.5, 0) → q5 → (1, 2.6, 1) → q5 → (6, 2.7, 2): the second saw the first's result.
    expect(stored.interval).toBe(6);
    expect(stored.easeFactor).toBeCloseTo(2.7, 5);
  });
});

describe("POST /api/notebook (written by the user)", () => {
  const add = (body) => saveConcept(json("POST", "/api/notebook", body));

  it("creates a concept with no AI explanation, due for review tomorrow", async () => {
    const res = await add({ term: "  Idempotency  key ", definition: "  A token that makes a retry safe. ", tags: ["API"], userNotes: "from standup" });
    expect(res.status).toBe(201);
    const { concept } = await res.json();
    expect(concept).toMatchObject({ term: "Idempotency key", definition: "A token that makes a retry safe.", tags: ["api"], userNotes: "from standup", explanationId: null, articleId: null, reviewCount: 0 });
    const due = new Date(concept.nextReviewAt).getTime() - Date.now();
    expect(due).toBeGreaterThan(23 * 3600_000);
  });

  it("can be tied to one of the user's articles, never someone else's", async () => {
    const res = await add({ term: "fiber", definition: "React's unit of work.", articleId: article.id });
    expect((await res.json()).concept).toMatchObject({ articleId: article.id, articleTitle: "React Internals" });
    asUser(bob);
    const other = await add({ term: "fiber", definition: "x", articleId: article.id });
    expect(other.status).toBe(404);
  });

  it("same term again (same article or none) is already_saved", async () => {
    const first = await (await add({ term: "Backpressure", definition: "Slow the producer." })).json();
    const again = await add({ term: "backpressure", definition: "Different words." });
    expect(again.status).toBe(409);
    expect((await again.json()).conceptId).toBe(first.concept.id);
  });

  it("needs a term and a definition, each validated", async () => {
    expect(await (await add({ definition: "no term" })).json()).toMatchObject({ error: "invalid_input", field: "term" });
    expect(await (await add({ term: "t", definition: "  " })).json()).toMatchObject({ field: "definition" });
    expect(await (await add({ term: "t", definition: "x".repeat(10_001) })).json()).toMatchObject({ field: "definition" });
    expect(await (await add({ term: "t" })).json()).toMatchObject({ field: "definition" });
    expect(await (await add({ term: "t", definition: "d", articleId: 5 })).json()).toMatchObject({ field: "articleId" });
  });
});
