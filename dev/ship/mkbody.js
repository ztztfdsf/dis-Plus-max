/* 发布说明正文的唯一生成器
 *   = CHANGELOG 里那一节原样搬过去 (不重写第二份, 免得两边漂)
 *   + 按【本地 dist 实算】的大小与 sha256 表
 * rel.js 建 release 用它, up.js 传完资产再刷一遍 —— 所以资产与正文不可能对不上。
 * (2026-11-16 就是栽在「replace.js + up.js 只换资产、不动正文」: 正文里留着上一版哈希。) */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const kb = (p) => (fs.statSync(p).size / 1024).toFixed(1);
const FILES = (VER) => [`moeguard-chrome-${VER}.zip`, `moeguard-edge-${VER}.zip`, `moeguard-firefox-${VER}.zip`, 'moeguard.user.js'];

/* 每个版本要直接介绍的几句话 (发版时在这里加, 找不到就硬退 —— 不允许正文遇空) */
const NOTES = {
  '3.8.0': [
    '- 修复「拖图太快 + 发送太快 → 图片没评分就发出（该混淆的没混淆/该直发的被混淆）」的竞态：发送现在会等上传登记落地（最多 3 秒），超时按原图放行并写日志，绝不静默',
    '- 表情栏/贴纸/复制链接/上传混淆/收图解码等能力不变',
  ],
  '3.7.17': [
    '- 表情栏对齐 3.7.11：能用的表情正常原生发送（面板原生自动收起），带锁/没权限的自动换成图片链接发送，不弹会员框', 
    '- 贴纸同口径：Discord 标了发不了的（stickerUnsendable）转链接，能发的走原生', 
    '- 聊天里已发出的表情/贴纸：悬停左上角出现 🔗，点击复制成链接；动图按原始消息内容判定（不看渲染帧）', 
    '- 图片上传前混淆 + 装了扩展的自动还原（核心功能不变）', 
  ],
};

function build(VER) {
  const notes = NOTES[VER];
  if (!notes) throw new Error('mkbody.js 里还没写 v' + VER + ' 的直接介绍 (NOTES)');
  const files = FILES(VER);
  for (const f of files) {
    if (!fs.existsSync(path.join(DIST, f))) throw new Error('dist 里缺 ' + f + ' —— 先 node build.js');
  }
  const table = files.map((f) => '| `' + f + '` | ' + kb(path.join(DIST, f)) + ' KB | `' + sha(path.join(DIST, f)) + '` |').join('\n');
  const body = [
    'MoeGuard —— Discord 喵图混淆 + 表情/贴纸解锁发送。本版 v' + VER + '。',
    '',
    '## 本版内容',
    '',
    ...notes,
    '',
    '## 下载',
    '',
    '| 文件 | 大小 | sha256 |', '|---|---|---|', table, '',
    '## 安装',
    '',
    '- **Chrome / Edge**：zip 解压 → `chrome://extensions` 开开发者模式 →「加载已解压的扩展程序」选解压目录。旧用户点 MoeGuard 卡片上的刷新。',
    '- **Firefox**：把 zip 改名 `moeguard@neko.local.xpi` 放进 profile 的 `extensions\\` 目录（换文件前先完全退出火狐），或 about:addons → ⚙ → 从文件安装附加组件。',
    '- **油猴**：Tampermonkey 新建脚本，全选删掉后粘贴 `moeguard.user.js` 全文保存。入口 `Alt+M`，版本号与扩展同步。',
  ].join('\n');
  return { body: body, files: files };
}

module.exports = { build: build, FILES: FILES };
