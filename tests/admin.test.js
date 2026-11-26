import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/db.js", async () => {
  const { makePrismaMock } = await import("./platform-helpers.js");
  return { default: makePrismaMock() };
});
vi.mock("@/lib/alerts.js", () => ({ alertError: vi.fn(async () => ({})), alertEvent: vi.fn(async () => ({})) }));
vi.mock("@/lib/ai/index.js", () => ({
  getChainStatus: () => [{ name: "anthropic", registered: true, configured: true, defaultModel: "claude-opus-5-5" }],
}));
vi.mock("@/lib/ai/pricing.js", () => ({ estimateCost: (model, tokens) => (model === "claude-opus-5-5" ? tokens / 1000 : 0) }));

const prisma = (await import("@/lib/db.js")).default;
const { createSessionToken, SESSION_COOKIE } = await import("@/lib/auth.js");
const admin = await import("@/lib/admin.js");
const { snapshotEnv } = await import("./platform-helpers.js");

const routes = {
  overview: await import("@/app/api/admin/overview/route.js"),
  logs: await import("@/app/api/admin/logs/route.js"),
  aiCalls: await import("@/app/api/admin/ai-calls/route.js"),
  users: await import("@/app/api/admin/users/route.js"),
  diagnostics: await import("@/app/api/admin/diagnostics/route.js"),
  metrics: await import("@/app/api/admin/metrics/route.js"),
};
const resolveRoute = await import("@/app/api/admin/logs/[id]/resolve/route.js");

const ADMIN = { id: "a1", email: "admin@example.test", displayName: null, locale: "en", helpLevel: 1, onboardedAt: null, sessionVersion: 0 };
const READER = { ...ADMIN, id: "r1", email: "reader@example.com" };

function stubEmptyDb() {
  for (const model of ["logEntry", "aiCall", "explanation", "article", "reviewCard", "concept", "user"]) {
    prisma[model].findMany.mockResolvedValue([]);
    prisma[model].groupBy.mockResolvedValue([]);
    prisma[model].count.mockResolvedValue(0);
  }
  prisma.explanation.aggregate.mockResolvedValue({ _avg: { aiLatencyMs: null } });
}

async function asUser(user, path = "/api/admin/x") {
  prisma.user.findUnique.mockResolvedValue(user);
  return new Request(`http://localhost${path}`, { headers: { cookie: `${SESSION_COOKIE}=${await createSessionToken(user)}` } });
}

let restore;
beforeEach(() => {
  restore = snapshotEnv();
  process.env.JWT_SECRET = "j".repeat(64);
  process.env.MAGIC_LINK_SECRET = "m".repeat(64);
  process.env.ADMIN_EMAILS = "admin@example.test";
  prisma._reset();
  stubEmptyDb();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => restore());

describe("admin route gating", () => {
  it.each(Object.entries(routes))("%s: 401 without session, 403 non-admin, 200 admin", async (_, route) => {
    expect((await route.GET(new Request("http://localhost/api/admin/x"))).status).toBe(401);
    const forbidden = await route.GET(await asUser(READER));
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).error).toBe("forbidden");
    expect((await route.GET(await asUser(ADMIN))).status).toBe(200);
  });

  it("empty ADMIN_EMAILS denies everyone (fails closed)", async () => {
    process.env.ADMIN_EMAILS = "";
    expect((await routes.overview.GET(await asUser(ADMIN))).status).toBe(403);
  });

  it("resolve route is gated too", async () => {
    const res = await resolveRoute.POST(await asUser(READER), { params: Promise.resolve({ id: "l1" }) });
    expect(res.status).toBe(403);
  });
});

describe("logs", () => {
  const row = { id: "l1", level: "ERROR", source: "ai", message: "m", detail: "d", firstDetail: "first d", count: 7, createdAt: new Date("2026-11-01"), lastSeenAt: new Date("2026-11-19"), updatedAt: new Date("2026-11-20"), resolvedAt: null };

  it("hides resolved by default and reports how many are hidden", async () => {
    prisma.logEntry.findMany.mockResolvedValue([row]);
    prisma.logEntry.count.mockResolvedValue(4);
    const body = await (await routes.logs.GET(await asUser(ADMIN, "/api/admin/logs"))).json();
    expect(prisma.logEntry.findMany.mock.calls[0][0].where).toEqual({ resolvedAt: null });
    expect(body.resolvedCount).toBe(4);
    expect(body.entries[0]).toMatchObject({ count: 7, firstSeenAt: "2026-11-01T00:00:00.000Z", lastSeenAt: "2026-11-19T00:00:00.000Z", resolved: false, firstDetail: "first d", detail: "d" });
    expect(prisma.logEntry.findMany.mock.calls[0][0].orderBy).toEqual({ lastSeenAt: "desc" });
  });

  it("includeResolved=1 shows everything", async () => {
    await routes.logs.GET(await asUser(ADMIN, "/api/admin/logs?includeResolved=1"));
    expect(prisma.logEntry.findMany.mock.calls[0][0].where).toEqual({});
  });

  it("resolve sets resolvedAt only (last-seen is its own column); 404 for unknown ids", async () => {
    prisma.logEntry.updateMany.mockResolvedValueOnce({ count: 0 });
    const missing = await resolveRoute.POST(await asUser(ADMIN), { params: Promise.resolve({ id: "nope" }) });
    expect(missing.status).toBe(404);

    prisma.logEntry.updateMany.mockResolvedValueOnce({ count: 1 });
    const ok = await resolveRoute.POST(await asUser(ADMIN), { params: Promise.resolve({ id: "l1" }) });
    expect(ok.status).toBe(200);
    const { where, data } = prisma.logEntry.updateMany.mock.calls[1][0];
    expect(where).toEqual({ id: "l1" });
    expect(Object.keys(data)).toEqual(["resolvedAt"]);
  });
});

