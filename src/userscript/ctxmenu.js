/* ══════════════════════════════════════════════════════════════════
 * MoeGuard 油猴版 —— 页内右键菜单
 *
 * 原版靠 chrome.contextMenus 往图片右键菜单塞一项「解码此图片」。
 * 油猴没有这个 API, 所以这里自己画一个小菜单:
 *
 *   - 只在【附件图】(cdn/media.discordapp + "/attachments/" 路径) 上接管
 *     头像 / 表情 / 贴纸 / 外链图 一律放行, 不打扰 Discord 原生菜单
 *   - 按住 Shift 右键 = 完全不接管 (给需要原生菜单的场合留后门)
 *   - 动作全部投给 content.js 的既有消息通道, 不重复实现解码逻辑
 * ══════════════════════════════════════════════════════════════════ */

const ATTACH_RE = /(?:cdn|media(?:-b\d)?)\.discordapp\.(?:com|net|org)\/attachments\//;

let ctxEl = null;

function attachmentUrlFor(img) {
  if (!img) return '';
  try {
    const a = img.closest ? img.closest('a[href*="/attachments/"]') : null;
    if (a && a.href && ATTACH_RE.test(a.href)) return a.href;
  } catch (e) {}
  const raw = img.currentSrc || img.src || '';
  if (raw && ATTACH_RE.test(raw)) return raw;
  /* 【与 content.js 同一套 fallback】图片被解码后 src/currentSrc 已经是 blob:,
   * 原始 CDN 地址只剩 data-moe-orig 里 —— 不回查它, 已解码的图就右不出菜单。 */
  const orig = img.dataset && img.dataset.moeOrig;
  if (orig && ATTACH_RE.test(orig)) return orig;
  /* 同容器内的单附件锚点 (2026 的 blob 渲染把 <img> 与 <a> 放成兄弟节点) */
  try {
    const box = img.closest('li, [id^="message-content-"], [class*="imageWrapper"], [class*="attachment"]');
    if (box) {
      const links = box.querySelectorAll('a[href*="/attachments/"], a[data-safe-src*="/attachments/"]');
      if (links.length === 1) {
        const h = links[0].getAttribute('href') || links[0].getAttribute('data-safe-src') || '';
        if (ATTACH_RE.test(h)) return h;
      }
    }
  } catch (e) {}
  return '';
}

function closeCtxMenu() {
  if (ctxEl) { try { ctxEl.remove(); } catch (e) {} ctxEl = null; }
}

function copyText(t) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(t); return; }
  } catch (e) {}
  try {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  } catch (e) {}
}

function openCtxMenu(x, y, url) {
  closeCtxMenu();
  const box = document.createElement('div');
  box.id = 'moe-ctxmenu';
  box.style.cssText = 'position:fixed;z-index:2147483600;min-width:196px;padding:6px;'
    + 'background:linear-gradient(160deg,#1c1630,#241a38);border:1px solid rgba(255,255,255,.12);'
    + 'border-radius:10px;box-shadow:0 14px 40px rgba(0,0,0,.6);'
    + 'font:13px/1.4 "Segoe UI","Microsoft YaHei",sans-serif;color:#e8e2f5;';

  const item = (label, hint, fn) => {
    const b = document.createElement('div');
    b.textContent = label + (hint ? '  ' + hint : '');
    b.style.cssText = 'padding:7px 10px;border-radius:7px;cursor:pointer;white-space:nowrap;';
    b.addEventListener('mouseenter', () => { b.style.background = 'rgba(255,255,255,.09)'; });
    b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
    b.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); closeCtxMenu(); fn(); });
    box.appendChild(b);
  };

  item('🔓 解码为原图', '', () => dispatchToContent({ action: 'decode-url', url }));
  item('💾 另存此图', '', () => saveAs(url, 'moeguard-saved.png'));
  item('📋 复制图片链接', '', () => copyText(url));

  const tip = document.createElement('div');
  tip.textContent = 'Shift+右键 = Discord 原生菜单';
  tip.style.cssText = 'padding:6px 10px 2px;font-size:10px;color:#8d84a6;border-top:1px solid rgba(255,255,255,.08);margin-top:4px;';
  box.appendChild(tip);

  (document.body || document.documentElement).appendChild(box);

  /* 贴边修正 */
  const r = box.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - r.width - 8);
  const top = Math.min(y, window.innerHeight - r.height - 8);
  box.style.left = Math.max(6, left) + 'px';
  box.style.top = Math.max(6, top) + 'px';

  ctxEl = box;
}

try {
  document.addEventListener('contextmenu', (e) => {
    if (e.shiftKey || e.button !== 2) return;          // Shift = 原生菜单
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('#' + PANEL_ID) || t.closest('#moe-ctxmenu')) return;   // 别拦自己的 UI
    const img = t.tagName === 'IMG' ? t : t.closest('img');
    if (!img) return;
    const url = attachmentUrlFor(img);
    if (!url) return;                                   // 非附件图 → 原生
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    openCtxMenu(e.clientX, e.clientY, url);
  }, true);

  const kill = () => closeCtxMenu();
  document.addEventListener('mousedown', (e) => { if (ctxEl && !ctxEl.contains(e.target)) kill(); }, true);
  document.addEventListener('scroll', kill, true);
  window.addEventListener('resize', kill, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') kill(); }, true);
} catch (e) {}