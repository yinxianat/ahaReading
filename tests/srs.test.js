import { describe, it, expect } from "vitest";
import { calculateNextReview, addDays, MIN_EASE, QUALITY_BUTTONS, streakDays } from "@/lib/srs.js";

describe("SM-2 algorithm (spec §22.5)", () => {
  it("resets interval on failure (quality < 3) and keeps ease", () => {
    const result = calculateNextReview(1, 10, 2.5, 5);
    expect(result.interval).toBe(1);
    expect(result.easeFactor).toBe(2.5);
  });

  it("uses 1-day interval for first successful review", () => {
    expect(calculateNextReview(4, 1, 2.5, 0).interval).toBe(1);
  });

  it("uses 6-day interval for second successful review", () => {
    expect(calculateNextReview(4, 1, 2.5, 1).interval).toBe(6);
  });

  it("multiplies by ease factor for subsequent reviews", () => {
    expect(calculateNextReview(4, 6, 2.5, 2).interval).toBe(15);
  });

  it("decreases ease factor for hard reviews", () => {
    expect(calculateNextReview(3, 6, 2.5, 2).easeFactor).toBeLessThan(2.5);
  });

  it("increases ease factor for easy reviews", () => {
    expect(calculateNextReview(5, 6, 2.5, 2).easeFactor).toBeGreaterThan(2.5);
  });

  it("never goes below minimum ease factor (1.3)", () => {
    let ef = 2.5;
    for (let i = 0; i < 100; i++) ef = calculateNextReview(3, 1, ef, i).easeFactor;
    expect(ef).toBeGreaterThanOrEqual(MIN_EASE);
    expect(ef).toBe(1.3);
  });

  it("computes exact SM-2 ease deltas", () => {
    expect(calculateNextReview(5, 6, 2.5, 2).easeFactor).toBe(2.6);
    expect(calculateNextReview(3, 6, 2.5, 2).easeFactor).toBe(2.36);
    expect(calculateNextReview(0, 6, 2.5, 2).easeFactor).toBe(2.5);
  });

  it("nextReviewAt is now + interval days", () => {
    const now = new Date("2026-03-07T12:00:00Z");
    const r = calculateNextReview(4, 6, 2.5, 2, now);
    expect(r.nextReviewAt.toISOString()).toBe("2026-03-22T12:00:00.000Z");
    expect(addDays(now, 1).getTime() - now.getTime()).toBe(86_400_000);
  });

  it("rejects invalid quality", () => {
    expect(() => calculateNextReview(6, 1, 2.5, 0)).toThrow(RangeError);
    expect(() => calculateNextReview(2.5, 1, 2.5, 0)).toThrow(RangeError);
    expect(() => calculateNextReview("5", 1, 2.5, 0)).toThrow(RangeError);
  });

  it("[ENG-13] a lapse resets repetitions; the ladder restarts at 1 → 6 days", () => {
    const lapse = calculateNextReview(1, 40, 2.5, 5);
    expect(lapse).toMatchObject({ interval: 1, repetitions: 0, easeFactor: 2.5 });
    const first = calculateNextReview(4, lapse.interval, lapse.easeFactor, lapse.repetitions);
    expect(first).toMatchObject({ interval: 1, repetitions: 1 });
    const second = calculateNextReview(4, first.interval, first.easeFactor, first.repetitions);
    expect(second).toMatchObject({ interval: 6, repetitions: 2 });
    expect(calculateNextReview(4, second.interval, second.easeFactor, second.repetitions)).toMatchObject({ interval: 15, repetitions: 3 });
  });

  it("[ENG-13] success increments repetitions; bad input falls back to 0", () => {
    expect(calculateNextReview(5, 6, 2.5, 2).repetitions).toBe(3);
    expect(calculateNextReview(5, 1, 2.5, -1)).toMatchObject({ interval: 1, repetitions: 1 });
    expect(calculateNextReview(5, 1, 2.5, undefined).repetitions).toBe(1);
  });

  it("button mapping matches spec §10.5", () => {
    expect(QUALITY_BUTTONS).toEqual({ forgot: 1, hard: 3, easy: 5 });
  });
});

describe("[PO-13] streakDays", () => {
  const now = new Date("2026-11-22T08:00:00Z");
  it("counts consecutive UTC days ending today", () => {
    expect(streakDays(["2026-11-22", "2026-11-21", "2026-11-20", "2026-11-18"], now)).toBe(3);
  });
  it("still counts when the last review was yesterday", () => {
    expect(streakDays(["2026-11-21", "2026-11-20"], now)).toBe(2);
  });
  it("is 0 when the last review was two days ago, or never", () => {
    expect(streakDays(["2026-11-20", "2026-11-19"], now)).toBe(0);
    expect(streakDays([], now)).toBe(0);
  });
  it("crosses month boundaries in UTC", () => {
    expect(streakDays(["2026-12-01", "2026-11-30", "2026-11-29"], new Date("2026-12-01T23:59:00Z"))).toBe(3);
  });
});
