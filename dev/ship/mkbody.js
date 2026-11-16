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

function build(VER) {
  const cl = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8').replace(/^\uFEFF/, '');
  const mine = cl.split(/\n(?=## v)/).find((seg) => seg.startsWith('## v' + VER));
  if (!mine) throw new Error('CHANGELOG 里没有 v' + VER + ' 那一节');
  const files = FILES(VER);
  for (const f of files) {
    if (!fs.existsSync(path.join(DIST, f))) throw new Error('dist 里缺 ' + f + ' —— 先 node build.js');
  }
  const table = files.map((f) => '| `' + f + '` | ' + kb(path.join(DIST, f)) + ' KB | `' + sha(path.join(DIST, f)) + '` |').join('\n');
  const body = [
    mine.replace(/^## v[^\n]*\n/, '').trim(),
    '', '---', '',
    '### 安装（四个包）', '',
    '| 文件 | 大小 | sha256 |', '|---|---|---|', table, '',
    '- 三个 `zip` → 解压后按 README「加载到浏览器」操作。老用户：`chrome://extensions` 里点 MoeGuard 卡片的刷新按钮（**必须重载才生效**）。',
    '- 火狐：把 `moeguard-firefox-<版本>.zip` 改名成 `moeguard@neko.local.xpi` 放进 profile 的 `extensions\\` 目录（或 about:addons → ⚙ → 从文件安装附加组件）。**换文件要完全退出火狐**——运行时那个 xpi 被内存映射占用，覆盖会失败。',
    '- `moeguard.user.js` → 油猴单文件版：Tampermonkey 新建脚本，全选删掉后粘贴全文保存。入口 `Alt+M`；已内置 `@updateURL`/`@downloadURL`，版本号与 `manifest.json` 同步。',
    '',
    '自检（四条都该成立）：',
    '',
    '1. 诊断面板第一行显示 `v' + VER + '`。',
    '2. 表情栏点表情或贴纸 → 输入框里出现 `[. ](图链)`、面板自动收起，**且不会弹「使用 Nitro 解锁所有表情符号」**（原生那条路整段拦死）。',
    '3. 聊天里的表情 / 贴纸 → 鼠标悬停时左上角出现 🔗，点一下剪贴板就是发送格式。',
    '4. `F12` 里 `window.__MoeUI` 由内容脚本挂在隔离世界（主世界看不见，属正常）。',
    '',
    '> 若正文的哈希表与 Assets 里显示的不一致，说明同版本内原地替换过资产而正文没刷 —— 以 Assets 为准，并请反馈给作者（这是打包脚本的缺陷）。',
    '',
  ].join('\n');
  return { body: body, files: files };
}

module.exports = { build: build, FILES: FILES };
