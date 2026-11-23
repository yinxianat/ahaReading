import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db.js", async () => {
  const { makePrismaMock } = await import("./platform-helpers.js");
  return { default: makePrismaMock() };
});
vi.mock("@/lib/alerts.js", async (importOriginal) => ({ ...(await importOriginal()), alertError: vi.fn(async () => ({ sent: true })) }));

const prisma = (await import("@/lib/db.js")).default;
const { alertError } = await import("@/lib/alerts.js");
const { logger, fingerprint, _resetLogger, _loggerState } = await import("@/lib/logger.js");
const { fakeCreds } = await import("./platform-helpers.js");

describe("logger", () => {
  beforeEach(() => {
    prisma._reset();
    _resetLogger();
    vi.mocked(alertError).mockClear();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("upserts by fingerprint, increments count and clears resolvedAt on recurrence", async () => {
    await logger.error("ai", "Provider failed", { status: 500 });
    const call = prisma.logEntry.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ fingerprint: fingerprint("ai", "Provider failed") });
    expect(call.create).toMatchObject({ level: "ERROR", source: "ai", message: "Provider failed", fingerprint: call.where.fingerprint });
    expect(call.update).toMatchObject({ count: { increment: 1 }, resolvedAt: null, level: "ERROR" });
  });

  it("fingerprint ignores detail, so varying data does not split entries", async () => {
    await logger.warn("api", "Same message", { id: 1 });
    await logger.warn("api", "Same message", { id: 2 });
    const [a, b] = prisma.logEntry.upsert.mock.calls.map((c) => c[0].where.fingerprint);
    expect(a).toBe(b);
    expect(fingerprint("api", "x")).not.toBe(fingerprint("auth", "x"));
  });

  it("redacts detail before persisting", async () => {
    const key = fakeCreds.anthropic();
    await logger.error("ai", "Provider failed", { key, email: "someone@example.com" });
    const persisted = prisma.logEntry.upsert.mock.calls[0][0].create.detail;
    expect(persisted).not.toContain(key);
    expect(persisted).toContain("s***@example.com");
  });

  it("never throws when the database fails", async () => {
    prisma.logEntry.upsert.mockRejectedValue(new Error("db down"));
    await expect(logger.error("api", "Thing broke")).resolves.toBeUndefined();
  });

  it("does not recurse: a failed write is reported to stderr, not re-logged", async () => {
    prisma.logEntry.upsert.mockRejectedValue(new Error("db down"));
    await logger.error("api", "Thing broke");
    expect(prisma.logEntry.upsert).toHaveBeenCalledTimes(1);
  });

  it("opens the circuit after 5 consecutive failures and skips the database", async () => {
    prisma.logEntry.upsert.mockRejectedValue(new Error("db down"));
    for (let i = 0; i < 5; i++) await logger.error("api", "Thing broke");
    expect(_loggerState().open).toBe(true);
    await logger.error("api", "Thing broke");
    expect(prisma.logEntry.upsert).toHaveBeenCalledTimes(5);
    expect(alertError).toHaveBeenCalledWith("system", "Log persistence circuit breaker opened", expect.any(Object));
  });

  it("alerts on ERROR and CRITICAL but not WARN or client reports", async () => {
    await logger.warn("api", "w");
    await logger.error("client", "Client render error");
    expect(alertError).not.toHaveBeenCalled();
    await logger.error("api", "e");
    await logger.critical("system", "c");
    expect(alertError).toHaveBeenCalledTimes(2);
  });

  it("survives an alert that rejects", async () => {
    vi.mocked(alertError).mockRejectedValueOnce(new Error("smtp"));
    await expect(logger.critical("system", "c")).resolves.toBeUndefined();
  });

  it("[Platform] keeps the first detail and records lastSeenAt on every occurrence", async () => {
    await logger.error("api", "Flooded", { n: 1 });
    const call = prisma.logEntry.upsert.mock.calls[0][0];
    expect(call.create.firstDetail).toBe(call.create.detail);
    expect(call.update.firstDetail).toBeUndefined();
    expect(call.create.lastSeenAt).toBeInstanceOf(Date);
    expect(call.update.lastSeenAt).toBeInstanceOf(Date);
  });

  it("[Platform] alert dedup is claimed on the row (alertedAt), so a second process does not re-send", async () => {
    prisma.logEntry.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    await logger.error("api", "Outage");
    await logger.error("api", "Outage");
    expect(alertError).toHaveBeenCalledTimes(1);
    const claim = prisma.logEntry.updateMany.mock.calls[0][0];
    expect(claim.where.fingerprint).toBe(fingerprint("api", "Outage"));
    expect(claim.data.alertedAt).toBeInstanceOf(Date);
  });

  it("[Platform] an undelivered alert releases its claim so a later occurrence can retry", async () => {
    vi.mocked(alertError).mockResolvedValueOnce({ sent: false, reason: "smtp_unreachable" });
    prisma.logEntry.updateMany.mockResolvedValue({ count: 1 });
    await logger.error("api", "Outage");
    await new Promise((r) => setTimeout(r, 0));
    const release = prisma.logEntry.updateMany.mock.calls[1]?.[0];
    expect(release.where.alertedAt).toBeInstanceOf(Date);
    expect(release.data.alertedAt.getTime()).toBeLessThan(release.where.alertedAt.getTime());
  });

  it("still alerts when the database is down (in-memory dedup only)", async () => {
    prisma.logEntry.upsert.mockRejectedValue(new Error("db down"));
    await logger.error("api", "DB gone");
    expect(alertError).toHaveBeenCalledWith("api", "DB gone", null);
  });
});