describe("read models", () => {
  it("groups AI calls by provider and status", async () => {
    prisma.aiCall.groupBy.mockResolvedValue([
      { provider: "anthropic", status: "ok", _count: { _all: 9 }, _avg: { latencyMs: 1200 }, _sum: { tokens: 900 } },
      { provider: "anthropic", status: "infrastructure", _count: { _all: 1 }, _avg: { latencyMs: 30000 }, _sum: { tokens: null } },
    ]);
    const out = await admin.getAiCalls();
    expect(out.total).toBe(10);
    expect(out.successRate).toBe("90.0%");
    expect(out.byProvider.anthropic).toMatchObject({ total: 10, ok: 9, infrastructure: 1, avgLatencyMs: 1200, tokens: 900 });
    expect(out.byStatus).toEqual({ ok: 9, infrastructure: 1 });
  });

  it("lists users with counts and last activity", async () => {
    prisma.user.findMany.mockResolvedValue([{
      id: "u1", email: "r@example.com", displayName: null, locale: "en", helpLevel: 2, onboardedAt: null, createdAt: new Date("2026-11-01"),
      _count: { concepts: 3, explanations: 10, articles: 2, reviewCards: 4 },
    }]);
    prisma.user.count.mockResolvedValue(1);
    prisma.explanation.groupBy.mockResolvedValue([{ userId: "u1", _max: { createdAt: new Date("2026-11-10") } }]);
    prisma.reviewCard.groupBy.mockResolvedValue([{ userId: "u1", _max: { reviewedAt: new Date("2026-11-12") } }]);
    const out = await admin.getUsers();
    expect(out.users[0]).toMatchObject({ concepts: 3, explanations: 10, lastActiveAt: "2026-11-12T00:00:00.000Z", onboarded: false });
  });

  it("[ENG-8][ENG-9] metrics follow spec 15.5, price per model group, count active users in SQL", async () => {
    prisma.explanation.count.mockResolvedValueOnce(10).mockResolvedValueOnce(4);
    prisma.aiCall.groupBy.mockResolvedValue([{ model: "claude-opus-5-5", _sum: { tokens: 1000, inputTokens: 600, outputTokens: 400 } }]);
    prisma.$queryRaw.mockResolvedValue([{ active: 3 }]);
    const m = await admin.getMetrics();
    expect(prisma.aiCall.findMany).not.toHaveBeenCalled();
    expect(prisma.aiCall.groupBy.mock.calls[0][0]).toMatchObject({ by: ["model"], where: { tokens: { not: null } } });
    expect(prisma.aiCall.groupBy.mock.calls[0][0].where.status).toBeUndefined();
    expect(m.users.activeToday).toBe(3);
    expect(m.period).toBe("last_24h");
    expect(m.explanations).toMatchObject({ total: 10, cacheHits: 4, cacheHitRate: "40.0%" });
    // Follow-ups ("Keep exploring") are stored at level 3 but counted apart from deep dives.
    const groups = prisma.explanation.groupBy.mock.calls.map((c) => c[0]);
    expect(groups.find((g) => g.by[0] === "helpLevel").where.followUp).toBeNull();
    expect(groups.find((g) => g.by[0] === "followUp").where.followUp).toEqual({ not: null });
    expect(m.explanations.byFollowUp).toEqual({});
    expect(m.costEstimate).toMatchObject({ today: "$1.00", projectedMonthly: "$30.00" });
    expect(Object.keys(m)).toEqual(expect.arrayContaining(["users", "concepts", "errors"]));
  });

  it("overview degrades one section without blanking the rest", async () => {
    prisma.user.findMany.mockRejectedValue(new Error("users table broke"));
    const out = await admin.getOverview();
    expect(out.users).toMatchObject({ error: "unavailable" });
    expect(Array.isArray(out.findings)).toBe(true);
    expect(out.metrics.period).toBe("last_24h");
    expect(out.headline.status).toBeDefined();
  });

  it("diagnostics route returns findings with severity counts", async () => {
    delete process.env.MAGIC_LINK_SECRET;
    const body = await (await routes.diagnostics.GET(await asUser(ADMIN))).json();
    expect(body.findings.find((f) => f.code === "missing_magic_link_secret")).toMatchObject({ severity: "high" });
    expect(body.counts.high).toBeGreaterThan(0);
  });
});
