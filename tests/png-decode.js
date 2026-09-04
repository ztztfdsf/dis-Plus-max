/* 迷你 PNG 解码器 (Node, 无依赖) —— 用于验证 CDN 上下载的图片
 * 支持: 8-bit, 色彩类型 0/2/3/4/6, 无交错, filter 0-4
 * 用法: const img = pngDecode(Buffer.from(pngBytes)); → {width, height, data(Uint8ClampedArray RGBA)}
 */
'use strict';
const zlib = require('zlib');

function readU32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }

function pngDecode(buf) {
  if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50) throw new Error('not png');
  let off = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, idat = [];
  while (off < buf.length) {
    const len = readU32(buf, off);
    let tc = '';
    for (let i = 0; i < 4; i++) tc += String.fromCharCode(buf[off + 4 + i]);
    const type = tc;
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = readU32(data, 0); height = readU32(data, 4);
      bitDepth = data[8]; colorType = data[9];
      if (data[12] !== 0) throw new Error('interlace not supported');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('bitDepth ' + bitDepth + ' not supported');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (bpp === undefined) throw new Error('colorType ' + colorType + ' not supported');
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = out.slice(y * stride, (y + 1) * stride);
    const prev = y ? out.slice((y - 1) * stride, y * stride) : null;
    const src = raw.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = (x >= bpp && prev) ? prev[x - bpp] : 0;
      let v = src[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      row[x] = v & 255;
    }
  }
  // 转 RGBA
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const si = (y * stride + x * bpp);
      const di = (y * width + x) * 4;
      if (colorType === 0) { const g = out[si]; rgba[di] = g; rgba[di + 1] = g; rgba[di + 2] = g; rgba[di + 3] = 255; }
      else if (colorType === 2) { rgba[di] = out[si]; rgba[di + 1] = out[si + 1]; rgba[di + 2] = out[si + 2]; rgba[di + 3] = 255; }
      else if (colorType === 3) { rgba[di] = out[si]; rgba[di + 1] = out[si]; rgba[di + 2] = out[si]; rgba[di + 3] = 255; } // 近似(灰)仅用于检测
      else if (colorType === 4) { const g = out[si]; rgba[di] = g; rgba[di + 1] = g; rgba[di + 2] = g; rgba[di + 3] = out[si + 1]; }
      else { rgba[di] = out[si]; rgba[di + 1] = out[si + 1]; rgba[di + 2] = out[si + 2]; rgba[di + 3] = out[si + 3]; }
    }
  }
  return { width, height, data: rgba };
}

module.exports = pngDecode;
if (require.main === module) {
  const fs = require('fs');
  const f = process.argv[2];
  const img = pngDecode(fs.readFileSync(f));
  console.log('PNG', img.width + 'x' + img.height, 'ok');
}