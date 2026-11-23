// /api/explain and /api/translate against the test database, with mocked auth and the mock AI provider.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const state = vi.hoisted(() => ({ user: null, limited: null, alerts: [] }));

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
vi.mock("@/lib/alerts.js", () => ({ alertError: vi.fn(async (...a) => state.alerts.push(a)) }));

import prisma from "@/lib/db.js";
import { POST as explain } from "@/app/api/explain/route.js";
import { POST as translate } from "@/app/api/translate/route.js";
import { resetCache } from "@/lib/cache.js";
import { _resetRateLimits } from "@/lib/rate-limit.js";

const EMAIL_PREFIX = "feat-explain-";
let alice;
let bob;
let bobArticle;
const savedChain = process.env.AI_PROVIDER_CHAIN;

function req(url, body, raw) {
  return new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: raw ?? JSON.stringify(body) });
}
const asUser = (u) => (state.user = { id: u.id, email: u.email, locale: u.locale, helpLevel: u.helpLevel });

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
  alice = await prisma.user.create({ data: { email: `${EMAIL_PREFIX}alice@example.test` } });
  bob = await prisma.user.create({ data: { email: `${EMAIL_PREFIX}bob@example.test` } });
  bobArticle = await prisma.article.create({ data: { userId: bob.id, title: "Bob's", content: "x" } });
});
afterAll(async () => {
  delete process.env.AI_MOCK;
  process.env.AI_PROVIDER_CHAIN = savedChain;
  if (savedChain === undefined) delete process.env.AI_PROVIDER_CHAIN;
  await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
  await prisma.$disconnect();
});
beforeEach(() => {
  process.env.AI_MOCK = "1";
  process.env.AI_PROVIDER_CHAIN = "mock";
  state.limited = null;
  state.alerts = [];
  resetCache();
  _resetRateLimits();
  delete process.env.AI_DAILY_LIMIT_PER_USER;
  delete process.env.AI_TIMEOUT_MS;
  delete process.env.AI_CHAIN_DEADLINE_MS;
  asUser(alice);
});

const body = (extra = {}) => ({ highlightedText: "the DOM reconciliation algorithm", surroundingText: "React uses the DOM reconciliation algorithm to update.", helpLevel: 1, language: "en", ...extra });

describe("POST /api/explain", () => {
  it("401 without a session", async () => {
    state.user = null;
    const res = await explain(req("/api/explain", body()));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("unauthenticated");
  });

  it("400 on malformed JSON and on missing / wrong-type / overlong highlightedText", async () => {
    expect((await explain(req("/api/explain", null, "{not json"))).status).toBe(400);
    expect((await explain(req("/api/explain", null, "[1,2]"))).status).toBe(400);
    for (const bad of [{ highlightedText: "" }, { highlightedText: 42 }, { highlightedText: "x".repeat(1001) }, { surroundingText: 5 }, { articleId: 7 }]) {
      const res = await explain(req("/api/explain", body(bad)));
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("invalid_input");
      expect(typeof json.message).toBe("string");
    }
  });

  it("429 when rate limited, with retryAfter", async () => {
    state.limited = 12;
    const res = await explain(req("/api/explain", body()));
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "rate_limited", retryAfter: 12 });
  });

  it("explains, stores an Explanation + AiCall, then serves a cache hit with its own explanationId", async () => {
    const first = await explain(req("/api/explain", body()));
    expect(first.status).toBe(200);
    const a = await first.json();
    expect(a).toMatchObject({ helpLevel: 1, language: "en", cached: false, provider: "mock", model: "mock-1" });
    expect(a.explanation).toContain("the DOM reconciliation algorithm");
    const stored = await prisma.explanation.findUnique({ where: { id: a.explanationId } });
    expect(stored).toMatchObject({ userId: alice.id, cacheHit: false, aiProvider: "mock", explanation: a.explanation });

    const second = await (await explain(req("/api/explain", body()))).json();
    expect(second).toMatchObject({ cached: true, explanation: a.explanation, provider: "mock" });
    expect(second.explanationId).not.toBe(a.explanationId);
    const hit = await prisma.explanation.findUnique({ where: { id: second.explanationId } });
    expect(hit).toMatchObject({ userId: alice.id, cacheHit: true });
  });

  it("invalid helpLevel/language degrade to defaults; zh returns Chinese", async () => {
    const res = await (await explain(req("/api/explain", body({ helpLevel: 9, language: "fr" })))).json();
    expect(res).toMatchObject({ helpLevel: 1, language: "en" });
    const zh = await (await explain(req("/api/explain", body({ language: "zh", helpLevel: 2 })))).json();
    expect(zh).toMatchObject({ helpLevel: 2, language: "zh" });
    expect(zh.explanation).toMatch(/[一-鿿]/);
  });

  it("articleId must belong to the caller (404 otherwise)", async () => {
    const res = await explain(req("/api/explain", body({ articleId: bobArticle.id })));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_found");
    const own = await prisma.article.create({ data: { userId: alice.id, title: "Mine", content: "y" } });
    const ok = await (await explain(req("/api/explain", body({ articleId: own.id, highlightedText: "something else entirely" })))).json();
    expect((await prisma.explanation.findUnique({ where: { id: ok.explanationId } })).articleId).toBe(own.id);
  });

  it("422 content_refused on refusal", async () => {
    const res = await explain(req("/api/explain", body({ highlightedText: "please __refuse__ this" })));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("content_refused");
  });

  it("503 ai_unavailable with retryAfter when every provider is down, and logs the ERROR that alerts", async () => {
    const res = await explain(req("/api/explain", body({ highlightedText: "__infra__ outage" })));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "ai_unavailable", retryAfter: 30 });
    expect(res.headers.get("retry-after")).toBe("30");
    await new Promise((r) => setTimeout(r, 0));
    const { logger } = await import("@/lib/logger.js");
    expect(vi.mocked(logger.error).mock.calls.some((c) => c[1] === "All AI providers failed")).toBe(true);
  });

  it("503 when no provider is configured", async () => {
    process.env.AI_MOCK = "0";
    const res = await explain(req("/api/explain", body({ highlightedText: "nothing configured" })));
    expect(res.status).toBe(503);
  });

  it("502 explanation_failed on invalid output, recorded as invalid_output", async () => {
    const res = await explain(req("/api/explain", body({ highlightedText: "__garbage__ please" })));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("explanation_failed");
    const call = await prisma.aiCall.findFirst({ where: { provider: "mock", status: "invalid_output" }, orderBy: { createdAt: "desc" } });
    expect(call).toBeTruthy();
  });
});

