import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/db.js", async () => {
  const { makePrismaMock } = await import("./platform-helpers.js");
  return { default: makePrismaMock() };
});
vi.mock("@/lib/alerts.js", () => ({ alertError: vi.fn(async () => ({})), alertEvent: vi.fn(async () => ({})) }));
vi.mock("@/lib/mailer.js", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, sendMail: vi.fn(async () => ({ delivered: false, loggedToConsole: true })) };
});

const prisma = (await import("@/lib/db.js")).default;
const auth = await import("@/lib/auth.js");
const { alertEvent } = await import("@/lib/alerts.js");
const { sendMail } = await import("@/lib/mailer.js");
const { _resetRateLimits } = await import("@/lib/rate-limit.js");
const { jsonRequest, snapshotEnv } = await import("./platform-helpers.js");
const requestLink = await import("@/app/api/auth/request-link/route.js");
const verify = await import("@/app/api/auth/verify/route.js");
const logout = await import("@/app/api/auth/logout/route.js");
const logoutAll = await import("@/app/api/auth/logout-all/route.js");
const meAuth = await import("@/app/api/auth/me/route.js");
const me = await import("@/app/api/me/route.js");

const TOKEN = "c".repeat(64);
const USER = { id: "u1", email: "reader@example.com", displayName: null, locale: "en", helpLevel: 1, onboardedAt: null, sessionVersion: 0 };

let restoreEnv;
beforeEach(() => {
  restoreEnv = snapshotEnv();
  process.env.JWT_SECRET = "j".repeat(64);
  process.env.MAGIC_LINK_SECRET = "m".repeat(64);
  process.env.BASE_URL = "http://localhost:3000";
  process.env.ADMIN_EMAILS = "admin@example.test";
  delete process.env.SMTP_HOST;
  prisma._reset();
  _resetRateLimits();
  vi.mocked(alertEvent).mockClear();
  vi.mocked(sendMail).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => restoreEnv());

async function sessionCookieFor(user = USER) {
  return `${auth.SESSION_COOKIE}=${await auth.createSessionToken(user)}`;
}

describe("magic tokens", () => {
  it("hashes with purpose scoping and never stores the plaintext", async () => {
    expect(auth.hashToken(TOKEN, "login")).not.toBe(auth.hashToken(TOKEN, "signup"));
    prisma.user.findUnique.mockResolvedValue(null);
    const { plaintext, expiresAt } = await auth.issueMagicToken("reader@example.com");
    expect(plaintext).toMatch(auth.TOKEN_PATTERN);
    const data = prisma.magicToken.create.mock.calls[0][0].data;
    expect(data.tokenHash).toBe(auth.hashToken(plaintext, "login"));
    expect(JSON.stringify(data)).not.toContain(plaintext);
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000);
  });

  it("invalidates older unconsumed tokens for the same email before minting", async () => {
    await auth.issueMagicToken("reader@example.com");
    const { where, data } = prisma.magicToken.updateMany.mock.calls[0][0];
    expect(where).toMatchObject({ email: "reader@example.com", purpose: "login", consumed: false });
    expect(data.expiresAt).toBeInstanceOf(Date);
    expect(prisma.magicToken.updateMany.mock.invocationCallOrder[0]).toBeLessThan(prisma.magicToken.create.mock.invocationCallOrder[0]);
  });

  it("distinguishes invalid, used and expired", async () => {
    expect(await auth.verifyMagicToken("short", "login")).toEqual({ valid: false, reason: "link_invalid" });
    expect(await auth.verifyMagicToken(42, "login")).toEqual({ valid: false, reason: "link_invalid" });
    prisma.magicToken.findUnique.mockResolvedValueOnce(null);
    expect((await auth.verifyMagicToken(TOKEN, "login")).reason).toBe("link_invalid");
    prisma.magicToken.findUnique.mockResolvedValueOnce({ id: "t", purpose: "signup", consumed: false, expiresAt: new Date(Date.now() + 1e5) });
    expect((await auth.verifyMagicToken(TOKEN, "login")).reason).toBe("link_invalid");
    prisma.magicToken.findUnique.mockResolvedValueOnce({ id: "t", purpose: "login", consumed: true, expiresAt: new Date(Date.now() + 1e5) });
    expect((await auth.verifyMagicToken(TOKEN, "login")).reason).toBe("link_used");
    prisma.magicToken.findUnique.mockResolvedValueOnce({ id: "t", purpose: "login", consumed: false, expiresAt: new Date(Date.now() - 1) });
    expect((await auth.verifyMagicToken(TOKEN, "login")).reason).toBe("link_expired");
  });

  it("consumes atomically with a count check", async () => {
    prisma.magicToken.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    expect(await auth.consumeMagicToken("t")).toBe(true);
    expect(await auth.consumeMagicToken("t")).toBe(false);
    expect(prisma.magicToken.updateMany.mock.calls[0][0].where).toEqual({ id: "t", consumed: false });
  });
});

