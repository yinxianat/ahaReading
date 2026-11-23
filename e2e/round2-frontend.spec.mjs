// Round 2 (Fixer-Frontend): sign-in code, simpler levels, structured article
// content, daily-limit copy, onboarding failure recovery, paste-link, and the
// shared-device wipe (SEC-3). Added by the frontend fixer; QA owns the suite.
import { createHmac, randomBytes } from "node:crypto";
import { test, expect, createArticle, explainPhrase, sql, isMobile } from "./support/fixtures.mjs";
import { createUser } from "./support/db.mjs";

/** Insert a login token + 6-digit code the way lib/auth.js does; returns the code. */
async function mintCode(email, { next = null } = {}) {
  const secret = process.env.MAGIC_LINK_SECRET;
  const plaintext = randomBytes(32).toString("hex");
  const tokenHash = createHmac("sha256", secret).update(`login:${plaintext}`).digest("hex");
  const code = String(100000 + Math.floor(Math.random() * 899999));
  const codeHash = createHmac("sha256", secret).update(`code:login:${tokenHash}:${code}`).digest("hex");
  await sql(`UPDATE "MagicToken" SET consumed=true WHERE email=$1`, [email]);
  await sql(
    `INSERT INTO "MagicToken" (id, "tokenHash", "codeHash", attempts, next, email, purpose, consumed, "expiresAt", "createdAt")
     VALUES ($1,$2,$3,0,$4,$5,'login',false,(now() at time zone 'utc') + interval '15 minutes',(now() at time zone 'utc'))`,
    [`qa${randomBytes(10).toString("hex")}`, tokenHash, codeHash, next, email]
  );
  return code;
}

/** Reach the check-your-email screen without spending the real request-link quota. */
async function reachCheckEmail(page, email, path = "/login") {
  await page.route("**/api/auth/request-link", (route) =>
    route.fulfill({ json: { ok: true, message: "Check your inbox.", expiresInMinutes: 15, codeLength: 6, deliveryDegraded: false } })
  );
  await page.goto(path);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
}

test.describe("sign-in code (PO-1)", () => {
  test("wrong code shows tries left; a pasted code with spaces signs in and honours next", async ({ page }) => {
    const u = await createUser();
    const code = await mintCode(u.email);
    await reachCheckEmail(page, u.email, "/login?next=%2Freview");
    const input = page.getByLabel("Sign-in code");
    await expect(input).toHaveAttribute("autocomplete", "one-time-code");
    await expect(input).toHaveAttribute("inputmode", "numeric");
    const wrong = code === "111111" ? "222222" : "111111";
    await input.fill(wrong);
    await expect(page.getByText(/That code isn't right\. .*4 tries left\./)).toBeVisible();
    await expect(input).toHaveValue("");
    // Paste-style input: spaces are dropped and the full code submits itself.
    await input.fill(`${code.slice(0, 3)} ${code.slice(3)}`);
    await expect(page).toHaveURL(/\/review$/);
    await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();
  });

  test("five wrong codes lock it and offer a new link", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "spends the shared per-IP verify quota; desktop only");
    const u = await createUser();
    const code = await mintCode(u.email);
    await reachCheckEmail(page, u.email);
    const input = page.getByLabel("Sign-in code");
    const wrong = code === "111111" ? "222222" : "111111";
    for (let i = 4; i >= 1; i--) {
      await input.fill(wrong);
      await expect(page.getByText(new RegExp(`${i} ${i === 1 ? "try" : "tries"} left`))).toBeVisible();
    }
    await input.fill(wrong);
    await expect(page.getByText("Send a new link to get a fresh code.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send a new link" })).toBeVisible();
    await expect(input).toBeDisabled();
  });
});

