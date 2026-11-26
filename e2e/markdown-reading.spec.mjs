// The original reading format: Markdown articles keep bold, links, tables and quotes, and every
// reading feature (explain, saved-concept marks, bookmarks) works over formatted text.
import { test, expect, sql } from "./support/fixtures.mjs";

const MD = [
  "# Replication notes",
  "",
  "Raft keeps a **replicated log** consistent across servers; see [the Raft paper](https://raft.github.io).",
  "",
  "> A quote that *matters*.",
  "",
  "| Term | Meaning |",
  "|---|---|",
  "| quorum | a **majority** of servers |",
  "",
  "- leaders send `AppendEntries`",
  "  - followers acknowledge",
  "",
  "Plain closing paragraph about eventual consistency and anti-entropy repair.",
].join("\n");

async function pasteArticle(page, text, { keepMarkdown = true } = {}) {
  await page.goto("/read");
  await page.getByRole("tab", { name: /^Paste/ }).click();
  await page.getByLabel("Article text").fill(text);
  const toggle = page.getByRole("checkbox", { name: /Keep Markdown formatting/ });
  await expect(toggle).toBeChecked();
  if (!keepMarkdown) await toggle.uncheck();
  await page.getByRole("button", { name: "Start reading" }).click();
  await expect(page).toHaveURL(/\/read\/[a-z0-9]+$/);
  return page.url().split("/").pop();
}

/** Select a phrase even when it crosses formatting elements (bold, links). */
async function selectAcross(page, phrase) {
  await page.locator("[data-p]").first().waitFor();
  await page.evaluate((phrase) => {
    for (const block of document.querySelectorAll("[data-p]")) {
      const at = block.textContent.indexOf(phrase);
      if (at < 0) continue;
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      let pos = 0;
      let start = null;
      let end = null;
      let node;
      while ((node = walker.nextNode())) {
        const len = node.data.length;
        if (!start && at < pos + len) start = [node, at - pos];
        if (at + phrase.length <= pos + len) {
          end = [node, at + phrase.length - pos];
          break;
        }
        pos += len;
      }
      const r = document.createRange();
      r.setStart(...start);
      r.setEnd(...end);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
      document.dispatchEvent(new Event("selectionchange"));
      return;
    }
    throw new Error(`phrase not found: ${phrase}`);
  }, phrase);
}

test.describe("original reading format (Markdown)", () => {
  test("pasted Markdown keeps bold, links, quotes, tables and nested lists; no raw syntax shows", async ({ page, user }) => {
    const id = await pasteArticle(page, MD);
    const article = page.locator("article");
    await expect(page.getByRole("heading", { name: "Replication notes", level: 1 })).toBeVisible();
    await expect(article.locator("strong", { hasText: "replicated log" })).toBeVisible();
    await expect(article.locator("a", { hasText: "the Raft paper" })).toHaveAttribute("href", "https://raft.github.io/");
    await expect(article.locator("a", { hasText: "the Raft paper" })).toHaveAttribute("rel", /noopener/);
    await expect(article.locator("blockquote em", { hasText: "matters" })).toBeVisible();
    await expect(article.locator("table td", { hasText: "a majority of servers" })).toBeVisible();
    await expect(article.locator("li code", { hasText: "AppendEntries" })).toBeVisible();
    const text = await article.innerText();
    expect(text).not.toMatch(/\*\*|\]\(|^>|\|---/m);
    expect((await sql(`SELECT format FROM "Article" WHERE id=$1`, [id]))[0].format).toBe("markdown");
  });

  test("explain a phrase that crosses bold text; the explanation gets the plain words", async ({ page, user }) => {
    await pasteArticle(page, MD);
    await selectAcross(page, "replicated log consistent");
    await page.getByRole("button", { name: "I don't understand" }).click();
    const panel = page.getByRole("dialog", { name: "Explanation" }).or(page.getByRole("complementary", { name: "Explanation" }));
    await expect(panel).toContainText('Mock explanation (level 1): "replicated log consistent"');
    await expect(page.locator("mark.active")).toContainText("replicated log consistent");
  });

  test("a saved concept is marked even when the term is bold; a bookmark sits on a table row", async ({ page, user }) => {
    const id = await pasteArticle(page, MD);
    await sql(`INSERT INTO "Concept"(id,"userId","articleId",term,definition,"createdAt","updatedAt") VALUES ($1,$2,$3,'replicated log','d',(now() at time zone 'utc'),(now() at time zone 'utc'))`, [
      `qac${Date.now()}`,
      user.id,
      id,
    ]);
    await page.reload();
    await expect(page.locator("mark.concept", { hasText: "replicated log" })).toBeVisible();

    await selectAcross(page, "a majority of servers");
    await page.getByRole("button", { name: "Bookmark", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Bookmark this passage" });
    await sheet.getByRole("button", { name: "Add bookmark" }).click();
    await expect(page.locator("tr.bm-revisit")).toContainText("a majority of servers");
  });

  test("plain-text paste stays exactly as typed; the editor previews and can switch format", async ({ page, user }) => {
    const id = await pasteArticle(page, "Some **bold** and a [link](https://x.io) stay as typed.\n\nSecond paragraph with enough words.", { keepMarkdown: false });
    await expect(page.locator("article")).toContainText("Some **bold** and a [link](https://x.io) stay as typed.");
    expect((await sql(`SELECT format FROM "Article" WHERE id=$1`, [id]))[0].format).toBe("blocks");

    await page.goto(`/read/${id}/edit`);
    const toggle = page.getByRole("checkbox", { name: "Markdown formatting" });
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await page.getByRole("radio", { name: "Preview" }).click();
    await expect(page.getByLabel("Preview").locator("strong", { hasText: "bold" })).toBeVisible();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(new RegExp(`/read/${id}$`));
    await expect(page.locator("article strong", { hasText: "bold" })).toBeVisible();
    expect((await sql(`SELECT format FROM "Article" WHERE id=$1`, [id]))[0].format).toBe("markdown");
  });
});