describe("sessions", () => {
  const withCookie = (token) => new Request("http://x/", { headers: { cookie: `${auth.SESSION_COOKIE}=${token}` } });

  it("round-trips via the session cookie", async () => {
    const token = await auth.createSessionToken(USER);
    const viaCookie = new Request("http://x/", { headers: { cookie: `other=1; ${auth.SESSION_COOKIE}=${token}` } });
    expect(await auth.getSession(viaCookie)).toEqual({ userId: "u1", email: USER.email, sessionVersion: 0 });
  });

  it("[SEC-10] ignores Authorization: Bearer (cookie-only sessions)", async () => {
    const token = await auth.createSessionToken(USER);
    expect(await auth.getSession(new Request("http://x/", { headers: { authorization: `Bearer ${token}` } }))).toBeNull();
  });

  it("rejects tampered or foreign-key tokens", async () => {
    const token = await auth.createSessionToken(USER);
    const tampered = token.slice(0, -2) + (token.endsWith("A") ? "BB" : "AA");
    expect(await auth.getSession(withCookie(tampered))).toBeNull();
    process.env.JWT_SECRET = "k".repeat(64);
    expect(await auth.getSession(withCookie(token))).toBeNull();
  });

  it("fails closed when JWT_SECRET is missing", async () => {
    const token = await auth.createSessionToken(USER);
    delete process.env.JWT_SECRET;
    expect(await auth.getSession(withCookie(token))).toBeNull();
    await expect(auth.createSessionToken(USER)).rejects.toThrow(/JWT_SECRET/);
  });

  it("[SEC-11] refuses a JWT_SECRET shorter than 32 characters", async () => {
    process.env.JWT_SECRET = "x";
    await expect(auth.createSessionToken(USER)).rejects.toThrow(/shorter than 32/);
    process.env.MAGIC_LINK_SECRET = "short-secret";
    expect(() => auth.hashToken(TOKEN, "login")).toThrow(/MAGIC_LINK_SECRET/);
  });

  it("fails closed when MAGIC_LINK_SECRET is missing", () => {
    delete process.env.MAGIC_LINK_SECRET;
    expect(() => auth.hashToken(TOKEN, "login")).toThrow(/MAGIC_LINK_SECRET/);
  });

  it("sets an httpOnly SameSite=Lax cookie, Secure only in production", () => {
    const dev = auth.setSessionCookie(new Response(null), "tok").headers.get("set-cookie");
    expect(dev).toMatch(/aha_session=tok/);
    expect(dev).toMatch(/HttpOnly/);
    expect(dev).toMatch(/SameSite=Lax/);
    expect(dev).toMatch(/Max-Age=2592000/);
    expect(dev).not.toMatch(/Secure/);
    process.env.NODE_ENV = "production";
    expect(auth.setSessionCookie(new Response(null), "tok").headers.get("set-cookie")).toMatch(/Secure/);
  });

  it("requireUser returns 401 unauthenticated without a session or for a deleted user", async () => {
    const none = await auth.requireUser(new Request("http://x/"));
    expect(none.response.status).toBe(401);
    expect(await none.response.json()).toMatchObject({ error: "unauthenticated" });
    prisma.user.findUnique.mockResolvedValue(null);
    const gone = await auth.requireUser(new Request("http://x/", { headers: { cookie: await sessionCookieFor() } }));
    expect(gone.response.status).toBe(401);
  });
});