describe("POST /api/translate", () => {
  it("translates, caches on the Explanation and copies into a saved Concept", async () => {
    const ex = await (await explain(req("/api/explain", body({ highlightedText: "virtual DOM" })))).json();
    const concept = await prisma.concept.create({ data: { userId: alice.id, explanationId: ex.explanationId, term: "virtual DOM", definition: ex.explanation } });

    const first = await translate(req("/api/translate", { explanationId: ex.explanationId }));
    expect(first.status).toBe(200);
    const t = await first.json();
    expect(t).toMatchObject({ language: "zh", cached: false });
    expect(t.translation).toMatch(/[一-鿿]/);
    expect((await prisma.explanation.findUnique({ where: { id: ex.explanationId } })).translationZh).toBe(t.translation);
    expect((await prisma.concept.findUnique({ where: { id: concept.id } })).definitionZh).toBe(t.translation);

    const again = await (await translate(req("/api/translate", { explanationId: ex.explanationId }))).json();
    expect(again).toMatchObject({ cached: true, translation: t.translation });
  });

  it("404 for another user's explanation; 400 for bad input", async () => {
    asUser(bob);
    const bobEx = await (await explain(req("/api/explain", body({ highlightedText: "bob's term" })))).json();
    asUser(alice);
    const res = await translate(req("/api/translate", { explanationId: bobEx.explanationId }));
    expect(res.status).toBe(404);
    expect((await translate(req("/api/translate", null, "nope"))).status).toBe(400);
    expect((await translate(req("/api/translate", { explanationId: 5 }))).status).toBe(400);
    expect((await translate(req("/api/translate", { explanationId: "x", targetLanguage: "fr" }))).status).toBe(400);
  });

  it("429 when rate limited", async () => {
    state.limited = 3;
    expect((await translate(req("/api/translate", { explanationId: "x" }))).status).toBe(429);
  });

  it("503 when providers are down", async () => {
    const ex = await (await explain(req("/api/explain", body({ highlightedText: "another term" })))).json();
    process.env.AI_MOCK = "0";
    const res = await translate(req("/api/translate", { explanationId: ex.explanationId }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("ai_unavailable");
  });
});

describe("round-2 guards on the AI routes", () => {
  it("[QA-2] NUL in any text field → 400 naming the field, never 500", async () => {
    for (const [field, extra] of [["highlightedText", { highlightedText: "a\u0000x" }], ["surroundingText", { surroundingText: "c\u0000" }], ["articleId", { articleId: "id\u0000" }]]) {
      const res = await explain(req("/api/explain", body(extra)));
      expect(res.status, field).toBe(400);
      expect((await res.json()).field).toBe(field);
    }
  });

  it("[SEC-4] per-user daily AI quota → 429 daily_limit with retryAfter; cache hits are free", async () => {
    process.env.AI_DAILY_LIMIT_PER_USER = "2";
    expect((await explain(req("/api/explain", body({ highlightedText: "quota one" })))).status).toBe(200);
    expect((await explain(req("/api/explain", body({ highlightedText: "quota one" })))).status).toBe(200); // cache hit
    expect((await explain(req("/api/explain", body({ highlightedText: "quota two" })))).status).toBe(200);
    const res = await explain(req("/api/explain", body({ highlightedText: "quota three" })));
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json).toMatchObject({ error: "daily_limit" });
    expect(json.retryAfter).toBeGreaterThan(0);
    expect(json.retryAfter).toBeLessThanOrEqual(86_400);
    expect(res.headers.get("retry-after")).toBe(String(json.retryAfter));
    asUser(bob);
    expect((await explain(req("/api/explain", body({ highlightedText: "quota three" })))).status).toBe(200);
  });

  it("[ENG-1] a hung provider answers 503 within the chain deadline (mock __slow__ + AI_TIMEOUT_MS)", async () => {
    process.env.AI_TIMEOUT_MS = "1000";
    process.env.AI_CHAIN_DEADLINE_MS = "1500";
    process.env.AI_PROVIDER_CHAIN = "mock,mock";
    const started = Date.now();
    const res = await explain(req("/api/explain", body({ highlightedText: "__slow__ deadline" })));
    expect(res.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(2500);
  });
});

