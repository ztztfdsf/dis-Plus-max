#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════
 * MoeGuard 打包脚本 —— 一份源码产出 Chrome / Edge / Firefox 三个包
 *
 *   node build.js            构建全部三个目标
 *   node build.js firefox    只构建一个
 *
 * 产物:
 *   dist/chrome/   dist/edge/   dist/firefox/       解压目录 (开发者模式直接加载)
 *   dist/moeguard-<target>-<版本>.zip                上架用压缩包
 *
 * ── 为什么需要分包 (MDN browser-compat-data 实测确认, 不是猜的) ──
 *   background.service_worker   chrome 88+  / firefox ❌ 不支持
 *   content_scripts.world       chrome 111+ / firefox 128+
 *   optional_host_permissions   chrome 102+ / firefox 128+
 *   CompressionStream           chrome 80+  / firefox 113+
 *   storage.session             chrome 102+ / firefox 115+
 *
 *   → Firefox 的 MV3 后台是「非持久 event page」而不是 service worker,
 *     所以 firefox 包必须把 background.service_worker 换成 background.scripts。
 *     其余 API 全都在 Firefox 128 的支持范围内, 源码无需任何分叉。
 *
 * ── zip 是可复现的 ──
 *   时间戳固定 (不写当前时间), 同一份源码永远产出同样字节的 zip。
 *   用户可以自己 build 一遍比对 sha256, 确认发布包没被塞东西。
 * ══════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const BASE = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const VER = BASE.version;

/* 打进包里的内容。dev/ 与 tests/ 不进包 —— 上架审核不需要, 也别让用户下载测试图 */
const PAYLOAD = ['src', 'icons'];
const EXTRA = ['README.md', 'LICENSE'];

/* ══════════════════ manifest 变换 ══════════════════ */

const TARGETS = {
  chrome: (m) => {
    /* Chrome 对未知顶层键会在扩展页面显示警告 → 摘掉 Firefox 专用键 */
    delete m.browser_specific_settings;
    return m;
  },

  /* Edge 就是 Chromium, manifest 与 Chrome 完全一致。
   * 单独出一份是因为 Edge Add-ons 要独立提交一个包。 */
  edge: (m) => {
    delete m.browser_specific_settings;
    return m;
  },

  firefox: (m) => {
    /* Firefox 的 MV3 后台是非持久 event page, 不认 service_worker。
     * background.js 本身是普通脚本 (没用 importScripts / clients / caches),
     * 换个声明就能跑, 代码零改动。 */
    m.background = { scripts: ['src/background.js'] };
    /* Chromium 专用键, Firefox 会当作无法识别的属性报警告 */
    delete m.minimum_chrome_version;
    /* world:"MAIN" 与 optional_host_permissions 都要 128+ */
    m.browser_specific_settings = {
      gecko: { id: 'moeguard@neko.local', strict_min_version: '128.0' },
    };
    return m;
  },
};

/* ══════════════════ 极简 ZIP 写入器 ══════════════════
 * 不引第三方依赖: 本项目零 dependencies, 为了打个包装 archiver 不值当。
 * 只用到 store/deflate 两种方式与标准中央目录, 够上架用。 */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  /* Node 20.15+/22+ 内置 zlib.crc32, 老版本走上面的查表实现 */
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* 固定时间戳 → 可复现构建。2026-01-01 00:00:00 的 DOS 格式 */
const DOS_TIME = 0;                      // 00:00:00
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

function zipWrite(entries, outFile) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    /* 已压缩过的资源 (png) 再 deflate 只会变大, 直接 store */
    const packed = e.store ? e.data : zlib.deflateRawSync(e.data, { level: 9 });
    const method = e.store ? 0 : 8;
    const body = packed.length < e.data.length ? packed : e.data;
    const useMethod = body === e.data ? 0 : method;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034B50, 0);     // 本地文件头签名
    lh.writeUInt16LE(20, 4);             // 解压所需版本 2.0
    lh.writeUInt16LE(0x0800, 6);         // 标志位: 文件名为 UTF-8
    lh.writeUInt16LE(useMethod, 8);
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014B50, 0);     // 中央目录头签名
    ch.writeUInt16LE(20, 4);             // 创建版本
    ch.writeUInt16LE(20, 6);             // 解压所需版本
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(useMethod, 10);
    ch.writeUInt16LE(DOS_TIME, 12);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(0, 38);             // 外部属性
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + body.length;
  }

  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054B50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);

  fs.writeFileSync(outFile, Buffer.concat([...locals, cd, end]));
  return fs.statSync(outFile).size;
}