describe("admin role", () => {
  it("normalises case and whitespace; empty list means nobody", () => {
    process.env.ADMIN_EMAILS = " Admin@Example.test , other@example.com";
    expect(auth.isAdminEmail("admin@example.TEST ")).toBe(true);
    expect(auth.isAdminEmail("nobody@example.com")).toBe(false);
    expect(auth.isAdminEmail(undefined)).toBe(false);
    process.env.ADMIN_EMAILS = "";
    expect(auth.isAdminEmail("admin@example.test")).toBe(false);
  });

  it("requireAdmin: 401 without session, 403 non-admin, ok for admin", async () => {
    expect((await auth.requireAdmin(new Request("http://x/"))).response.status).toBe(401);
    prisma.user.findUnique.mockResolvedValue(USER);
    const r = new Request("http://x/", { headers: { cookie: await sessionCookieFor() } });
    expect((await auth.requireAdmin(r)).response.status).toBe(403);
    const admin = { ...USER, email: "admin@example.test" };
    prisma.user.findUnique.mockResolvedValue(admin);
    const ok = await auth.requireAdmin(new Request("http://x/", { headers: { cookie: await sessionCookieFor(admin) } }));
    expect(ok.user.email).toBe("admin@example.test");
  });
});

describe("safeNextPath", () => {
  it.each([["/read", "/read"], ["/notebook?tag=a", "/notebook?tag=a"]])("keeps %s", (input, out) => {
    expect(auth.safeNextPath(input)).toBe(out);
  });
  it.each(["//evil.com", "/\\evil.com", "https://evil.com", "read", "", null, 5, "/a\nb", "javascript:alert(1)"])(
    "rejects %p",
    (input) => {
      expect(auth.safeNextPath(input)).toBeNull();
    }
  );
});

describe("POST /api/auth/request-link", () => {
  const post = (body, headers) => requestLink.POST(jsonRequest("/api/auth/request-link", { body, headers }));

  it("returns 200 with expiry and a devLink built from BASE_URL, ignoring the Host header", async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const res = await post({ email: " Reader@Example.com ", next: "/notebook" }, { host: "evil.example", "x-forwarded-host": "evil.example" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, expiresInMinutes: 15 });
    expect(body.message).toMatch(/15 minutes/);
    expect(body.message).toMatch(/spam/);
    expect(body.devLink).toMatch(/^http:\/\/localhost:3000\/auth\/verify\?token=[a-f0-9]{64}&next=%2Fnotebook$/);
    expect(prisma.magicToken.create.mock.calls[0][0].data.email).toBe("reader@example.com");
    expect(sendMail).toHaveBeenCalledOnce();
  });

  it("does not wait for the email to send", async () => {
    vi.mocked(sendMail).mockReturnValueOnce(new Promise(() => {}));
    const res = await post({ email: "reader@example.com" });
    expect(res.status).toBe(200);
  });

  it("drops an unsafe next path", async () => {
    const body = await (await post({ email: "reader@example.com", next: "//evil.com" })).json();
    expect(body.devLink).not.toMatch(/next=/);
  });

  it("omits devLink in production and when SMTP is configured", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_USER = "u@example.com";
    process.env.SMTP_PASS = "p";
    expect((await (await post({ email: "reader@example.com" })).json()).devLink).toBeUndefined();
    delete process.env.SMTP_HOST;
    process.env.NODE_ENV = "production";
    expect((await (await post({ email: "reader2@example.com" })).json()).devLink).toBeUndefined();
  });

  it("names the fix for a bad address", async () => {
    const res = await post({ email: "reader.example.com" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_input", field: "email", message: expect.stringMatching(/Add an @/) });
  });

  it("rate limits 5 per 15 minutes per IP", async () => {
    const ip = { "x-forwarded-for": "9.9.9.9" };
    for (let i = 0; i < 5; i++) expect((await post({ email: `r${i}@example.com` }, ip)).status).toBe(200);
    const res = await post({ email: "r9@example.com" }, ip);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  it("rate limits per email across IPs", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await post({ email: "same@example.com" }, { "x-forwarded-for": `1.1.1.${i}` })).status).toBe(200);
    }
    expect((await post({ email: "same@example.com" }, { "x-forwarded-for": "2.2.2.2" })).status).toBe(429);
  });
});

