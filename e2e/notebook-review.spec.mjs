// Notebook (search, filters, detail edits, delete + undo) and Review (SRS, keyboard, offline sync).
import { test, expect, sql, isMobile } from "./support/fixtures.mjs";

/** Seed concepts through the real API: article → explain → save. */
async function seed(page, items) {
  const ids = {};
  const art = {};
  for (const it of items) {
    const title = it.article || "Seed article";
    if (!art[title]) {
      const r = await page.request.post("/api/articles", { data: { text: `${it.term} appears here. ${Math.random()}`, title } });
      art[title] = (await r.json()).article.id;
    }
    const ex = await page.request.post("/api/explain", { data: { highlightedText: it.term, surroundingText: `${it.term} ${Math.random()}`, articleId: art[title] } });
    expect(ex.status()).toBe(200);
    const { explanationId } = await ex.json();
    const c = await page.request.post("/api/notebook", { data: { explanationId, tags: it.tags || [], userNotes: it.note } });
    expect(c.status()).toBe(201);
    ids[it.term] = (await c.json()).concept.id;
  }
  return { ids, art };
}

test.describe("notebook", () => {
  test("empty state", async ({ page, user }) => {
    await page.goto("/notebook");
    await expect(page.getByText("Your Notebook is empty")).toBeVisible();
    await expect(page.getByRole("link", { name: "Start reading" })).toBeVisible();
  });

  test("search, tag filter, article filter, clear filters, URL reflects filters", async ({ page, user }) => {
    await seed(page, [
      { term: "idempotency", tags: ["api"], article: "Article A" },
      { term: "backpressure", tags: ["streams"], article: "Article B" },
      { term: "sharding", tags: ["db", "api"], article: "Article B" },
    ]);
    await page.goto("/notebook");
    await expect(page.locator("main li")).toHaveCount(3);
    await page.getByPlaceholder("Search terms and explanations").fill("backpress");
    await expect(page.locator("main li")).toHaveCount(1);
    await expect(page).toHaveURL(/search=backpress/);
    await page.getByPlaceholder("Search terms and explanations").fill("zzzz-nomatch");
    await expect(page.getByText("No concepts match “zzzz-nomatch”.")).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page.locator("main li")).toHaveCount(3);
    await page.getByRole("radio", { name: /^api/ }).click();
    await expect(page.locator("main li")).toHaveCount(2);
    await expect(page).toHaveURL(/tag=api/);
    await page.reload();
    await expect(page.locator("main li")).toHaveCount(2);
    await page.getByRole("radio", { name: "All" }).click();
    await page.getByRole("button", { name: /All articles/ }).click();
    await page.getByRole("button", { name: "Article B" }).click();
    await expect(page.getByText("From: Article B")).toBeVisible();
    await expect(page.locator("main li")).toHaveCount(2);
    await page.getByRole("button", { name: "Clear article filter" }).click();
    await expect(page.locator("main li")).toHaveCount(3);
  });

  test("detail: edit notes and tags persist after reload; edit term/definition", async ({ page, user }) => {
    const { ids } = await seed(page, [{ term: "memoization", tags: ["perf"], note: "first" }]);
    await page.goto(`/notebook/${ids.memoization}`);
    await expect(page.getByRole("heading", { name: "memoization" })).toBeVisible();
    const note = page.getByLabel("Your note");
    await note.fill("updated note text");
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    const tags = page.getByLabel("Tags");
    await tags.fill("caching");
    await tags.press("Enter");
    await page.getByRole("button", { name: "Remove tag perf" }).click();
    await expect(page.getByRole("button", { name: "Remove tag perf" })).toHaveCount(0);
    await page.waitForTimeout(500);
    await page.reload();
    await expect(page.getByLabel("Your note")).toHaveValue("updated note text");
    await expect(page.getByRole("button", { name: "Remove tag caching" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove tag perf" })).toHaveCount(0);
    await page.getByRole("button", { name: "Edit" }).click();
    await page.getByLabel("Term").fill("");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Add a term — it's what you'll see on the flashcard.")).toBeVisible();
    await page.getByLabel("Term").fill("Memoization (edited)");
    await page.getByLabel("Definition").fill("Caching a function's results by its inputs.");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Memoization (edited)" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Memoization (edited)" })).toBeVisible();
    await expect(page.getByText("Caching a function's results by its inputs.")).toBeVisible();
  });

  test("delete + undo restores; delete for real removes the row", async ({ page, user }) => {
    const { ids } = await seed(page, [{ term: "quorum" }, { term: "gossip protocol" }]);
    await page.goto(`/notebook/${ids.quorum}`);
    await page.getByRole("button", { name: "Delete" }).click();
    await expect(page).toHaveURL(/\/notebook$/);
    await expect(page.locator("p", { hasText: "Concept deleted." })).toBeVisible();
    await expect(page.locator("main li")).toHaveCount(1);
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.locator("main li")).toHaveCount(2);
    await page.waitForTimeout(6500);
    expect((await sql(`SELECT id FROM "Concept" WHERE id=$1`, [ids.quorum])).length).toBe(1);
    // For real this time: wait out the toast.
    await page.goto(`/notebook/${ids.quorum}`);
    await page.getByRole("button", { name: "Delete" }).click();
    await expect(page.locator("main li")).toHaveCount(1);
    // QA-7: on touch emulation the pointer is left over the toast after navigation and the
    // pause-on-hover never ends. Move it away so this test checks the commit itself.
    await page.mouse.move(2, 2);
    await expect.poll(async () => (await sql(`SELECT id FROM "Concept" WHERE id=$1`, [ids.quorum])).length, { timeout: 12_000 }).toBe(0);
    await page.reload();
    await expect(page.locator("main li")).toHaveCount(1);
  });

  test("[QA-7] undo toast expires (and deletes) without any further interaction", async ({ page, user }) => {
    const { ids } = await seed(page, [{ term: "latched" }]);
    await page.goto(`/notebook/${ids.latched}`);
    await page.getByRole("button", { name: "Delete" }).click();
    await expect(page.locator("p", { hasText: "Concept deleted." })).toBeVisible();
    await expect.poll(async () => (await sql(`SELECT id FROM "Concept" WHERE id=$1`, [ids.latched])).length, { timeout: 12_000 }).toBe(0);
  });

  test("deleted concept detail shows a recoverable not-found page", async ({ page, user }) => {
    await page.goto("/notebook/doesnotexist999");
    await expect(page.getByText("That concept isn't in your Notebook.")).toBeVisible();
    await page.getByRole("link", { name: "Back to Notebook" }).click();
    await expect(page).toHaveURL(/\/notebook$/);
  });
});

