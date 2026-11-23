/**
 * SM-2 spaced repetition (spec §10.3, true SM-2 per ENG-13).
 * Quality 0–5; below 3 is a lapse: repetitions and interval reset (1 day), ease
 * factor unchanged. The 1 → 6 → ×EF ladder keys off `repetitions` (the current
 * success streak), not the lifetime review count, so a lapsed card climbs again
 * from the bottom.
 */
export const MIN_EASE = 1.3;
export const DEFAULT_EASE = 2.5;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Three-button review UI → SM-2 quality. */
export const QUALITY_BUTTONS = Object.freeze({ forgot: 1, hard: 3, easy: 5 });

/**
 * @param {Date} date
 * @param {number} days
 * @returns {Date}
 */
export function addDays(date, days) {
  // Millisecond arithmetic so a DST change never shifts a review by an hour.
  return new Date(date.getTime() + days * DAY_MS);
}

/**
 * Calculate the next review.
 * @param {number} quality recall rating 0..5 (integer)
 * @param {number} currentInterval current interval in days
 * @param {number} easeFactor current ease factor (≥ 1.3)
 * @param {number} repetitions successful reviews in a row so far (Concept.repetitions)
 * @param {Date} [now]
 * @returns {{interval: number, easeFactor: number, repetitions: number, nextReviewAt: Date}}
 */
export function calculateNextReview(quality, currentInterval, easeFactor, repetitions, now = new Date()) {
  if (!Number.isInteger(quality) || quality < 0 || quality > 5) {
    throw new RangeError("quality must be an integer 0..5");
  }
  const ef = Number.isFinite(easeFactor) && easeFactor >= MIN_EASE ? easeFactor : easeFactor < MIN_EASE ? MIN_EASE : DEFAULT_EASE;
  const interval = Number.isFinite(currentInterval) && currentInterval >= 1 ? currentInterval : 1;
  const count = Number.isInteger(repetitions) && repetitions >= 0 ? repetitions : 0;

  if (quality < 3) {
    return { interval: 1, easeFactor: ef, repetitions: 0, nextReviewAt: addDays(now, 1) };
  }

  // EF' = EF + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)), rounded to avoid float drift.
  const delta = 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02);
  const newEF = Math.max(MIN_EASE, Math.round((ef + delta) * 1000) / 1000);

  let newInterval;
  if (count === 0) newInterval = 1;
  else if (count === 1) newInterval = 6;
  else newInterval = Math.max(1, Math.round(interval * newEF));

  return { interval: newInterval, easeFactor: newEF, repetitions: count + 1, nextReviewAt: addDays(now, newInterval) };
}

/** A concept whose interval reaches this many days counts as mastered (PO-13). */
export const MASTERED_INTERVAL_DAYS = 21;

/**
 * @param {Date} date
 * @returns {string} UTC calendar day, "YYYY-MM-DD"
 */
export function utcDay(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Review streak (PO-13): consecutive UTC days with at least one review, ending
 * today or yesterday (so the streak survives until the day is over).
 * @param {string[]} days distinct "YYYY-MM-DD" UTC days with a review, any order
 * @param {Date} [now]
 * @returns {number}
 */
export function streakDays(days, now = new Date()) {
  const have = new Set(days);
  let cursor = new Date(`${utcDay(now)}T00:00:00Z`);
  if (!have.has(utcDay(cursor))) cursor = addDays(cursor, -1);
  let streak = 0;
  while (have.has(utcDay(cursor))) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}
