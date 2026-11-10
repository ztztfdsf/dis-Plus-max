/* ══════════════════════════════════════════════════════════════════
 * MoeGuard 油猴版 —— 页内面板 (替代 popup.html + options.html)
 *
 * 为什么合并: 油猴没有 action 弹窗, 也没有独立设置页。
 * 做法是把原来两个页面的 <body> 原样搬进一个浮层 (id 保持原样),
 * 这样 popup.js / options.js 的代码一行都不用改 —— 它们只用
 * document.getElementById 和 chrome.*, 而 chrome.* 已经被 shim 接住。
 *
 * 入口: GM 菜单命令 / Alt+M / 面板里的「打开设置」按钮。
 * ══════════════════════════════════════════════════════════════════ */

const PANEL_ID = 'moe-panel';

const SHELL_CSS = `
#moe-panel{position:fixed;top:12px;right:12px;z-index:2147483000;width:330px;max-height:calc(100vh - 24px);
  display:flex;flex-direction:column;border-radius:14px;overflow:hidden;
  background:linear-gradient(160deg,#1c1630,#241a38);color:#e8e2f5;
  box-shadow:0 18px 60px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.08);
  font-family:"Segoe UI","Microsoft YaHei",sans-serif;font-size:13px;line-height:1.4}
#moe-panel .moe-pane{width:auto}   /* 弹窗页的 body{width:250px} 是给独立窗口的, 面板里应铺满 */
#moe-panel.moe-wide{width:660px}
#moe-panel .moe-head{display:flex;align-items:center;gap:6px;padding:9px 10px;background:rgba(255,255,255,.05);
  border-bottom:1px solid rgba(255,255,255,.08);flex:0 0 auto;cursor:default}
#moe-panel .moe-title{font-size:13px;font-weight:700;color:#ffb7e2;margin-right:auto;white-space:nowrap}
#moe-panel .moe-head button{border:none;border-radius:7px;padding:5px 10px;font-size:12px;font-weight:600;
  cursor:pointer;background:#332c4d;color:#cfc6e8}
#moe-panel .moe-head button.on{background:#5865f2;color:#fff}
#moe-panel .moe-head button.moe-x{background:transparent;color:#a99fc4;font-size:16px;padding:2px 8px}
#moe-panel .moe-body{overflow:auto;flex:1 1 auto;scrollbar-width:thin}
#moe-panel .moe-pane{padding:14px 16px 18px}
#moe-panel .moe-pane[hidden]{display:none}
#moe-panel .moe-pane.moe-wide-pane{max-width:none}
#moe-panel .moe-tabpane{display:flex;flex-direction:column;gap:10px}
`;

let panelEl = null;
let panelTab = 'popup';
const booted = { popup: false, settings: false };

/* ---------- 样式注入: <style> 被 CSP 拦时改用 constructable stylesheet ---------- */
function injectStyle(css, id) {
  let ok = false;
  try {
    const st = document.createElement('style');
    st.id = id;
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
    ok = !!st.sheet;      // CSP 拦掉时 sheet 为 null
    if (!ok) st.remove();
  } catch (e) { ok = false; }
  if (ok) return;
  try {
    const ss = new CSSStyleSheet();
    ss.replaceSync(css);
    document.adoptedStyleSheets = document.adoptedStyleSheets.concat([ss]);
  } catch (e) {
    try { console.warn('[MoeGuard] 样式注入失败', e); } catch (e2) {}
  }
}

