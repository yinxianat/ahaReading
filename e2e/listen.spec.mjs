// Aha Listening: set up audio from an article or a selection, the part is written on first
// play and spoken through the browser voice (faked here: headless browsers can't speak), progress
// is saved and resumed, history lists the series, and the daily audio minutes are enforced.
import { test, expect, sql } from "./support/fixtures.mjs";

// Plain prose: the shared fixture text holds mock-AI failure triggers (__infra__ etc.).
const PROSE = (n) =>
  [
    `A data warehouse keeps the history of a business so analysts can ask questions about it (${n}).`,
    "Fact tables record events such as sales, and dimension tables describe them: the product, the store and the date.",
    "A star schema puts one fact table in the middle with the dimensions around it, which keeps queries simple and fast.",
  ].join("\n\n");

// A stand-in for speechSynthesis that "speaks" each utterance in 300 ms and records it.
const FAKE_SPEECH = () => {
  window.__spoken = [];
  const synth = {
    speaking: false,
    paused: false,
    pending: false,
    _timer: null,
    _current: null,
    getVoices: () => [{ voiceURI: "fake-en", name: "Fake English", lang: "en-US", default: true }],
    addEventListener() {},
    speak(u) {
      window.__spoken.push(u.text);
      this._current = u;
      this._timer = setTimeout(() => {
        this._current = null;
        u.onend?.();
      }, 300);
    },
    cancel() {
      clearTimeout(this._timer);
      const u = this._current;
      this._current = null;
      u?.onerror?.({ error: "interrupted" });
    },
    pause() {},
    resume() {},
  };
  Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
  window.SpeechSynthesisUtterance = function SpeechSynthesisUtterance(text) {
    this.text = text;
  };
};

async function pasteArticle(page) {
  await page.goto("/read");
  await page.getByRole("tab", { name: /^Paste/ }).click();
  await page.getByLabel("Article text").fill(PROSE(Math.random().toString(36).slice(2, 8)));
  await page.getByRole("button", { name: "Start reading" }).click();
  await expect(page).toHaveURL(/\/read\/[a-z0-9]+$/);
  return page.url().split("/").pop();
}

test.describe("Aha Listening", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(FAKE_SPEECH);
  });

  test("listen to an article: choose a style, the part is written and spoken, progress resumes", async ({ page, user }) => {
    const articleId = await pasteArticle(page);
    await page.getByRole("button", { name: "Listen", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Listen to this article" });
    await sheet.getByRole("radio", { name: /Quiz by ear/ }).click();
    await sheet.getByRole("radio", { name: "2 minutes" }).click();
    await sheet.getByRole("button", { name: "Start listening" }).click();

    await expect(page).toHaveURL(/\/listen\/[a-z0-9]+\?autoplay=1$/);
    const seriesId = new URL(page.url()).pathname.split("/").pop();
    await expect(page.getByRole("heading", { name: "Mock listening series" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Transcript" }).getByRole("heading", { name: "Recap" })).toBeVisible({ timeout: 20000 });

    // Autoplay: the spoken cue, then chapter titles and sentences.
    await expect.poll(() => page.evaluate(() => window.__spoken.length)).toBeGreaterThan(3);
    const spoken = await page.evaluate(() => window.__spoken);
    expect(spoken[0]).toMatch(/^Part 1 of \d: Mock part 1\. About \d+ minutes?\.$/);
    expect(spoken).toContain("Getting started.");

    await page.getByRole("button", { name: "Pause" }).click();
    await expect(page.getByRole("button", { name: "Play" })).toBeVisible();
    await expect
      .poll(async () => (await sql(`SELECT "positionChapter" c, "positionSentence" s FROM "AudioPart" WHERE "seriesId"=$1 AND "order"=0`, [seriesId]))[0])
      .not.toEqual({ c: 0, s: 0 });
    const [saved] = await sql(`SELECT "positionChapter" c, "positionSentence" s FROM "AudioPart" WHERE "seriesId"=$1 AND "order"=0`, [seriesId]);
    const [row] = await sql(`SELECT style, "partMinutes", "sourceKind", "articleId" FROM "AudioSeries" WHERE id=$1`, [seriesId]);
    expect(row).toEqual({ style: "quiz", partMinutes: 2, sourceKind: "article", articleId });

    // History, then resume where we stopped.
    await page.goto("/listen");
    await expect(page.getByText(/of 60 audio minutes used today/)).toBeVisible();
    await page.getByRole("link", { name: /Mock listening series/ }).click();
    await expect(page.getByRole("region", { name: "Transcript" }).getByRole("heading", { name: "Recap" })).toBeVisible();
    await page.evaluate(() => (window.__spoken = []));
    await page.getByRole("button", { name: "Play" }).click();
    await expect.poll(() => page.evaluate(() => window.__spoken.length)).toBeGreaterThan(0);
    const first = (await page.evaluate(() => window.__spoken))[0];
    expect(first).not.toMatch(/^Part 1 of/); // resumed mid-part, not from the start
    expect(saved.c + saved.s).toBeGreaterThan(0);
  });

  test("listen to a selection; the daily audio minutes are enforced with a clear message", async ({ page, user }) => {
    await pasteArticle(page);
    await page.locator("[data-p]").first().waitFor();
    await page.evaluate(() => {
      const block = document.querySelector("[data-p]");
      const r = document.createRange();
      r.selectNodeContents(block);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
      document.dispatchEvent(new Event("selectionchange"));
    });
    await page.locator("[data-selection-ui]").getByRole("button", { name: "Listen" }).click();
    const sheet = page.getByRole("dialog", { name: "Listen to this selection" });
    await expect(sheet).toBeVisible();

    await sql(`INSERT INTO "AudioUsage"(id,"userId",seconds,"createdAt") VALUES ($1,$2,3600,(now() at time zone 'utc'))`, [`qau${Date.now()}`, user.id]);
    await sheet.getByRole("button", { name: "Start listening" }).click();
    await expect(sheet.getByRole("alert")).toContainText("You've used 60 of today's 60 audio minutes. More in");
    await expect(sheet.getByText("Parts you've already made still play.")).toBeVisible();
  });
});
