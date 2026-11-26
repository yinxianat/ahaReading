/**
 * Speech provider: the browser's built-in voice (Web Speech API, `speechSynthesis`).
 * Free and instant; the voice depends on the device. One utterance per sentence, which keeps
 * Chrome from stopping long utterances and lets the player pause and seek by sentence.
 * Known limits: no audio file (nothing to cache offline), and on iPhone speech stops when the
 * screen locks. A server provider (see ./index.js) removes both.
 */

function synth() {
  return typeof window !== "undefined" ? window.speechSynthesis : undefined;
}

/** @type {import("./index.js").SpeechProvider} */
const browserSpeech = {
  id: "browser",
  label: "This device's voice",

  isAvailable() {
    return Boolean(synth()) && typeof window.SpeechSynthesisUtterance === "function";
  },

  async voices(lang) {
    const s = synth();
    if (!s) return [];
    let list = s.getVoices();
    if (list.length === 0) {
      // Chrome loads voices asynchronously.
      list = await new Promise((resolve) => {
        const done = () => resolve(s.getVoices());
        s.addEventListener?.("voiceschanged", done, { once: true });
        setTimeout(done, 1500);
      });
    }
    const prefix = String(lang || "").slice(0, 2).toLowerCase();
    return list
      .filter((v) => !prefix || v.lang.toLowerCase().startsWith(prefix))
      .map((v) => ({ id: v.voiceURI, name: v.name, lang: v.lang, isDefault: v.default }));
  },

  speak(segment, { rate = 1, voiceId, onEnd, onError } = {}) {
    const s = synth();
    if (!s) {
      onError?.(new Error("speech_unavailable"));
      return { cancel() {} };
    }
    let live = true;
    const u = new window.SpeechSynthesisUtterance(segment.text);
    u.rate = Math.min(2, Math.max(0.5, rate));
    if (segment.lang) u.lang = segment.lang;
    if (voiceId) {
      const voice = s.getVoices().find((v) => v.voiceURI === voiceId);
      if (voice) u.voice = voice;
    }
    u.onend = () => {
      if (live) {
        live = false;
        onEnd?.();
      }
    };
    u.onerror = (e) => {
      if (!live) return;
      live = false;
      // "interrupted"/"canceled" come from our own cancel() and aren't errors.
      if (e?.error === "interrupted" || e?.error === "canceled") return;
      onError?.(new Error(e?.error || "speech_failed"));
    };
    // Safari sometimes leaves the queue paused after another page used speech.
    if (s.paused) s.resume();
    s.speak(u);
    return {
      cancel() {
        live = false;
        s.cancel();
      },
    };
  },

  stop() {
    synth()?.cancel();
  },
};

export default browserSpeech;
