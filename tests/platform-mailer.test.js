import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const nm = vi.hoisted(() => ({ opts: null, send: null, verify: null }));
vi.mock("nodemailer", () => ({
  default: {
    createTransport: (opts) => {
      nm.opts = opts;
      return { sendMail: (...a) => nm.send(...a), verify: () => nm.verify() };
    },
  },
}));
vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "192.0.2.10", family: 4 }]) }));
vi.mock("node:net", () => {
  const { EventEmitter } = require("node:events");
  return {
    default: {
      createConnection: () => {
        const sock = new EventEmitter();
        sock.destroy = () => {};
        setTimeout(() => sock.emit("connect"), 0);
        return sock;
      },
    },
  };
});

const mailer = await import("@/lib/mailer.js");
const alerts = await import("@/lib/alerts.js");
const { snapshotEnv } = await import("./platform-helpers.js");

let restore;
beforeEach(() => {
  restore = snapshotEnv();
  process.env.SMTP_HOST = "smtp.example.com";
  process.env.SMTP_PORT = "587";
  process.env.SMTP_USER = "mailer@example.com";
  process.env.SMTP_PASS = "pw";
  delete process.env.SMTP_USERNAME;
  delete process.env.SMTP_PASSWORD;
  nm.send = vi.fn(async () => ({ messageId: "1" }));
  nm.verify = vi.fn(async () => true);
  mailer._resetDeliveryHealth();
  alerts._resetAlerts();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  restore();
  vi.restoreAllMocks();
});

describe("mailer configuration", () => {
  it("accepts both credential name pairs", () => {
    expect(mailer.smtpState()).toBe("configured");
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    expect(mailer.smtpState()).toBe("credentials_incomplete");
    process.env.SMTP_USERNAME = "mailer@example.com";
    process.env.SMTP_PASSWORD = "pw";
    expect(mailer.smtpUser()).toBe("mailer@example.com");
    expect(mailer.smtpPass()).toBe("pw");
    expect(mailer.smtpState()).toBe("configured");
    delete process.env.SMTP_HOST;
    expect(mailer.smtpState()).toBe("not_configured");
  });

  it("sets transport timeouts", async () => {
    await mailer.sendMail({ to: "a@example.com", subject: "s", text: "t" });
    expect(nm.opts).toMatchObject({ connectionTimeout: expect.any(Number), greetingTimeout: expect.any(Number), socketTimeout: expect.any(Number) });
    expect(nm.opts.auth).toEqual({ user: "mailer@example.com", pass: "pw" });
  });
});

