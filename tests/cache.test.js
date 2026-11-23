import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { computeCacheKey, computeTranslationKey, getFromCache, setCache, getCacheStats, resetCache, _setRawEntryForTests } from "@/lib/cache.js";

beforeEach(() => resetCache());
afterEach(() => vi.useRealTimers());

describe("cache key", () => {
  it("is deterministic and depends on every input", () => {
    const k = computeCacheKey("a", "b", 1, "en");
    expect(k).toBe(computeCacheKey("a", "b", 1, "en"));
    expect(k).not.toBe(computeCacheKey("a", "b", 2, "en"));
    expect(k).not.toBe(computeCacheKey("a", "b", 1, "zh"));
    expect(k).not.toBe(computeCacheKey("a", "c", 1, "en"));
  });

  it("has no delimiter collisions", () => {
    expect(computeCacheKey("a|b", "c", 1, "en")).not.toBe(computeCacheKey("a", "b|c", 1, "en"));
  });

  it("translation keys are separate from explain keys", () => {
    expect(computeTranslationKey("a")).not.toBe(computeCacheKey("a", "", 1, "en"));
    expect(computeTranslationKey("a")).toMatch(/^translate:/);
  });
});

describe("cache behavior", () => {
  it("hit and miss", () => {
    expect(getFromCache("k")).toBeNull();
    setCache("k", { explanation: "x" });
    expect(getFromCache("k")).toEqual({ explanation: "x" });
    const stats = getCacheStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
  });

  it("expires after the TTL", () => {
    vi.useFakeTimers();
    resetCache({ ttlMs: 1000 });
    setCache("k", { v: 1 });
    vi.advanceTimersByTime(999);
    expect(getFromCache("k")).toEqual({ v: 1 });
    vi.advanceTimersByTime(2);
    expect(getFromCache("k")).toBeNull();
    expect(getCacheStats().total).toBe(0);
  });

  it("evicts the least recently USED entry, not the oldest inserted", () => {
    resetCache({ maxEntries: 3 });
    setCache("a", 1);
    setCache("b", 2);
    setCache("c", 3);
    expect(getFromCache("a")).toBe(1); // a becomes most recent
    setCache("d", 4); // evicts b
    expect(getFromCache("b")).toBeNull();
    expect(getFromCache("a")).toBe(1);
    expect(getFromCache("c")).toBe(3);
    expect(getFromCache("d")).toBe(4);
    expect(getCacheStats().evictions).toBe(1);
  });

  it("never exceeds the size cap (default 1000)", () => {
    for (let i = 0; i < 1005; i++) setCache(`k${i}`, i);
    expect(getCacheStats().total).toBe(1000);
    expect(getFromCache("k0")).toBeNull();
    expect(getFromCache("k1004")).toBe(1004);
  });

  it("treats a corrupted entry as a miss and removes it", () => {
    _setRawEntryForTests("bad1", "not an object");
    _setRawEntryForTests("bad2", { value: { x: 1 } });
    _setRawEntryForTests("bad3", { value: null, expiresAt: Date.now() + 1000 });
    expect(getFromCache("bad1")).toBeNull();
    expect(getFromCache("bad2")).toBeNull();
    expect(getFromCache("bad3")).toBeNull();
    expect(getCacheStats().total).toBe(0);
  });

  it("ignores null/undefined values", () => {
    setCache("n", null);
    expect(getCacheStats().total).toBe(0);
  });
});
