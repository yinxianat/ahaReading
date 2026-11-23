// Runs before every test file. Makes the database safety rule (LESSONS 67) hold even for
// a test that forgets to mock @/lib/db.js: DATABASE_URL is repointed at the verified test
// database, and the run aborts when that database could be anything else. AI keys are
// removed unless RUN_LIVE_AI=1, so no unit test can spend money on a real provider.
import "dotenv/config";
import { testDatabaseProblem } from "./test-db-guard.js";

process.env.NODE_ENV ??= "test";

const problem = testDatabaseProblem(process.env);
if (problem) throw new Error(`Refusing to run tests: ${problem}`);
process.env.ORIGINAL_DATABASE_URL = process.env.DATABASE_URL ?? "";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
// pg falls back to PG* variables for anything missing from a connection string; Railway
// injects them into linked services, so they must not leak in.
for (const name of ["PGHOST", "PGDATABASE", "PGUSER", "PGPASSWORD", "PGPORT"]) delete process.env[name];

if (process.env.RUN_LIVE_AI !== "1") {
  for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_AI_API_KEY", "GEMINI_API_KEY"]) delete process.env[name];
}
// No test sends real mail: SMTP from a developer's .env is dropped (tests that need it set it).
for (const name of ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "SMTP_USERNAME", "SMTP_PASSWORD"]) delete process.env[name];
