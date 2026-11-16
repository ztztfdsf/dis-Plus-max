/* 逐个节点试 uploads.github.com 能不能连通 (当前节点 ECONNRESET)
 * 用法: node dev/ship/nodeswitch.js [最多试几个]
 * 做法: 通过 FlClashCore 的 9090 控制器切节点 → 用 7890 代理发一次 GET 探
 * 找到能通的就停下并保持; 全不通则恢复原来的节点 */
'use strict';
const CTRL = 'http://127.0.0.1:9090';
const SECRET = 'ff587GHhwZpPx0d3RjoIHnd0hFZiTc5f';
const H = { Authorization: 'Bearer ' + SECRET };
const PROXY = 'http://127.0.0.1:7890';
const GROUPS = ['极速机场', 'GLOBAL', '自动选择'];
const LIMIT = Number(process.argv[2] || 10);

const hx = new (require('node:https').Agent)();
async function ctrl(path, opts) {
  const r = await fetch(CTRL + path, Object.assign({ headers: H }, opts));
  return r;
}
async function probe(url, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms || 12000);
  try {
    const r = await fetch(url, { signal: ac.signal, proxy: PROXY, headers: { 'user-agent': 'pi' } });
    return 'HTTP ' + r.status;
  } catch (e) {
    return 'FAIL ' + ((e.cause && e.cause.code) || e.message || '').toString().slice(0, 40);
  } finally { clearTimeout(t); }
}

(async () => {
  const j = await (await ctrl('/proxies')).json();
  const orig = {};
  for (const g of GROUPS) if (j.proxies[g]) orig[g] = j.proxies[g].now;
  console.log('原节点:', JSON.stringify(orig));

  /* 候选: 各地区都拿一个, 排除当前那个 */
  const members = j.proxies[GROUPS[0]].all || [];
  const seen = new Set(); const cand = [];
  for (const m of members) {
    if (m === orig[GROUPS[0]]) continue;
    const tag = /🇺🇸|美国/.test(m) ? 'US' : /🇯🇵|日本/.test(m) ? 'JP' : /🇸🇬|新加坡/.test(m) ? 'SG'
      : /🇭🇰|港/.test(m) ? 'HK' : /🇹🇼|台湾/.test(m) ? 'TW' : /🇰🇷|韩国/.test(m) ? 'KR'
        : /🇬🇧|英/.test(m) ? 'UK' : '其他';
    if (seen.has(tag)) continue;
    seen.add(tag); cand.push(m);
  }
  /* 同地区再多补几个, 凑到 LIMIT */
  for (const m of members) { if (cand.length >= LIMIT) break; if (!cand.includes(m) && m !== orig[GROUPS[0]]) cand.push(m); }
  cand.length = Math.min(cand.length, LIMIT);
  console.log('候选 ' + cand.length + ' 个');

  let win = null;
  for (const name of cand) {
    for (const g of GROUPS) {
      if ((j.proxies[g].all || []).includes(name)) {
        await ctrl('/proxy/' + encodeURIComponent(g), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
      }
    }
    await new Promise((r) => setTimeout(r, 500));
    const up = await probe('https://uploads.github.com/', 12000);
    const api = await probe('https://api.github.com/zen', 12000);
    console.log('  ' + name.padEnd(24) + ' uploads=' + up + '  api=' + api);
    if (up.indexOf('HTTP') === 0) { win = name; break; }
  }

  if (!win) {
    console.log('全不通 → 恢复原节点');
    for (const g of GROUPS) if (orig[g]) {
      await ctrl('/proxy/' + encodeURIComponent(g), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: orig[g] }) });
    }
    console.log('已恢复', JSON.stringify(orig));
    process.exit(2);
  }
  const now = await (await ctrl('/proxies')).json();
  console.log('✓ 可用节点: ' + win);
  for (const g of GROUPS) console.log('   组 ' + g + ' 现在 = ' + now.proxies[g].now);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
