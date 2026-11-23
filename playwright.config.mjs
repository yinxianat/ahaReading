// AhaReading end-to-end regression suite (QA-owned).
// Runs against a dev server on port 3100 with the QA database and the mock AI
// provider. `reuseExistingServer` lets you keep a server running between runs.
//
// Note: the in-memory rate limits live in the server process. The request-link
// limit (5 / 15 min / IP) is only spent by the auth spec on desktop-chromium
// (2 sends per run); re-running that spec many times against the same reused
// server inside 15 minutes will hit the limit — restart the server to reset.
import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;
const BASE_URL = `http://localhost:${PORT}`;
// Override with QA_DATABASE_URL when your Postgres user differs (e2e/support/db.mjs reads it too).
const QA_DB = process.env.QA_DATABASE_URL || "postgresql://yinxiatao@localhost:5432/ahareading_qa";

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.mjs$/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "e2e/.report" }]],
  outputDir: "e2e/.results",
  // Runs after webServer is up: compiles every page route so a cold `next dev`
  // doesn't HMR-reload pages mid-test (see e2e/support/warmup.mjs).
  globalSetup: "./e2e/support/warmup.mjs",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
    // iPhone 13 geometry + touch, rendered by Chromium.
    { name: "mobile-chromium", use: { ...devices["iPhone 13"], browserName: "chromium" } },
    // The real iOS engine family.
    { name: "mobile-webkit", use: { ...devices["iPhone 13"] } },
  ],
  webServer: {
    command: `npm run dev -- -p ${PORT}`,
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: true,
    timeout: 120_000,
    env: {
      DATABASE_URL: QA_DB,
      BASE_URL,
      AI_MOCK: "1",
      AI_PROVIDER_CHAIN: "mock",
      ADMIN_EMAILS: "qa-admin@example.test",
    },
  },
});
