/* ══════════════════════════════════════════════════════════════════
 * MoeGuard 喵图混淆 —— 后台 Service Worker (MV3) v1.5
 *
 * ⚠️ v1.5 起彻底移除 chrome.debugger 网络层拦截:
 *    MV3 的 Service Worker 会在 ~30s 空闲后被杀, 被 Fetch 域暂停的
 *    请求就永远收不到 continueRequest → 上传永久卡在 0% (实测复现)。
 *    改为纯页面内拦截 (hook.js), 稳定且无副作用。
 *
 * 本文件职责:
 *   1. 右键菜单「解码此图片」
 *   2. 替 content 抓取跨域图片 (扩展权限绕过 CORS)
 *   3. 触发下载
 *   4. 遥测面板数据 (由页面 seam 上报)
 * ══════════════════════════════════════════════════════════════════ */
'use strict';

const CONTEXT_MENU_ID = 'moe-decode-image';

const dbg = {
  version: '3.6.2',
  mode: '页面内拦截 (XHR + fetch seam)',
  tracked: 0, encoded: 0, uploadsSeen: 0, uploadsReplaced: 0, uploadsPass: 0,
  lastFile: '', lastSize: 0, lastReplace: '', lastError: '', lastTime: '', lastReview: '',
};
function dbgSave() { try { chrome.storage.session.set({ moeDbg: dbg }); } catch (e) {} }

chrome.runtime.onInstalled.addListener(() => {
  try { chrome.contextMenus.removeAll(() => createMenus()); } catch (e) { createMenus(); }
});
function createMenus() {
  try {
    chrome.contextMenus.create({ id: CONTEXT_MENU_ID, title: '🔓 解码此图片（喵图混淆）', contexts: ['image'] });
  } catch (e) {}
}
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!info || info.menuItemId !== CONTEXT_MENU_ID) return;
  if (tab && tab.id != null && info.srcUrl) {
    try { chrome.tabs.sendMessage(tab.id, { action: 'decode-url', url: info.srcUrl }); } catch (e) {}
  }
});

function u8ToB64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}

/* ══════════════════════════════════════════════════════════════════
 * NSFW 审查代发 —— 只有用户在设置页显式开启远端审查时才会走到这里
 * ══════════════════════════════════════════════════════════════════
 * 为什么要放在后台: 主世界 fetch 跨域会被 Discord 的 CSP 拦死;
 *   后台 Service Worker 不受页面 CSP 约束。
 *
 * ⚠️ 隐私: 开启远端审查 = 把图片(已缩到 512px)发给第三方,
 *   与本插件「防外泄」的初衷相冲突 → 设置页有醒目警告, 默认关闭。
 *
 * 适配器设计: 不同服务的请求/响应格式差别很大, 所以抽成 {build, parse}。
 *   自定义服务只要能「POST 收 base64 / 回 JSON 里带一个 0..1 分数」就能接。
 * ══════════════════════════════════════════════════════════════════ */
const NSFW_ADAPTERS = {
  // Sightengine: 表单 POST, 回 nudity.{sexual_activity,sexual_display,erotica,...}
  sightengine: {
    build(cfg, blob) {
      const fd = new FormData();
      fd.append('media', blob, 'i.png');
      fd.append('models', 'nudity-2.1');
      fd.append('api_user', cfg.apiUser || '');
      fd.append('api_secret', cfg.apiKey || '');
      return { url: 'https://api.sightengine.com/1.0/check.json', init: { method: 'POST', body: fd } };
    },
    parse(j) {
      const n = j && j.nudity;
      if (!n) return null;
      return Math.max(n.sexual_activity || 0, n.sexual_display || 0, n.erotica || 0, (n.very_suggestive || 0) * 0.6);
    },
  },
  // 通用: POST JSON {image: "<base64>"} → 从常见字段里找分数
  generic: {
    build(cfg, blob, b64) {
      const headers = { 'content-type': 'application/json' };
      if (cfg.apiKey) headers.authorization = 'Bearer ' + cfg.apiKey;
      return {
        url: cfg.apiUrl,
        init: { method: 'POST', headers, body: JSON.stringify({ image: b64 }) },
      };
    },
    parse(j) {
      if (!j) return null;
      const cands = [j.nsfw_score, j.score, j.nsfw, j.porn, j.confidence,
        j.data && j.data.score, j.result && j.result.score];
      for (const v of cands) if (typeof v === 'number' && isFinite(v)) return v > 1 ? v / 100 : v;
      // 分类数组: [{label,score}]
      const arr = Array.isArray(j) ? j : (Array.isArray(j.labels) ? j.labels : null);
      if (arr) {
        let best = null;
        for (const it of arr) {
          const lb = String((it && (it.label || it.class || it.name)) || '').toLowerCase();
          const sc = it && (it.score != null ? it.score : it.confidence);
          if (typeof sc === 'number' && /porn|hentai|sexy|nsfw|nudity|explicit/.test(lb)) {
            best = best == null ? sc : Math.max(best, sc);
          }
        }
        if (best != null) return best > 1 ? best / 100 : best;
      }
      return null;
    },
  },
};

