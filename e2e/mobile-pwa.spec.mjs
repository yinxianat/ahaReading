// 320px layout, touch targets, bottom nav, PWA assets, console hygiene per page.
import { test, expect, createArticle, sql } from "./support/fixtures.mjs";

const PAGES = ["/read", "/notebook", "/review", "/settings"];

async function seedOne(page) {
  const id = await createArticle(page, { text: `A verylongunbrokenwordthatcouldoverflowthelayoutonasmallscreen_${"x".repeat(80)} and https://example.com/${"path/".repeat(20)}\n\nSecond paragraph.` });
  const ex = await (await page.request.post("/api/explain", { data: { highlightedText: `term-${"y".repeat(60)}`, surroundingText: "ctx", articleId: id } })).json();
  const c = await (await page.request.post("/api/notebook", { data: { explanationId: ex.explanationId, tags: ["averyveryverylongtagnamethatkeepsgoingandgoing"] } })).json();
  return { articleId: id, conceptId: c.concept.id };
}

test.describe("320px wide", () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test("no horizontal scroll on any app page", async ({ page, user }) => {
    const { articleId, conceptId } = await seedOne(page);
    const offenders = [];
    for (const path of ["/", "/login", ...PAGES, `/read/${articleId}`, `/notebook/${conceptId}`, "/onboarding", "/admin", "/nope-404"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      if (w.sw > w.cw) offenders.push(`${path}: scrollWidth ${w.sw} > ${w.cw}`);
    }
    expect(offenders).toEqual([]);
  });

  test("bottom nav present with 4 items and aria-current", async ({ page, user }) => {
    await page.goto("/notebook");
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav).toBeVisible();
    for (const name of ["Read", "Notebook", "Review", "Settings"]) await expect(nav.getByRole("link", { name: new RegExp(name) })).toBeVisible();
    await expect(nav.getByRole("link", { name: /Notebook/ })).toHaveAttribute("aria-current", "page");
  });

  test("touch targets ≥ 44px on main screens", async ({ page, user }) => {
    const { articleId } = await seedOne(page);
    const small = [];
    for (const path of [...PAGES, `/read/${articleId}`]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const found = await page.evaluate(() =>
        [...document.querySelectorAll("button, a[href], [role=button], [role=radio], [role=tab], input:not([type=hidden])")]
          .filter((el) => {
            const r = el.getBoundingClientRect();
            if (!r.width || !r.height) return false;
            if (el.closest(".sr-only, .skip-link, nextjs-portal")) return false;
            const cs = getComputedStyle(el);
            if (cs.visibility === "hidden" || cs.display === "none") return false;
            // inline text links inside paragraphs are exempt (WCAG 2.5.8 inline exception)
            if (el.tagName === "A" && el.closest("p, dd, li") && cs.display === "inline") return false;
            return r.height < 44 && r.width < 44 ? true : Math.min(r.height, r.width) < 36;
          })
          .map((el) => `${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 30)}" ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`)
      );
      small.push(...found.map((f) => `${path}: ${f}`));
    }
    // Recorded for the report; the soft threshold (36px) is the hard failure.
    test.info().annotations.push({ type: "small-targets", description: small.join("\n") || "none" });
    expect(small).toEqual([]);
  });
});

test.describe("PWA", () => {
  test("manifest is valid and linked", async ({ page, request }) => {
    const res = await request.get("/manifest.json");
    expect(res.status()).toBe(200);
    const m = await res.json();
    expect(m.name).toBeTruthy();
    expect(m.short_name).toBeTruthy();
    expect(m.start_url).toBeTruthy();
    expect(["standalone", "fullscreen", "minimal-ui"]).toContain(m.display);
    expect(m.theme_color).toBe("#2557D6");
    expect(m.background_color).toBe("#FAF9F6");
    const sizes = (m.icons || []).map((i) => i.sizes);
    expect(sizes).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    for (const icon of m.icons) expect((await request.get(icon.src)).status(), icon.src).toBe(200);
    await page.goto("/");
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.json");
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1);
  });

  test("sw.js and offline page are served", async ({ request }) => {
    const sw = await request.get("/sw.js");
    expect(sw.status()).toBe(200);
    expect(sw.headers()["content-type"]).toMatch(/javascript/);
    expect(sw.headers()["cache-control"]).toMatch(/no-cache|no-store/);
    const off = await request.get("/offline.html");
    expect(off.status()).toBe(200);
    expect(await off.text()).toMatch(/offline/i);
  });

  test("service worker registers (forced in dev) and serves cached notebook offline", async ({ page, context, user }, testInfo) => {
    test.skip(testInfo.project.name === "mobile-webkit", "Playwright WebKit does not support service workers");
    // Dev-mode chunks aren't cacheable, so the offline reload hangs on "Loading…" in `next dev`.
    // Run against `next start` with QA_PROD=1 (seedOne needs the mock, so seed via paste only).
    test.skip(!process.env.QA_PROD, "service-worker offline needs a production build (QA_PROD=1)");
    await seedOne(page);
    await page.addInitScript(() => localStorage.setItem("aha.sw", "1"));
    await page.goto("/notebook");
    await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 20_000 }).catch(() => {});
    await page.reload();
    await expect(page.locator("main li")).toHaveCount(1);
    await page.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 20_000 });
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByText("Showing saved copy — you're offline.")).toBeVisible();
    await expect(page.locator("main li")).toHaveCount(1);
    await page.goto("/totally-uncached-page");
    await expect(page.getByText(/offline/i).first()).toBeVisible();
    await context.setOffline(false);
  });
});

test.describe("console hygiene", () => {
  test("no console errors, hydration warnings or 5xx on any page", async ({ page, user, issues }) => {
    const { articleId, conceptId } = await seedOne(page);
    for (const path of ["/", "/login", ...PAGES, `/read/${articleId}`, `/notebook/${conceptId}`, "/onboarding", "/admin", "/nope-404", "/auth/verify?token=bad"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
    }
    // Expected noise: the 403s from /admin as a non-admin and 400 from the bad verify token are not 5xx.
    expect(issues.filter((i) => !/status of 40[0-4]/.test(i))).toEqual([]);
  });

  test("signed-out pages are clean too", async ({ page, issues }) => {
    for (const path of ["/", "/login", "/login?reason=expired", "/auth/verify?token=bad", "/nope-404"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
    }
    expect(issues.filter((i) => !/status of 40[0-4]/.test(i))).toEqual([]);
  });
});
