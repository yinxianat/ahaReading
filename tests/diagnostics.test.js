import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/db.js", async () => {
  const { makePrismaMock } = await import("./platform-helpers.js");
  return { default: makePrismaMock() };
});
const chain = vi.hoisted(() => ({ status: [] }));
vi.mock("@/lib/ai/index.js", () => ({ getChainStatus: () => chain.status }));

const prisma = (await import("@/lib/db.js")).default;
const { getFindings, getConfigFindings, getEnvironmentChecks, FINDING_TITLES, SEVERITIES } = await import("@/lib/diagnostics.js");
const { snapshotEnv } = await import("./platform-helpers.js");

const configured = (name) => ({ name, registered: true, configured: true, defaultModel: "m" });

let restore;
beforeEach(() => {
  restore = snapshotEnv();
  prisma._reset();
  prisma.logEntry.groupBy.mockResolvedValue([]);
  prisma.aiCall.groupBy.mockResolvedValue([]);
  chain.status = [configured("anthropic"), configured("openai")];
  process.env.JWT_SECRET = "j".repeat(64);
  process.env.MAGIC_LINK_SECRET = "m".repeat(64);
  process.env.ADMIN_EMAILS = "admin@example.test";
  process.env.SMTP_HOST = "smtp.example.com";
  process.env.SMTP_USER = "u@example.com";
  process.env.SMTP_PASS = "pw-value";
});
afterEach(() => restore());

function expectWellFormed(findings) {
  for (const f of findings) {
    expect(Object.keys(FINDING_TITLES)).toContain(f.code);
    expect(SEVERITIES).toContain(f.severity);
    expect(f.title).toBe(FINDING_TITLES[f.code]);
    expect(f.detail.length).toBeGreaterThan(10);
    expect(f.remediation.length).toBeGreaterThan(10);
  }
}

describe("diagnostics", () => {
  it("no findings for a healthy configuration", async () => {
    expect(await getFindings()).toEqual([]);
  });

  it("flags missing secrets, missing admins, no AI and SMTP without credentials", async () => {
    delete process.env.JWT_SECRET;
    delete process.env.MAGIC_LINK_SECRET;
    delete process.env.ADMIN_EMAILS;
    delete process.env.SMTP_PASS;
    chain.status = [{ ...configured("anthropic"), configured: false }];
    const findings = await getConfigFindings();
    const codes = findings.map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining([
      "missing_jwt_secret", "missing_magic_link_secret", "no_admin_emails", "no_ai_provider", "smtp_credentials_incomplete",
    ]));
    expectWellFormed(findings);
  });

  it("notes a single provider and the mock provider", async () => {
    chain.status = [configured("anthropic"), configured("mock")];
    const codes = (await getConfigFindings()).map((f) => f.code);
    expect(codes).toContain("single_ai_provider");
    expect(codes).toContain("mock_ai_active");
  });

  it("production: BASE_URL problems and local-only variables", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.BASE_URL;
    process.env.AI_MOCK = "1";
    const findings = await getConfigFindings();
    expect(findings.map((f) => f.code)).toEqual(expect.arrayContaining(["missing_base_url", "local_only_var_in_production"]));
    expectWellFormed(findings);
  });

  it("[SEC-11] flags a JWT/magic-link secret shorter than 32 characters", async () => {
    process.env.JWT_SECRET = "x";
    process.env.MAGIC_LINK_SECRET = "y".repeat(31);
    const codes = (await getConfigFindings()).map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(["weak_jwt_secret", "weak_magic_link_secret"]));
  });

  it("[ENG-7] every health-relevant code is in the one catalogue", async () => {
    const { HEALTH_IMPACT, FINDING_TITLES } = await import("@/lib/diagnostics.js");
    for (const code of Object.keys(HEALTH_IMPACT)) expect(FINDING_TITLES[code], code).toBeTruthy();
  });

  it("derives runtime findings from the log and AI ledger, sorted by severity", async () => {
    prisma.logEntry.groupBy.mockResolvedValue([
      { level: "CRITICAL", _count: { _all: 1 } },
      { level: "ERROR", _count: { _all: 3 } },
    ]);
    prisma.aiCall.groupBy.mockResolvedValue([
      { status: "ok", _count: { _all: 2 } },
      { status: "infrastructure", _count: { _all: 8 } },
      { status: "refusal", _count: { _all: 5 } },
    ]);
    const findings = await getFindings();
    expect(findings.map((f) => f.code)).toEqual(["critical_logged", "ai_failures", "errors_logged", "ai_refusals"]);
    expectWellFormed(findings);
    expect(prisma.logEntry.groupBy.mock.calls[0][0].where.resolvedAt).toBeNull();
  });

  it("a failing query becomes a finding, not an exception", async () => {
    prisma.logEntry.groupBy.mockRejectedValue(new Error("db down"));
    prisma.aiCall.groupBy.mockRejectedValue(new Error("db down"));
    const codes = (await getFindings()).map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(["log_query_failed", "ai_call_query_failed"]));
  });

  it("environment checks report presence only, never values", () => {
    const checks = getEnvironmentChecks();
    const text = JSON.stringify(checks);
    expect(text).not.toContain(process.env.JWT_SECRET);
    expect(text).not.toContain("pw-value");
    expect(checks.find((c) => c.name === "SMTP_PASS")).toMatchObject({ set: true, alternative: "SMTP_PASSWORD" });
  });
});