function dataUrlToBlob(dataUrl) {
  const i = dataUrl.indexOf(',');
  const meta = dataUrl.slice(0, i);
  const b64 = dataUrl.slice(i + 1);
  const mime = (meta.match(/data:([^;]+)/) || [])[1] || 'image/png';
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) u8[k] = bin.charCodeAt(k);
  return { blob: new Blob([u8], { type: mime }), b64 };
}

async function nsfwCheck(dataUrl) {
  const cfg = await new Promise((res) => {
    try { chrome.storage.sync.get({ reviewMode: 'local', apiProvider: 'generic', apiUrl: '', apiUser: '', apiKey: '' }, res); }
    catch (e) { res({ reviewMode: 'local' }); }
  });
  if (cfg.reviewMode === 'local') return { score: null, error: 'remote-disabled' };
  const ad = NSFW_ADAPTERS[cfg.apiProvider] || NSFW_ADAPTERS.generic;
  if (ad === NSFW_ADAPTERS.generic && !cfg.apiUrl) return { score: null, error: 'no-api-url' };
  const { blob, b64 } = dataUrlToBlob(dataUrl);
  const req = ad.build(cfg, blob, b64);
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(req.url, Object.assign({ signal: ctl.signal }, req.init));
    const j = await r.json().catch(() => null);
    const score = ad.parse(j);
    dbg.lastReview = 'score=' + score + ' http=' + r.status;
    dbgSave();
    return { score: typeof score === 'number' ? Math.max(0, Math.min(1, score)) : null, http: r.status };
  } catch (e) {
    dbg.lastReview = 'ERR ' + String(e.message || e).slice(0, 80);
    dbgSave();
    return { score: null, error: String(e.message || e).slice(0, 120) };
  } finally {
    clearTimeout(to);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.action === 'nsfw-check' && msg.dataUrl) {
    nsfwCheck(msg.dataUrl).then(sendResponse).catch(() => sendResponse({ score: null, error: 'throw' }));
    return true;
  }

  // 页面 seam 遥测
  if (msg.action === 'moe-telemetry') {
    const t = msg.data || {};
    if (t.ev === 'tracked') { dbg.tracked++; dbg.lastFile = t.name || ''; dbg.lastSize = t.size || 0; }
    else if (t.ev === 'encoded') { dbg.encoded++; dbg.lastReplace = (t.name || '') + ' → ' + (t.newSize || 0) + 'B ' + (t.w || 0) + 'x' + (t.h || 0); }
    else if (t.ev === 'upload-seen') { dbg.uploadsSeen++; }
    else if (t.ev === 'upload-replaced') { dbg.uploadsReplaced++; dbg.lastReplace = t.info || dbg.lastReplace; }
    else if (t.ev === 'upload-pass') { dbg.uploadsPass++; dbg.lastError = t.why || dbg.lastError; }
    else if (t.ev === 'error') { dbg.lastError = String(t.msg || '').slice(0, 200); }
    else if (t.ev === 'review') { dbg.lastReview = (t.source || '') + ' ' + t.score + ' → ' + (t.obfuscate ? '混淆' : '直通'); }
    dbg.lastTime = new Date().toTimeString().slice(0, 8);
    dbgSave();
    sendResponse({ ok: true });
    return false;
  }

  if (msg.action === 'fetchImg' && msg.url) {
    const init = { credentials: 'include', cache: 'no-store' };
    if (msg.range) init.headers = { Range: 'bytes=' + msg.range };
    fetch(msg.url, init)
      .then(async (r) => {
        if (!r.ok && r.status !== 206) throw new Error('HTTP ' + r.status);
        const buf = new Uint8Array(await r.arrayBuffer());
        sendResponse({ ok: true, base64: u8ToB64(buf), mime: r.headers.get('content-type') || 'application/octet-stream' });
      })
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg.action === 'download' && msg.url) {
    chrome.downloads.download({ url: msg.url, filename: msg.filename || 'decoded.png', saveAs: false });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.action === 'moe-dbg') { sendResponse(JSON.parse(JSON.stringify(dbg))); return true; }
  return undefined;
});