/* ══════════════════════════════════════════════════════════════════
 * MoeGuard 油猴版 —— chrome.* 兼容层 (原 background.js 的替代)
 *
 * 油猴里没有 Service Worker, 也没有 chrome.storage / downloads / contextMenus。
 * 这里造一个同名对象填进脚本作用域, 让 core/content/hook/popup/options
 * 的源码一行都不用为「没有扩展 API」改写 —— 只把每个 API 落到 GM_* 上。
 *
 *   chrome.runtime.sendMessage  → 本地派发 (原后台的 5 个 handler 原样搬来)
 *   chrome.storage.sync.*       → GM_getValue / GM_setValue
 *   chrome.downloads.download   → GM_download (不可用则 <a download>)
 *   chrome.tabs.sendMessage     → 直接投给页面内的 content 监听器
 *   chrome.permissions.request  → 恒真 (域名靠 @connect 静态声明)
 *   chrome.runtime.getURL       → @resource (字体只在 GeckoView 用, 桌面不触发)
 *
 * ⚠️ 自检: TM 若把脚本注入到非主世界, hook 会失效 (上传不混淆, 但 UI 照常)。
 *    所以这里在 document 上留一条 data-moe-world 供诊断面板读。
 * ══════════════════════════════════════════════════════════════════ */

const MOE_VER = '__MOE_VERSION__';

const GM = {
  xhr: typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest : null,
  getVal: typeof GM_getValue === 'function' ? GM_getValue : null,
  setVal: typeof GM_setValue === 'function' ? GM_setValue : null,
  download: typeof GM_download === 'function' ? GM_download : null,
  menu: typeof GM_registerMenuCommand === 'function' ? GM_registerMenuCommand : null,
  resURL: typeof GM_getResourceURL === 'function' ? GM_getResourceURL : null,
};

const CFG_KEY = 'moeguard.cfg';        // 旧版整包快照: 只读兼容 / 首次迁移
const KEY_INDEX = 'moeguard.cfg.keys';
const KEY_PREFIX = 'moeguard.cfg.';

/* 【存储必须是按 key 写】chrome.storage.sync.set 是按键 merge —— popup 只写 4 个键,
 * 不会动 salt/阈值/API 配置。而 GM_setValue 只能整值写: 拿一份快照覆盖整包的话,
 * 两个 Discord 窗口交叉写就会互相抹掉 (A 改了开关, B 刚保存的盐值就回去了)。
 * 所以每个配置键单独一个 GM 键 + 一个键名索引。 */
function readIndex() {
  try {
    const raw = GM.getVal ? GM.getVal(KEY_INDEX, null) : null;
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(arr) ? arr.filter((k) => typeof k === 'string') : [];
  } catch (e) { return []; }
}

function readAll() {
  const out = {};
  try {
    const bag = GM.getVal ? GM.getVal(CFG_KEY, null) : null;
    const o = typeof bag === 'string' ? JSON.parse(bag) : bag;
    if (o && typeof o === 'object') Object.assign(out, o);   // 旧格式打底
  } catch (e) {}
  for (const k of readIndex()) {
    try {
      const v = GM.getVal ? GM.getVal(KEY_PREFIX + k, undefined) : undefined;
      if (v !== undefined) out[k] = v;                       // 新格式覆盖
    } catch (e) {}
  }
  return out;
}

function writeAll(obj) {
  if (!GM.setVal) return;
  try {
    let idx = readIndex();
    const add = [];
    for (const k of Object.keys(obj)) {
      try { GM.setVal(KEY_PREFIX + k, obj[k]); } catch (e) { continue; }
      if (idx.indexOf(k) < 0) add.push(k);
    }
    if (add.length) { idx = idx.concat(add); try { GM.setVal(KEY_INDEX, idx); } catch (e) {} }
  } catch (e) {}
}

/* ---------- 后台遥测 (原 background.js 的 dbg 对象, 一字不改搬过来) ---------- */
const dbg = {
  version: MOE_VER,
  mode: '油猴 · 页面内拦截 (XHR + fetch seam)',
  tracked: 0, encoded: 0, uploadsSeen: 0, uploadsReplaced: 0, uploadsPass: 0,
  lastFile: '', lastSize: 0, lastReplace: '', lastError: '', lastTime: '', lastReview: '',
};