describe("POST /api/auth/verify", () => {
  const post = (body) => verify.POST(jsonRequest("/api/auth/verify", { body }));
  const live = { id: "t1", purpose: "login", consumed: false, email: USER.email, userId: null, expiresAt: new Date(Date.now() + 60_000) };

  it("creates the user on first sign-in, sets the cookie, alerts, and consumes last", async () => {
    prisma.magicToken.findUnique.mockResolvedValue(live);
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue(USER);
    prisma.magicToken.updateMany.mockResolvedValue({ count: 1 });
    const res = await post({ token: TOKEN, next: "/notebook" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, next: "/notebook", user: { id: "u1", email: USER.email, isAdmin: false } });
    expect(res.headers.get("set-cookie")).toMatch(/^aha_session=ey/);
    expect(alertEvent).toHaveBeenCalledWith("New user signup", expect.objectContaining({ email: "r***@example.com" }));
    expect(prisma.user.create.mock.invocationCallOrder[0]).toBeLessThan(prisma.magicToken.updateMany.mock.invocationCallOrder[0]);
  });

  it("does not alert for a returning user and defaults next", async () => {
    prisma.magicToken.findUnique.mockResolvedValue(live);
    prisma.user.findUnique.mockResolvedValue(USER);
    prisma.magicToken.updateMany.mockResolvedValue({ count: 1 });
    const body = await (await post({ token: TOKEN, next: "//evil.com" })).json();
    expect(body.next).toBe("/read");
    expect(alertEvent).not.toHaveBeenCalled();
  });

  it("reports link_used when a concurrent request claimed the token first", async () => {
    prisma.magicToken.findUnique.mockResolvedValue(live);
    prisma.user.findUnique.mockResolvedValue(USER);
    prisma.magicToken.updateMany.mockResolvedValue({ count: 0 });
    const res = await post({ token: TOKEN });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("link_used");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it.each([
    [{ ...live, consumed: true }, "link_used"],
    [{ ...live, expiresAt: new Date(Date.now() - 1000) }, "link_expired"],
    [null, "link_invalid"],
  ])("returns 400 %#", async (record, code) => {
    prisma.magicToken.findUnique.mockResolvedValue(record);
    const res = await post({ token: TOKEN });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(code);
    expect(body.message).toMatch(/request a new/i);
  });

  it("has no GET handler (scanners must not consume links)", () => {
    expect(verify.GET).toBeUndefined();
  });
});

describe("session routes", () => {
  it("logout clears the cookie", async () => {
    const res = await logout.POST();
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/aha_session=; .*Max-Age=0/);
  });

  it("GET /api/auth/me returns the user with isAdmin, or 401", async () => {
    expect((await meAuth.GET(new Request("http://x/api/auth/me"))).status).toBe(401);
    const admin = { ...USER, email: "admin@example.test" };
    prisma.user.findUnique.mockResolvedValue(admin);
    const res = await meAuth.GET(new Request("http://x/api/auth/me", { headers: { cookie: await sessionCookieFor(admin) } }));
    expect(await res.json()).toEqual({
      user: { id: "u1", email: "admin@example.test", displayName: null, locale: "en", helpLevel: 1, onboardedAt: null, isAdmin: true },
    });
  });

  it("PATCH /api/me updates allowed fields and sets onboardedAt once", async () => {
    prisma.user.findUnique.mockResolvedValue(USER);
    prisma.user.update.mockImplementation(async ({ data }) => ({ ...USER, ...data }));
    const res = await me.PATCH(jsonRequest("/api/me", {
      method: "PATCH",
      body: { displayName: "  Ana ", locale: "zh", helpLevel: 3, onboarded: true },
      headers: { cookie: await sessionCookieFor() },
    }));
    expect(res.status).toBe(200);
    const data = prisma.user.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ displayName: "Ana", locale: "zh", helpLevel: 3 });
    expect(data.onboardedAt).toBeInstanceOf(Date);
    expect(prisma.user.update.mock.calls[0][0].where).toEqual({ id: "u1" });
  });

  it("DELETE /api/me requires confirm and cascades", async () => {
    prisma.user.findUnique.mockResolvedValue(USER);
    const cookie = await sessionCookieFor();
    const missing = await me.DELETE(jsonRequest("/api/me", { method: "DELETE", body: { confirm: "yes" }, headers: { cookie } }));
    expect(missing.status).toBe(400);
    expect((await missing.json()).field).toBe("confirm");
    expect(prisma.user.delete).not.toHaveBeenCalled();

    const ok = await me.DELETE(jsonRequest("/api/me", { method: "DELETE", body: { confirm: "DELETE" }, headers: { cookie } }));
    expect(ok.status).toBe(200);
    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: "u1" } });
    expect(prisma.magicToken.deleteMany).toHaveBeenCalledWith({ where: { email: USER.email } });
    expect(ok.headers.get("set-cookie")).toMatch(/Max-Age=0/);
  });

  it("PATCH and DELETE require a session", async () => {
    expect((await me.PATCH(jsonRequest("/api/me", { method: "PATCH", body: { locale: "en" } }))).status).toBe(401);
    expect((await me.DELETE(jsonRequest("/api/me", { method: "DELETE", body: { confirm: "DELETE" } }))).status).toBe(401);
  });
});

