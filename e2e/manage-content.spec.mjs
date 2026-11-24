// Users manage their own content: edit/delete articles, add their own Notebook concepts.
import { test, expect, createArticle, sql } from "./support/fixtures.mjs";

test.describe("edit and delete reading materials", () => {
  test("edit an article's title and text from the reader", async ({ page, user }) => {
    const id = await createArticle(page, { text: "Original opening paragraph about caching.\n\nA second paragraph.", title: "Old title" });
    await page.goto(`/read/${id}`);
    await page.getByRole("link", { name: "Edit" }).click();
    await expect(page).toHaveURL(new RegExp(`/read/${id}/edit$`));
    await expect(page.getByLabel("Text")).toHaveValue(/Original opening paragraph/);

    await page.getByLabel("Title").fill("New title");
    await page.getByLabel("Text").fill("## Fresh section\n\nRewritten paragraph about caching.");
    await page.getByRole("button", { name: "Save changes" }).click();

    await expect(page).toHaveURL(new RegExp(`/read/${id}$`));
    await expect(page.getByRole("heading", { name: "New title", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Fresh section" })).toBeVisible();
    await expect(page.getByText("Rewritten paragraph about caching.")).toBeVisible();
    const [row] = await sql(`SELECT title, content FROM "Article" WHERE id=$1`, [id]);
    expect(row.title).toBe("New title");
  });

  test("Cancel with unsaved changes asks first; discarding keeps the original", async ({ page, user }) => {
    const id = await createArticle(page, { text: "Keep this text exactly as it is, please.", title: "Stable" });
    await page.goto(`/read/${id}/edit`);
    await page.getByLabel("Title").fill("Changed my mind");
    await page.getByRole("button", { name: "Cancel" }).click();
    const dialog = page.getByRole("dialog", { name: "Discard your changes?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Keep editing" }).click();
    await expect(page.getByLabel("Title")).toHaveValue("Changed my mind");
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Discard" }).click();
    await expect(page).toHaveURL(new RegExp(`/read/${id}$`));
    await expect(page.getByRole("heading", { name: "Stable", level: 1 })).toBeVisible();
  });

  test("an empty text can't be saved, and says how to delete instead", async ({ page, user }) => {
    const id = await createArticle(page);
    await page.goto(`/read/${id}/edit`);
    await page.getByLabel("Text").fill("   ");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("The article needs some text. To remove it, use Delete article below.")).toBeVisible();
  });

  test("delete from the editor; open the editor from the Library", async ({ page, user }) => {
    const id = await createArticle(page, { text: "Short-lived article body text for deletion.", title: "Doomed article" });
    await page.goto("/read");
    await page.getByRole("button", { name: "Edit “Doomed article”" }).click();
    await expect(page).toHaveURL(new RegExp(`/read/${id}/edit$`));
    await page.getByRole("button", { name: "Delete article" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page).toHaveURL(/\/read$/);
    await expect(page.locator("main li", { hasText: "Doomed article" })).toHaveCount(0);
    expect(await sql(`SELECT 1 FROM "Article" WHERE id=$1`, [id])).toHaveLength(0);
  });
});

// A saved concept's page, not /notebook/new itself.
const CONCEPT_URL = /\/notebook\/(?!new$)[a-z0-9]+$/;

test.describe("add your own Notebook concept", () => {
  test("write a concept by hand; it opens in the Notebook and is due tomorrow", async ({ page, user }) => {
    await page.goto("/notebook");
    await page.getByRole("link", { name: "Add" }).click();
    await expect(page).toHaveURL(/\/notebook\/new$/);
    await page.getByLabel("Term or phrase").fill("Write-ahead log");
    await page.getByLabel("What it means").fill("A log of changes written before the data itself, so a crash can be replayed.");
    await page.getByLabel("Your note (optional)").fill("Postgres calls it WAL.");
    await page.getByRole("button", { name: "Add to Notebook" }).click();

    await expect(page).toHaveURL(CONCEPT_URL);
    await expect(page.getByRole("heading", { name: "Write-ahead log" })).toBeVisible();
    await expect(page.getByText("Written by you")).toBeVisible();
    await expect(page.getByText("A log of changes written before the data itself")).toBeVisible();
    const [row] = await sql(
      `SELECT "explanationId", "userNotes", "nextReviewAt" > (now() at time zone 'utc') + interval '20 hours' AS later FROM "Concept" WHERE "userId"=$1`,
      [user.id]
    );
    expect(row).toMatchObject({ explanationId: null, userNotes: "Postgres calls it WAL.", later: true });

    await page.goto("/notebook");
    await expect(page.locator("main li", { hasText: "Write-ahead log" })).toBeVisible();
  });

  test("missing fields are named; a duplicate term links to the saved one", async ({ page, user }) => {
    await page.goto("/notebook/new");
    await page.getByRole("button", { name: "Add to Notebook" }).click();
    await expect(page.getByText("Add the word or phrase you want to remember.")).toBeVisible();
    await expect(page.getByText("Write what it means, in your own words.")).toBeVisible();

    await page.getByLabel("Term or phrase").fill("Quorum");
    await page.getByLabel("What it means").fill("A majority of replicas that must agree.");
    await page.getByRole("button", { name: "Add to Notebook" }).click();
    await expect(page).toHaveURL(CONCEPT_URL);
    await expect(page.getByRole("heading", { name: "Quorum" })).toBeVisible();

    await page.goto("/notebook/new");
    await page.getByLabel("Term or phrase").fill("quorum");
    await page.getByLabel("What it means").fill("Same idea, different words.");
    await page.getByRole("button", { name: "Add to Notebook" }).click();
    await expect(page.getByText(/You already have “quorum” in your Notebook/)).toBeVisible();
    await page.getByRole("link", { name: "Open it" }).click();
    await expect(page.getByRole("heading", { name: "Quorum" })).toBeVisible();
  });
});
