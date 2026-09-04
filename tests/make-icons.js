/* 生成扩展图标 (纯 Node, 无依赖: 手写 PNG 编码 + zlib) */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const core = require('../src/core.js');

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const tb = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0);
  return Buffer.concat([len, tb, data, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const PINK = [[255, 155, 210], [255, 124, 184], [232, 107, 169], [255, 214, 235], [120, 90, 220]];
const WHITE = [255, 255, 255];

function makeIcon(size) {
  const cells = 4;
  const cell = Math.floor(size / cells);
  const next = core.makePRNG('moeguard-icon-v1');
  const n = cells * cells;
  const perm = [];
  for (let i = 0; i < n; i++) perm.push(i);
  for (let i = n - 1; i > 0; i--) { const j = next() % (i + 1); const t = perm[i]; perm[i] = perm[j]; perm[j] = t; }
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = Math.min(cells - 1, Math.floor(x / cell));
      const cy = Math.min(cells - 1, Math.floor(y / cell));
      const idx = perm[cy * cells + cx];
      let c = idx === 5 ? WHITE : PINK[idx % PINK.length];
      const edge = x < 2 || y < 2 || x >= size - 2 || y >= size - 2;
      if (edge && idx === 5) c = [235, 235, 245];
      if (edge) c = [c[0] * 0.45 | 0, c[1] * 0.45 | 0, c[2] * 0.55 | 0];
      const o = (y * size + x) * 4;
      buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2]; buf[o + 3] = 255;
    }
  }
  return encodePNG(size, size, buf);
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const s of [16, 32, 48, 128]) {
  fs.writeFileSync(path.join(outDir, `icon${s}.png`), makeIcon(s));
  console.log('✓ icon' + s + '.png');
}