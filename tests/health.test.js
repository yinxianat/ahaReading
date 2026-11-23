import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/db.js", async () => {
  const { makePrismaMock } = await import("./platform-helpers.js");
  return { default: makePrismaMock() };
});
vi.mock("@/lib/alerts.js", () => ({ alertError: vi.fn(async () => ({})), alertEvent: vi.fn(async () => ({})) }));
const chain = vi.hoisted(() => ({ status: [], throws: false }));
vi.mock("@/lib/ai/index.js", () => ({
  getChainStatus: () => {
    if (chain.throws) throw new Error("ai module broken");
    return chain.status;
  },
}));

const prisma = (await import("@/lib/db.js")).default;
const { GET } = await import("@/app/api/health/route.js");
const { alertError } = await import("@/lib/alerts.js");
const { snapshotEnv } = await import("./platform-helpers.js");

let restore;
beforeEach(() => {
  restore = snapshotEnv();
  prisma._reset();
  prisma.user.count.mockResolvedValue(3);
  chain.status = [{ name: "anthropic", registered: true, configured: true, defaultModel: "claude-opus-5-5" }];
  chain.throws = false;
  process.env.JWT_SECRET = "j".repeat(64);
  process.env.MAGIC_LINK_SECRET = "m".repeat(64);
  process.env.BASE_URL = "https://aha.example.com";
  process.env.SMTP_HOST = "smtp.example.com";
  process.env.SMTP_USER = "mailer@example.com";
  process.env.SMTP_PASS = "app-password-value";
  delete process.env.SMTP_USERNAME;
  delete process.env.SMTP_PASSWORD;
  vi.mocked(alertError).mockClear();
});
afterEach(() => restore());

async function check() {
  const res = await GET();
  return { status: res.status, body: await res.json() };
}

describe("GET /api/health", () => {
  it("200 ok when everything is in place", async () => {
    const { status, body } = await check();
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: "ok", fatal: [], warnings: [], checks: { database: "ok", secrets: "ok", ai: ["anthropic"], smtp: "configured" } });
  });

  it("503 when the database is unreachable", async () => {
    prisma.user.count.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const { status, body } = await check();
    expect(status).toBe(503);
    expect(body.fatal).toContain("database_unreachable");
    expect(alertError).toHaveBeenCalled();
  });

  it("503 migrations_not_applied when the schema is missing", async () => {
    prisma.user.count.mockRejectedValue(Object.assign(new Error("table does not exist"), { code: "P2021" }));
    expect((await check()).body.fatal).toContain("migrations_not_applied");
  });

  it.each([["JWT_SECRET", "missing_jwt_secret"], ["MAGIC_LINK_SECRET", "missing_magic_link_secret"]])(
    "503 when %s is missing",
    async (name, code) => {
      delete process.env[name];
      const { status, body } = await check();
      expect(status).toBe(503);
      expect(body.fatal).toContain(code);
    }
  );

  it("503 in production without BASE_URL or with an unexpanded template", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.BASE_URL;
    expect((await check()).body.fatal).toContain("missing_base_url");
    process.env.BASE_URL = "https://${{RAILWAY_PUBLIC_DOMAIN}}";
    const { status, body } = await check();
    expect(status).toBe(503);
    expect(body.fatal).toContain("base_url_unresolved_template");
  });

  it("missing BASE_URL outside production is not fatal", async () => {
    delete process.env.BASE_URL;
    expect((await check()).status).toBe(200);
  });

  it("200 degraded with no AI provider", async () => {
    chain.status = [{ name: "anthropic", registered: true, configured: false, defaultModel: "x" }];
    const { status, body } = await check();
    expect(status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.warnings).toContain("no_ai_provider");
  });

  it("200 degraded when the AI module throws", async () => {
    chain.throws = true;
    const { status, body } = await check();
    expect(status).toBe(200);
    expect(body.warnings).toContain("ai_status_unavailable");
  });

  it("200 degraded when SMTP is missing or has no password", async () => {
    delete process.env.SMTP_HOST;
    expect((await check()).body.warnings).toContain("smtp_not_configured");
    process.env.SMTP_HOST = "smtp.example.com";
    delete process.env.SMTP_PASS;
    const { status, body } = await check();
    expect(status).toBe(200);
    expect(body.warnings).toContain("smtp_credentials_incomplete");
  });

  it("accepts SMTP_USERNAME/SMTP_PASSWORD as the credential pair", async () => {
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    process.env.SMTP_USERNAME = "mailer@example.com";
    process.env.SMTP_PASSWORD = "app-password-value";
    expect((await check()).body.checks.smtp).toBe("configured");
  });

  it("never exposes secret values", async () => {
    delete process.env.MAGIC_LINK_SECRET;
    const text = JSON.stringify((await check()).body);
    for (const v of [process.env.JWT_SECRET, process.env.SMTP_PASS, process.env.SMTP_USER, process.env.BASE_URL]) {
      expect(text).not.toContain(v);
    }
  });

  it("[SEC-11] 503 when a secret is shorter than 32 characters", async () => {
    process.env.JWT_SECRET = "short";
    const { status, body } = await check();
    expect(status).toBe(503);
    expect(body.fatal).toContain("weak_jwt_secret");
    expect(body.checks.secrets).toBe("weak");
  });

  it("[ENG-3] a database that never answers gives 503 database_timeout within ~3 s", async () => {
    prisma.user.count.mockReturnValue(new Promise(() => {}));
    vi.useFakeTimers();
    try {
      const pending = GET();
      await vi.advanceTimersByTimeAsync(3001);
      const res = await pending;
      expect(res.status).toBe(503);
      expect((await res.json()).fatal).toContain("database_timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("[SEC-13] production: anonymous callers get coarse checks (no provider names)", async () => {
    process.env.NODE_ENV = "production";
    const { body } = await check();
    expect(body.checks.ai).toBe("ok");
    expect(body.checks.smtp).toBe("ok");
    expect(Object.keys(body).sort()).toEqual(["checks", "fatal", "status", "timestamp", "warnings"]);
  });
});
