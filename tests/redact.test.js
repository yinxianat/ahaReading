import { describe, it, expect } from "vitest";
import { redact, maskEmail } from "@/lib/redact.js";
import { fakeCreds } from "./platform-helpers.js";

describe("redact", () => {
  it.each(Object.entries(fakeCreds))("removes %s-shaped secrets", (_, make) => {
    const secret = make();
    const out = redact(`prefix ${secret} suffix`);
    expect(out).not.toContain(secret);
    expect(out).toContain("prefix");
  });

  it("redacts bearer tokens", () => {
    const token = "x".repeat(20);
    expect(redact(`Authorization: Bearer ${token}`)).toBe("Authorization: Bearer [redacted]");
  });

  it("redacts token query parameters", () => {
    expect(redact("/auth/verify?token=short123&next=/read")).toBe("/auth/verify?token=[redacted]&next=/read");
  });

  it("masks emails but keeps the domain", () => {
    expect(redact("user alice.smith@example.com failed")).toBe("user a***@example.com failed");
    expect(maskEmail("bob@mail.example.org")).toBe("b***@mail.example.org");
    expect(maskEmail(null)).toBe("");
  });

  it("serialises objects and errors, and redacts inside them", () => {
    const out = redact({ err: new Error("bad"), url: fakeCreds.connection() });
    expect(out).toContain("Error: bad");
    expect(out).toContain("[connection-string]");
  });

  it("handles null, undefined and circular values", () => {
    expect(redact(null)).toBe("");
    expect(redact(undefined)).toBe("");
    const loop = {};
    loop.self = loop;
    expect(redact(loop)).toBe("[unserializable]");
  });

  it("caps length", () => {
    const out = redact("z".repeat(5000));
    expect(out.length).toBeLessThan(2100);
    expect(out.endsWith("[truncated]")).toBe(true);
  });
});
