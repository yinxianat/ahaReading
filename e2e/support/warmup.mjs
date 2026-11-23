// Global setup: compile every page route once before the tests start.
//
// `next dev` compiles routes on first request. While a route compiles, the dev
// server pushes HMR rebuilds to every open page, and pages that are still
// loading do a full reload. On a cold server the first ~minute of tests sat on
// "Loading…" in a reload loop and timed out. Requesting each route here (after
// Playwright's webServer is up) moves that compile cost out of the tests.
const BASE = "http://localhost:3100";
const ROUTES = ["/", "/login", "/auth/verify", "/onboarding", "/read", "/read/warmup", "/notebook", "/notebook/warmup", "/review", "/settings", "/admin", "/nope-404"];

export default async function warmup() {
  const started = Date.now();
  for (const path of ROUTES) {
    try {
      await fetch(`${BASE}${path}`, { redirect: "manual", signal: AbortSignal.timeout(120_000) });
    } catch {
      // A failed warm-up only costs speed; the tests report real problems.
    }
  }
  console.log(`[warmup] compiled ${ROUTES.length} routes in ${Math.round((Date.now() - started) / 1000)}s`);
}
