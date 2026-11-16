/* 删掉指定 release 的全部资产 (文档改了 → 包内容变了 → 必须换掉旧资产) */
'use strict';
const fs = require('fs');
const T = JSON.parse(fs.readFileSync('dev/ship/rel.json', 'utf8'));
const TOK = fs.readFileSync(process.env.TEMP + '/gh_tok.txt', 'utf8').trim();  // 与 rel.js 同一份, 不打印
(async () => {
  const h = { authorization: 'Bearer ' + TOK, Accept: 'application/vnd.github+json' };
  const list = await (await fetch('https://api.github.com/repos/ztztfdsf/dis-Plus-max/releases/' + T.id + '/assets?per_page=100', { headers: h })).json();
  if (!Array.isArray(list)) { console.log('列表异常', JSON.stringify(list).slice(0, 200)); process.exit(1); }
  console.log('现有资产', list.length, '个');
  for (const a of list) {
    const r = await fetch('https://api.github.com/repos/ztztfdsf/dis-Plus-max/releases/assets/' + a.id, { method: 'DELETE', headers: h });
    console.log((r.status === 204 ? '✓ 删 ' : '✗ ' + r.status + ' ') + a.name + ' (' + a.size + 'B)');
  }
  const j = await (await fetch('https://api.github.com/repos/ztztfdsf/dis-Plus-max/releases/' + T.id, { headers: h })).json();
  console.log('删完剩', (j.assets || []).length, '个');
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