test.describe("simpler, please (PO-2)", () => {
  test.use({ userOptions: { helpLevel: 3 } });

  test("starting at level 3, lower levels are reachable", async ({ page, user }) => {
    const id = await createArticle(page);
    await page.goto(`/read/${id}`);
    const panel = await explainPhrase(page, "eventual consistency");
    await expect(panel).toContainText("Mock explanation (level 3)");
    await expect(panel.getByRole("radio", { name: "Level 1, Simple" })).toBeEnabled();
    await panel.getByRole("button", { name: "Simpler, please" }).click();
    await expect(panel).toContainText("Mock explanation (level 2)");
    await panel.getByRole("radio", { name: "Level 1, Simple" }).click();
    await expect(panel).toContainText("Mock explanation (level 1)");
    // Level 3 is still one tap away, instantly.
    await panel.getByRole("radio", { name: "Level 3, Deep dive" }).click();
    await expect(panel).toContainText("Mock explanation (level 3)");
  });
});

test.describe("structured articles (PO-6)", () => {
  test("headings, lists and verbatim code blocks render; code scrolls inside its block", async ({ page, user }) => {
    const longLine = `const result = ${"someVeryLongIdentifierName + ".repeat(8)}1;`;
    const text = [
      "## Caching basics",
      "A cache keeps a copy of data close to where it is used.",
      "- fast reads\n- fewer database trips",
      "1. check the cache\n2. fall back to the database",
      "```js\nfunction get(key) {\n    return cache.get(key) ?? db.load(key);\n}\n" + longLine + "\n```",
      "Afterwards, the cache is warm.",
    ].join("\n\n");
    const id = await createArticle(page, { text, title: "Structured" });
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(`/read/${id}`);
    await expect(page.getByRole("heading", { name: "Caching basics" })).toBeVisible();
    await expect(page.locator("ul li", { hasText: "fast reads" })).toBeVisible();
    await expect(page.locator("ol li", { hasText: "fall back to the database" })).toBeVisible();
    const pre = page.locator("pre[data-p]");
    await expect(pre).toHaveCount(1);
    expect(await pre.textContent()).toBe(`function get(key) {\n    return cache.get(key) ?? db.load(key);\n}\n${longLine}`);
    const sizes = await pre.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, font: getComputedStyle(el).fontFamily }));
    expect(sizes.scroll).toBeGreaterThan(sizes.client);
    expect(sizes.font).toMatch(/mono|Menlo|Consolas|Courier/i);
    const pageScroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(pageScroll).toBeLessThanOrEqual(0);
    // No markup is ever interpreted.
    expect(await page.locator("article script, article img").count()).toBe(0);
  });

  test("old plain-text articles still render as paragraphs", async ({ page, user }) => {
    const id = await createArticle(page, { text: "Line one\nwrapped.\n\nSecond paragraph." });
    await page.goto(`/read/${id}`);
    await expect(page.locator("p[data-p='0']")).toHaveText("Line one wrapped.");
    await expect(page.locator("p[data-p='1']")).toHaveText("Second paragraph.");
  });
});

test.describe("error recovery", () => {
  test("daily_limit: clear copy, Notebook way out, no useless Try again", async ({ page, user }) => {
    await page.route("**/api/explain", (route) =>
      route.fulfill({ status: 429, json: { error: "daily_limit", message: "Daily limit reached.", retryAfter: 7200 } })
    );
    const id = await createArticle(page);
    await page.goto(`/read/${id}`);
    const panel = await explainPhrase(page, "eventual consistency");
    // The alert renders the sentence twice: an aria-hidden visual copy and an sr-only copy.
    const alert = panel.getByRole("alert");
    const visual = alert.locator("span[aria-hidden='true']").first();
    await expect(visual).toBeVisible();
    await expect(visual).toContainText("You've reached today's limit for explanations.");
    await expect(alert.getByText("2h", { exact: true })).toBeVisible();
    await expect(alert.locator("span.sr-only")).toContainText("You've reached today's limit for explanations. More in 2h.");
    await expect(panel.getByRole("link", { name: "Open Notebook" })).toBeVisible();
    await expect(panel.getByRole("button", { name: /^Try again/ })).toHaveCount(0);
  });

  test.describe("onboarding save failure (PO-4)", () => {
    test.use({ userOptions: { onboarded: false } });

    test("shows the error with Try again and Continue anyway, and never loops", async ({ page, user }) => {
      let fail = true;
      await page.route("**/api/me", async (route) => {
        const body = route.request().postData() || "";
        if (route.request().method() === "PATCH" && body.includes("onboarded") && fail) {
          return route.fulfill({ status: 500, json: { error: "server_error", message: "Something went wrong on our side. Please try again." } });
        }
        return route.continue();
      });
      await page.goto("/onboarding");
      await page.getByRole("button", { name: "Skip", exact: true }).click();
      await expect(page.locator("#main").getByText("Couldn't save that.")).toBeVisible();
      await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
      await expect(page).toHaveURL(/\/onboarding/);
      await page.getByRole("button", { name: "Continue anyway" }).click();
      await expect(page).toHaveURL(/\/read$/);
      await expect(page.getByRole("heading", { name: "Read", exact: true })).toBeVisible();
      // The background retry (still failing here) never bounces the user back.
      await page.waitForTimeout(500);
      await expect(page).toHaveURL(/\/read$/);
      fail = false;
    });
  });
});

