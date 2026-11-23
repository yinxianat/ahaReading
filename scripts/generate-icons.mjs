// Generates the PWA / Apple touch icons as solid-colour PNGs with a simple
// "open book" glyph, using only Node built-ins (zlib for the IDAT stream).
// Run: node scripts/generate-icons.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const ACCENT = [0x25, 0x57, 0xd6];
const WHITE = [0xff, 0xff, 0xff];

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * @param {number} size
 * @param {number} glyphScale fraction of the canvas the glyph spans (smaller for maskable safe zone)
 * @param {boolean} rounded transparent rounded corners (not for maskable/apple)
 */
function icon(size, glyphScale, rounded) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const g = size * glyphScale;
  const cx = size / 2;
  const top = size / 2 - g * 0.36;
  const bottom = size / 2 + g * 0.36;
  const half = g / 2;
  const stroke = Math.max(2, g * 0.07);
  const radius = size * 0.2;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let color = ACCENT;
      let alpha = 255;
      if (rounded) {
        const dx = Math.max(radius - x, 0, x - (size - 1 - radius));
        const dy = Math.max(radius - y, 0, y - (size - 1 - radius));
        if (dx * dx + dy * dy > radius * radius) alpha = 0;
      }
      // Two pages: each a slanted quadrilateral meeting at the spine.
      const t = (y - top) / (bottom - top);
      if (t >= 0 && t <= 1) {
        const dip = g * 0.06 * Math.sin(Math.PI * Math.abs((x - cx) / half));
        const pageTop = top + dip;
        const inPage = Math.abs(x - cx) <= half && y >= pageTop && y <= bottom + dip * 0.5;
        const spine = Math.abs(x - cx) < stroke * 0.5;
        if (inPage && !spine) color = WHITE;
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = color[0];
      raw[o + 1] = color[1];
      raw[o + 2] = color[2];
      raw[o + 3] = alpha;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const out = new URL("../public/icons/", import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL("icon-192.png", out), icon(192, 0.6, true));
writeFileSync(new URL("icon-512.png", out), icon(512, 0.6, true));
writeFileSync(new URL("icon-maskable-512.png", out), icon(512, 0.46, false));
writeFileSync(new URL("apple-touch-icon.png", out), icon(180, 0.6, false));
console.log("icons written");
