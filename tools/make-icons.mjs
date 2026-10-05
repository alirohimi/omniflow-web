// ============================================================================
// OmniFlow PWA icon generator — pure Node, zero dependencies.
// Renders a rounded-square gradient tile with a white "flow" ring at 180/192/512
// and writes valid PNGs (zlib deflate + CRC32, no canvas/image libs needed).
// ============================================================================

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = `${__dirname}/../public`;
mkdirSync(PUBLIC, { recursive: true });

// ---------- CRC32 (PNG chunk integrity) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// ---------- PNG assembly (RGBA, 8-bit) ----------
function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // Raw scanlines: each row prefixed with filter byte 0.
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- Rendering ----------
// Rounded gradient tile + white ring ("O") + flow node, anti-aliased via
// signed-distance smoothstep. Content sits inside the 80% maskable safe zone.
function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.225;          // corner radius
  const ringR = size * 0.185;           // ring center radius
  const ringT = size * 0.052;          // ring thickness
  const nodeR = size * 0.045;          // flow node radius
  const nodeY = cy - ringR;            // node sits on the top of the ring

  // Gradient endpoints (accent blue -> violet), diagonal.
  const A = [0x4f, 0x8c, 0xff];
  const B = [0x7a, 0x5c, 0xff];

  const aa = (d) => { // smoothstep anti-alias on a signed distance (1px falloff)
    return Math.min(1, Math.max(0, 0.5 - d));
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;

      // Rounded-rect SDF (distance outside + is a rounded box).
      const dx = Math.abs(x - cx) - (size / 2 - radius);
      const dy = Math.abs(y - cy) - (size / 2 - radius);
      const qx = Math.max(dx, 0);
      const qy = Math.max(dy, 0);
      const dBox = Math.hypot(qx, qy) + Math.min(Math.max(dx, dy), 0) - radius;
      const cover = 1 - aa(dBox); // 1 inside, fades over ~1px
      if (cover <= 0) continue;    // fully transparent corner

      // Diagonal gradient sample.
      const t = (x + y) / (2 * size);
      const r = Math.round(A[0] + (B[0] - A[0]) * t);
      const g = Math.round(A[1] + (B[1] - A[1]) * t);
      const b = Math.round(A[2] + (B[2] - A[2]) * t);

      // White ring (annulus SDF).
      const dist = Math.hypot(x - cx, y - cy);
      const dRing = Math.abs(dist - ringR) - ringT;
      const ring = aa(dRing);

      // Flow node (filled circle on top of ring).
      const dNode = Math.hypot(x - cx, y - nodeY) - nodeR;
      const node = aa(dNode);

      // Compose white over gradient.
      const w = Math.max(ring, node) * cover;
      rgba[o] = Math.round(r + (255 - r) * w);
      rgba[o + 1] = Math.round(g + (255 - g) * w);
      rgba[o + 2] = Math.round(b + (255 - b) * w);
      rgba[o + 3] = Math.round(255 * cover);
    }
  }
  return rgba;
}

for (const size of [180, 192, 512]) {
  const png = encodePng(size, size, render(size));
  const out = `${PUBLIC}/icon-${size}.png`;
  writeFileSync(out, png);
  console.log(`wrote ${out} (${png.length} bytes)`);
}
console.log('done');
