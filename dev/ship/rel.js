/* 发版: 组 body → 建 release → 打印上传地址 (资产由 up.js 传)
 * 用法: node dev/ship/rel.js 3.7.13 "标题副题"
 * 幂等: 同名 release 先删再建, tag 一并重建。 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VER = process.argv[2];
const SUB = process.argv[3] || '';
if (!VER) { console.error('用法: node rel.js <版本> [副标题]'); process.exit(1); }
const ROOT = path.join(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');
const REPO = 'ztztfdsf/dis-Plus-max';
const TAG = 'v' + VER;
const TOK = fs.readFileSync(path.join(process.env.TEMP, 'gh_tok.txt'), 'utf8').trim();
const H = { authorization: 'Bearer ' + TOK, 'user-agent': 'pi', accept: 'application/vnd.github+json', 'content-type': 'application/json' };
/* 正文由唯一生成器 mkbody.js 出 (rel.js 建 release 用它, up.js 传完资产再刷一遍)
 * —— 这里不再自己拼一份, 两份模板必漂:
 *    2026-11-16 就漂过, replace.js + up.js 只换资产不动正文,
 *    发布说明里留着上一版的 sha256, 而且那句自检还在指 3.7.14 就拆掉的 window.__moeGw。 */
const { build } = require('./mkbody');
const body = build(VER).body;
fs.writeFileSync(path.join(__dirname, 'body-' + VER + '.md'), body);

(async () => {
  const got = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${TAG}`, { headers: H });
  if (got.ok) {
    const old = await got.json();
    await fetch(`https://api.github.com/repos/${REPO}/releases/${old.id}`, { method: 'DELETE', headers: H });
    await fetch(`https://api.github.com/repos/${REPO}/git/refs/tags/${TAG}`, { method: 'DELETE', headers: H }).catch(() => {});
    console.log('删掉旧 release + tag');
  }
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ tag_name: TAG, target_commitish: 'main', name: 'v' + VER + (SUB ? ' — ' + SUB : ''), body, draft: false, prerelease: false }),
  });
  const j = await r.json();
  if (!r.ok) { console.error('建 release 失败', r.status, JSON.stringify(j).slice(0, 300)); process.exit(1); }
  fs.writeFileSync(path.join(__dirname, 'rel.json'), JSON.stringify({ id: j.id, ver: VER, upload: j.upload_url }, null, 1));
  console.log('✓ release', j.id, j.tag_name, '| body', body.length, '字 | 资产', j.assets.length);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
