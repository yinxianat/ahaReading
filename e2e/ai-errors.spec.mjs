// Every AI error path through the UI: visible message AND a working recovery.
import { test, expect, createArticle, explainPhrase, sql, isMobile } from "./support/fixtures.mjs";

test("__infra__ → 503: warning with countdown, Try again disabled until 0, Open Notebook link", async ({ page, user }) => {
  const id = await createArticle(page);
  await page.goto(`/read/${id}`);
  const panel = await explainPhrase(page, "__infra__ outage");
  await expect(panel).toContainText("Our AI helper is temporarily unavailable");
  await expect(panel).toContainText("Your Notebook and Review still work.");
  const retry = panel.getByRole("button", { name: /Try again in \d+s/ });
  await expect(retry).toBeDisabled();
  await expect(panel.getByRole("link", { name: "Open Notebook" })).toHaveAttribute("href", "/notebook");
  await expect(panel.getByRole("button", { name: "Close", exact: true })).toBeVisible();
  // Fast-forward: the countdown must end in an enabled "Try again" that refetches.
  const plain = panel.getByRole("button", { name: "Try again", exact: true });
  await expect(plain).toBeEnabled({ timeout: 40_000 });
  const req = page.waitForRequest((r) => r.url().endsWith("/api/explain"));
  await plain.click();
  await req;
  await expect(panel).toContainText("Our AI helper is temporarily unavailable");
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await expect(panel).toBeHidden();
});

test("__refuse__ → 422: neutral message, Pick different text closes", async ({ page, user }) => {
  const id = await createArticle(page);
  await page.goto(`/read/${id}`);
  const panel = await explainPhrase(page, "__refuse__ decision");
  await expect(panel).toContainText("We can't explain this passage. Try selecting a different part of the text.");
  await panel.getByRole("button", { name: "Pick different text" }).click();
  await expect(panel).toBeHidden();
});

test("__garbage__ → 502: danger message, immediate Try again refetches", async ({ page, user }) => {
  const id = await createArticle(page);
  await page.goto(`/read/${id}`);
  const panel = await explainPhrase(page, "__garbage__ output");
  await expect(panel).toContainText("We had trouble writing a clear explanation. Trying again usually works.");
  const retry = panel.getByRole("button", { name: "Try again", exact: true });
  await expect(retry).toBeEnabled();
  const req = page.waitForRequest((r) => r.url().endsWith("/api/explain"));
  await retry.click();
  await req;
  await expect(panel).toContainText("We had trouble writing a clear explanation");
  // Nothing user-facing leaks provider names or status codes.
  await expect(panel).not.toContainText(/mock|502|provider/i);
});

test("rate limit: >30 explains/min → UI shows countdown and Try again re-enables", async ({ page, user }) => {
  const id = await createArticle(page);
  // Burn the per-user quota through the API (30/min).
  const codes = [];
  for (let i = 0; i < 31; i++) {
    const r = await page.request.post("/api/explain", { data: { highlightedText: `burn ${i}`, surroundingText: `ctx ${user.id}` } });
    codes.push(r.status());
  }
  expect(codes.slice(0, 30).every((c) => c === 200)).toBe(true);
  expect(codes[30]).toBe(429);
  await page.goto(`/read/${id}`);
  const panel = await explainPhrase(page, "content delivery network");
  await expect(panel).toContainText("You're going a bit fast. You can try again in");
  const retry = panel.getByRole("button", { name: /Try again in \d+s/ });
  await expect(retry).toBeDisabled();
  const before = Number((await retry.textContent()).match(/(\d+)s/)[1]);
  await page.waitForTimeout(2200);
  const after = Number((await retry.textContent()).match(/(\d+)s/)[1]);
  expect(after).toBeLessThan(before);
});

test("translate failure shows inline 中文 error with Try again and Show English; English stays", async ({ page, user }) => {
  const id = await createArticle(page);
  await page.goto(`/read/${id}`);
  const panel = await explainPhrase(page, "content delivery network");
  await expect(panel).toContainText("Mock explanation (level 1)");
  // Make the stored explanation text carry the infra trigger so translate fails.
  await sql(`UPDATE "Explanation" SET explanation = explanation || ' __infra__' WHERE "userId"=$1`, [user.id]);
  await panel.getByRole("radio", { name: "中文" }).click();
  await expect(panel).toContainText("Translation isn't available right now. 翻译暂时不可用。");
  await expect(panel).toContainText("Mock explanation (level 1)");
  await expect(panel.getByRole("button", { name: /Try again/ })).toBeVisible();
  await panel.getByRole("button", { name: "Show English" }).click();
  await expect(panel.getByText("中文翻译")).toBeHidden();
});

test("offline while explaining: offline message and retry waits for connectivity", async ({ page, context, user }) => {
  const id = await createArticle(page);
  await page.goto(`/read/${id}`);
  await page.locator("[data-p]").first().waitFor();
  await context.setOffline(true);
  const panel = await explainPhrase(page, "eventual consistency");
  await expect(panel).toContainText("You're offline. Explanations need an internet connection.");
  const retry = panel.getByRole("button", { name: "Try again", exact: true });
  await expect(retry).toBeDisabled();
  await context.setOffline(false);
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(panel).toContainText("Mock explanation (level 1)");
});