/* ══════════════════ 工具 ══════════════════ */

function walk(dir, rel = dir, out = []) {
  for (const n of fs.readdirSync(path.join(ROOT, dir)).sort()) {
    const abs = path.join(ROOT, dir, n);
    const r = rel + '/' + n;
    if (fs.statSync(abs).isDirectory()) walk(path.join(dir, n), r, out);
    else out.push(r);
  }
  return out;
}

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }

function sha256(buf) { return require('crypto').createHash('sha256').update(buf).digest('hex'); }

/* ══════════════════ 主流程 ══════════════════ */

function build(target) {
  const tweak = TARGETS[target];
  if (!tweak) throw new Error('未知目标: ' + target);

  const manifest = tweak(JSON.parse(JSON.stringify(BASE)));
  const outDir = path.join(DIST, target);
  rmrf(outDir);

  /* 收集文件清单 */
  const files = [];
  for (const d of PAYLOAD) for (const f of walk(d)) files.push(f);
  for (const f of EXTRA) if (fs.existsSync(path.join(ROOT, f))) files.push(f);

  /* 校验: manifest 引用的脚本必须真的存在, 否则上架被拒才发现就太晚了 */
  const declared = new Set();
  for (const cs of manifest.content_scripts || []) for (const j of cs.js || []) declared.add(j);
  if (manifest.background) {
    if (manifest.background.service_worker) declared.add(manifest.background.service_worker);
    for (const s of manifest.background.scripts || []) declared.add(s);
  }
  if (manifest.action && manifest.action.default_popup) declared.add(manifest.action.default_popup);
  if (manifest.options_page) declared.add(manifest.options_page);
  for (const p of Object.values(manifest.icons || {})) declared.add(p);
  const missing = [...declared].filter((p) => !fs.existsSync(path.join(ROOT, p)));
  if (missing.length) throw new Error(target + ': manifest 引用了不存在的文件 → ' + missing.join(', '));

  /* 写解压目录 */
  fs.mkdirSync(outDir, { recursive: true });
  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(outDir, 'manifest.json'), manifestBuf);
  for (const f of files) {
    const dst = path.join(outDir, f);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), dst);
  }

  /* 打 zip。png 已经是压缩格式, 标记为 store */
  const entries = [{ name: 'manifest.json', data: manifestBuf }];
  for (const f of files) {
    entries.push({
      name: f,
      data: fs.readFileSync(path.join(ROOT, f)),
      store: /\.(png|jpg|jpeg|webp|gif|zip)$/i.test(f),
    });
  }
  const zipPath = path.join(DIST, `moeguard-${target}-${VER}.zip`);
  const size = zipWrite(entries, zipPath);

  return {
    target,
    files: entries.length,
    zip: path.basename(zipPath),
    kb: (size / 1024).toFixed(1),
    sha256: sha256(fs.readFileSync(zipPath)).slice(0, 16),
    bg: manifest.background.service_worker ? 'service_worker' : 'scripts (event page)',
    min: manifest.minimum_chrome_version
      ? 'Chrome ' + manifest.minimum_chrome_version
      : 'Firefox ' + manifest.browser_specific_settings.gecko.strict_min_version,
  };
}

const want = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const list = want.length ? want : Object.keys(TARGETS);

fs.mkdirSync(DIST, { recursive: true });
console.log(`MoeGuard 喵图混淆 v${VER} —— 打包\n`);

const rows = [];
for (const t of list) {
  try {
    rows.push(build(t));
  } catch (e) {
    console.error(`  ✗ ${t}: ${e.message}`);
    process.exitCode = 1;
  }
}

for (const r of rows) {
  console.log(`  ✓ ${r.target.padEnd(8)} ${r.files} 个文件  ${r.kb.padStart(7)} KB  ${r.zip}`);
  console.log(`    ${''.padEnd(8)} 后台: ${r.bg}   最低版本: ${r.min}   sha256: ${r.sha256}…`);
}
console.log(`\n产物目录: ${path.relative(process.cwd(), DIST) || 'dist'}`);
console.log('加载方式: Chrome/Edge → 扩展页开发者模式「加载已解压的扩展程序」选 dist/<target>/');
console.log('          Firefox   → about:debugging「临时载入」选 dist/firefox/manifest.json');
