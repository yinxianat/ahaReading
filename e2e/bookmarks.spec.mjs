// Bookmarks (re-visit later / important, with notes) and resuming where you stopped reading.
import { test, expect, createArticle, selectPhrase, sql } from "./support/fixtures.mjs";

const LONG_TEXT = Array.from(
  { length: 40 },
  (_, i) => `Paragraph ${i + 1}: replicas converge once updates stop, and quorum reads pick the newest value they see in section ${i + 1}.`
).join("\n\n");

async function bookmarkPhrase(page, phrase, { kind = "Re-visit later", note } = {}) {
  await selectPhrase(page, phrase);
  await page.getByRole("button", { name: "Bookmark", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Bookmark this passage" });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator("blockquote")).toContainText(phrase);
  await sheet.getByRole("radio", { name: kind }).click();
  if (note) await sheet.getByLabel("Note (optional)").fill(note);
  await sheet.getByRole("button", { name: "Add bookmark" }).click();
  await expect(sheet).toBeHidden();
}

test.describe("bookmarks", () => {
  test("bookmark a passage as important with a note; it's marked in the article and listed on Bookmarks", async ({ page, user }) => {
    const id = await createArticle(page, { title: "Replication notes" });
    await page.goto(`/read/${id}`);
    await bookmarkPhrase(page, "eventual consistency", { kind: "Important", note: "Exam question" });

    await expect(page.locator(".bm-important")).toHaveCount(1);
    await expect(page.locator(".bm-important")).toContainText("eventual consistency");
    await expect(page.getByRole("button", { name: "Bookmarks in this article (1)" })).toBeVisible();

    await page.goto("/bookmarks");
    const item = page.getByTestId("bookmark-item");
    await expect(item).toHaveCount(1);
    await expect(item).toContainText("Important");
    await expect(item).toContainText("eventual consistency");
    await expect(item).toContainText("Exam question");
    await expect(page.getByRole("heading", { name: "Replication notes" })).toBeVisible();
    // Filters show counts and narrow the list.
    await page.getByRole("radio", { name: "Re-visit (0)" }).click();
    await expect(item).toHaveCount(0);
    await page.getByRole("radio", { name: "Important (1)" }).click();
    await expect(item).toHaveCount(1);
  });

  test("Open jumps to the bookmarked passage; edit and delete from the Bookmarks page", async ({ page, user }) => {
    const id = await createArticle(page, { text: LONG_TEXT, title: "Long read" });
    await page.goto(`/read/${id}`);
    await bookmarkPhrase(page, "in section 33.");

    await page.goto("/bookmarks");
    await page.getByRole("link", { name: "Open" }).click();
    await expect(page).toHaveURL(new RegExp(`/read/${id}#bm-`));
    await expect(page.locator(".bm-revisit")).toBeInViewport();

    await page.goto("/bookmarks");
    await page.getByRole("button", { name: /Edit bookmark/ }).click();
    const sheet = page.getByRole("dialog", { name: "Edit bookmark" });
    await sheet.getByRole("radio", { name: "Important" }).click();
    await sheet.getByLabel("Note (optional)").fill("Re-read before the meeting");
    await sheet.getByRole("button", { name: "Save" }).click();
    await expect(page.getByTestId("bookmark-item")).toContainText("Re-read before the meeting");
    await expect(page.getByTestId("bookmark-item")).toContainText("Important");

    await page.getByRole("button", { name: /Edit bookmark/ }).click();
    await page.getByRole("dialog", { name: "Edit bookmark" }).getByRole("button", { name: "Delete" }).click();
    await expect(page.getByRole("heading", { name: "No bookmarks yet" })).toBeVisible();
    expect(await sql(`SELECT 1 FROM "Bookmark" WHERE "userId"=$1`, [user.id])).toHaveLength(0);
  });

  test("Bookmark where I am, from the article's bookmark list", async ({ page, user }) => {
    const id = await createArticle(page, { text: LONG_TEXT });
    await page.goto(`/read/${id}`);
    await page.locator('[data-p="20"]').waitFor();
    await page.evaluate(() => document.querySelector('[data-p="20"]').scrollIntoView({ block: "start" }));
    await page.getByRole("button", { name: "Bookmarks in this article (0)" }).click();
    await page.getByRole("button", { name: "Bookmark where I am" }).click();
    const sheet = page.getByRole("dialog", { name: "Bookmark this passage" });
    // The first block that's readable below the sticky bar (one partly hidden under it is skipped).
    await expect(sheet.locator("blockquote")).toContainText(/Paragraph (2[0-3]):/);
    await sheet.getByRole("button", { name: "Add bookmark" }).click();
    await expect(page.locator(".bm-revisit")).toHaveCount(1);
  });
});

test.describe("reading progress", () => {
  test("leaving part-way and coming back offers to continue; the Library shows progress", async ({ page, user }) => {
    const id = await createArticle(page, { text: LONG_TEXT, title: "Progress article" });
    await page.goto(`/read/${id}`);
    await page.locator('[data-p="24"]').waitFor();
    await page.evaluate(() => document.querySelector('[data-p="24"]').scrollIntoView({ block: "start" }));
    // Saved a moment after scrolling stops.
    await expect
      .poll(async () => (await sql(`SELECT "readBlock", "readPercent" FROM "Article" WHERE id=$1`, [id]))[0], { timeout: 10000 })
      .toMatchObject({ readBlock: expect.any(Number) });
    const [saved] = await sql(`SELECT "readBlock", "readPercent" FROM "Article" WHERE id=$1`, [id]);
    expect(saved.readBlock).toBeGreaterThanOrEqual(22);
    expect(saved.readPercent).toBeGreaterThan(30);

    await page.goto("/read");
    await expect(page.locator("main li", { hasText: "Progress article" })).toContainText(`${saved.readPercent}% read`);

    await page.goto(`/read/${id}`);
    await expect(page.getByText(`You were ${saved.readPercent}% through this article.`)).toBeVisible();
    await page.getByRole("button", { name: "Continue reading" }).click();
    await expect(page.locator(`[data-p="${saved.readBlock}"]`)).toBeInViewport();
  });

  test("opening an article and leaving without scrolling keeps the saved place", async ({ page, user }) => {
    const id = await createArticle(page, { text: LONG_TEXT });
    await sql(`UPDATE "Article" SET "readBlock"=15, "readPercent"=40 WHERE id=$1`, [id]);
    await page.goto(`/read/${id}`);
    await expect(page.getByText("You were 40% through this article.")).toBeVisible();
    await page.goto("/read");
    await page.waitForTimeout(500);
    expect((await sql(`SELECT "readBlock" FROM "Article" WHERE id=$1`, [id]))[0].readBlock).toBe(15);
  });
});
