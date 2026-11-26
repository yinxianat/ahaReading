// After a deep dive: "Keep exploring" — go deeper, see the bigger picture, or expand the topic.
import { test, expect, createArticle, explainPhrase, sql, isMobile } from "./support/fixtures.mjs";

async function deepDive(page) {
  const id = await createArticle(page);
  await page.goto(`/read/${id}`);
  const panel = await explainPhrase(page, "eventual consistency");
  await expect(panel).toContainText("Mock explanation (level 1)");
  await panel.getByRole("button", { name: "Still confused" }).click();
  await expect(panel).toContainText("Mock explanation (level 2)");
  await panel.getByRole("button", { name: "Still confused" }).click();
  await expect(panel).toContainText("Mock explanation (level 3)");
  return panel;
}

test.describe("keep exploring after a deep dive", () => {
  test("go deeper, bigger picture, expand the topic, and back to the deep dive", async ({ page, user }) => {
    const panel = await deepDive(page);
    const section = panel.getByRole("region", { name: "Keep exploring" });
    await expect(section).toBeVisible();
    for (const label of ["Go deeper", "See the bigger picture", "Expand the topic"]) {
      await expect(section.getByRole("button", { name: new RegExp(`^${label}`) })).toBeVisible();
    }

    await section.getByRole("button", { name: /^Go deeper/ }).click();
    await expect(panel.getByText("Deep dive › Go deeper")).toBeVisible();
    await expect(panel).toContainText("Mock follow-up (deeper)");
    // The "still stuck" tip belongs to the deep dive itself, not to follow-ups.
    await expect(panel.getByRole("button", { name: "Pick a smaller phrase" })).toHaveCount(0);

    await panel.getByRole("region", { name: "Keep exploring" }).getByRole("button", { name: /^See the bigger picture/ }).click();
    await expect(panel.getByText("Deep dive › See the bigger picture")).toBeVisible();
    await expect(panel).toContainText("Mock follow-up (big_picture)");

    await panel.getByRole("region", { name: "Keep exploring" }).getByRole("button", { name: /^Expand the topic/ }).click();
    await expect(panel).toContainText("Mock follow-up (related)");
    await expect(panel).toContainText("First related concept");
    // Numbered items render as a real list, not one run-together paragraph.
    await expect(panel.locator("ol > li")).toHaveCount(3);

    await panel.getByRole("button", { name: "Back to deep dive" }).click();
    await expect(panel).toContainText("Mock explanation (level 3)");
    await expect(panel.getByText(/Deep dive ›/)).toHaveCount(0);
  });

  test("go deeper again from a follow-up; a follow-up can be saved to the Notebook", async ({ page, user }) => {
    const panel = await deepDive(page);
    await panel.getByRole("region", { name: "Keep exploring" }).getByRole("button", { name: /^Go deeper/ }).click();
    await expect(panel).toContainText("Mock follow-up (deeper)");
    await expect(panel.getByRole("button", { name: /^Go deeper again/ })).toBeVisible();
    await panel.getByRole("button", { name: /^Go deeper again/ }).click();
    await expect(panel).toContainText("Mock follow-up (deeper)");
    const rows = await sql(`SELECT "followUp", "basedOnId" FROM "Explanation" WHERE "userId"=$1 AND "followUp" IS NOT NULL ORDER BY "createdAt"`, [user.id]);
    expect(rows.map((r) => r.followUp)).toEqual(["deeper", "deeper"]);
    expect(rows[1].basedOnId).not.toBe(rows[0].basedOnId);

    await panel.getByRole("button", { name: "Save to Notebook" }).click();
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(async () => (await sql(`SELECT definition FROM "Concept" WHERE "userId"=$1`, [user.id]))[0]?.definition).toContain("Mock follow-up (deeper)");
  });

  test("cancel while a follow-up loads returns to the deep dive; focus stays in the panel", async ({ page, user }, testInfo) => {
    // Start at level 3 directly; "__slow__" in the paragraph makes every mock answer take 3 s.
    const me = await page.request.patch("/api/me", { data: { helpLevel: 3 } });
    expect(me.status(), await me.text()).toBe(200);
    if (isMobile(testInfo)) await page.setViewportSize({ width: 320, height: 640 });
    const id = await createArticle(page);
    await page.goto(`/read/${id}`);
    const panel = await explainPhrase(page, "__slow__ responses");
    await expect(panel).toContainText("Mock explanation (level 3)", { timeout: 15_000 });

    const section = panel.getByRole("region", { name: "Keep exploring" });
    // Usable on a 320 px phone: every button fits the sheet's width.
    const sheet = await panel.boundingBox();
    for (const label of ["Go deeper", "See the bigger picture", "Expand the topic"]) {
      const box = await section.getByRole("button", { name: label, exact: true }).boundingBox();
      expect(box.x + box.width).toBeLessThanOrEqual(sheet.x + sheet.width + 1);
    }
    // The hint is the description, not part of the name.
    await expect(section.getByRole("button", { name: "Go deeper", exact: true })).toHaveAccessibleDescription(/How it works underneath/);

    await section.getByRole("button", { name: "Go deeper", exact: true }).click();
    await expect(panel.getByText("Going deeper…").first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest("[role=dialog], [role=complementary]"))).toBe(true);
    await panel.getByRole("button", { name: "Cancel" }).click();
    await expect(panel).toContainText("Mock explanation (level 3)");
    await expect(panel.getByText(/Deep dive ›/)).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Got it" })).toBeVisible();
  });
});
