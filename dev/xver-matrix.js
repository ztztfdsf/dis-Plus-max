/* 跨版本互通矩阵 —— 证明「已发布的所有版本互相都能解」，不靠猜。
 * 用法:
 *   node dev/xver-matrix.js <core.js> [<core.js> ...]
 * 取旧版 core 的办法: 解压 release 里的 moeguard-chrome-<ver>.zip，取 src/core.js。
 * 2026-11-28 实测 3.6.3 / 3.7.11 / 3.7.17 / 3.8.2 四版两两互转: 16/16 逐像素一致。
 * 唯一会影响互通的是设置里的「盐值」: 一方填了、另一方没填，就一定解不出（这是设计, 不是版本问题）。
 */
const path = require('node:path');
const args = process.argv.slice(2);
if (args.length < 2) { console.error('至少给两个 core.js 路径'); process.exit(2); }
const cores = {};
for (const a of args) cores[path.basename(a).replace(/^core[-_]?/, '').replace(/\.js$/, '')] = require(path.resolve(a));
function img(w,h,seed){const d=new Uint8ClampedArray(w*h*4);let s=seed;for(let i=0;i<d.length;i+=4){s=(s*1103515245+12345)&0x7fffffff;d[i]=s&255;d[i+1]=(s>>8)&255;d[i+2]=(s>>16)&255;d[i+3]=255;}return{width:w,height:h,data:d};}
const same=(x,y)=>!!x&&x.width===y.width&&x.height===y.height&&Buffer.compare(Buffer.from(x.data),Buffer.from(y.data))===0;
const src=img(41,33,99);
const names=Object.keys(cores);
let bad=0;
console.log('编码端 → 解码端（默认无盐）');
for(const a of names){
  const row=[];
  for(const b of names){
    let out=null;
    try{ const enc=cores[a].encodeImage(src,{}); out=cores[b].decodeImage(enc,{}); }catch(e){ out=null; }
    const ok=same(src,out);
    if(!ok)bad++;
    row.push((ok?'✓':'✗')+' '+b);
  }
  console.log(a.padEnd(7), row.join('  '));
}
// salt mismatch is a real (and only) interoperability limit
const first=names[0], last=names[names.length-1];
const encSalt=cores[first].encodeImage(src,{salt:'abc'});
const noSalt=cores[last].decodeImage(encSalt,{});
const withSalt=cores[last].decodeImage(encSalt,{salt:'abc'});
console.log('\n设置里填了盐 abc，对方没填 →', same(src,noSalt)?'仍能解':'解不出（预期）');
console.log('两边都填 abc →', same(src,withSalt)?'能解':'解不出');
console.log('\n失败格数:',bad);
