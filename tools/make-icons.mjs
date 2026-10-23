// Draws the app icon as PNGs (192, 512, and a "maskable" 512 for Android/ChromeOS launchers).
// Same design as app/icons/icon.svg. No dependencies: a tiny anti-aliased rasterizer + zlib.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'icons');
mkdirSync(outDir, { recursive: true });

const BARS = [[70, 216, 80], [126, 166, 180], [182, 106, 300], [238, 146, 220], [294, 186, 140], [350, 136, 240], [406, 206, 100]];

function inRoundRect(x, y, rx, ry, w, h, r) {
  const dx = Math.max(rx + r - x, 0, x - (rx + w - r));
  const dy = Math.max(ry + r - y, 0, y - (ry + h - r));
  return x >= rx && x <= rx + w && y >= ry && y <= ry + h && dx * dx + dy * dy <= r * r;
}

function render(size, maskable) {
  const px = new Uint8Array(size * size * 4);
  const S = 4; // 4x4 supersampling
  const scale = 512 / size;
  // Maskable icons get cropped to a circle, so the art shrinks into the safe zone and the background fills edge to edge.
  const art = maskable ? 0.72 : 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const u = (x + (sx + 0.5) / S) * scale;
          const v = (y + (sy + 0.5) / S) * scale;
          if (maskable || inRoundRect(u, v, 0, 0, 512, 512, 112)) bg++;
          const au = 256 + (u - 256) / art;
          const av = 256 + (v - 256) / art;
          if (BARS.some(([bx, by, bh]) => inRoundRect(au, av, bx, by, 36, bh, 18))) fg++;
        }
      }
      const n = S * S;
      const t = (x + y) / (2 * size); // diagonal gradient #5b7cff -> #9b5bff
      const r = 0x5b + (0x9b - 0x5b) * t;
      const g = 0x7c + (0x5b - 0x7c) * t;
      const b = 0xff;
      const f = fg / n;
      const i = (y * size + x) * 4;
      px[i] = Math.round(r * (1 - f) + 255 * f);
      px[i + 1] = Math.round(g * (1 - f) + 255 * f);
      px[i + 2] = Math.round(b * (1 - f) + 255 * f);
      px[i + 3] = Math.round((bg / n) * 255);
    }
  }
  return px;
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const [name, size, maskable] of [['icon-192.png', 192, false], ['icon-512.png', 512, false], ['icon-maskable-512.png', 512, true]]) {
  writeFileSync(join(outDir, name), png(size, render(size, maskable)));
  console.log('wrote', name);
}
