/**
 * The only way a unit test reaches Postgres (LESSONS 67). Pure, so setup.js and
 * test-db.js share one rule: TEST_DATABASE_URL must be set, must differ from the
 * app's DATABASE_URL, and must name a database ending in `_test`.
 */

function databaseName(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    return "";
  }
}

/**
 * @param {{TEST_DATABASE_URL?: string, DATABASE_URL?: string}} env
 * @returns {string|null} why the test database is unsafe to use, or null when it is fine
 */
export function testDatabaseProblem(env) {
  const testUrl = (env.TEST_DATABASE_URL ?? "").trim();
  if (!testUrl) return "TEST_DATABASE_URL is not set. Point it at a throwaway database whose name ends in _test.";
  const appUrl = (env.DATABASE_URL ?? "").trim();
  if (appUrl && appUrl === testUrl) return "TEST_DATABASE_URL equals DATABASE_URL. Tests delete rows; use a separate *_test database.";
  const name = databaseName(testUrl);
  if (!name.endsWith("_test")) return `TEST_DATABASE_URL names database "${name || "(none)"}", which does not end in _test.`;
  if (appUrl && databaseName(appUrl) === name) return "TEST_DATABASE_URL and DATABASE_URL name the same database.";
  return null;
}
