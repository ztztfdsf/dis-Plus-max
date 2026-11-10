#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════
 * MoeGuard 油猴版打包 —— 一份源码产出单文件 .user.js
 *
 *   node build-user.js
 *
 * 产物: dist/moeguard.user.js
 *
 * 拼装顺序 (顺序有意义, 不能乱换):
 *   1. 元数据头 (版本号从 manifest.json 读, 只此一处权威)
 *   2. PAGE 判定 + shim        ← 必须最先, content/popup/options 全靠它
 *   3. core / review / format  ← 纯逻辑, 与扩展版逐字节相同
 *   4. hook.js                 ← 必须在 document-start 就跑 (patch XHR)
 *   5. content.js              ← 等到 DOM 就绪再 boot (原 document_idle)
 *   6. 面板 + popup/options 代码
 *   7. 右键菜单
 *
 * 对上游源码只做两类改动, 全部集中在本文件里 (便于上游更新后重打):
 *   - hook.js 里 4 处 window 引用换成 PAGE (保证 patch 打在页面自己的对象上)
 *   - 把 popup.html / options.html 的 <style> 与 <body> 拆出来当字符串嵌进面板
 * 断言式替换: 匹配不到就直接报错退出, 绝不静默出一个半残的包。
 * ══════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'src');
const USER = path.join(SRC, 'userscript');
const DIST = path.join(ROOT, 'dist');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const VER = MANIFEST.version;

function read(p) { return fs.readFileSync(p, 'utf8').split('\r\n').join('\n'); }   // 上游是 CRLF, 统一成 LF 才能做多行锚点
function must(text, needle, what) {
  if (text.indexOf(needle) < 0) throw new Error('补丁锚点丢失: ' + what + '\n  找不到: ' + JSON.stringify(needle));
  return text;
}
/* 与 must 相同, 但返回原文 (用于模板字符串里的“断言后原样插入”) */
function must2(text, needle, what) { return must(text, needle, what); }

/* 两个 pane 共用同一批配置键 (popup 写 4 个 / options 写 13 个), 都只在 boot 时读一次。
 * 把各自的 load() 导出来, 切页时重读 —— 否则在 A 页改完再去 B 页保存会把旧值写回去。
 * (不能重跑 boot: popup.js 里的 setInterval 会重复创建) */
function exportLoad(src, name, what) {
  const re = /load\(\);\s*$/;
  if (!re.test(src)) throw new Error(what + ': 文件尾部找不到 load();');
  return src.replace(re, name + ' = load;\nload();');
}

/* ══════════════════ HTML 抽取 ══════════════════ */
function extract(htmlFile, what) {
  const html = read(path.join(SRC, htmlFile));
  const styles = [];
  html.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (m, css) => { styles.push(css); return ''; });
  const bodyM = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (!bodyM) throw new Error(what + ': 找不到 <body>');
  let body = bodyM[1].replace(/<script[\s\S]*?<\/script>/gi, '').trim();
  return { css: styles.join('\n'), body };
}

/* 把 CSS 作用域限制在 #moe-panel 内 —— 否则 `button{}` `input{}` 会把 Discord 自己的按钮洗掉。
 * 这两个样式表都是纯扁平规则 (无 @media / 无嵌套), 用括号配平就能安全切分。 */
function scopeCss(css, root) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  let i = 0;
  while (i < css.length) {
    const brace = css.indexOf('{', i);
    if (brace < 0) break;
    let j = brace + 1, depth = 1;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      j++;
    }
    const selector = css.slice(i, brace).trim();
    const body = css.slice(brace, j);           // 含 { } 
    i = j;
    if (!selector) continue;
    if (selector[0] === '@') { out.push(selector + body); continue; }
    const scoped = selector.split(',').map((s) => {
      s = s.trim();
      /* 【两个 pane 必须分开作用域】两分 HTML 都有 body{...} 与 button{...},
       * 合并到同一个 #moe-panel 下会互相影响: 设置的 body 规则把弹窗 padding 打乱,
       * 弹窗的 body{width:250px} 又把设置挤成 250px。因此 body → 自身 pane。 */
      if (s === ':root' || s === 'html' || s === 'body') return root;
      return root + ' ' + s;
    }).join(',');
    out.push(scoped + body);
  }
  return out.join('\n');
}