test.describe("review", () => {
  test("empty state when nothing saved", async ({ page, user }) => {
    await page.goto("/review");
    await expect(page.getByText("Nothing due")).toBeVisible();
    await expect(page.getByText("Save concepts while reading and they'll appear here for review.")).toBeVisible();
  });

  test("not due yet → Nothing due + next review phrase", async ({ page, user }) => {
    await seed(page, [{ term: "vector clock" }]);
    await page.goto("/review");
    await expect(page.getByText("Nothing due")).toBeVisible();
    await expect(page.getByText(/Next review/)).toBeVisible();
  });

  test("[PO-13] Nothing due shows the streak (kept from yesterday) and mastered count", async ({ page, user }) => {
    const { ids } = await seed(page, [{ term: "merkle tree" }]);
    const id = ids["merkle tree"];
    await sql(`UPDATE "Concept" SET interval = 21, "nextReviewAt" = (now() at time zone 'utc') + interval '21 days' WHERE id=$1`, [id]);
    await sql(
      `INSERT INTO "ReviewCard" (id, "userId", "conceptId", quality, "reviewedAt") VALUES ($1,$2,$3,5,(now() at time zone 'utc') - interval '1 day')`,
      [`qarc${Math.random().toString(36).slice(2, 12)}`, user.id, id]
    );
    await page.goto("/review");
    await expect(page.getByText("Nothing due")).toBeVisible();
    await expect(page.getByText(/1-day streak · 1 mastered\./)).toBeVisible();
  });

  test("due cards: reveal, Forgot/Hard/Easy, keyboard, completion, SRS rows", async ({ page, user }, testInfo) => {
    const { ids } = await seed(page, [{ term: "alpha term" }, { term: "beta term" }, { term: "gamma term" }]);
    await sql(`UPDATE "Concept" SET "nextReviewAt" = (now() at time zone 'utc') - interval '2 days' WHERE "userId"=$1`, [user.id]);
    await page.goto("/review");
    await expect(page.getByText("1 of 3")).toBeVisible();
    await expect(page.getByText("Do you remember?")).toBeVisible();
    await page.getByRole("button", { name: /Show answer/ }).click();
    await expect(page.getByRole("button", { name: /Forgot/ })).toBeVisible();
    await page.getByRole("button", { name: /Forgot/ }).click();
    await expect(page.getByText("2 of 3")).toBeVisible();
    if (!isMobile(testInfo)) {
      await page.keyboard.press("Space");
      await page.keyboard.press("2");
    } else {
      await page.getByRole("button", { name: /Show answer/ }).click();
      await page.getByRole("button", { name: /Hard/ }).click();
    }
    await expect(page.getByText("3 of 3")).toBeVisible();
    await page.getByRole("button", { name: /Show answer/ }).click();
    await page.getByRole("button", { name: /Easy/ }).click();
    await expect(page.getByRole("heading", { name: "All done" })).toBeVisible();
    await expect(page.getByText("You reviewed 3 concepts.")).toBeVisible();
    // [PO-13] today's session starts the streak.
    await expect(page.getByTestId("review-stats")).toHaveText("1-day streak · 3 reviewed today");
    await expect(page.getByRole("link", { name: "Back to reading" })).toBeVisible();
    await expect.poll(async () => (await sql(`SELECT count(*)::int n FROM "ReviewCard" WHERE "userId"=$1`, [user.id]))[0].n).toBe(3);
    const rows = await sql(`SELECT quality FROM "ReviewCard" WHERE "userId"=$1 ORDER BY "reviewedAt"`, [user.id]);
    expect(rows.map((r) => r.quality)).toEqual([1, 3, 5]);
    const due = await sql(`SELECT count(*)::int n FROM "Concept" WHERE "userId"=$1 AND "nextReviewAt" <= (now() at time zone 'utc')`, [user.id]);
    expect(due[0].n).toBe(0);
    void ids;
  });

  test("offline review queues, syncs once back online, no duplicate ReviewCard rows", async ({ page, context, user }) => {
    await seed(page, [{ term: "offline one" }, { term: "offline two" }]);
    await sql(`UPDATE "Concept" SET "nextReviewAt" = (now() at time zone 'utc') - interval '1 day' WHERE "userId"=$1`, [user.id]);
    await page.goto("/review");
    await expect(page.getByText("1 of 2")).toBeVisible();
    await context.setOffline(true);
    await page.getByRole("button", { name: /Show answer/ }).click();
    await page.getByRole("button", { name: /Easy/ }).click();
    await page.getByRole("button", { name: /Show answer/ }).click();
    await page.getByRole("button", { name: /Hard/ }).click();
    await expect(page.getByText("2 reviews will sync when you're back online.").first()).toBeVisible();
    await expect(page.getByText("You're offline. Notebook and Review still work.")).toBeVisible();
    expect((await sql(`SELECT count(*)::int n FROM "ReviewCard" WHERE "userId"=$1`, [user.id]))[0].n).toBe(0);
    await context.setOffline(false);
    await expect(page.locator("p", { hasText: "2 reviews synced." })).toBeVisible();
    await expect.poll(async () => (await sql(`SELECT count(*)::int n FROM "ReviewCard" WHERE "userId"=$1`, [user.id]))[0].n).toBe(2);
    // Trigger another flush (focus) — must not duplicate.
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForTimeout(1500);
    expect((await sql(`SELECT count(*)::int n FROM "ReviewCard" WHERE "userId"=$1`, [user.id]))[0].n).toBe(2);
    expect(await page.evaluate(() => localStorage.getItem("aha.reviewQueue"))).toBeNull();
  });

  test("API replay of the same clientId is idempotent", async ({ page, user }) => {
    const { ids } = await seed(page, [{ term: "replay" }]);
    const body = { conceptId: ids.replay, quality: 5, clientId: `qa-${Date.now()}` };
    const a = await page.request.post("/api/review", { data: body });
    const b = await page.request.post("/api/review", { data: body });
    expect(a.status()).toBe(200);
    expect(b.status()).toBe(200);
    expect((await sql(`SELECT count(*)::int n FROM "ReviewCard" WHERE "userId"=$1`, [user.id]))[0].n).toBe(1);
  });

  test("review badge shows due count", async ({ page, user }) => {
    await seed(page, [{ term: "badge one" }, { term: "badge two" }]);
    await sql(`UPDATE "Concept" SET "nextReviewAt" = (now() at time zone 'utc') - interval '1 day' WHERE "userId"=$1`, [user.id]);
    await page.goto("/read");
    await expect(page.getByRole("link", { name: /Review, 2 due/ }).first()).toBeVisible();
  });
});