function buildPanel() {
  if (panelEl && panelEl.isConnected) return panelEl;
  /* 【不能只重建】面板节点被 Discord 重渲染移走时, 重建出来的新 DOM 没有业务监听器
   * (popup.js / options.js 的监听器只绑在旧节点上), 而重跑 boot 又会重复创建 setInterval。
   * 所以把【原节点】重新挂回去 —— 监听器、状态、输入值全部原样保留。 */
  if (panelEl && document.documentElement) {
    (document.body || document.documentElement).appendChild(panelEl);
    return panelEl;
  }
  /* document-start 阶段 documentElement 可能还不存在 (GM 菜单命令能在这时被点) */
  if (!document.documentElement) {
    document.addEventListener('DOMContentLoaded', () => { try { openPanel(); } catch (e) {} }, { once: true });
    return null;
  }

  /* 先注入 pane 样式, 再注外壳 —— 外壳里的 #moe-panel .moe-pane{width:auto} 要能盖掉
   * 弹窗页 body{width:250px} 带来的固定宽度 (同位阶, 后写者胜)。 */
  injectStyle(MOE_PANEL_CSS, 'moe-panel-css');
  injectStyle(SHELL_CSS, 'moe-panel-shell');

  const root = document.createElement('div');
  root.id = PANEL_ID;
  root.innerHTML = ''
    + '<div class="moe-head">'
    + '  <span class="moe-title">🌸 MoeGuard 喵图混淆</span>'
    + '  <button class="moe-tab on" data-tab="popup">弹窗</button>'
    + '  <button class="moe-tab" data-tab="settings">设置</button>'
    + '  <button class="moe-x" title="关闭 (Alt+M)">×</button>'
    + '</div>'
    + '<div class="moe-body">'
    + '  <div class="moe-pane" data-pane="popup"></div>'
    + '  <div class="moe-pane moe-wide-pane" data-pane="settings" hidden></div>'
    + '</div>';

  const panePopup = root.querySelector('[data-pane="popup"]');
  const paneSettings = root.querySelector('[data-pane="settings"]');
  panePopup.innerHTML = MOE_POPUP_HTML;
  paneSettings.innerHTML = MOE_OPTIONS_HTML;

  root.querySelector('.moe-x').addEventListener('click', () => closePanel());
  root.querySelectorAll('.moe-tab').forEach((b) => {
    b.addEventListener('click', () => selectTab(b.dataset.tab));
  });

  (document.body || document.documentElement).appendChild(root);
  root.style.display = 'none';    // 建好先藏起来: 否则 togglePanel 第一次会反着关
  panelEl = root;

  /* 原 popup.js / options.js 的代码在这里第一次运行 (见 build-user.js 的拼接) */
  if (!booted.popup) { booted.popup = true; try { __bootPopup(); } catch (e) { console.warn('[MoeGuard] popup boot', e); } }
  if (!booted.settings) { booted.settings = true; try { __bootOptions(); } catch (e) { console.warn('[MoeGuard] options boot', e); } }

  return root;
}

function selectTab(tab) {
  panelTab = tab === 'settings' ? 'settings' : 'popup';
  if (!panelEl) return;
  panelEl.classList.toggle('moe-wide', panelTab === 'settings');
  panelEl.querySelectorAll('.moe-tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === panelTab));
  panelEl.querySelectorAll('.moe-pane').forEach((p) => { p.hidden = p.dataset.pane !== panelTab; });
  /* 【切页重读】两边共用 enabled/autoDecode/badge/nsfwOnly 四个键, 而各自只在 boot 时读一次。
   * 不重读 → 在弹窗改了开关, 再去设置页保存, 会把旧值写回去 (悄悄地撤销改动)。 */
  try {
    const fn = panelTab === 'settings' ? __moeReloadOptions : __moeReloadPopup;
    if (typeof fn === 'function') fn();
  } catch (e) {}
}

function openPanel(tab) {
  /* 先记意图: documentElement 还不存在时 buildPanel 会排一个 DOMContentLoaded 重开,
   * 那边读的就是 panelTab —— 不能先 build 后 select, 否则“打开设置”会变成弹窗。 */
  if (tab) panelTab = tab === 'settings' ? 'settings' : 'popup';
  const root = buildPanel();
  if (!root) return;
  selectTab(panelTab);
  root.style.display = 'flex';
}

function closePanel() {
  if (panelEl) panelEl.style.display = 'none';
}

function togglePanel() {
  const root = buildPanel();
  if (!root) return;
  if (root.style.display === 'none') openPanel(); else closePanel();
}

function panelVisible() {
  return !!(panelEl && panelEl.isConnected && panelEl.style.display !== 'none');
}

/* ---------- 入口: Alt+M ---------- */
try {
  window.addEventListener('keydown', (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'm' || e.key === 'M')) {
      e.preventDefault();
      e.stopPropagation();
      togglePanel();
    }
  }, true);
} catch (e) {}

/* ---------- 入口: GM 菜单命令 ---------- */
try {
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('🌸 MoeGuard 面板', () => togglePanel());
    GM_registerMenuCommand('⚙️ MoeGuard 设置', () => openPanel('settings'));
    GM_registerMenuCommand('🔄 解码本页所有图片', () => dispatchToContent({ action: 'scan-all' }));
  }
} catch (e) {}