/* ══════════════════ hook.js: window → PAGE ══════════════════ */
function patchHook(src) {
  const before = src;
  src = must(src, 'if (window.__moeGuardInstalled) return;', 'hook 安装守卫');
  src = src.split('window.__moeGuardInstalled').join('PAGE.__moeGuardInstalled');
  src = src.split('window.__moeFetchPatched').join('PAGE.__moeFetchPatched');
  src = src.split('const XHRProto = XMLHttpRequest.prototype;').join('const XHRProto = PAGE.XMLHttpRequest.prototype;');
  src = src.split('const rawFetch = window.fetch ? window.fetch.bind(window) : null;')
           .join('const rawFetch = PAGE.fetch ? PAGE.fetch.bind(PAGE) : null;');
  src = src.split('const nativeFetch = window.fetch ? window.fetch.bind(window) : null;')
           .join('const nativeFetch = PAGE.fetch ? PAGE.fetch.bind(PAGE) : null;');
  src = src.split('window.fetch = async function moeFetch(').join('PAGE.fetch = async function moeFetch(');
  /* 【漏了就白干】两处 Object.defineProperty(window, '__moeXxx') 的首参是裸 window,
   * 上面的字符串替换碰不到它 → 标记打在沙箱窗上, 页面上白标一次。 */
  src = src.split("Object.defineProperty(window,").join("Object.defineProperty(PAGE,");
  if (src === before) throw new Error('hook.js 补丁一条都没生效');
  if (/const XHRProto = XMLHttpRequest\.prototype;/.test(src)) throw new Error('XHR 补丁没生效');
  if (/Object\.defineProperty\(window,/.test(src)) throw new Error('defineProperty 目标补丁没生效');
  return patchHookLogic(patchHookGuard(src));
}

/* ══════════════ hook.js: 安装守卫不能被 Xray 打断 ══════════════
 * Firefox 隔离世界里 PAGE 是 Xray 包装, Object.defineProperty 会抛
 * Permission denied —— 而这一行在 IIFE 最外层且不在 try 里,
 * 一抛就整个脚本(含后面 content/面板)全不跑。 */
function patchHookGuard(src) {
  const A = 'if (PAGE.__moeGuardInstalled) return;';
  must(src, A, 'hook 安装守卫');
  src = src.replace(A, 'try { if (PAGE.__moeGuardInstalled) return; } catch (e) { return; }');
  const B = "Object.defineProperty(PAGE, '__moeGuardInstalled', { value: true, configurable: false });";
  must(src, B, 'hook 安装标志');
  src = src.replace(B, "try { Object.defineProperty(PAGE, '__moeGuardInstalled', { value: true, configurable: false }); } catch (e) {}");
  return src;
}

/* ══════════════ hook.js: 四条逻辑补丁 (上游真 bug, 不改上游文件) ══════════════
 * ①②③④ 的触发条件都在真实使用中出现 (不是理论输入):
 *   ① 预处理期(解码+指纹)按 Enter → 意图丢失 → 只能等 45s TTL 才上传
 *   ② 预处理期删除预览/切频道 → abort 看不见 item → 幽灵上传
 *   ③ 放行期 abort → 仍会 origSend
 *   ④ 有 ck 却没精确命中 → 回退到感知指纹模糊匹配 → 相似 A/B 图串位,
 *      A 的「原图直通」能套到 B 上 (tests/core.test.js 已断言相似图会互相命中)
 */
function patchHookLogic(src) {
  /* ① 记住发送意图时刻 */
  const A1 = '  function onSendIntent(why) {\n    if (!held.some((h) => h.state === \'held\')) return;';
  must(src, A1, 'hook onSendIntent');
  src = src.replace(A1,
    '  let lastIntentAt = 0;   // 【油猴补丁①】最近一次【用户亲手】发送意图, 供「意图早于入队」补课\n'
    + '  function onSendIntent(why) {\n'
    + '    /* 只记真按键/真按钮: POST /messages 也会调到这里(作保险信号),\n'
    + '     * 但它在发完消息之后才到 —— 记进去会让「发完上一条 → 3s 内拖新图」误判成\n'
    + '     * 「这张图也要立刻发」, 提前把图 PUT 上去。 */\n'
    + '    if (why === \'enter\' || why === \'send-button\') lastIntentAt = Date.now();\n'
    + '    if (!held.some((h) => h.state === \'held\')) return;');

  /* ② abort 置标志 (预处理期也能看见) */
  const A2 = '  XHRProto.abort = function () {\n    try {\n      const it = this.__moeHeld;';
  must(src, A2, 'hook abort');
  src = src.replace(A2,
    '  XHRProto.abort = function () {\n    try {\n      this.__moeAbort = true;   // 【油猴补丁②】预处理期没有 __moeHeld, 只能靠标志\n'
    + '      const it = this.__moeHeld;');

  /* ③ 入队前: 已取消就丢弃; 刚发生过发送意图就直接放行 */
  const A3 = '          dropStale();\n          const item = {';
  must(src, A3, 'hook 入队点');
  src = src.replace(A3,
    '          dropStale();\n'
    + '          /* 【油猴补丁②】预处理期已被 abort (删预览/切频道) → 不进队列, 也不补发 */\n'
    + '          if (self.__moeAbort) { rec({ ev: \'hold-abort-pre\', ck: (ck || \'\').slice(0, 12) }); return; }\n'
    + '          const item = {');

  const A4 = '          self.__moeHeld = item;\n          held.push(item);';
  must(src, A4, 'hook 入队 push');
  src = src.replace(A4,
    '          self.__moeHeld = item;\n'
    + '          held.push(item);\n'
    + '          /* 【油猴补丁①】用户已经按过发送键才排队进来 → 立即按当时结论放行,\n'
    + '           * 不要干等 45s TTL (解码+指纹有几百毫秒, 手快就会踩到)。3s 窗口避免误伤\n'
    + '           * 「发上一条消息时刚按过 Enter」的正常场景。 */\n'
    + '          if (Date.now() - lastIntentAt < 3000) {\n'
    + '            rec({ ev: \'intent-late\', id: item.id, fp: fpShort(fp) });\n'
    + '            releaseOne(item, \'intent-late\').catch(() => {});\n'
    + '          }');

  /* ④ 放行前再检查一次取消态 */
  const A5 = '    item.state = \'sent\';';
  must(src, A5, 'hook release 置 sent');
  src = src.replace(A5,
    '    /* 【油猴补丁③】放行期间被 abort → 不再补发 */\n'
    + '    if (item.state === \'aborted\' || item.xhr.__moeAbort) {\n'
    + '      item.state = \'aborted\';\n'
    + '      rec({ ev: \'release-abort\', id: item.id });\n'
    + '      return;\n'
    + '    }\n'
    + '    item.state = \'sent\';');

  /* ⑤ ck 精确身份隔离: 有 ck 但没命中 → 禁止借用别的图的结论 */
  const A6 = '          const Review = window.__MoeGuardReview;\n          act = Review\n            ? await Review.resolveAction(img, decisions, cfg, {';
  must(src, A6, 'hook resolveAction 调用');
  src = src.replace(A6,
    '          const Review = window.__MoeGuardReview;\n'
    + '          /* 【油猴补丁④】ck 是这张图的字节身份: 有 ck 却没精确命中 = 队列里没有这张图的结论。\n'
    + '           * 此时绝不能走感知指纹模糊匹配 —— 相似的 A/B 图会互相命中, 把 A 的\n'
    + '           * 「原图直通」套给 B (正是这张图要防的那个泄露)。改为现场重审。 */\n'
    + '          const pool = item.ck ? [] : decisions;\n'
    + '          act = Review\n            ? await Review.resolveAction(img, pool, cfg, {');

  if (!/resolveAction\(img, pool, cfg/.test(src)) throw new Error('ck 隔离补丁没生效');   // fetch 备用路径仍用 decisions, 那边没有 ck 概念
  return src;
}

/* ══════════════ content.js: 重扫后能恢复原始地址 ══════════════
 * 上游 bug: 「解码本页所有图片」把 data-moe-scan / data-moe-scan-src 一键删掉,
 * 而图片此时 src 已经是 blob: 了 —— 原始 CDN 地址只剩 data-moe-orig 里还有,
 * 于是这图之后每轮扫描都算不出 raw, 直接被 continue 跳过 (角标也永远回不来)。
 * 三处取 raw 的地方 (scanImages / swapIfKnown / 触屏长按) 补同一条回落。 */
function patchContent(src) {
  const LINE = 'if (!raw || /^(blob:|data:)/.test(raw)) raw = origUrlFor(img);   // 2026+ blob: 渲染';
  const FIXED = 'if (!raw || /^(blob:|data:)/.test(raw)) raw = origUrlFor(img) || (img.dataset && img.dataset.moeOrig) || \'\';   // 2026+ blob: 渲染';
  const n = src.split(LINE).length - 1;
  if (n !== 3) throw new Error('content.js 取 raw 的锚点数量变了: 期望 3 处, 实际 ' + n + ' 处');
  return src.split(LINE).join(FIXED);
}

/* ══════════════════ 组装 ══════════════════ */
const popup = extract('popup.html', 'popup.html');
const options = extract('options.html', 'options.html');

const POPUP_ROOT = '#moe-panel [data-pane="popup"]';
const OPTIONS_ROOT = '#moe-panel [data-pane="settings"]';
const panelCss = '/* 弹窗页 */\n' + scopeCss(popup.css, POPUP_ROOT)
               + '\n/* 设置页 */\n' + scopeCss(options.css, OPTIONS_ROOT);
const panelJs = ''
  + 'const MOE_PANEL_CSS = ' + JSON.stringify(panelCss) + ';\n'
  + 'const MOE_POPUP_HTML = ' + JSON.stringify(popup.body) + ';\n'
  + 'const MOE_OPTIONS_HTML = ' + JSON.stringify(options.body) + ';\n';

const shim = read(path.join(USER, 'shim.js')).replace('__MOE_VERSION__', VER);

const head = `// ==UserScript==
// @name         MoeGuard 喵图混淆（Discord 上传自动混淆 · 流光照影）
// @name:zh-CN   MoeGuard 喵图混淆
// @namespace    moeguard.userjs
// @version      ${VER}
// @description  Discord 图片上传自动混淆：发图时打乱成分形纹样，只有装了本脚本的人能看到原图。轻量 · 无损 · 无需密钥，可选只混淆色情图片。
// @description:en Auto-obfuscate Discord image uploads (MOE v3). Only users with this script can decode.
// @author       ztztfdsf（原扩展）· 油猴移植版
// @license      GPL-3.0
// @match        https://discord.com/*
// @run-at       document-start
// @sandbox      raw
// @inject-into  page
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_download
// @grant        GM_registerMenuCommand
// @connect      discord.com
// @connect      discordapp.com
// @connect      discordapp.net
// @connect      storage.googleapis.com
// @connect      *
// ==/UserScript==
`;

const body = `
/* ══════════════════════════════════════════════════════════════════
 * 本文件由 build-user.js 从 src/ 自动生成 —— 不要直接改这里
 * ══════════════════════════════════════════════════════════════════ */
(function () {
'use strict';

/* 油猴可能把脚本注入到主世界 (raw) 也可能落到沙箱里。
 * 主世界才能 patch 页面自己的 XMLHttpRequest —— 落错地方就只解码不混淆, 所以显式判定。 */
const PAGE = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
const IS_PAGE_WORLD = (() => {
  try {
    if (typeof unsafeWindow === 'undefined' || unsafeWindow === window) return true;
    window.__moeWorldProbe = 1;
    const ok = unsafeWindow.__moeWorldProbe === 1;
    try { delete window.__moeWorldProbe; } catch (e) { window.__moeWorldProbe = undefined; }
    return ok;
  } catch (e) { return false; }
})();

/* ─────── 1. chrome.* 兼容层 (原 background.js) ─────── */
${shim}

/* ─────── 2. 纯逻辑引擎 (与扩展版逐字节相同) ─────── */
${read(path.join(SRC, 'core.js'))}
${read(path.join(SRC, 'review.js'))}
${read(path.join(SRC, 'format.js'))}

/* ─────── 3. 上传拦截 (document-start, 必须在 Discord 发第一个请求之前) ─────── */
${patchHook(read(path.join(SRC, 'hook.js')))}

/* ─────── 4. 页面 UI / 解码 (原 content.js, 原本 document_idle) ─────── */
function __bootContent() {
${patchContent(read(path.join(SRC, 'content.js')))}
}

/* ─────── 5. 面板 (原 popup.html + options.html) ─────── */
${/** 两个 pane 共用同一批配置键(popup 写 4 个, options 写 13 个),
  * 都只加载一次 → 在 A 页改完再去 B 页保存, 会把 A 的改动写回旧值。
  * 这里把两边的 load() 导出来, 切页时重读一次。
  * (不能重跑 boot: popup.js 的 setInterval 会重复创建) */
''}
let __moeReloadPopup = null, __moeReloadOptions = null;
${panelJs}
${read(path.join(USER, 'panel.js'))}

function __bootPopup() {
${exportLoad(read(path.join(SRC, 'popup.js')), '__moeReloadPopup', 'popup.js')}
}
function __bootOptions() {
${exportLoad(read(path.join(SRC, 'options.js')), '__moeReloadOptions', 'options.js')}
}

/* ─────── 6. 页内右键菜单 ─────── */
${read(path.join(USER, 'ctxmenu.js'))}

/* ─────── 7. 启动 ─────── */
try { window.__moeWorld = IS_PAGE_WORLD ? 'page' : 'isolated'; } catch (e) {}
if (!IS_PAGE_WORLD) {
  try { console.warn('[MoeGuard] 脚本没跑在主世界: 自动解码可用, 上传混淆会失效。'
    + '请把 @sandbox 设为 raw 并确认浏览器未强制沙箱。'); } catch (e) {}
}

function bootUI() {
  try { __bootContent(); } catch (e) { try { console.warn('[MoeGuard] content boot', e); } catch (e2) {} }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootUI, { once: true });
} else {
  setTimeout(bootUI, 0);
}

})();
`;

fs.mkdirSync(DIST, { recursive: true });
const outFile = path.join(DIST, 'moeguard.user.js');
fs.writeFileSync(outFile, head + body, 'utf8');

const bytes = Buffer.byteLength(head + body, 'utf8');
console.log('✓ dist/moeguard.user.js  v' + VER + '  ' + (bytes / 1024).toFixed(1) + ' KB');
console.log('  拼装: shim + core + review + format + hook + content + panel + ctxmenu');
console.log('  校验: sandbox raw → PAGE 补丁 ' + (/PAGE\.XMLHttpRequest\.prototype/.test(body) ? 'ok' : 'FAIL'));