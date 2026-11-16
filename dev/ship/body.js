/* 把正文刷成与本地 dist 一致: node dev/ship/body.js <版本>
 * up.js 传完资产会自动调这里的 refresh(), 所以正常流程不需要单独跑。 */
'use strict';
const fs = require('fs');
const path = require('path');
const { build } = require('./mkbody');

const ROOT = path.join(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');
const REPO = 'ztztfdsf/dis-Plus-max';
const TOK = fs.readFileSync(path.join(process.env.TEMP, 'gh_tok.txt'), 'utf8').trim();
const H = { authorization: 'Bearer ' + TOK, 'user-agent': 'pi', accept: 'application/vnd.github+json', 'content-type': 'application/json' };

async function refresh(VER) {
  const rel = JSON.parse(fs.readFileSync(path.join(__dirname, 'rel.json'), 'utf8'));
  if (rel.ver !== VER) throw new Error('rel.json 是 ' + rel.ver + ' 不是 ' + VER);
  const b = build(VER);
  fs.writeFileSync(path.join(__dirname, 'body-' + VER + '.md'), b.body);
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/${rel.id}`, {
    method: 'PATCH', headers: H, body: JSON.stringify({ body: b.body }),
  });
  if (!r.ok) throw new Error('PATCH body → HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  /* 回读核对: 正文里那 4 行哈希必须逐个等于本地实算 */
  const got = await (await fetch(`https://api.github.com/repos/${REPO}/releases/${rel.id}`, { headers: H })).json();
  const lines = (got.body || '').split('\n').filter((x) => x.indexOf('| `moeguard') === 0);
  let bad = 0;
  for (const f of b.files) {
    const local = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(DIST, f))).digest('hex');
    const row = lines.find((x) => x.indexOf('`' + f + '`') >= 0) || '';
    const inBody = (row.match(/`([0-9a-f]{64})`/) || [])[1] || '(缺行)';
    const okk = inBody === local;
    if (!okk) bad++;
    console.log((okk ? '✓ ' : '✗ ') + f.padEnd(30) + ' 正文 ' + inBody.slice(0, 16) + '… / 本地 ' + local.slice(0, 16) + '…');
  }
  console.log('正文长度 ' + (got.body || '').length + ' 字 | 表格行 ' + lines.length + ' 行 | 不符 ' + bad + ' 项');
  if (bad) throw new Error(bad + ' 项哈希与本地不一致');
  return got.body;
}

module.exports = { refresh: refresh };

if (require.main === module) {
  const VER = process.argv[2];
  if (!VER) { console.error('用法: node body.js <版本>'); process.exit(1); }
  refresh(VER).then(() => console.log('✓ 发布说明已与本地构建产物对齐')).catch((e) => { console.error('ERR', e.message); process.exit(1); });
}
