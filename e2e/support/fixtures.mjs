/**
 * Shared Playwright fixtures:
 *  - `user`: a fresh, onboarded user signed in on the browser context.
 *  - `issues`: console errors, page errors, hydration warnings and failed /
 *    5xx requests seen by the page (tests may assert on them).
 *  - helpers to create an article and to select text inside the reader.
 */
import { test as base, expect } from "@playwright/test";
import { createUser, sql, BASE } from "./db.mjs";

export { expect, sql };

/** Article text; `nonce` makes paragraphs unique so the server's explanation cache misses. */
export const articleText = (nonce = Math.random().toString(36).slice(2, 8)) => [
  "Most web apps put a content delivery network in front of their servers so pages load quickly worldwide.",
  "Databases that replicate across regions often settle for eventual consistency instead of strict ordering.",
  "Our QA paragraph mentions __slow__ responses that take a while to arrive.",
  "This paragraph simulates an __infra__ outage of every provider.",
  "This paragraph simulates a __refuse__ decision by the provider.",
  "This paragraph simulates __garbage__ output from the provider.",
].map((p) => `${p} (ref ${nonce})`).join("\n\n");
export const ARTICLE_TEXT = articleText("static");

export async function addSession(context, token) {
  await context.addCookies([{ name: "aha_session", value: token, url: BASE, httpOnly: true, sameSite: "Lax" }]);
}

// The server keys its per-IP auth limits (verify 30 / 15 min, request-link 5 / 15 min)
// on x-real-ip. Without this every project shares "unknown", and one full run spends
// more than 30 verifies across the three projects. One stable address per project
// keeps the "desktop only" quota reasoning above true per project.
const PROJECT_IP = { "desktop-chromium": "192.0.2.1", "mobile-chromium": "192.0.2.2", "mobile-webkit": "192.0.2.3" };

export const test = base.extend({
  extraHTTPHeaders: async ({ extraHTTPHeaders }, use, testInfo) => {
    const ip = PROJECT_IP[testInfo.project.name] || "192.0.2.9";
    await use({ ...extraHTTPHeaders, "x-real-ip": ip });
  },
  userOptions: [{}, { option: true }],
  user: async ({ context, userOptions }, use) => {
    const u = await createUser(userOptions);
    await addSession(context, u.token);
    // Skip the first-visit reader tip in most tests (it has its own test).
    await context.addInitScript(() => {
      try {
        if (!sessionStorage.getItem("qa.keepCoach")) localStorage.setItem("aha.coachReader", "1");
      } catch {}
    });
    await use(u);
  },
  issues: [
    async ({ page }, use) => {
      const list = [];
      page.on("console", (m) => {
        const text = m.text();
        if (m.type() === "error" || /hydrat/i.test(text)) list.push(`console.${m.type()}: ${text}`);
      });
      page.on("pageerror", (e) => list.push(`pageerror: ${e.message}`));
      page.on("response", (r) => {
        if (r.status() >= 500) list.push(`HTTP ${r.status()} ${r.request().method()} ${r.url()}`);
      });
      page.on("requestfailed", (r) => {
        const f = r.failure()?.errorText || "";
        if (/aborted|cancelled|ERR_ABORTED|NS_BINDING_ABORTED|Load request cancelled/i.test(f)) return;
        list.push(`requestfailed ${r.method()} ${r.url()} ${f}`);
      });
      await use(list);
    },
    { auto: true },
  ],
});

/** Create a pasted article through the real API; returns its id. */
export async function createArticle(page, { text = articleText(), title = "QA article" } = {}) {
  const res = await page.request.post("/api/articles", { data: { text, title } });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).article.id;
}

/** Programmatically select `phrase` inside the reader body (all engines). */
export async function selectPhrase(page, phrase) {
  await page.locator("[data-p]").first().waitFor();
  await page.evaluate((phrase) => {
    for (const p of document.querySelectorAll("[data-p]")) {
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const i = n.data.indexOf(phrase);
        if (i >= 0) {
          const r = document.createRange();
          r.setStart(n, i);
          r.setEnd(n, i + phrase.length);
          const s = window.getSelection();
          s.removeAllRanges();
          s.addRange(r);
          document.dispatchEvent(new Event("selectionchange"));
          return;
        }
      }
    }
    throw new Error(`phrase not found: ${phrase}`);
  }, phrase);
}

/** Select a phrase and press the entry point (pill on desktop, action bar on touch). */
export async function explainPhrase(page, phrase) {
  await selectPhrase(page, phrase);
  const btn = page.getByRole("button", { name: "I don't understand" });
  await expect(btn).toBeVisible();
  await btn.click();
  return page.getByRole("dialog", { name: "Explanation" }).or(page.getByRole("complementary", { name: "Explanation" }));
}

export function isMobile(testInfo) {
  return testInfo.project.name.startsWith("mobile");
}

/** Open the inline save form; on the mobile sheet expand to 92% first (see QA-5). */
export async function openSaveForm(page, panel) {
  await panel.getByRole("button", { name: "Save to Notebook" }).click();
  const expand = page.getByRole("button", { name: "Expand panel" });
  if (await expand.count()) await expand.click();
}
