import { describe, it, expect, vi } from "vitest";
import { createPlayer, buildQueue, splitSentences, indexFor } from "@/lib/client/speech/player.js";
import { getSpeechProvider, PROVIDERS } from "@/lib/client/speech/index.js";

/** A provider that "speaks" instantly when told to, recording what it said. */
function fakeProvider() {
  const said = [];
  let pending = null;
  return {
    id: "fake",
    said,
    finish: () => {
      const p = pending;
      pending = null;
      p?.onEnd?.();
    },
    fail: () => pending?.onError?.(new Error("synthesis-failed")),
    isAvailable: () => true,
    voices: async () => [],
    speak(segment, opts) {
      said.push(segment.text);
      pending = opts;
      return { cancel: () => (pending = null) };
    },
    stop: vi.fn(),
  };
}

const PART = {
  id: "p1",
  chapters: [
    { title: "Start", text: "Facts record events like sales. Dimensions describe them.\n\nA third sentence is here." },
    { title: "Quiz", text: "What is a fact table?\n\n[pause]\n\nIt records events." },
    { title: "Recap", text: "Facts and dimensions work together." },
  ],
};

describe("listening player engine (provider-agnostic)", () => {
  it("splits sentences and builds a queue with spoken lead-ins and quiz pauses", () => {
    expect(splitSentences("One idea here. e.g. two words. Another one!\n\n[pause]")).toEqual(["One idea here.", "e.g. two words.", "Another one!", "[pause]"]);
    const q = buildQueue(PART, { intro: "Part 1 of 2: Basics. About 2 minutes." });
    expect(q[0]).toMatchObject({ lead: true, text: "Part 1 of 2: Basics. About 2 minutes." });
    expect(q[1]).toMatchObject({ lead: true, text: "Start.", chapter: 0, sentence: -1 });
    expect(q.find((s) => s.pause)).toMatchObject({ chapter: 1, sentence: 1, pause: 4 });
    expect(indexFor(q, { chapter: 1, sentence: 0 })).toBe(q.findIndex((s) => s.text === "Quiz."));
    expect(indexFor(q, { chapter: 0, sentence: 2 })).toBe(q.findIndex((s) => s.text === "A third sentence is here."));
  });

  it("plays in order, pauses and resumes at the sentence, skips chapters, ends", () => {
    const provider = fakeProvider();
    const onEnded = vi.fn();
    const states = [];
    const player = createPlayer({ provider, onEnded, onChange: (s) => states.push(s) });
    player.load(buildQueue(PART), 0);
    player.play();
    expect(provider.said).toEqual(["Start."]);
    provider.finish();
    provider.finish();
    expect(provider.said.at(-1)).toBe("Dimensions describe them.");
    expect(states.at(-1)).toMatchObject({ playing: true, chapter: 0, sentence: 1 });

    player.pause();
    provider.finish(); // a late callback after pause is ignored
    expect(player.state.playing).toBe(false);
    player.play();
    expect(provider.said.at(-1)).toBe("Dimensions describe them.");

    expect(player.nextChapter()).toBe(true);
    expect(provider.said.at(-1)).toBe("Quiz.");
    player.prevChapter();
    expect(provider.said.at(-1)).toBe("Start.");

    player.seek(buildQueue(PART).length - 1);
    provider.finish();
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(player.state.playing).toBe(false);
  });

  it("a speech error stops playback and is reported; rate is clamped", () => {
    const provider = fakeProvider();
    const onError = vi.fn();
    const player = createPlayer({ provider, onError });
    player.load(buildQueue(PART));
    player.setRate(5);
    expect(player.state.rate).toBe(2);
    player.play();
    provider.fail();
    expect(onError).toHaveBeenCalled();
    expect(player.state.playing).toBe(false);
  });

  it("no provider available → null (the page shows the transcript instead)", () => {
    expect(Object.keys(PROVIDERS)).toContain("browser");
    expect(getSpeechProvider("browser")).toBeNull(); // no speechSynthesis in Node
    expect(getSpeechProvider("__proto__")).toBeNull();
  });
});
