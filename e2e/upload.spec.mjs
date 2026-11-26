// Upload a PDF, Word or Markdown file as reading material (Library → Upload file).
import { test, expect } from "./support/fixtures.mjs";
import { makePdf, makeDocx, PROSE } from "../tests/fixtures/documents.js";

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

async function openUploadTab(page) {
  await page.goto("/read");
  await page.getByRole("tab", { name: "Upload file" }).click();
  return page.locator("#upload-input");
}

test.describe("upload a document", () => {
  test("a PDF opens in the reader with its structure and file name", async ({ page, user }) => {
    const input = await openUploadTab(page);
    const pdf = makePdf([[
      { text: "Raft in one page", y: 720, size: 22 },
      { text: PROSE, y: 690 },
      { text: "• leaders replicate the log", y: 660 },
      { text: "• followers vote", y: 646 },
    ]]);
    await input.setInputFiles({ name: "raft-notes.pdf", mimeType: "application/pdf", buffer: Buffer.from(pdf) });
    await expect(page.getByTestId("upload-file")).toContainText("raft-notes.pdf");
    await page.getByRole("button", { name: "Upload and read" }).click();
    await expect(page).toHaveURL(/\/read\/[a-z0-9]+$/);
    // The opening heading becomes the title, shown once.
    await expect(page.getByRole("heading", { name: "Raft in one page" })).toHaveCount(1);
    await expect(page.getByRole("heading", { name: "Raft in one page", level: 1 })).toBeVisible();
    await expect(page.locator("ul li", { hasText: "followers vote" })).toBeVisible();
    await expect(page.getByText(/raft-notes\.pdf · Uploaded/)).toBeVisible();
    // The Library lists it by file name.
    await page.goto("/read");
    await expect(page.locator("main li", { hasText: "Raft in one page" })).toContainText("raft-notes.pdf");
  });

  test("a Markdown file keeps its original formatting: bold, links, tables; no raw syntax", async ({ page, user }) => {
    const input = await openUploadTab(page);
    const md = [
      "---", "title: Raft study notes", "---", "",
      "# Raft study notes", "",
      `${PROSE} Leaders use **heartbeats** — see [the paper](https://raft.github.io).`, "",
      "## Roles", "", "- **Leader**: handles writes", "- [x] Follower", "",
      "| Term | Meaning |", "|---|---|", "| quorum | a majority |", "",
      "```js", "const term = 1;", "```", "",
    ].join("\n");
    await input.setInputFiles({ name: "raft-notes.md", mimeType: "text/markdown", buffer: Buffer.from(md) });
    await expect(page.getByTestId("upload-file")).toContainText("raft-notes.md");
    await page.getByRole("button", { name: "Upload and read" }).click();
    await expect(page.getByRole("heading", { name: "Raft study notes", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Roles" })).toBeVisible();
    await expect(page.locator("ul li", { hasText: "Leader: handles writes" })).toBeVisible();
    // Formatting is kept as real formatting: a table, bold text and a link.
    await expect(page.locator("article table td", { hasText: "a majority" })).toBeVisible();
    await expect(page.locator("article table th", { hasText: "Meaning" })).toBeVisible();
    await expect(page.locator("article strong", { hasText: "heartbeats" })).toBeVisible();
    await expect(page.locator("article a", { hasText: "the paper" })).toHaveAttribute("href", "https://raft.github.io/");
    await expect(page.locator("pre[data-p]")).toHaveText("const term = 1;");
    const article = await page.locator("article").innerText();
    expect(article).toContain("Leaders use heartbeats — see the paper.");
    expect(article).not.toMatch(/\*\*|\]\(|title:|\|---|```/);
    await expect(page.getByText(/raft-notes\.md · Uploaded/)).toBeVisible();
  });

  test("a Word file uploads too", async ({ page, user }) => {
    const input = await openUploadTab(page);
    const docx = await makeDocx([{ heading: "Vector clocks" }, { p: PROSE }]);
    await input.setInputFiles({ name: "clocks.docx", mimeType: DOCX_TYPE, buffer: Buffer.from(docx) });
    await page.getByRole("button", { name: "Upload and read" }).click();
    await expect(page.getByRole("heading", { name: "Vector clocks", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Vector clocks" })).toHaveCount(1);
  });

  test("an old .doc is caught before uploading, with the fix named", async ({ page, user }) => {
    let uploaded = false;
    await page.route("**/api/articles/upload", (route) => {
      uploaded = true;
      return route.continue();
    });
    const input = await openUploadTab(page);
    await input.setInputFiles({ name: "old.doc", mimeType: "application/msword", buffer: Buffer.from("doc") });
    await expect(page.getByRole("alert").filter({ hasText: "older Word file (.doc)" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Upload and read" })).toBeDisabled();
    expect(uploaded).toBe(false);
  });

  test("a server-side failure explains itself and offers Paste text instead", async ({ page, user }) => {
    await page.route("**/api/articles/upload", (route) =>
      route.fulfill({ status: 422, json: { error: "file_unreadable", message: "This PDF has no text we can read. It's probably scanned pages.", field: "file" } })
    );
    const input = await openUploadTab(page);
    await input.setInputFiles({ name: "scan.pdf", mimeType: "application/pdf", buffer: Buffer.from(makePdf([[]])) });
    await page.getByRole("button", { name: "Upload and read" }).click();
    await expect(page.getByRole("tabpanel", { name: "Upload file" }).getByText("This PDF has no text we can read.")).toBeVisible();
    await page.getByRole("button", { name: "Paste text instead" }).click();
    await expect(page.getByLabel("Article text")).toBeVisible();
  });

  test("[QA4-12] at phone width every New reading tab is visible without scrolling", async ({ page, user }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto("/read");
    const tabs = page.getByRole("tablist", { name: "New reading" });
    const box = await tabs.boundingBox();
    for (const name of ["Paste text", "Import from URL", "Upload file"]) {
      const tab = page.getByRole("tab", { name });
      const b = await tab.boundingBox();
      expect(b.x, name).toBeGreaterThanOrEqual(box.x - 1);
      expect(b.x + b.width, name).toBeLessThanOrEqual(box.x + box.width + 1);
      expect(b.height).toBeGreaterThanOrEqual(44);
    }
    const fileTab = page.getByRole("tab", { name: "Upload file" });
    await expect(fileTab.getByText("File", { exact: true })).toBeVisible();
    await expect(fileTab.getByText("Upload file", { exact: true })).toBeHidden();
  });

  test("a real server-side refusal (no mocking) explains itself", async ({ page, user }) => {
    const input = await openUploadTab(page);
    await input.setInputFiles({ name: "scan.pdf", mimeType: "application/pdf", buffer: Buffer.from(makePdf([[]])) });
    await page.getByRole("button", { name: "Upload and read" }).click();
    await expect(page.getByRole("tabpanel", { name: "Upload file" }).getByText(/This PDF has no text we can read/)).toBeVisible();
    await expect(page).toHaveURL(/\/read$/);
  });

  test("[QA4-13] a file dropped outside the zone is picked, not opened in the tab", async ({ page, user }) => {
    await openUploadTab(page);
    const pdf = Buffer.from(makePdf([[{ text: PROSE, y: 700 }]])).toString("base64");
    const prevented = await page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], "dropped.pdf", { type: "application/pdf" }));
      const target = document.querySelector("h2") || document.body;
      const over = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt });
      target.dispatchEvent(over);
      const drop = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt });
      target.dispatchEvent(drop);
      return over.defaultPrevented && drop.defaultPrevented;
    }, pdf);
    expect(prevented).toBe(true);
    await expect(page.getByTestId("upload-file")).toContainText("dropped.pdf");
  });

  test("[QA4-15] switching tabs mid-upload cancels it instead of jumping to the reader later", async ({ page, user }) => {
    let release;
    const held = new Promise((resolve) => (release = resolve));
    await page.route("**/api/articles/upload", async (route) => {
      await held;
      await route.fulfill({ status: 201, json: { article: { id: "late-reply" } } }).catch(() => {});
    });
    const input = await openUploadTab(page);
    await input.setInputFiles({ name: "slow.pdf", mimeType: "application/pdf", buffer: Buffer.from(makePdf([[{ text: PROSE, y: 700 }]])) });
    await page.getByRole("button", { name: "Upload and read" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Reading your document" })).toBeVisible();
    await page.getByRole("tab", { name: "Paste text" }).click();
    release();
    await page.waitForTimeout(500);
    await expect(page).toHaveURL(/\/read$/);
    await expect(page.getByLabel("Article text")).toBeVisible();
  });
});

