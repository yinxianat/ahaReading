// API robustness (no browser): malformed input → 400 never 500, ownership → 404, shapes.
import { test, expect } from "./support/fixtures.mjs";
import { createUser } from "./support/db.mjs";

test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== "desktop-chromium", "API checks run once"));

const auth = (t) => ({ cookie: `aha_session=${t}` });

test("health JSON shape, no secret values", async ({ request }) => {
  const r = await request.get("/api/health");
  expect([200, 503]).toContain(r.status());
  const j = await r.json();
  expect(Object.keys(j).sort()).toEqual(["checks", "fatal", "status", "timestamp", "warnings"]);
  expect(Object.keys(j.checks)).toEqual(expect.arrayContaining(["database", "secrets", "baseUrl", "ai", "smtp"]));
  expect(JSON.stringify(j)).not.toMatch(/postgres(ql)?:\/\/|secret=|sk-/i);
});

test("unauthenticated → 401 unauthenticated on every user route", async ({ request }) => {
  for (const [m, p] of [["GET", "/api/auth/me"], ["GET", "/api/articles"], ["POST", "/api/explain"], ["GET", "/api/notebook"], ["GET", "/api/review"], ["PATCH", "/api/me"], ["GET", "/api/admin/overview"]]) {
    const r = await request.fetch(p, { method: m, data: {} });
    expect(r.status(), `${m} ${p}`).toBe(401);
    expect((await r.json()).error).toBe("unauthenticated");
  }
});

test("malformed JSON and wrong types → 400 on every POST/PATCH", async ({ request }) => {
  const u = await createUser();
  const cases = [
    ["POST", "/api/articles"], ["POST", "/api/explain"], ["POST", "/api/translate"], ["POST", "/api/notebook"],
    ["POST", "/api/review"], ["PATCH", "/api/me"], ["DELETE", "/api/me"], ["POST", "/api/client-error"],
  ];
  for (const [m, p] of cases) {
    for (const body of ["{bad", "[]", "null", '{"x":1}']) {
      const r = await request.fetch(p, { method: m, headers: { ...auth(u.token), "content-type": "application/json" }, data: body });
      expect(r.status(), `${m} ${p} ${body}`).toBeLessThan(500);
      const text = await r.text();
      expect(text, `${m} ${p}`).not.toMatch(/\n\s+at |stack|prisma\./i);
    }
  }
});

test("[QA-2] NUL characters → 400, not 500", async ({ request }) => {
  const u = await createUser();
  const h = { ...auth(u.token), "content-type": "application/json" };
  const results = {};
  results.articleText = (await request.post("/api/articles", { headers: h, data: '{"text":"a\\u0000b"}' })).status();
  results.articleTitle = (await request.post("/api/articles", { headers: h, data: '{"text":"ok","title":"a\\u0000"}' })).status();
  results.explain = (await request.post("/api/explain", { headers: h, data: '{"highlightedText":"a\\u0000x","surroundingText":"c"}' })).status();
  results.displayName = (await request.patch("/api/me", { headers: h, data: '{"displayName":"a\\u0000"}' })).status();
  results.search = (await request.get("/api/notebook?search=%00", { headers: h })).status();
  results.tag = (await request.get("/api/notebook?tag=%00", { headers: h })).status();
  expect(results).toEqual({ articleText: 400, articleTitle: 400, explain: 400, displayName: 400, search: 400, tag: 400 });
});

test("other user's ids → 404", async ({ request }) => {
  const a = await createUser();
  const b = await createUser();
  const ha = { ...auth(a.token), "content-type": "application/json" };
  const hb = { ...auth(b.token), "content-type": "application/json" };
  const art = (await (await request.post("/api/articles", { headers: ha, data: { text: "owned by a", title: "A" } })).json()).article.id;
  expect((await request.get(`/api/articles/${art}`, { headers: hb })).status()).toBe(404);
  expect((await request.delete(`/api/articles/${art}`, { headers: hb })).status()).toBe(404);
  expect((await request.post("/api/explain", { headers: hb, data: { highlightedText: "x", surroundingText: "y", articleId: art } })).status()).toBe(404);
});

test("unknown /api → 404 not_found", async ({ request }) => {
  for (const m of ["GET", "POST", "DELETE"]) {
    const r = await request.fetch("/api/definitely-not-here", { method: m });
    expect(r.status()).toBe(404);
    expect((await r.json()).error).toBe("not_found");
  }
});
