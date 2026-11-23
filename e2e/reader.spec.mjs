// Core loop: library → paste → reader → explain L1/L2/L3 → translate → save.
import { test, expect, createArticle, explainPhrase, selectPhrase, sql, isMobile, openSaveForm } from "./support/fixtures.mjs";

test.describe("onboarding", () => {
  test.use({ userOptions: { onboarded: false } });

  test("new user is sent to onboarding, choices persist, lands on library", async ({ page, user }) => {
    await page.goto("/read");
    await expect(page).toHaveURL(/\/onboarding/);
    await expect(page.getByRole("heading", { name: "How would you like explanations?" })).toBeVisible();
    await page.getByText("English + 中文", { exact: false }).first().click();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "Where should explanations start?" })).toBeVisible();
    await page.getByText("2 · Analogy", { exact: false }).first().click();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "Here's how it works." })).toBeVisible();
    await page.getByRole("button", { name: "Start reading" }).click();
    await expect(page).toHaveURL(/\/read$/);
    await expect(page.getByRole("heading", { name: "Read", exact: true })).toBeVisible();
    const [row] = await sql(`SELECT locale, "helpLevel", "onboardedAt" FROM "User" WHERE id=$1`, [user.id]);
    expect(row.locale).toBe("zh");
    expect(row.helpLevel).toBe(2);
    expect(row.onboardedAt).not.toBeNull();
  });

  test("skip always works", async ({ page, user }) => {
    await page.goto("/onboarding");
    await page.getByRole("link", { name: "Skip", exact: true }).or(page.getByRole("button", { name: "Skip", exact: true })).first().click();
    await expect(page).toHaveURL(/\/read/);
    const [row] = await sql(`SELECT "onboardedAt" FROM "User" WHERE id=$1`, [user.id]);
    expect(row.onboardedAt).not.toBeNull();
  });
});