describe("[PO-1] sign-in codes", () => {
  const post = (body) => verify.POST(jsonRequest("/api/auth/verify", { body }));
  const tokenHash = "a".repeat(64);
  const row = (code, extra = {}) => ({
    id: "t1", purpose: "login", consumed: false, email: USER.email, userId: null, tokenHash,
    codeHash: auth.hashCode(code, tokenHash, "login"), attempts: 0, next: null, expiresAt: new Date(Date.now() + 60_000), ...extra,
  });

  it("issueMagicToken stores only the code's HMAC (salted per row), purges old rows, all in one transaction", async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const { code, plaintext } = await auth.issueMagicToken(USER.email, { next: "/review" });
    expect(code).toMatch(/^\d{6}$/);
    const data = prisma.magicToken.create.mock.calls[0][0].data;
    expect(data.codeHash).toBe(auth.hashCode(code, auth.hashToken(plaintext, "login"), "login"));
    expect(JSON.stringify(data)).not.toContain(`"${code}"`);
    expect(data.next).toBe("/review");
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(prisma.magicToken.deleteMany.mock.calls[0][0].where.expiresAt.lt).toBeInstanceOf(Date);
  });

  it("request-link returns codeLength and (dev only) devCode, and the email carries the code", async () => {
    const body = await (await requestLink.POST(jsonRequest("/api/auth/request-link", { body: { email: USER.email } }))).json();
    expect(body.codeLength).toBe(6);
    expect(body.devCode).toMatch(/^\d{6}$/);
    const mail = vi.mocked(sendMail).mock.calls[0][0];
    expect(mail.text).toContain(`${body.devCode.slice(0, 3)} ${body.devCode.slice(3)}`);
    process.env.NODE_ENV = "production";
    const prod = await (await requestLink.POST(jsonRequest("/api/auth/request-link", { body: { email: "other@example.com" } }))).json();
    expect(prod.devCode).toBeUndefined();
    expect(prod.codeLength).toBe(6);
  });

  it("a correct code signs in, consumes the row, and uses the next saved at request time", async () => {
    prisma.magicToken.findFirst.mockResolvedValue(row("123456", { next: "/notebook/abc" }));
    prisma.magicToken.updateMany.mockResolvedValue({ count: 1 });
    prisma.user.findUnique.mockResolvedValue(USER);
    const res = await post({ email: " Reader@Example.com ", code: "123 456" });
    expect(res.status).toBe(200);
    expect((await res.json()).next).toBe("/notebook/abc");
    expect(res.headers.get("set-cookie")).toMatch(/^aha_session=ey/);
    expect(prisma.magicToken.findFirst.mock.calls[0][0].where).toEqual({ email: USER.email, purpose: "login" });
  });

  it("a wrong code is code_invalid with attemptsLeft, and spends an attempt atomically", async () => {
    prisma.magicToken.findFirst.mockResolvedValue(row("123456", { attempts: 2 }));
    prisma.magicToken.updateMany.mockResolvedValue({ count: 1 });
    const res = await post({ email: USER.email, code: "654321" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "code_invalid", attemptsLeft: 2 });
    expect(prisma.magicToken.updateMany.mock.calls[0][0]).toEqual({
      where: { id: "t1", consumed: false, attempts: { lt: 5 } },
      data: { attempts: { increment: 1 } },
    });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("locks after 5 wrong attempts (even the right code), and a lost race also locks", async () => {
    prisma.magicToken.findFirst.mockResolvedValueOnce(row("123456", { attempts: 5 }));
    expect((await (await post({ email: USER.email, code: "123456" })).json()).error).toBe("code_locked");
    prisma.magicToken.findFirst.mockResolvedValueOnce(row("123456", { attempts: 4 }));
    prisma.magicToken.updateMany.mockResolvedValueOnce({ count: 0 });
    expect((await (await post({ email: USER.email, code: "123456" })).json()).error).toBe("code_locked");
  });

  it("expired / used rows and malformed codes", async () => {
    prisma.magicToken.findFirst.mockResolvedValueOnce(row("123456", { expiresAt: new Date(Date.now() - 1) }));
    expect((await (await post({ email: USER.email, code: "123456" })).json()).error).toBe("link_expired");
    prisma.magicToken.findFirst.mockResolvedValueOnce(row("123456", { consumed: true }));
    expect((await (await post({ email: USER.email, code: "123456" })).json()).error).toBe("link_used");
    const bad = await post({ email: USER.email, code: "12ab" });
    expect(await bad.json()).toMatchObject({ error: "invalid_input", field: "code" });
    prisma.magicToken.findFirst.mockResolvedValueOnce(null);
    expect(await (await post({ email: USER.email, code: "123456" })).json()).toMatchObject({ error: "code_invalid", attemptsLeft: 0 });
  });
});

describe("[QA-6][ENG-4] next after sign-in", () => {
  const post = (body) => verify.POST(jsonRequest("/api/auth/verify", { body }));
  const live = { id: "t1", purpose: "login", consumed: false, email: USER.email, userId: null, expiresAt: new Date(Date.now() + 60_000) };
  beforeEach(() => {
    prisma.user.findUnique.mockResolvedValue(USER);
    prisma.magicToken.updateMany.mockResolvedValue({ count: 1 });
  });

  it("uses the next embedded at request time when the body has none", async () => {
    prisma.magicToken.findUnique.mockResolvedValue({ ...live, next: "/review" });
    expect((await (await post({ token: TOKEN })).json()).next).toBe("/review");
  });
  it("a safe next in the body wins over the stored one", async () => {
    prisma.magicToken.findUnique.mockResolvedValue({ ...live, next: "/review" });
    expect((await (await post({ token: TOKEN, next: "/notebook" })).json()).next).toBe("/notebook");
  });
  it("auth pages are never a next target (would loop)", () => {
    for (const p of ["/", "/login", "/login?next=/x", "/auth/verify?token=x"]) expect(auth.safeNextPath(p)).toBeNull();
  });
});

describe("[SEC-1] request-link abuse limits", () => {
  const post = (email, ip) => requestLink.POST(jsonRequest("/api/auth/request-link", { body: { email }, headers: { "x-real-ip": ip } }));

  it("one mailbox bucket for +tags, dots (gmail) and case", async () => {
    const variants = ["victim@gmail.com", "Victim+1@gmail.com", "v.ictim@gmail.com", "victim+x@googlemail.com", "VICTIM@GMAIL.COM"];
    for (const [i, e] of variants.entries()) expect((await post(e, `10.0.0.${i}`)).status).toBe(200);
    expect((await post("vic.tim+again@gmail.com", "10.0.1.1")).status).toBe(429);
  });

  it("an app-wide ceiling of 200 per 15 minutes holds when IP and mailbox both rotate", async () => {
    for (let i = 0; i < 200; i++) expect((await post(`user${i}@example.com`, `10.1.${i >> 8}.${i & 255}`)).status).toBe(200);
    expect((await post("one-more@example.com", "10.9.9.9")).status).toBe(429);
  });
});

describe("[PO-5] deleted user with a valid JWT", () => {
  it("requireUser clears the cookie and answers 401", async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const res = await meAuth.GET(new Request("http://x/api/auth/me", { headers: { cookie: await sessionCookieFor() } }));
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toMatch(/aha_session=; .*Max-Age=0/);
  });
});

