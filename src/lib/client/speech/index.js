/**
 * Speech providers for Aha Listening (design decision A1).
 *
 * The player only talks to this interface, so the voice can change without touching the
 * player, the scripts or the API. Today: "browser" (the device's built-in voice). To add a
 * server voice (e.g. a text-to-speech service that returns audio files):
 *   1. write a provider with the same shape, e.g. ./server.js, whose `speak` plays the audio for
 *      `segment.key` (`<partId>:<chapter>:<sentence>`), fetched once per part from an API route
 *      that stores files in object storage (§5.1) with sentence timings;
 *   2. add it to PROVIDERS below;
 *   3. choose it with `getSpeechProvider("server")`, from a setting or the user's plan.
 *
 * @typedef {object} SpeechSegment
 * @property {string} key stable id of the sentence: `<partId>:<chapter>:<sentence>`
 * @property {string} text what to say
 * @property {string} [lang] BCP-47 language, e.g. "en-US"
 *
 * @typedef {object} SpeechProvider
 * @property {string} id
 * @property {string} label shown in the voice picker
 * @property {() => boolean} isAvailable
 * @property {(lang?: string) => Promise<Array<{id: string, name: string, lang: string, isDefault: boolean}>>} voices
 * @property {(segment: SpeechSegment, options: {rate?: number, voiceId?: string, onEnd?: () => void, onError?: (err: Error) => void}) => {cancel: () => void}} speak
 *   says one segment; calls onEnd when it finishes (never after cancel)
 * @property {() => void} stop stops anything playing
 */
import browserSpeech from "./browser.js";

export const PROVIDERS = Object.freeze({ browser: browserSpeech });
export const DEFAULT_PROVIDER = "browser";

/**
 * @param {string} [id]
 * @returns {SpeechProvider|null} the provider, or the first available one; null when none works here
 */
export function getSpeechProvider(id = DEFAULT_PROVIDER) {
  const wanted = Object.hasOwn(PROVIDERS, id) ? PROVIDERS[id] : null;
  if (wanted?.isAvailable()) return wanted;
  return Object.values(PROVIDERS).find((p) => p.isAvailable()) || null;
}
