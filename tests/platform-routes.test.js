import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/db.js", async () => {
  const { makePrismaMock } = await import("./platform-helpers.js");
  return { default: makePrismaMock() };
});
vi.mock("@/lib/alerts.js", () => ({ alertError: vi.fn(async () => ({})), alertEvent: vi.fn(async () => ({})) }));
vi.mock("@/lib/mailer.js", async (importOriginal) => ({ ...(await importOriginal()), sendMail: vi.fn(async () => ({ delivered: true })) }));

const prisma = (await import("@/lib/db.js")).default;
const { createSessionToken, SESSION_COOKIE } = await import("@/lib/auth.js");
const { logger } = await import("@/lib/logger.js");
const { _resetRateLimits } = await import("@/lib/rate-limit.js");
const { jsonRequest, snapshotEnv, fakeCreds } = await import("./platform-helpers.js");
const requestLink = await import("@/app/api/auth/request-link/route.js");
const verify = await import("@/app/api/auth/verify/route.js");
const me = await import("@/app/api/me/route.js");
const clientError = await import("@/app/api/client-error/route.js");
const catchAll = await import("@/app/api/[...catchall]/route.js");

const USER = { id: "u1", email: "reader@example.com", displayName: null, locale: "en", helpLevel: 1, onboardedAt: null, sessionVersion: 0 };
let restore;
let cookie;
beforeEach(async () => {
  restore = snapshotEnv();
  process.env.JWT_SECRET = "j".repeat(64);
  process.env.MAGIC_LINK_SECRET = "m".repeat(64);
  prisma._reset();
  prisma.user.findUnique.mockResolvedValue(USER);
  _resetRateLimits();
  cookie = `${SESSION_COOKIE}=${await createSessionToken(USER)}`;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  restore();
  vi.restoreAllMocks();
});

const MALFORMED = ["{not json", "", "null", "[]", "42"];

describe("malformed bodies are 400, never 500", () => {
  const cases = {
    "request-link": (body) => requestLink.POST(jsonRequest("/api/auth/request-link", { body })),
    verify: (body) => verify.POST(jsonRequest("/api/auth/verify", { body })),
    "me PATCH": (body) => me.PATCH(jsonRequest("/api/me", { method: "PATCH", body, headers: { cookie } })),
    "me DELETE": (body) => me.DELETE(jsonRequest("/api/me", { method: "DELETE", body, headers: { cookie } })),
    "client-error": (body) => clientError.POST(jsonRequest("/api/client-error", { body })),
  };
  for (const [name, call] of Object.entries(cases)) {
    it.each(MALFORMED)(`${name} with body %p`, async (body) => {
      const res = await call(body);
      expect(res.status).toBe(400);
      expect(typeof (await res.json()).error).toBe("string");
    });
  }
});

describe("wrong types are 400 with a field", () => {
  it.each([[{ email: 42 }], [{ email: ["a@b.com"] }], [{ email: { x: 1 } }], [{}]])("request-link %p", async (body) => {
    const res = await requestLink.POST(jsonRequest("/api/auth/request-link", { body }));
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe("email");
  });

  it.each([[{ token: 42 }], [{ token: null }], [{ token: ["x"] }], [{}]])("verify %p", async (body) => {
    const res = await verify.POST(jsonRequest("/api/auth/verify", { body }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("link_invalid");
  });

  it.each([
    [{ displayName: 5 }, "displayName"],
    [{ displayName: "x".repeat(101) }, "displayName"],
    [{ locale: "fr" }, "locale"],
    [{ locale: 1 }, "locale"],
    [{ helpLevel: "2" }, "helpLevel"],
    [{ helpLevel: 4 }, "helpLevel"],
    [{ helpLevel: 1.5 }, "helpLevel"],
    [{ onboarded: "yes" }, "onboarded"],
    [{}, undefined],
  ])("me PATCH %p", async (body, field) => {
    const res = await me.PATCH(jsonRequest("/api/me", { method: "PATCH", body, headers: { cookie } }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("invalid_input");
    expect(json.field).toBe(field);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it.each([[{ confirm: true }], [{ confirm: "delete" }], [{}]])("me DELETE %p", async (body) => {
    const res = await me.DELETE(jsonRequest("/api/me", { method: "DELETE", body, headers: { cookie } }));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/client-error", () => {
  const post = (body, headers) => clientError.POST(jsonRequest("/api/client-error", { body, headers }));

  it("logs at source client, capped and redacted, and returns 204", async () => {
    const spy = vi.spyOn(logger, "error").mockResolvedValue();
    const key = fakeCreds.openai();
    const res = await post({ kind: "render", message: `boom ${key} ${"x".repeat(2000)}`, stack: "s".repeat(9000), url: "https://aha.example.com/auth/verify?token=abc" });
    expect(res.status).toBe(204);
    const [source, message, detail] = spy.mock.calls[0];
    expect(source).toBe("client");
    expect(message).toBe("Client render error");
    expect(detail.message).not.toContain(key);
    expect(detail.message.length).toBeLessThanOrEqual(520);
    expect(detail.stack.length).toBeLessThanOrEqual(2020);
    expect(detail.path).toBe("/auth/verify");
  });

  it("maps unknown kinds to a constant message", async () => {
    const spy = vi.spyOn(logger, "error").mockResolvedValue();
    await post({ kind: "<script>", message: "x" });
    expect(spy.mock.calls[0][1]).toBe("Client error reported");
  });

  it("rate limits 10 per minute per IP", async () => {
    vi.spyOn(logger, "error").mockResolvedValue();
    const ip = { "x-forwarded-for": "5.5.5.5" };
    for (let i = 0; i < 10; i++) expect((await post({ message: "x" }, ip)).status).toBe(204);
    expect((await post({ message: "x" }, ip)).status).toBe(429);
  });

  it("[ENG-10] accepts the real client payload: source/digest kept, a boundary source means a render error", async () => {
    const spy = vi.spyOn(logger, "error").mockResolvedValue();
    await post({ message: "x", source: "route", digest: "1234567890", componentStack: "at A" });
    const [, message, detail] = spy.mock.calls[0];
    expect(message).toBe("Client render error");
    expect(detail).toMatchObject({ source: "route", digest: "1234567890" });
  });

  it("[SEC-16] an app-wide cap holds when the IP rotates", async () => {
    vi.spyOn(logger, "error").mockResolvedValue();
    const statuses = [];
    for (let i = 0; i < 305; i++) statuses.push((await post({ message: "x" }, { "x-real-ip": `10.2.${i >> 8}.${i & 255}` })).status);
    expect(statuses.filter((s) => s === 204)).toHaveLength(300);
    expect(statuses.at(-1)).toBe(429);
  });

  it("[SEC-9] refuses a cross-site post", async () => {
    expect((await post({ message: "x" }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
  });

  it("never 500s, even if the logger throws", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => {
      throw new Error("logger exploded");
    });
    expect((await post({ message: "x" })).status).toBe(204);
  });
});

describe("unknown /api routes", () => {
  it.each(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])("%s -> 404 not_found JSON", async (method) => {
    const res = await catchAll[method]();
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_found");
  });
});