/* ---------- 字节工具 ---------- */
function u8ToB64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}
function toU8(resp) {
  if (!resp) return null;
  if (resp instanceof ArrayBuffer) return new Uint8Array(resp);
  if (ArrayBuffer.isView(resp)) return new Uint8Array(resp.buffer, resp.byteOffset, resp.byteLength);
  /* 【兜底】某些实现 responseType:'arraybuffer' 失效时会给二进制字符串 */
  if (typeof resp === 'string') {
    const u8 = new Uint8Array(resp.length);
    for (let i = 0; i < resp.length; i++) u8[i] = resp.charCodeAt(i) & 255;
    return u8;
  }
  /* 【兜底】跨 realm 的裸 ArrayBuffer: instanceof 会失败 */
  try {
    if (typeof resp.byteLength === 'number' && typeof resp.slice === 'function') {
      return new Uint8Array(resp.slice(0));
    }
  } catch (e) {}
  return null;
}
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

/* ---------- 跨域抓图 (原 background 的 fetchImg) ---------- */
function gmFetch(url, range) {
  return new Promise((res) => {
    if (!GM.xhr) { res({ ok: false, error: 'no-gm-xhr' }); return; }
    let done = false;
    const fin = (r) => { if (!done) { done = true; res(r); } };
    try {
      GM.xhr({
        method: 'GET',
        url,
        headers: range ? { Range: 'bytes=' + range } : {},
        responseType: 'arraybuffer',
        timeout: 20000,
        onload(r) {
          try {
            if (!(r.status === 200 || r.status === 206)) { fin({ ok: false, error: 'HTTP ' + r.status }); return; }
            const u8 = toU8(r.response);
            if (!u8) { fin({ ok: false, error: 'no-bytes(type=' + typeof r.response + ')' }); return; }
            /* responseHeaders 可能是字符串、对象数组或 null —— 统一当字符串处理,
             * 否则 null.split 会在 onload 里抛异常 → Promise 永不结算 (只能等 12s 超时) */
            const rawH = r.responseHeaders;
            const hdr = typeof rawH === 'string' ? rawH
              : Array.isArray(rawH) ? rawH.map((h) => (h && h.name ? h.name + ': ' + h.value : '')).join('\n')
              : '';
            const mime = hdr.split('\n')
              .map((l) => l.trim()).filter(Boolean)
              .map((l) => l.split(/:\s*/)).find((p) => p[0] && p[0].toLowerCase() === 'content-type');
            fin({ ok: true, base64: u8ToB64(u8), mime: (mime && mime[1]) || 'image/png' });
          } catch (e) {
            fin({ ok: false, error: 'onload:' + String((e && e.message) || e).slice(0, 80) });
          }
        },
        onerror: () => fin({ ok: false, error: 'network' }),
        ontimeout: () => fin({ ok: false, error: 'timeout:20s' }),
        onabort: () => fin({ ok: false, error: 'abort' }),
      });
    } catch (e) { fin({ ok: false, error: String(e && e.message || e) }); }
  });
}

