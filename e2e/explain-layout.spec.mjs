// The explain panel must never hide the text being explained, and scrollable areas must look scrollable.
import { test, expect, createArticle, explainPhrase, isMobile } from "./support/fixtures.mjs";

test.describe("explain panel layout", () => {
  test("laptop width: the side panel sits beside the article, never over it", async ({ page, user }, testInfo) => {
    test.skip(isMobile(testInfo), "side panel is desktop-only");
    await page.setViewportSize({ width: 1024, height: 760 });
    const id = await createArticle(page);
    await page.goto(`/read/${id}`);
    const panel = await explainPhrase(page, "eventual consistency");
    await expect(panel).toContainText("Mock explanation (level 1)");
    // Let the column's padding transition finish.
    await expect
      .poll(async () => {
        const article = await page.locator("article").boundingBox();
        const side = await panel.boundingBox();
        return article.x + article.width <= side.x;
      })
      .toBe(true);
    await expect(page.locator("mark.active")).toBeInViewport();
  });

  test("phone: the article stays scrollable behind the sheet and the phrase stays visible above it", async ({ page, user }, testInfo) => {
    test.skip(!isMobile(testInfo), "bottom sheet only");
    const id = await createArticle(page);
    await page.goto(`/read/${id}`);
    const panel = await explainPhrase(page, "eventual consistency");
    await expect(panel).toContainText("Mock explanation (level 1)");
    // No dimming scrim: the page behind is not modal.
    await expect(panel).not.toHaveAttribute("aria-modal", "true");
    // The highlighted phrase ends up above the sheet's top edge.
    await expect
      .poll(async () => {
        const mark = await page.locator("mark.active").boundingBox();
        const sheet = await panel.boundingBox();
        return mark && sheet && mark.y + mark.height <= sheet.y;
      })
      .toBe(true);
    // Touches above the sheet reach the article (no scrim catching them), so it can be scrolled and read.
    const sheetTop = (await panel.boundingBox()).y;
    const hit = await page.evaluate((y) => Boolean(document.elementFromPoint(window.innerWidth / 2, y)?.closest("article, main")), sheetTop / 2);
    expect(hit).toBe(true);
    // Room below the text: the last paragraph can scroll up above the sheet.
    const room = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight - window.scrollY);
    expect(room).toBeGreaterThan(0);
  });

  test("a long code line says it scrolls sideways", async ({ page, user }) => {
    const longLine = `const result = ${"someVeryLongIdentifierName + ".repeat(8)}1;`;
    const id = await createArticle(page, { text: `Intro paragraph about the code below.\n\n\`\`\`js\n${longLine}\n\`\`\`` });
    await page.setViewportSize({ width: 360, height: 700 });
    await page.goto(`/read/${id}`);
    await expect(page.getByText("Scroll sideways to see the full lines →")).toBeVisible();
    await page.locator("pre[data-p]").evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
    await expect(page.getByText("← Scroll back to the start of the lines")).toBeVisible();
  });
});
