#!/usr/bin/env node
/* Six-target release audit for MoeGuard. Offline: reads the built artifacts only. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const version = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).version;

function unzip(buf) {
  /* Read the central directory: the local headers rely on data descriptors here. */
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('no end-of-central-directory');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central header at ' + p);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20), nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (name.endsWith('/')) { p += 46 + nameLen + extraLen + commentLen; continue; }
    const lNameLen = buf.readUInt16LE(localOff + 26), lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(start, start + csize);
    out.set(name, method === 0 ? data : zlib.inflateRawSync(data));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const rows = [];
const fail = [];
function check(name, ok, detail) {
  rows.push({ name, ok: !!ok, detail });
  if (!ok) fail.push(name + ' — ' + detail);
}

const FORBIDDEN = [
  ['准备附件', '3.8.1 的确认弹窗文案'],
  ['showModal', '3.8.1 的确认弹窗'],
  ['加入草稿', '3.8.1 的确认弹窗按钮'],
  ['tests/', '测试目录不该进包'],
  ['dev/', '开发台不该进包'],
];

function auditZip(target, expectFiles) {
  const file = path.join(dist, `moeguard-${target}-${version}.zip`);
  if (!fs.existsSync(file)) return check(`${target}: zip 存在`, false, 'missing');
  const buf = fs.readFileSync(file);
  const z = unzip(buf);
  const manifest = JSON.parse(z.get('manifest.json').toString('utf8'));
  check(`${target}: 版本号`, manifest.version === version, `${manifest.version} != ${version}`);
  const hook = z.get('src/hook.js')?.toString('utf8') || '';
  check(`${target}: 双回车修复在包里`, hook.includes('deferSubmit') && hook.includes('pendingUploads'), 'hook 缺补发逻辑');
  check(`${target}: 无补按回车的旧做法`, hook.includes('synthetic.has(e)'), '缺补发守卫');
  /* Docs may legitimately mention the removed dialog when explaining history;
   * the ban is on shipping it as code. */
  const all = [...z].filter(([k]) => !/\.(md|txt)$/i.test(k))
    .map(([k, v]) => k + '\n' + (v.length < 400000 ? v.toString('latin1') : '')).join('\n');
  for (const [needle, why] of FORBIDDEN) {
    if (needle.endsWith('/')) check(`${target}: 不含 ${needle}`, ![...z.keys()].some(k => k.includes(needle)), why);
    else check(`${target}: 不含「${needle}」`, !all.includes(Buffer.from(needle).toString('latin1')), why);
  }
  check(`${target}: 文件数`, z.size >= (expectFiles || 20), `${z.size} 个文件`);
  return { file, bytes: buf.length, sha: sha(buf), files: z.size };
}

const results = {};
for (const t of ['chrome', 'edge', 'firefox']) results[t] = auditZip(t, 20);

/* userscript: single file, must carry the same fix and the world guard */
const us = path.join(dist, 'moeguard.user.js');
if (fs.existsSync(us)) {
  const s = fs.readFileSync(us, 'utf8');
  check('userscript: 版本号', new RegExp('// @version\\s+' + version.replace(/\./g, '\\.') + '(\\s|$)').test(s), 'meta 版本不对');
  check('userscript: 双回车修复', s.includes('deferSubmit'), '缺补发逻辑');
  check('userscript: 沙箱加固', /@sandbox\s+raw/.test(s) && /@run-at\s+document-start/.test(s), 'metadata 被改坏');
  check('userscript: 无确认弹窗', !s.includes('准备附件'), '混进弹窗文案');
  results.userscript = { file: us, bytes: fs.statSync(us).size, sha: sha(fs.readFileSync(us)) };
} else check('userscript: 存在', false, 'missing');

/* equicord: plugin bundle */
const eq = path.join(dist, `moeguard-equicord-${version}.zip`);
if (fs.existsSync(eq)) {
  const buf = fs.readFileSync(eq);
  const z = unzip(buf);
  const rel = z.get('moeGuard/release.json');
  check('equicord: release.json', !!rel && JSON.parse(rel.toString('utf8')).version === version, '版本不对');
  const idx = z.get('moeGuard/index.tsx')?.toString('utf8') || '';
  check('equicord: 官方 API 用法', idx.includes("@api/ChatButtons") && idx.includes('UploadHandler.promptToUpload') && idx.includes('DraftType.ChannelMessage'), '接口用法偏离官方示例');
  check('equicord: 不含本地路径', !/D:\\\\|G:\\\\/.test([...z.values()].map(v => v.toString('latin1')).join('')), '包内有本地绝对路径');
  check('equicord: 无测试文件', ![...z.keys()].some(k => k.includes('test')), '混入测试');
  results.equicord = { file: eq, bytes: buf.length, sha: sha(buf), files: z.size };
} else check('equicord: 存在', false, 'missing');

/* android: shipped as-is, only the hash is verified */
const apks = process.argv[2];
if (apks && fs.existsSync(apks)) {
  const buf = fs.readFileSync(apks);
  const z = unzip(buf);
  check('android: 分包集', z.has('base.apk') && z.has('config.hdpi.apk'), '缺 base 或资源包');
  results.android = { file: apks, bytes: buf.length, sha: sha(buf), files: z.size };
} else check('android: 包存在', false, apks ? 'missing: ' + apks : 'no path given');

const report = { version, at: new Date().toISOString(), results, checks: rows, fail };
const outDir = process.argv[3] || path.join(root, 'dist');
fs.writeFileSync(path.join(outDir, 'audit-6.json'), JSON.stringify(report, null, 2));
for (const r of rows) if (!r.ok) console.log('✗ ' + r.name + ' — ' + r.detail);
console.log(`\n${rows.filter(r => r.ok).length}/${rows.length} 项通过  version=${version}`);
process.exitCode = fail.length ? 1 : 0;