test.describe("library: paste link (PO-7)", () => {
  test("a link pasted into the text box offers to import it instead", async ({ page, user }) => {
    await page.goto("/read");
    await page.getByRole("tab", { name: "Paste text" }).click();
    await page.getByLabel("Article text").fill("https://example.com/some/article");
    await page.getByRole("button", { name: "Import this link instead" }).click();
    await expect(page.getByLabel("Article link")).toHaveValue("https://example.com/some/article");
  });

  test("Paste link from clipboard fills the link field", async ({ page, context, user }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "clipboard permissions are Chromium-only in Playwright");
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/read");
    await page.getByRole("tab", { name: "Import from URL" }).click();
    await page.evaluate(() => navigator.clipboard.writeText("Read this: https://example.com/post"));
    await page.getByRole("button", { name: "Paste link from clipboard" }).click();
    await expect(page.getByLabel("Article link")).toHaveValue("https://example.com/post");
    await page.evaluate(() => navigator.clipboard.writeText("no link here"));
    await page.getByRole("button", { name: "Paste link from clipboard" }).click();
    await expect(page.getByText("Your clipboard doesn't have a link in it.", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Paste text instead" })).toBeVisible();
  });
});

test.describe("shared device (SEC-3)", () => {
  test("a different signed-in user wipes the previous user's offline queue and cached user", async ({ page, user }) => {
    await page.addInitScript(() => {
      if (sessionStorage.getItem("qa.seeded")) return;
      sessionStorage.setItem("qa.seeded", "1");
      localStorage.setItem("aha.uid", "someone-else");
      localStorage.setItem("aha.user", JSON.stringify({ id: "someone-else", email: "other@example.test" }));
      localStorage.setItem("aha.reviewQueue", JSON.stringify([{ clientId: "c1", conceptId: "x", quality: 5, queuedAt: new Date().toISOString() }]));
    });
    await page.goto("/notebook");
    await expect(page.getByRole("heading", { name: "Notebook", exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("aha.reviewQueue"))).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem("aha.uid"))).toBe(user.id);
    expect(JSON.parse(await page.evaluate(() => localStorage.getItem("aha.user"))).id).toBe(user.id);
  });
});

test("[mobile] save form opens with the sheet expanded (QA-5 companion)", async ({ page, user }, testInfo) => {
  test.skip(!isMobile(testInfo), "bottom sheet only");
  const id = await createArticle(page);
  await page.goto(`/read/${id}`);
  const panel = await explainPhrase(page, "eventual consistency");
  await expect(panel).toContainText("Mock explanation (level 1)");
  await panel.getByRole("button", { name: "Save to Notebook" }).click();
  await expect(page.getByRole("button", { name: "Collapse panel" })).toBeVisible();
  await expect(panel.getByLabel("Tags")).toBeInViewport();
});
