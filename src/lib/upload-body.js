/**
 * Read a raw upload body with a size cap and stall limits. A client that disconnects
 * or stalls ends the read quietly: that is a network event, not a server error.
 */

// A stalled or trickling body must not hold the user's upload slot for Node's default
// 5-minute request timeout. The client gives up after 90 s anyway.
export const BODY_IDLE_MS = 20_000;
export const BODY_DEADLINE_MS = 120_000;

function readChunk(reader, waitMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("body_idle")), waitMs);
  });
  return Promise.race([reader.read(), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Buffer the body, stopping as soon as it passes `max` (an oversized upload is never held).
 * @param {Request} request
 * @param {number} max bytes
 * @param {{idleMs?: number, deadlineMs?: number}} [limits] no chunk for `idleMs`, or the
 *   whole body taking longer than `deadlineMs`, counts as an interrupted upload
 * @returns {Promise<{bytes: Uint8Array} | {tooLarge: true} | {interrupted: "aborted"|"idle"}>}
 */
export async function readUploadBody(request, max, { idleMs = BODY_IDLE_MS, deadlineMs = BODY_DEADLINE_MS } = {}) {
  if (!request.body) return { bytes: new Uint8Array(0) };
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    let result;
    try {
      result = await readChunk(reader, Math.max(1, Math.min(idleMs, deadline - Date.now())));
    } catch (err) {
      reader.cancel().catch(() => {});
      return { interrupted: err?.message === "body_idle" ? "idle" : "aborted" };
    }
    if (result.done) break;
    total += result.value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return { tooLarge: true };
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes };
}
