-- ENG-13: estimate the SM-2 success streak for concepts reviewed before
-- `repetitions` existed. A card past the 1-day step has succeeded at least
-- reviewCount times in a row under the old ladder; interval 1 is ambiguous
-- (first success or a lapse) and stays 0, the conservative choice.
UPDATE "Concept" SET "repetitions" = "reviewCount" WHERE "interval" > 1 AND "repetitions" = 0;
