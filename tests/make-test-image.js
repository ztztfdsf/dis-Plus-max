/* 生成确定性测试图 testdata/test-upload.png (与页面内对比脚本共用同一生成函数) */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

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
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// 与 dev/compare.js 完全一致的确定性生成
function buildPixels(w, h) {
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r, g, b;
      r = Math.round((x / w) * 255);
      g = Math.round((y / h) * 255);
      b = Math.round(((x + y) / (w + h)) * 255);
      // 四角色块
      if (x < w * 0.3 && y < h * 0.3) { r = 255; g = 60; b = 60; }
      else if (x > w * 0.7 && y < h * 0.3) { r = 60; g = 255; b = 60; }
      else if (x < w * 0.3 && y > h * 0.7) { r = 60; g = 120; b = 255; }
      else if (x > w * 0.7 && y > h * 0.7) { r = 255; g = 215; b = 60; }
      // 对角线白条
      const d = Math.abs((y / h) - (x / w));
      if (d < 0.04) { r = 255; g = 255; b = 255; }
      // 棋盘细格(右下区域)
      if (x > w * 0.35 && x < w * 0.65 && y > h * 0.35 && y < h * 0.65) {
        const cell = 14;
        if ((Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0) { r = 20; g = 20; b = 24; }
      }
      const o = (y * w + x) * 4;
      buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = 255;
    }
  }
  return buf;
}

const w = 640, h = 400;
const outDir = path.join(__dirname, '..', 'testdata');
fs.mkdirSync(outDir, { recursive: true });
const png = encodePNG(w, h, buildPixels(w, h));
const file = path.join(outDir, 'test-upload.png');
fs.writeFileSync(file, png);
console.log('✓ test-upload.png', png.length, 'bytes,', w + 'x' + h);