describe("sendMail", () => {
  it("delivers", async () => {
    expect(await mailer.sendMail({ to: "a@example.com", subject: "s", text: "t" })).toMatchObject({ delivered: true });
  });

  it.each([
    [Object.assign(new Error("Invalid login: 535 5.7.8 Username and Password not accepted"), { code: "EAUTH", responseCode: 535 }), "smtp_auth_rejected"],
    [Object.assign(new Error("getaddrinfo ENOTFOUND smtp.example.com"), { code: "ENOTFOUND" }), "smtp_host_not_found"],
    [Object.assign(new Error("Connection timeout"), { code: "ETIMEDOUT" }), "smtp_unreachable"],
    [new Error("a -> ENETUNREACH; b -> ENETUNREACH"), "smtp_no_route"],
    [new Error("a -> ETIMEDOUT; b -> ENETUNREACH"), "smtp_unreachable"],
    [Object.assign(new Error("553 Sender address rejected: not owned by user"), { code: "EENVELOPE" }), "smtp_sender_rejected"],
    [new Error("something odd"), "smtp_failed"],
  ])("never throws and classifies %#", async (err, reason) => {
    nm.send = vi.fn(async () => {
      throw err;
    });
    const out = await mailer.sendMail({ to: "a@example.com", subject: "s", text: "t" });
    expect(out.delivered).toBe(false);
    expect(out.error).toBe(reason);
    expect(out.hint).toBe(mailer.FAILURE_REASONS[reason]);
    expect(out.detail).toContain(mailer.FAILURE_REASONS[reason]);
    expect(mailer.deliveryHealth()).toEqual({ degraded: true, reason });
  });

  it("every reason code has a remedy", () => {
    for (const hint of Object.values(mailer.FAILURE_REASONS)) expect(hint.length).toBeGreaterThan(20);
  });

  it("prints to console only outside production", async () => {
    delete process.env.SMTP_HOST;
    expect(await mailer.sendMail({ to: "a@example.com", subject: "s", text: "LINK" })).toEqual({ delivered: false, loggedToConsole: true });
    process.env.NODE_ENV = "production";
    vi.mocked(console.log).mockClear();
    const out = await mailer.sendMail({ to: "a@example.com", subject: "s", text: "LINK" });
    expect(out.error).toBe("smtp_not_configured");
    expect(console.log).not.toHaveBeenCalled();
  });

  it("does not attempt a send with incomplete credentials", async () => {
    delete process.env.SMTP_PASS;
    const out = await mailer.sendMail({ to: "a@example.com", subject: "s", text: "t" });
    expect(out.error).toBe("smtp_credentials_incomplete");
    expect(nm.send).not.toHaveBeenCalled();
  });

  it("verifyTransport reports elapsed time and classification", async () => {
    expect(await mailer.verifyTransport()).toMatchObject({ ok: true, host: "smtp.example.com", port: 587 });
    nm.verify = vi.fn(async () => {
      throw Object.assign(new Error("535 bad creds"), { code: "EAUTH" });
    });
    expect(await mailer.verifyTransport()).toMatchObject({ ok: false, error: "smtp_auth_rejected", elapsedMs: expect.any(Number) });
  });
});

describe("alerts", () => {
  beforeEach(() => {
    process.env.ADMIN_EMAILS = "admin@example.test";
  });

  it("deduplicates errors by source+message", async () => {
    expect((await alerts.alertError("ai", "All providers failed", { n: 1 })).sent).toBe(true);
    expect((await alerts.alertError("ai", "All providers failed", { n: 2 })).reason).toBe("deduplicated");
    expect((await alerts.alertError("ai", "Other", null)).sent).toBe(true);
    expect(nm.send).toHaveBeenCalledTimes(2);
  });

  it("does not dedupe events", async () => {
    await alerts.alertEvent("New user signup", { email: "r***@example.com" });
    await alerts.alertEvent("New user signup", { email: "s***@example.com" });
    expect(nm.send).toHaveBeenCalledTimes(2);
  });

  it("[SEC-15] caps event alerts per hour and reports the overflow in the next hour's first email", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); // only the clock: mail delivery still needs real timers
    try {
      vi.setSystemTime(new Date("2026-11-20T10:00:00Z"));
      alerts._resetAlerts();
      nm.send.mockClear?.();
      const sent = [];
      for (let i = 0; i < alerts.EVENT_ALERTS_PER_HOUR + 5; i++) sent.push((await alerts.alertEvent("New user signup", { n: i })).sent);
      expect(sent.filter(Boolean)).toHaveLength(alerts.EVENT_ALERTS_PER_HOUR);
      vi.setSystemTime(new Date("2026-11-20T11:00:01Z"));
      const before = nm.send.mock.calls.length;
      expect((await alerts.alertEvent("New user signup", { n: 99 })).sent).toBe(true);
      expect(nm.send.mock.calls[before][0].text).toMatch(/5 more "New user signup" event/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends nothing with no admins", async () => {
    process.env.ADMIN_EMAILS = "";
    expect(await alerts.alertEvent("x")).toEqual({ sent: false, reason: "no_admin_configured" });
  });

  it("never throws when delivery fails, and redacts detail", async () => {
    nm.send = vi.fn(async () => {
      throw new Error("down");
    });
    await expect(alerts.alertError("system", "c", { email: "secret.person@example.com" })).resolves.toMatchObject({ sent: false });
    nm.send = vi.fn(async () => ({}));
    alerts._resetAlerts();
    await alerts.alertError("system", "d", { email: "secret.person@example.com" });
    expect(nm.send.mock.calls[0][0].text).toContain("s***@example.com");
  });
});