describe("[SEC-10] sign out of all devices (sessionVersion)", () => {
  const meReq = async (user) => new Request("http://x/api/auth/me", { headers: { cookie: await sessionCookieFor(user) } });

  it("puts sv in the JWT and accepts it while it matches", async () => {
    const user = { ...USER, sessionVersion: 3 };
    prisma.user.findUnique.mockResolvedValue(user);
    const session = await auth.getSession(await meReq(user));
    expect(session.sessionVersion).toBe(3);
    expect((await meAuth.GET(await meReq(user))).status).toBe(200);
  });

  it("rejects a JWT whose sv is stale, and clears the cookie", async () => {
    prisma.user.findUnique.mockResolvedValue({ ...USER, sessionVersion: 1 });
    const res = await meAuth.GET(await meReq({ ...USER, sessionVersion: 0 }));
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toMatch(/aha_session=; .*Max-Age=0/);
  });

  it("treats a JWT minted before sv existed as version 0", async () => {
    const { SignJWT } = await import("jose");
    const legacy = await new SignJWT({ email: USER.email }).setProtectedHeader({ alg: "HS256" }).setSubject(USER.id)
      .setIssuedAt().setExpirationTime("1d").sign(new TextEncoder().encode(process.env.JWT_SECRET));
    const req = new Request("http://x/", { headers: { cookie: `${auth.SESSION_COOKIE}=${legacy}` } });
    prisma.user.findUnique.mockResolvedValue({ ...USER, sessionVersion: 0 });
    expect((await auth.requireUser(req)).user).toBeTruthy();
    prisma.user.findUnique.mockResolvedValue({ ...USER, sessionVersion: 1 });
    expect((await auth.requireUser(req)).response.status).toBe(401);
  });

  it("POST /api/auth/logout-all bumps sessionVersion and clears this cookie", async () => {
    prisma.user.findUnique.mockResolvedValue({ ...USER, sessionVersion: 0 });
    prisma.user.update.mockResolvedValue({});
    const res = await logoutAll.POST(jsonRequest("/api/auth/logout-all", {
      body: {}, headers: { cookie: await sessionCookieFor({ ...USER, sessionVersion: 0 }) },
    }));
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: USER.id }, data: { sessionVersion: { increment: 1 } } });
    expect(res.headers.get("set-cookie")).toMatch(/aha_session=; .*Max-Age=0/);
  });

  it("logout-all needs a session", async () => {
    const res = await logoutAll.POST(jsonRequest("/api/auth/logout-all", { body: {} }));
    expect(res.status).toBe(401);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("publicUser never exposes sessionVersion", () => {
    expect(auth.publicUser({ ...USER, sessionVersion: 7 })).not.toHaveProperty("sessionVersion");
  });
});
