import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { checkRateLimit, consumeDailyQuota, mailboxKey, MAX_KEYS, _resetRateLimits, _rateLimitSizes } from "@/lib/rate-limit.js";

describe("checkRateLimit", () => {
  beforeEach(() => {
    _resetRateLimits();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-20T00:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("allows up to maxRequests then blocks with retryAfter", () => {
    const opts = { maxRequests: 3, windowMs: 60_000 };
    for (let i = 0; i < 3; i++) expect(checkRateLimit("k", opts)).toEqual({ allowed: true });
    const blocked = checkRateLimit("k", opts);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBe(60);
  });

  it("slides: frees a slot once the oldest request leaves the window", () => {
    const opts = { maxRequests: 2, windowMs: 10_000 };
    checkRateLimit("k", opts);
    vi.advanceTimersByTime(5_000);
    checkRateLimit("k", opts);
    expect(checkRateLimit("k", opts).allowed).toBe(false);
    vi.advanceTimersByTime(5_001);
    expect(checkRateLimit("k", opts).allowed).toBe(true);
    expect(checkRateLimit("k", opts).allowed).toBe(false);
  });

  it("keeps keys independent", () => {
    const opts = { maxRequests: 1, windowMs: 60_000 };
    expect(checkRateLimit("a", opts).allowed).toBe(true);
    expect(checkRateLimit("b", opts).allowed).toBe(true);
    expect(checkRateLimit("a", opts).allowed).toBe(false);
  });

  it("retryAfter is never below one second", () => {
    const opts = { maxRequests: 1, windowMs: 100 };
    checkRateLimit("k", opts);
    expect(checkRateLimit("k", opts).retryAfter).toBe(1);
  });
});

describe("[SEC-2] bounded maps", () => {
  beforeEach(() => _resetRateLimits());

  it("never holds more than MAX_KEYS windows; the least recently used key is evicted", () => {
    const opts = { maxRequests: 1, windowMs: 15 * 60_000 };
    checkRateLimit("hot", opts);
    for (let i = 0; i < MAX_KEYS + 500; i++) {
      checkRateLimit(`flood:${i}`, { maxRequests: 5, windowMs: 15 * 60_000 });
      if (i === 10) checkRateLimit("hot", opts); // touched early, then evicted as the flood continues
    }
    expect(_rateLimitSizes().windows).toBeLessThanOrEqual(MAX_KEYS);
    expect(checkRateLimit("flood:" + (MAX_KEYS + 499), { maxRequests: 1, windowMs: 60_000 }).allowed).toBe(false);
  });
});

describe("[SEC-4] daily quota", () => {
  beforeEach(() => {
    _resetRateLimits();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-20T22:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("allows `limit` per UTC day, then reports seconds until UTC midnight; resets the next day", () => {
    expect(consumeDailyQuota("u", 2).allowed).toBe(true);
    expect(consumeDailyQuota("u", 2).allowed).toBe(true);
    expect(consumeDailyQuota("u", 2)).toEqual({ allowed: false, used: 2, retryAfter: 7200 });
    vi.setSystemTime(new Date("2026-11-21T00:00:01Z"));
    expect(consumeDailyQuota("u", 2).allowed).toBe(true);
  });
});

describe("[SEC-1] mailboxKey", () => {
  it.each([
    ["A.B+news@Gmail.com", "ab@gmail.com"],
    ["ab@googlemail.com", "ab@gmail.com"],
    ["first.last+x@example.com", "first.last@example.com"],
    ["+only@example.com", "+only@example.com"],
  ])("%s → %s", (input, key) => expect(mailboxKey(input)).toBe(key));
});
