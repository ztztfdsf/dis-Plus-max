/* 删指定版本的 release (连资产) + tag
 * 用法: node dev/ship/delrel.js 3.7.13 3.7.14 3.7.15 3.7.16
 * 只碰命令行里点名的版本; 删之前必须已本地备份 */
'use strict';
const fs = require('fs');
const TOK = fs.readFileSync(process.env.TEMP + '/gh_tok.txt', 'utf8').trim();
const H = { authorization: 'Bearer ' + TOK, 'user-agent': 'pi', accept: 'application/vnd.github+json' };
const REPO = 'ztztfdsf/dis-Plus-max';
const VERS = process.argv.slice(2).filter((x) => /^\d+\.\d+\.\d+$/.test(x));
if (!VERS.length) { console.error('用法: node delrel.js <版本> [<版本>…]'); process.exit(1); }
(async () => {
  for (const v of VERS) {
    const t = 'v' + v;
    const g = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${t}`, { headers: H });
    if (g.status === 200) {
      const r = await g.json();
      const n = (r.assets || []).length;
      const d = await fetch(`https://api.github.com/repos/${REPO}/releases/${r.id}`, { method: 'DELETE', headers: H });
      console.log(`release ${t} (id=${r.id}, 资产 ${n} 个) → DELETE ${d.status === 204 ? '✓ 已删' : '✗ ' + d.status}`);
    } else {
      console.log(`release ${t} → ${g.status} (本来就不存在, 跳过)`);
    }
    const tr = await fetch(`https://api.github.com/repos/${REPO}/git/refs/tags/${t}`, { method: 'DELETE', headers: H });
    console.log(`tag ${t} → DELETE ${tr.status === 204 ? '✓ 已删' : tr.status === 404 ? '已不存在' : '✗ ' + tr.status}`);
  }
  const l = await (await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, { headers: H })).json();
  console.log('剩余 release:', l.map((x) => x.tag_name + '(' + (x.assets || []).length + ')').join(' '));
  const tg = await (await fetch(`https://api.github.com/repos/${REPO}/git/refs/tags`, { headers: H })).json();
  console.log('剩余 tag:', (Array.isArray(tg) ? tg : []).map((x) => x.ref.replace('refs/tags/', '')).join(' '));
  const lat = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: H });
  console.log('latest →', lat.status === 200 ? (await lat.json()).tag_name : lat.status);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
