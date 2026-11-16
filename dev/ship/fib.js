'use strict';
const { probeJs } = require('./probe');
(async () => {
  const j = await probeJs(`
var tiles = document.querySelectorAll('button[data-type=emoji][data-id]');
var cur = (location.pathname.match(/channels\\/(\\d+)/)||[])[1] || null;
var out = {cur: cur, n: tiles.length, rows: []};
for (var i = 0; i < tiles.length && i < 40; i++) {
  var b = tiles[i];
  var fk = Object.keys(b).find(function(k){return k.indexOf('__reactFiber')===0;});
  var f = fk ? b[fk] : null;
  var rec = {id: b.dataset.id, gid: null, isLocked: null, depth: -1};
  var d = 0;
  while (f && d < 12) {
    var mp = f.memoizedProps;
    if (mp) {
      var cp = mp.children && mp.children.props;
      var em = (cp && cp.emoji) || mp.emoji || null;
      if (em && String(em.id) === String(b.dataset.id)) {
        rec.gid = em.guildId != null ? String(em.guildId) : null;
        rec.isLocked = (cp && cp.isLocked !== undefined) ? cp.isLocked : (mp.isLocked !== undefined ? mp.isLocked : null);
        rec.depth = d;
        break;
      }
    }
    f = f.return; d++;
  }
  out.rows.push(rec);
}
return out`);
  const mine = j.rows ? j.rows.filter(r => r.gid === j.cur) : [];
  const foreign = j.rows ? j.rows.filter(r => r.gid && r.gid !== j.cur) : [];
  const noEnt = j.rows ? j.rows.filter(r => !r.gid) : [];
  console.log('当前服 =', j.cur, '| 取样', j.n, '格');
  console.log('本服(gid=当前):', mine.length, '| 外服:', foreign.length, '| 没挖到实体:', noEnt.length);
  console.log('本服样本 isLocked:', mine.slice(0, 5).map(r => r.isLocked).join(','));
  console.log('外服样本 isLocked:', foreign.slice(0, 5).map(r => r.isLocked).join(','));
  console.log('没实体的样本 data-id:', noEnt.slice(0, 5).map(r => r.id).join(','));
  console.log('FULL:', JSON.stringify(j).slice(0, 900));
})().catch(e => console.error('FAIL', e.message));