/* ---------- 远端审查 (原 background 的 NSFW_ADAPTERS, 原样保留) ---------- */
const NSFW_ADAPTERS = {
  sightengine: {
    build(cfg, blob) {
      const fd = new FormData();
      fd.append('media', blob, 'i.png');
      fd.append('models', 'nudity-2.1');
      fd.append('api_user', cfg.apiUser || '');
      fd.append('api_secret', cfg.apiKey || '');
      return { url: 'https://api.sightengine.com/1.0/check.json', body: fd, headers: {} };
    },
    parse(j) {
      const n = j && j.nudity;
      if (!n) return null;
      return Math.max(n.sexual_activity || 0, n.sexual_display || 0, n.erotica || 0, (n.very_suggestive || 0) * 0.6);
    },
  },
  generic: {
    build(cfg, blob, b64) {
      const headers = { 'content-type': 'application/json' };
      if (cfg.apiKey) headers.authorization = 'Bearer ' + cfg.apiKey;
      return { url: cfg.apiUrl, body: JSON.stringify({ image: b64 }), headers };
    },
    parse(j) {
      if (!j) return null;
      const cands = [j.nsfw_score, j.score, j.nsfw, j.porn, j.confidence,
        j.data && j.data.score, j.result && j.result.score];
      for (const v of cands) if (typeof v === 'number' && isFinite(v)) return v > 1 ? v / 100 : v;
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

function nsfwCheck(dataUrl) {
  const all = readAll();
  const cfg = Object.assign({ reviewMode: 'local', apiProvider: 'generic', apiUrl: '', apiUser: '', apiKey: '' }, all);
  if (cfg.reviewMode === 'local') return Promise.resolve({ score: null, error: 'remote-disabled' });
  const ad = NSFW_ADAPTERS[cfg.apiProvider] || NSFW_ADAPTERS.generic;
  if (ad === NSFW_ADAPTERS.generic && !cfg.apiUrl) return Promise.resolve({ score: null, error: 'no-api-url' });
  const { blob, b64 } = dataUrlToBlob(dataUrl);
  const req = ad.build(cfg, blob, b64);

  return new Promise((res) => {
    if (!GM.xhr) { res({ score: null, error: 'no-gm-xhr' }); return; }
    let done = false;
    const fin = (r) => { if (!done) { done = true; res(r); } };
    try {
      GM.xhr({
        method: 'POST',
        url: req.url,
        headers: req.headers,
        data: req.body,
        timeout: 8000,
        onload(r) {
          let j = null;
          try { j = JSON.parse(r.responseText); } catch (e) {}
          const score = ad.parse(j);
          dbg.lastReview = 'score=' + score + ' http=' + r.status;
          fin({
            score: typeof score === 'number' ? Math.max(0, Math.min(1, score)) : null,
            http: r.status,
          });
        },
        onerror: () => { dbg.lastReview = 'ERR network'; fin({ score: null, error: 'network' }); },
        ontimeout: () => { dbg.lastReview = 'ERR timeout'; fin({ score: null, error: 'timeout:8s' }); },
      });
    } catch (e) { fin({ score: null, error: String(e && e.message || e) }); }
  });
}

/* ---------- 下载 ---------- */
/* 【不能用 <a download> 合成点击】content.js 的多图下载循环里有 await(解码/抓图/220ms),
 * 之后再合成点击时瞬态用户激活已经没了 → 从第 2 张起被浏览器丢掉。
 * GM_download 是 API 调用不吃激活限制, 所以统一走它: data: 先转 blob: 再交出去。 */
async function saveAs(url, filename) {
  const name = filename || 'moeguard-decoded.png';
  let target = url;
  if (GM.download) {
    if (/^data:/.test(url)) {
      try {
        const blob = await (await fetch(url)).blob();
        target = URL.createObjectURL(blob);
      } catch (e) { target = url; }
    }
    try { GM.download({ url: target, name, saveAs: false }); return; } catch (e) {}
  }
  /* 没有 GM_download 时的兵库: 只能合成点击 (可能被激活策略拦) */
  try {
    const a = document.createElement('a');
    a.href = url; a.download = name;
    a.style.display = 'none';
    (document.body || document.documentElement).appendChild(a);
    a.click();
    setTimeout(() => { try { a.remove(); } catch (e) {} }, 1000);
  } catch (e) {}
}

/* ---------- 遥测 (原 background 的 moe-telemetry 分支) ---------- */
function ingestTelemetry(t) {
  t = t || {};
  if (t.ev === 'tracked') { dbg.tracked++; dbg.lastFile = t.name || ''; dbg.lastSize = t.size || 0; }
  else if (t.ev === 'encoded') { dbg.encoded++; dbg.lastReplace = (t.name || '') + ' → ' + (t.newSize || 0) + 'B ' + (t.w || 0) + 'x' + (t.h || 0); }
  else if (t.ev === 'upload-seen') { dbg.uploadsSeen++; }
  else if (t.ev === 'upload-replaced') {
    if (t.obf === false) { dbg.uploadsPass++; dbg.lastReplace = '原图直传 ' + (t.kb || ''); }
    else { dbg.uploadsReplaced++; dbg.lastReplace = t.info || dbg.lastReplace; }
  }
  else if (t.ev === 'upload-pass') { dbg.uploadsPass++; dbg.lastError = t.why || dbg.lastError; }
  else if (t.ev === 'error') { dbg.lastError = String(t.msg || '').slice(0, 200); }
  else if (t.ev === 'review') { dbg.lastReview = (t.source || '') + ' ' + t.score + ' → ' + (t.obfuscate ? '混淆' : '直通'); }
  dbg.lastTime = new Date().toTimeString().slice(0, 8);
}

/* ══════════════════════════════════════════════════════════════════
 * chrome.* 替身
 * ══════════════════════════════════════════════════════════════════ */
const contentListeners = [];   // chrome.runtime.onMessage 注册的页面侧监听器
const pendingToContent = [];   // content.js 还没 boot 时先排队的消息

/* 把一条「后台 → 内容脚本」消息投进去 (返回是否有人认领) */
function dispatchToContent(msg, cb) {
  if (!contentListeners.length && pendingToContent.length < 20) {
    pendingToContent.push({ msg, cb });   // 页面脚本还没起来, 别把点击吞掉
    return;
  }
  let answered = false;
  const sendResponse = (r) => {
    if (answered) return;
    answered = true;
    if (cb) { try { cb(r); } catch (e) {} }
  };
  for (const fn of contentListeners) {
    try { fn(msg, {}, sendResponse); } catch (e) {}
  }
  setTimeout(() => { if (!answered) sendResponse(undefined); }, 0);
}

const chrome = {
  runtime: {
    id: 'moeguard-userjs',
    lastError: undefined,
    getManifest: () => ({ version: MOE_VER, name: 'MoeGuard 喵图混淆' }),
    getURL: (p) => {
      try { return GM.resURL ? GM.resURL(p) : ''; } catch (e) { return ''; }
    },
    openOptionsPage: () => { try { openPanel('settings'); } catch (e) {} },
    sendNativeMessage: undefined,
    onMessage: { addListener: (fn) => {
      if (typeof fn === 'function' && contentListeners.indexOf(fn) < 0) contentListeners.push(fn);
      while (pendingToContent.length && contentListeners.length) {
        const it = pendingToContent.shift();
        try { dispatchToContent(it.msg, it.cb); } catch (e) {}
      }
    } },
    /* 原 background.js 的 onMessage 分支, 语义完全保留 */
    sendMessage: (msg, cb) => {
      if (!msg) { if (cb) setTimeout(() => cb(undefined), 0); return; }
      const reply = (r) => { if (cb) setTimeout(() => cb(r), 0); };

      if (msg.action === 'nsfw-check' && msg.dataUrl) {
        nsfwCheck(msg.dataUrl).then(reply, () => reply({ score: null, error: 'throw' }));
        return;
      }
      if (msg.action === 'moe-telemetry') { ingestTelemetry(msg.data); reply({ ok: true }); return; }
      if (msg.action === 'fetchImg' && msg.url) { gmFetch(msg.url, msg.range).then(reply); return; }
      if (msg.action === 'download' && msg.url) { saveAs(msg.url, msg.filename).then(() => reply({ ok: true }), () => reply({ ok: false })); return; }
      if (msg.action === 'platform-probe') { reply({ geckoView: false }); return; }
      if (msg.action === 'moe-dbg') { reply(JSON.parse(JSON.stringify(dbg))); return; }
      reply(undefined);
    },
  },

  storage: {
    sync: {
      get: (p, cb) => {
        const all = readAll();
        let out;
        if (p == null) out = Object.assign({}, all);
        else if (typeof p === 'string') out = { [p]: all[p] };
        else if (Array.isArray(p)) { out = {}; for (const k of p) out[k] = all[k]; }
        else { out = Object.assign({}, p); for (const k in p) if (k in all) out[k] = all[k]; }
        setTimeout(() => { try { cb && cb(out); } catch (e) {} }, 0);
      },
      set: (obj, cb) => {
        writeAll(Object.assign(readAll(), obj));
        setTimeout(() => { try { cb && cb(); } catch (e) {} }, 0);
      },
    },
    /* 遥测本来就是内存态, session 只是让它别落盘 */
    session: {
      set: (obj, cb) => { setTimeout(() => { try { cb && cb(); } catch (e) {} }, 0); },
      get: (p, cb) => { setTimeout(() => { try { cb && cb({}); } catch (e) {} }, 0); },
    },
  },

  tabs: {
    query: (q, cb) => { setTimeout(() => { try { cb && cb([{ id: 1, url: location.href }]); } catch (e) {} }, 0); },
    /* 【面板关着就别打扰页面】popup.js 轮询每 2s 要一次 moe-diag, 那会在 Discord 里扫一遍 DOM。 */
    sendMessage: (tabId, msg, cb) => {
      if (msg && (msg.action === 'moe-diag' || msg.action === 'scan-all') && !panelVisible()) {
        if (cb) setTimeout(() => cb(undefined), 0);
        return;
      }
      dispatchToContent(msg, cb);
    },
  },

  permissions: { request: (o, cb) => { setTimeout(() => { try { cb && cb(true); } catch (e) {} }, 0); } },

  downloads: {
    download: (o, cb) => { saveAs(o && o.url, o && o.filename); setTimeout(() => { try { cb && cb(1); } catch (e) {} }, 0); return 1; },
  },

  /* 原生右键菜单在油猴里不存在 —— 后台那套 create/onClicked 是空壳,
   * 真正的入口是 ctxmenu.js 的页内菜单 + GM 菜单命令。 */
  contextMenus: undefined,
};

/* GM 菜单命令在 ctxmenu.js 里注册 (那边要用 decode-url 派发)。 */