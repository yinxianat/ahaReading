// [ENG-2] The unit suite refuses to touch any database that is not a dedicated *_test one.
import { describe, it, expect } from "vitest";
import { testDatabaseProblem } from "./test-db-guard.js";

const url = (name) => `postgresql://me@localhost:5432/${name}`;

describe("testDatabaseProblem", () => {
  it("accepts a distinct *_test database", () => {
    expect(testDatabaseProblem({ TEST_DATABASE_URL: url("ahareading_test"), DATABASE_URL: url("ahareading") })).toBeNull();
  });
  it.each([
    [{ DATABASE_URL: url("ahareading") }, /not set/],
    [{ TEST_DATABASE_URL: url("ahareading"), DATABASE_URL: url("ahareading") }, /equals DATABASE_URL/],
    [{ TEST_DATABASE_URL: url("ahareading"), DATABASE_URL: url("other_test") }, /does not end in _test/],
    [{ TEST_DATABASE_URL: "postgresql://a@db.internal:5432/app_test", DATABASE_URL: "postgresql://b@other:5432/app_test" }, /same database/],
    [{ TEST_DATABASE_URL: "not a url" }, /does not end in _test/],
  ])("refuses %o", (env, message) => {
    expect(testDatabaseProblem(env)).toMatch(message);
  });
  it("setup.js repointed DATABASE_URL at the test database for this run", () => {
    expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
    expect(testDatabaseProblem({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL, DATABASE_URL: process.env.ORIGINAL_DATABASE_URL })).toBeNull();
  });
});
