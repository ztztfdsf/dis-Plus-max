/* 传资产: node dev/ship/up.js <版本>
 * 必须挂代理 (Node 默认不走系统代理) —— 用 NODE_USE_ENV_PROXY=1 + HTTPS_PROXY。
 * 不用 PowerShell: 中文路径经 bash→PS 传参会把反斜杠+引号吃掉一层 (系统铁律 §4)。 */
'use strict';
const fs = require('fs');
const path = require('path');

const VER = process.argv[2];
if (!VER) { console.error('用法: node up.js <版本>'); process.exit(1); }
const ROOT = path.join(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');
const TOK = fs.readFileSync(path.join(process.env.TEMP, 'gh_tok.txt'), 'utf8').trim();
const rel = JSON.parse(fs.readFileSync(path.join(__dirname, 'rel.json'), 'utf8'));
if (rel.ver !== VER) { console.error('rel.json 是 ' + rel.ver + ' 不是 ' + VER); process.exit(1); }
const UP = rel.upload.split('{')[0];
const FILES = [`moeguard-chrome-${VER}.zip`, `moeguard-edge-${VER}.zip`, `moeguard-firefox-${VER}.zip`, 'moeguard.user.js'];

(async () => {
  for (const f of FILES) {
    const buf = fs.readFileSync(path.join(DIST, f));
    const r = await fetch(UP + '?name=' + encodeURIComponent(f), {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + TOK, 'user-agent': 'pi', accept: 'application/vnd.github+json',
        'content-type': f.endsWith('.js') ? 'text/javascript' : 'application/zip',
        'content-length': String(buf.length),
      },
      body: buf,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { console.log('FAIL', f, r.status, JSON.stringify(j).slice(0, 200)); continue; }
    console.log('OK  ' + j.name + '  ' + (j.size / 1024).toFixed(1) + ' KB  → ' + j.browser_download_url);
  }
  const g = await fetch(`https://api.github.com/repos/ztztfdsf/dis-Plus-max/releases/${rel.id}`, {
    headers: { authorization: 'Bearer ' + TOK, 'user-agent': 'pi', accept: 'application/vnd.github+json' },
  });
  const j = await g.json();
  console.log('release 资产数 =', (j.assets || []).length, '| tag =', j.tag_name);
  /* 传完资产立刻把正文刷成与本地 dist 一致 —— 正文里那张哈希表必须跟着包走。
   * 不能指望人记得单独跑一次: 2026-11-16 就漏过, 换完资产没换正文,
   * 主人指着发布说明问「256 怎么没改?」。 */
  const { refresh } = require('./body');
  await refresh(VER);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