test.describe("library", () => {
  test("empty state, paste an article, it opens in the reader and lists in Recent", async ({ page, user }) => {
    await page.goto("/read");
    await expect(page.getByText("Nothing here yet")).toBeVisible();
    await page.getByRole("tab", { name: "Paste text" }).click();
    const start = page.getByRole("button", { name: "Start reading" });
    await expect(start).toBeDisabled();
    await page.getByLabel("Title (optional)").fill("Pasted via UI");
    await page.getByLabel("Article text").fill("First paragraph about caching.\n\nSecond paragraph about queues.");
    await expect(page.getByText(/\d+ \/ 200,000/)).toBeVisible();
    await start.click();
    await expect(page).toHaveURL(/\/read\/[a-z0-9]+$/);
    await expect(page.getByRole("heading", { name: "Pasted via UI" })).toBeVisible();
    await expect(page.locator("[data-p]")).toHaveCount(2);
    await page.getByRole("link", { name: "Library" }).click();
    await expect(page.getByRole("link", { name: /Pasted via UI/ })).toBeVisible();
    await expect(page.getByText(/Pasted text · /)).toBeVisible();
  });

  test("delete article from library with confirm dialog", async ({ page, user }) => {
    await createArticle(page, { title: "Delete me" });
    await page.goto("/read");
    await page.getByRole("button", { name: "Delete “Delete me”" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Concepts you saved from it stay in your Notebook.");
    await dialog.getByRole("button", { name: "Delete" }).click();
    await expect(page.locator("p", { hasText: "Article deleted." })).toBeVisible();
    await expect(page.getByText("Nothing here yet")).toBeVisible();
  });

  for (const [url, label] of [
    ["http://169.254.169.254/", "metadata"],
    ["http://localhost:3100", "self"],
  ]) {
    test(`import blocked URL (${label}) shows message and Paste-text recovery`, async ({ page, user }) => {
      await page.goto("/read");
      await page.getByRole("tab", { name: "Import from URL" }).click();
      await page.getByLabel("Article link").fill(url);
      await page.getByRole("button", { name: "Import" }).click();
      const alert = page.locator("form [role=alert]");
      await expect(alert).toContainText("can't be imported");
      await alert.getByRole("button", { name: "Paste text instead" }).click();
      await expect(page.getByRole("tab", { name: "Paste text" })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByLabel("Article text")).toBeFocused();
    });
  }

  test("import with missing scheme auto-prefixes https", async ({ page, user }) => {
    await page.goto("/read");
    await page.getByRole("tab", { name: "Import from URL" }).click();
    await page.getByLabel("Article link").fill("localhost");
    await page.getByRole("button", { name: "Import" }).click();
    await expect(page.getByLabel("Article link")).toHaveValue("https://localhost");
    await expect(page.locator("form [role=alert]")).toContainText("can't be imported");
  });

  test("unknown article id shows not-found page with a way back", async ({ page, user }) => {
    await page.goto("/read/doesnotexist123");
    await expect(page.getByText("We can't find that article.")).toBeVisible();
    await page.getByRole("link", { name: "Back to Library" }).click();
    await expect(page).toHaveURL(/\/read$/);
  });
});

test.describe("reader explain loop", () => {
  test("first-visit coach tip shows and is dismissible", async ({ page, user }) => {
    const id = await createArticle(page);
    await page.addInitScript(() => sessionStorage.setItem("qa.keepCoach", "1"));
    await page.goto("/");
    await page.evaluate(() => localStorage.removeItem("aha.coachReader"));
    await page.goto(`/read/${id}`);
    const tip = page.getByRole("note");
    await expect(tip).toContainText("Select any word or sentence you don't understand");
    await tip.getByRole("button", { name: "Got it" }).click();
    await expect(tip).toBeHidden();
    await page.reload();
    await expect(page.locator("[data-p]").first()).toBeVisible();
    await expect(page.getByRole("note")).toBeHidden();
  });

  test("L1 → Still confused → L2 → L3 → smaller-phrase hint; stepper revisits", async ({ page, user }, testInfo) => {
    const id = await createArticle(page);
    await page.goto(`/read/${id}`);
    const panel = await explainPhrase(page, "content delivery network");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Mock explanation (level 1): "content delivery network"');
    await panel.getByRole("button", { name: "Still confused" }).click();
    await expect(panel).toContainText("Mock explanation (level 2)");
    await panel.getByRole("button", { name: "Still confused" }).click();
    await expect(panel).toContainText("Mock explanation (level 3)");
    await expect(panel.getByRole("button", { name: "Still confused" })).toHaveCount(0);
    await expect(panel).toContainText("Still stuck? Try selecting a smaller phrase");
    // Revisit level 1 instantly via the stepper.
    await panel.getByRole("radio", { name: "Level 1, Simple" }).click();
    await expect(panel).toContainText("Mock explanation (level 1)");
    await panel.getByRole("radio", { name: "Level 3, Deep dive" }).click();
    await panel.getByRole("button", { name: "Pick a smaller phrase" }).click();
    await expect(panel).toBeHidden();
    if (isMobile(testInfo)) await expect(page.getByRole("paragraph").filter({ hasText: "Select one word or term" })).toBeVisible();
    // Explanations were stored server-side with the article link.
    const rows = await sql(`SELECT "helpLevel" FROM "Explanation" WHERE "userId"=$1 ORDER BY "helpLevel"`, [user.id]);
    expect([...new Set(rows.map((r) => r.helpLevel))]).toEqual([1, 2, 3]);
  });

  test("Got it closes the panel", async ({ page, user }) => {
    const id = await createArticle(page);
    await page.goto(`/read/${id}`);
    const panel = await explainPhrase(page, "eventual consistency");
    await expect(panel).toContainText("Mock explanation (level 1)");
    await panel.getByRole("button", { name: "Got it" }).click();
    await expect(panel).toBeHidden();
  });

  test("Esc closes the panel (desktop)", async ({ page, user }, testInfo) => {
    test.skip(isMobile(testInfo), "keyboard path is desktop-only");
    const id = await createArticle(page);
    await page.goto(`/read/${id}`);
    const panel = await explainPhrase(page, "eventual consistency");
    await expect(panel).toContainText("Mock explanation (level 1)");
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
  });

  test("Alt+Enter opens the panel from a keyboard selection (desktop)", async ({ page, user }, testInfo) => {
    test.skip(isMobile(testInfo), "keyboard path is desktop-only");
    const id = await createArticle(page);
    await page.goto(`/read/${id}`);
    await selectPhrase(page, "eventual consistency");
    await expect(page.getByRole("button", { name: "I don't understand" })).toBeVisible();
    await page.keyboard.press("Alt+Enter");
    await expect(page.getByRole("complementary", { name: "Explanation" }).or(page.getByRole("dialog", { name: "Explanation" }))).toContainText("Mock explanation");
  });

  test("cancel while loading (__slow__) closes the panel and restores the entry point", async ({ page, user }) => {
    const id = await createArticle(page);
    await page.goto(`/read/${id}`);
    const panel = await explainPhrase(page, "__slow__ responses");
    await expect(panel.getByText("Thinking…")).toBeVisible();
    await panel.getByRole("button", { name: "Cancel" }).click();
    await expect(panel).toBeHidden();
    await expect(page.getByRole("button", { name: "I don't understand" })).toBeVisible();
    // Nothing late-arrives into a ghost panel.
    await page.waitForTimeout(3500);
    await expect(panel).toBeHidden();
  });

  test("cancel an escalation returns to the previous level", async ({ page, user }) => {
    const id = await createArticle(page);
    await page.goto(`/read/${id}`);
    const panel = await explainPhrase(page, "__slow__ responses");
    await expect(panel).toContainText("Mock explanation (level 1)", { timeout: 15_000 });
    await panel.getByRole("button", { name: "Still confused" }).click();
    await expect(panel.getByText("Finding an analogy…")).toBeVisible();
    await panel.getByRole("button", { name: "Cancel" }).click();
    await expect(panel).toContainText("Mock explanation (level 1)");
    await expect(panel.getByRole("radio", { name: "Level 1, Simple" })).toHaveAttribute("aria-checked", "true");
  });

  test("中文 toggle shows the translation; saved concept carries it", async ({ page, user }) => {
    const id = await createArticle(page);
    await page.goto(`/read/${id}`);
    const panel = await explainPhrase(page, "content delivery network");
    await expect(panel).toContainText("Mock explanation (level 1)");
    await panel.getByRole("radio", { name: "中文" }).click();
    await expect(panel.getByText("中文翻译")).toBeVisible();
    await expect(panel).toContainText("这是一个模拟翻译");
    await openSaveForm(page, panel);
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    await expect(panel.getByText("Saved ✓ · Review tomorrow")).toBeVisible();
    const [c] = await sql(`SELECT "definitionZh" FROM "Concept" WHERE "userId"=$1`, [user.id]);
    expect(c.definitionZh).toContain("模拟翻译");
  });

  test("[QA-3] save with tags and note → Saved; re-explain same term → Already in your Notebook; term highlighted", async ({ page, user }) => {
    const id = await createArticle(page);
    await page.goto(`/read/${id}`);
    let panel = await explainPhrase(page, "eventual consistency");
    await expect(panel).toContainText("Mock explanation (level 1)");
    await openSaveForm(page, panel);
    const tags = panel.getByLabel("Tags");
    await tags.fill("Databases");
    await tags.press("Enter");
    await tags.fill("distributed,");
    await expect(panel.getByRole("button", { name: "Remove tag databases" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Remove tag distributed" })).toBeVisible();
    await panel.getByLabel("Your note (optional)").fill("Like gossip spreading in a village.");
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    await expect(panel.getByText("Saved ✓ · Review tomorrow")).toBeVisible();
    await expect(panel.getByRole("link", { name: "Open in Notebook" })).toBeVisible();
    const [c] = await sql(`SELECT term, tags, "userNotes", "articleId" FROM "Concept" WHERE "userId"=$1`, [user.id]);
    expect(c.term).toBe("eventual consistency");
    expect(c.tags).toEqual(["databases", "distributed"]);
    expect(c.userNotes).toBe("Like gossip spreading in a village.");
    expect(c.articleId).toBe(id);
    await panel.getByRole("button", { name: "Got it" }).click();
    await expect(panel).toBeHidden();
    // Saved-concept mark appears immediately.
    const mark = page.locator("mark.concept", { hasText: "eventual consistency" });
    await expect(mark).toBeVisible();
    // Same selection again (cached explanation, same id) → already saved.
    panel = await explainPhrase(page, "Databases that replicate");
    await expect(panel).toContainText("Mock explanation (level 1)");
    await panel.getByRole("button", { name: "Got it" }).click();
    // Re-explain the exact saved term via the mark's "Explain again".
    await page.reload();
    await expect(mark).toBeVisible();
    await mark.click();
    await expect(page.getByText("Next review:")).toBeVisible();
    await page.getByRole("button", { name: "Explain again" }).click();
    panel = page.getByRole("dialog", { name: "Explanation" }).or(page.getByRole("complementary", { name: "Explanation" }));
    await expect(panel).toContainText('Mock explanation (level 1): "eventual consistency"');
    await openSaveForm(page, panel);
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    await expect(panel.getByText("Already in your Notebook")).toBeVisible();
    await expect(panel.getByRole("link", { name: "Open" })).toHaveAttribute("href", /\/notebook\/.+/);
  });

  test("selection longer than 1000 chars shows the too-long state, no API call", async ({ page, user }) => {
    const long = Array.from({ length: 180 }, (_, i) => `word${i}`).join(" ") + " end.";
    const id = await createArticle(page, { text: `${long}\n\nshort tail` });
    await page.goto(`/read/${id}`);
    await page.locator("[data-p]").first().waitFor();
    let calls = 0;
    page.on("request", (r) => r.url().includes("/api/explain") && calls++);
    await page.evaluate(() => {
      const p = document.querySelector("[data-p='0']");
      const r = document.createRange();
      r.selectNodeContents(p);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    });
    await expect(page.getByText("Too long — select up to a sentence or two").first()).toBeVisible();
    expect(calls).toBe(0);
  });
});

test("[QA-5] mobile: Save button is reachable at the default sheet height", async ({ page, user }, testInfo) => {
  test.skip(!isMobile(testInfo), "bottom sheet only");
  const id = await createArticle(page);
  await page.goto(`/read/${id}`);
  const panel = await explainPhrase(page, "eventual consistency");
  await expect(panel).toContainText("Mock explanation (level 1)");
  await panel.getByRole("button", { name: "Save to Notebook" }).click();
  await expect(panel.getByRole("button", { name: "Save", exact: true })).toBeInViewport();
  await expect(panel.getByText("Mock explanation (level 1)")).toBeInViewport();
});
