/**
 * The listening player engine: a queue of spoken segments (sentences, chapter titles, pauses)
 * played through any SpeechProvider (./index.js). No React here, so it's unit-testable with a
 * fake provider. Positions are {chapter, sentence}, the same numbers the server saves, so a
 * part resumes at the sentence where the listener stopped, on any device.
 */

const WORDS_PER_MINUTE = 150;
export const PAUSE_SECONDS = 4;
const PAUSE_RE = /^\[pause\]$/i;

/**
 * Split spoken text into sentences (keeps "e.g." and decimals together well enough for speech).
 * @param {string} text
 * @returns {string[]}
 */
export function splitSentences(text) {
  const out = [];
  for (const para of String(text || "").split(/\n\s*\n|\n/)) {
    const p = para.trim();
    if (!p) continue;
    if (PAUSE_RE.test(p)) {
      out.push("[pause]");
      continue;
    }
    const parts = p.match(/[^.!?。！？]+(?:[.!?。！？]+["'”’)\]]*|$)/g) || [p];
    let carry = "";
    for (const raw of parts) {
      const joined = carry + raw;
      const s = joined.trim();
      // Very short fragments ("e.g.", "No.") are joined to the next sentence.
      if (s.length < 12 && !/[。！？]$/.test(s)) {
        carry = joined;
        continue;
      }
      carry = "";
      if (s) out.push(s);
    }
    if (carry.trim()) out.push(carry.trim());
  }
  return out;
}

/** Estimated seconds to say a segment at 1×. */
export function estimateSeconds(segment) {
  if (segment.pause) return segment.pause;
  const s = segment.text || "";
  const cjk = (s.match(/[㐀-鿿豈-﫿]/g) || []).length;
  const words = s.replace(/[㐀-鿿豈-﫿]/g, " ").split(/\s+/).filter(Boolean).length + cjk / 1.7;
  return Math.max(0.6, (words / WORDS_PER_MINUTE) * 60);
}

/**
 * Turn a part's chapters into a playable queue. Each chapter starts with its title; the part
 * starts with a spoken cue ("Part 2 of 4: …, about 5 minutes."). Lead-ins have sentence -1.
 * @param {{id: string, chapters: Array<{title: string, text: string}>}} part
 * @param {{intro?: string, lang?: string}} [options]
 * @returns {Array<{key: string, chapter: number, sentence: number, text: string, pause?: number, lang?: string, lead?: boolean}>}
 */
export function buildQueue(part, { intro, lang } = {}) {
  const queue = [];
  if (intro) queue.push({ key: `${part.id}:intro`, chapter: 0, sentence: -1, text: intro, lang, lead: true });
  (part.chapters || []).forEach((c, chapter) => {
    if (c.title) queue.push({ key: `${part.id}:${chapter}:title`, chapter, sentence: -1, text: `${c.title}.`, lang, lead: true });
    splitSentences(c.text).forEach((text, sentence) => {
      queue.push(
        PAUSE_RE.test(text)
          ? { key: `${part.id}:${chapter}:${sentence}`, chapter, sentence, text: "", pause: PAUSE_SECONDS }
          : { key: `${part.id}:${chapter}:${sentence}`, chapter, sentence, text, lang }
      );
    });
  });
  return queue;
}

/**
 * Index in the queue for a saved position (the chapter's lead-in when sentence is 0).
 * @returns {number}
 */
export function indexFor(queue, { chapter = 0, sentence = 0 } = {}) {
  if (chapter === 0 && sentence === 0) return 0;
  const exact = queue.findIndex((s) => s.chapter === chapter && s.sentence === sentence);
  if (exact >= 0) return sentence === 0 && queue[exact - 1]?.chapter === chapter && queue[exact - 1].lead ? exact - 1 : exact;
  const chapterStart = queue.findIndex((s) => s.chapter === chapter);
  return chapterStart >= 0 ? chapterStart : 0;
}

/**
 * @param {{provider: import("./index.js").SpeechProvider, onChange?: (state: object) => void, onEnded?: () => void, onError?: (err: Error) => void}} options
 */
export function createPlayer({ provider, onChange, onEnded, onError }) {
  let queue = [];
  let index = 0;
  let playing = false;
  let rate = 1;
  let voiceId;
  let handle = null;
  let timer = null;
  let token = 0;

  const state = () => {
    const seg = queue[index];
    const left = queue.slice(index).reduce((sum, s) => sum + estimateSeconds(s), 0) / rate;
    const total = queue.reduce((sum, s) => sum + estimateSeconds(s), 0) / rate;
    return { playing, index, length: queue.length, chapter: seg?.chapter ?? 0, sentence: Math.max(0, seg?.sentence ?? 0), secondsLeft: Math.round(left), secondsTotal: Math.round(total), rate };
  };
  const emit = () => onChange?.(state());

  const halt = () => {
    token += 1;
    handle?.cancel();
    handle = null;
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const speakCurrent = () => {
    halt();
    const my = token;
    const seg = queue[index];
    if (!seg) {
      playing = false;
      emit();
      onEnded?.();
      return;
    }
    emit();
    const advance = () => {
      if (my !== token) return;
      index += 1;
      speakCurrent();
    };
    if (seg.pause) {
      timer = setTimeout(advance, (seg.pause * 1000) / rate);
      return;
    }
    handle = provider.speak(seg, {
      rate,
      voiceId,
      onEnd: advance,
      onError: (err) => {
        if (my !== token) return;
        playing = false;
        halt();
        emit();
        onError?.(err);
      },
    });
  };

  const jump = (i) => {
    index = Math.max(0, Math.min(queue.length - 1, i));
    if (playing) speakCurrent();
    else emit();
  };

  return {
    /** Load a queue and move to `startIndex` (paused). */
    load(nextQueue, startIndex = 0) {
      halt();
      playing = false;
      queue = nextQueue;
      index = Math.max(0, Math.min(queue.length - 1, startIndex));
      emit();
    },
    play() {
      if (!queue.length) return;
      if (index >= queue.length) index = 0;
      playing = true;
      speakCurrent();
    },
    /** Pausing restarts the current sentence on play: providers can't all resume mid-sentence. */
    pause() {
      playing = false;
      halt();
      provider.stop();
      emit();
    },
    toggle() {
      if (playing) this.pause();
      else this.play();
    },
    seek(i) {
      jump(i);
    },
    /** Skip by about `seconds` (negative = back), in whole segments. */
    skipSeconds(seconds) {
      let i = index;
      let acc = 0;
      if (seconds < 0) {
        while (i > 0 && acc < -seconds) acc += estimateSeconds(queue[--i]) / rate;
      } else {
        while (i < queue.length - 1 && acc < seconds) acc += estimateSeconds(queue[i++]) / rate;
      }
      jump(i);
    },
    nextChapter() {
      const current = queue[index]?.chapter ?? 0;
      const i = queue.findIndex((s, n) => n > index && s.chapter > current);
      if (i >= 0) jump(i);
      return i >= 0;
    },
    /** Back to the start of this chapter, or the previous one when already near its start. */
    prevChapter() {
      const current = queue[index]?.chapter ?? 0;
      const start = queue.findIndex((s) => s.chapter === current);
      const target = index - start <= 1 && current > 0 ? queue.findIndex((s) => s.chapter === current - 1) : start;
      jump(Math.max(0, target));
    },
    setRate(r) {
      rate = Math.min(2, Math.max(0.5, Number(r) || 1));
      if (playing) speakCurrent();
      else emit();
    },
    setVoice(id) {
      voiceId = id || undefined;
      if (playing) speakCurrent();
    },
    get state() {
      return state();
    },
    destroy() {
      playing = false;
      halt();
      provider.stop();
    },
  };
}
