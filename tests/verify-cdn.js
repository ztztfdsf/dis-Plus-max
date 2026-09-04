/* CDN 上传验证脚本:
 * 用法: MOE_TOKEN=xxx MOE_USER_ID=xxx node verify-cdn.js <channelId> [本地原图路径]
 *   1) 用 token 拉取频道最新消息 → 最新一条带附件的本人消息
 *   2) 下载附件 → PNG 解码 → MoeGuard 解码 → 与本地原图像素逐字节比对
 *   3) 输出 PASS/FAIL
 * 依赖: src/core.js, tests/png-decode.js
 *
 * ⚠️ 开发者自测脚本, 需要你自己的 Discord token 才能跑。
 *    token 只从环境变量读, 结代码里一律不存 —— 它等于账号密码,
 *    泄露后别人能直接以你的身份收发消息。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const core = require('../src/core.js');
const pngDecode = require('./png-decode.js');

const TOKEN = process.env.MOE_TOKEN || '';
const MY_ID = process.env.MOE_USER_ID || '';
if (!TOKEN || !MY_ID) {
  console.error('缺少环境变量。用法:');
  console.error('  MOE_TOKEN=<token> MOE_USER_ID=<用户ID> node verify-cdn.js <channelId> [原图路径]');
  process.exit(2);
}

function get(url, headers = {}) {
  return new Promise((res, rej) => {
    const u = new URL(url);
    https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: { 'user-agent': 'MoeGuard-verify', ...headers } }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks) }));
    }).on('error', rej);
  });
}

async function latestMine(channelId, limit = 5) {
  const r = await get(`https://discord.com/api/v9/channels/${channelId}/messages?limit=${limit}`, { authorization: TOKEN });
  if (r.status !== 200) throw new Error('messages http ' + r.status);
  const msgs = JSON.parse(r.body.toString());
  const mine = msgs.filter((m) => m.author && m.author.id === MY_ID && m.attachments && m.attachments.length);
  return mine[0] || null;
}

async function main() {
  const channelId = process.argv[2];
  const origPath = process.argv[3] || path.join(__dirname, '..', 'testdata', 'test-upload.png');
  if (!channelId) { console.error('usage: node verify-cdn.js <channelId> [origPath]'); process.exit(2); }

  const msg = await latestMine(channelId);
  if (!msg) { console.log('✗ 最近没有本人带附件的消息'); process.exit(1); }
  console.log('最新本人消息:', msg.id, '· 附件数:', msg.attachments.length);

  for (let i = 0; i < msg.attachments.length; i++) {
    const a = msg.attachments[i];
    console.log(`── 附件[${i}] ${a.filename} 声明size=${a.size} ${a.width}x${a.height} ct=${a.content_type}`);
    const r = await get(a.url);
    console.log(`   下载: http ${r.status}, ${r.body.length} B, content-type: ${r.headers['content-type']}`);
    if (r.status !== 200) continue;
    const magic = r.body.slice(0, 8);
    const isPng = magic[0] === 0x89 && magic[1] === 0x50 && magic[2] === 0x4e && magic[3] === 0x47;
    console.log('   magic:', magic.toString('hex'), isPng ? '(PNG✓)' : '(非PNG!)');
    if (!isPng) continue;
    const img = pngDecode(r.body);
    console.log(`   尺寸: ${img.width}x${img.height}`);
    const fr = core.detectFrame(img);
    console.log(`   定位框: ${fr.ok ? '✓ 识别到喵图' : '✗ 未识别'} (score=${fr.score})`);
    const mk = core.pngReadMarker(r.body.subarray(0, 128), '');
    console.log(`   moEg 预筛(前128B): ${mk ? JSON.stringify(mk) : '无'}`);
    const dec = core.decodeImage(img, { blockSize: 16, salt: '' });
    console.log(`   解码: ${dec.ok ? '✓ ok (布局 ' + dec.layout + ')' : '✗ ' + dec.reason}`);
    if (dec.ok) {
      // 保存解码结果
      const outFile = path.join(__dirname, '..', 'testdata', 'decoded-output.png');
      const { writePng } = require('./png-write.js');
      fs.writeFileSync(outFile, writePng(dec));
      console.log('   已保存解码图 →', outFile);
      // 与本地原图比对(仅当提供了且存在)
      if (fs.existsSync(origPath)) {
        const origPng = pngDecode(fs.readFileSync(origPath));
        const same = dec.width === origPng.width && dec.height === origPng.height;
        let diffs = 0, maxD = 0;
        if (same && dec.data.length === origPng.data.length) {
          for (let k = 0; k < dec.data.length; k++) {
            const d = Math.abs(dec.data[k] - origPng.data[k]);
            if (d) { diffs++; if (d > maxD) maxD = d; }
          }
        }
        const pass = same && diffs === 0;
        console.log(`   与本地原图比对: ${pass ? '✅ PASS 像素100%一致' : '❌ FAIL'} (${dec.width}x${dec.height} vs ${origPng.width}x${origPng.height}, diffs=${diffs}, maxDelta=${maxD})`);
      } else {
        console.log('   未提供本地原图 → 请人工打开 decoded-output.png 与原图对比');
      }
    }
  }
}

main().catch((e) => { console.error('ERR:', e.message); process.exit(1); });