test.describe("settings", () => {
  test("language and help level persist and drive explain", async ({ page, user }) => {
    await page.goto("/settings");
    await page.getByRole("radio", { name: "English + 中文" }).click();
    await page.getByRole("radio", { name: "3 Deep dive" }).click();
    await expect.poll(async () => (await sql(`SELECT locale, "helpLevel" FROM "User" WHERE id=$1`, [user.id]))[0]).toEqual({ locale: "zh", helpLevel: 3 });
    await page.reload();
    await expect(page.getByRole("radio", { name: "3 Deep dive" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("radio", { name: "English + 中文" })).toHaveAttribute("aria-checked", "true");
    const r = await page.request.post("/api/articles", { data: { text: `Kubernetes uses a control loop. ${Math.random()}`, title: "Settings effect" } });
    const id = (await r.json()).article.id;
    await page.goto(`/read/${id}`);
    const { explainPhrase } = await import("./support/fixtures.mjs");
    const panel = await explainPhrase(page, "control loop");
    await expect(panel).toContainText("Mock explanation (level 3)");
    await expect(panel.getByText("中文翻译")).toBeVisible();
    await expect(panel).toContainText("模拟翻译");
  });

  test("display name saves", async ({ page, user }) => {
    await page.goto("/settings");
    const name = page.getByLabel("Display name");
    await name.fill("QA Person");
    await name.press("Enter");
    await expect.poll(async () => (await sql(`SELECT "displayName" FROM "User" WHERE id=$1`, [user.id]))[0].displayName).toBe("QA Person");
  });

  test("delete account requires exact DELETE and removes all data", async ({ page, user }) => {
    await seed(page, [{ term: "to be deleted" }]);
    await page.goto("/settings");
    await page.getByRole("button", { name: "Delete account" }).click();
    const dialog = page.getByRole("dialog", { name: "Delete your account?" });
    const confirm = dialog.getByRole("button", { name: "Delete account" });
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel("Type DELETE to confirm").fill("delete");
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel("Type DELETE to confirm").fill("DELETE");
    await confirm.click();
    await expect(page).toHaveURL(/localhost:3100\/$/);
    expect(await sql(`SELECT id FROM "User" WHERE id=$1`, [user.id])).toHaveLength(0);
    for (const t of ["Concept", "Article", "Explanation", "ReviewCard"]) {
      expect(await sql(`SELECT id FROM "${t}" WHERE "userId"=$1`, [user.id]), t).toHaveLength(0);
    }
    expect((await page.request.get("/api/auth/me")).status()).toBe(401);
  });
});
