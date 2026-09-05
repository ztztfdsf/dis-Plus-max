/* ══════════════════════════════════════════════════════════════════
 * MoeGuard 喵图混淆 —— 隔离世界 UI (ISOLATED world, document_idle) v1.5
 *
 * 职责:
 *   1. 读配置 → 同步给主世界 hook
 *   2. 聊天流里自动检测喵图 → 解码 → 换成原图显示 + 「已解码 ✓」角标
 *   3. 输入框预览「已混淆 (发送后加密)」角标
 *   4. 右键「解码此图片」弹窗
 *   5. 遥测转发给后台 (弹窗调试面板)
 *
 * 2026 Discord DOM 事实:
 *   - 消息列表: [data-list-id="chat-messages"] 下的 <li>, 没有 <article>
 *   - 图片显示走 media.discordapp.net (webp 重编码 + ?width=&height=),
 *     必须换成 cdn.discordapp.com 原始 URL 才能无损解码
 * ══════════════════════════════════════════════════════════════════ */
'use strict';
(function () {
  /* 【诊断印记】写到一个独立隐藏 div 的 data-* 上
   * 历史教训: Discord 用 react-helmet 接管 <html>/<head> 属性, 会抹掉外来 data-*;
   *   window.localStorage 也被 Discord 删掉了(防盗 token) → 主世界读不到。
   *   自己新建的 div 在 React 根之外, 不会被调和掉。 */
  const DIAG_VER = '3.6.3';
  let diagEl = null;
  function stamp(k, v) {
    try {
      if (!diagEl || !diagEl.isConnected) {
        diagEl = document.getElementById('__moe_diag');
        if (!diagEl) {
          diagEl = document.createElement('div');
          diagEl.id = '__moe_diag';
          diagEl.style.display = 'none';
          (document.body || document.documentElement).appendChild(diagEl);
        }
      }
      diagEl.setAttribute('data-ver', DIAG_VER);
      diagEl.setAttribute('data-' + k, String(v).slice(0, 200));
    } catch (e) {}
  }

  const Core = window.__MoeGuardCore;
  const FMT = window._moeFormat;
  if (!Core || !FMT) { stamp('fatal', 'no-core-or-fmt'); return; }

  const EXT = (() => { try { return !!(chrome && chrome.runtime && chrome.runtime.id); } catch (e) { return false; } })();
  const DEFAULTS = { enabled: true, autoDecode: true, badge: true, tile: 0, salt: '', maxDim: 0, skipAnimated: true, nsfwOnly: false, nsfwThreshold: 0.7, reviewMode: 'local', apiProvider: 'generic', apiUrl: '', apiUser: '', apiKey: '' };
  const cfg = Object.assign({}, DEFAULTS);

  /* ---------- 诊断印记 ---------- */
  stamp('world', EXT ? 'ext' : 'page');
  window.addEventListener('error', (e) => {
    if (e && e.filename && e.filename.indexOf('content.js') >= 0) stamp('err', (e.message || '') + '@' + e.lineno);
  });

  /* ---------- 存储 ---------- */
  function storageGet() {
    return new Promise((res) => {
      if (EXT) {
        try { chrome.storage.sync.get(DEFAULTS, (v) => res(Object.assign({}, DEFAULTS, v))); }
        catch (e) { res(Object.assign({}, DEFAULTS)); }
      } else {
        try { res(Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('moeguard.cfg') || '{}'))); }
        catch (e) { res(Object.assign({}, DEFAULTS)); }
      }
    });
  }

  /* ---------- base64 / blob ---------- */
  function b64ToBlob(b64, mime) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Blob([u8], { type: mime || 'image/png' });
  }
  function blobToDataUrl(blob) {
    return new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
  }

  /* ---------- 抓图 (后台代抓, 绕 CORS; 支持 Range 只取头部) ---------- */
  function fetchImg(url, range) {
    return new Promise((res) => {
      if (EXT) {
        try {
          chrome.runtime.sendMessage({ action: 'fetchImg', url, range }, (r) => res(r || { ok: false, error: 'no-reply' }));
          return;
        } catch (e) {}
      }
      const opt = { credentials: 'include', cache: 'no-store' };
      if (range) opt.headers = { Range: 'bytes=' + range };
      fetch(url, opt)
        .then(async (r) => {
          if (!r.ok && r.status !== 206) throw new Error('HTTP ' + r.status);
          const buf = new Uint8Array(await r.arrayBuffer());
          let bin = '';
          for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
          res({ ok: true, base64: btoa(bin), mime: r.headers.get('content-type') || 'image/png' });
        })
        .catch((e) => res({ ok: false, error: String(e) }));
    });
  }
  function tele(data) { if (EXT) { try { chrome.runtime.sendMessage({ action: 'moe-telemetry', data }); } catch (e) {} } }

  /* ---------- URL 规整: media 代理 → cdn 原始 ---------- */
  function toOriginalUrl(u) {
    try {
      const url = new URL(u, location.href);
      if (/^media(-b\d)?\.discordapp\.net$/.test(url.hostname) && url.pathname.startsWith('/attachments/')) {
        url.hostname = 'cdn.discordapp.com';
      }
      if (url.hostname === 'cdn.discordapp.com') {
        for (const k of ['width', 'height', 'format', 'quality', 'animated', 'size']) url.searchParams.delete(k);
      }
      return url.href;
    } catch (e) { return u || ''; }
  }
  function isAttachment(u) {
    try {
      const url = new URL(u, location.href);
      return /(^|\.)discordapp\.(com|net)$/.test(url.hostname) && /^\/attachments\//.test(url.pathname);
    } catch (e) { return false; }
  }

  /* ---------- 共用字体 (跟 Discord 主题变量) ---------- */
  const FONT = 'var(--font-primary),"Segoe UI","Microsoft YaHei",sans-serif';

  /* ---------- Toast (Discord 原生悬浮面色调) ---------- */
  let toastEl = null;
  function toast(msg, ms) {
    try {
      if (!toastEl) {
        toastEl = document.createElement('div');
        toastEl.style.cssText = 'position:fixed;bottom:78px;left:50%;transform:translateX(-50%);z-index:2147483646;' +
          'background:var(--background-surface-highest,#fff);color:var(--text-default,#2e3338);' +
          'font:600 13px/1.4 ' + FONT + ';padding:8px 14px;border-radius:var(--radius-sm,8px);' +
          'box-shadow:var(--shadow-border),var(--shadow-medium);max-width:72vw;' +
          'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        document.body.appendChild(toastEl);
      }
      toastEl.textContent = msg;
      toastEl.style.display = 'block';
      clearTimeout(toastEl._t);
      toastEl._t = setTimeout(() => { if (toastEl) toastEl.style.display = 'none'; }, ms || 2600);
    } catch (e) {}
  }

  /* ---------- 预筛: 只取前 128 字节读 moEg 标记块 ----------
   * 混淆产物会在 PNG 的 IHDR 后插入 'moEg' ancillary 块,
   * 因此只需 128 字节就能安全判定「是不是喵图」,
   * 普通图片/表情/头像永不会被完整下载或解码 → 不影响正常交流。
   * 尺寸整除作为辅助兜底 (兼容旧版无标记块的图)。
   * -------------------------------------------------- */
  const prefilterCache = new Map(); // url → Promise<'moe'|'legacy'|'no'|'retry'>
  function prefilter(url) {
    if (prefilterCache.has(url)) return prefilterCache.get(url);
    const p = (async () => {
      const fr = await fetchImg(url, '0-127');
      if (!fr.ok || !fr.base64) return 'retry';        // 抓不到字节 ≠ 不是喵图
      const bin = atob(fr.base64);
      const b = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
      if (!Core.isPng(b)) return 'no';
      const mk = Core.pngReadMarker(b, cfg.salt);
      if (mk) return mk.saltOk ? 'moe' : 'no';
      if (b.length >= 24) {
        const w = (b[16] << 24 | b[17] << 16 | b[18] << 8 | b[19]) >>> 0;
        const h = (b[20] << 24 | b[21] << 16 | b[22] << 8 | b[23]) >>> 0;
        // 喵图尺寸 = tile 网格 + 两边定位框; tile 是 2 幂 (64/128/256/…)
        const F2 = 2 * (Core.V3_FRAME || 12);
        if (w > F2 && h > F2) {
          const gw = w - F2, gh = h - F2;
          for (let T = 64; T <= (Core.V3_CAP_TILE || 1024); T *= 2) {
            if (gw % T === 0 && gh % T === 0) return 'legacy';
          }
        }
      }
      return 'no';
    })().catch(() => 'retry');
    prefilterCache.set(url, p);
    p.then((v) => { if (v === 'retry') prefilterCache.delete(url); }).catch(() => prefilterCache.delete(url));
    return p;
  }

  /* ---------- 解码管线 (带缓存) ----------
   * 缓存策略: 稳定结果(decoded/not-moe/bad-salt/resized) 永久缓存;
   *   瞬时失败(fetch-fail) 不缓存 → 下一轮能重试
   *   (历史问题: MV3 的 SW 被杀/网络抖动导致一次失败, 就永远不再试 → 看着像「不自动」) */
  const cache = new Map(); // origUrl → Promise<{status, blob?, width?, height?}>
  /* 已解码结果的【同步】索引: origUrl → {url(objectURL), w, h, meta}
   * 为何要单独开一份: cache 里是 Promise, 取值得 await → 一个微任务后才能换 src,
   *   而大图弹窗那一帧已经把混淆图画出来了 (主人看到的“先闪一下混淆图”)。
   *   有了同步索引就能在节点插入的同一个任务里直接置换。 */
  const decodedSync = new Map();
  /** 附件身份键: 只用 pathname (/attachments/<频道>/<附件id>/<文件名>)
   *  为何不用完整 URL: Discord 的签名参数 ex/is/hm 会定期刷新,
   *  列表缩图与大图拿到的签名可能不同 → 完整 URL 做键会认不出是同一张。 */
  function attachKey(u) {
    try { return new URL(u, location.href).pathname; } catch (e) { return String(u || ''); }
  }
  function decodeUrl(origUrl, skipPrefilter) {
    if (cache.has(origUrl)) return cache.get(origUrl);
    const p = (async () => {
      if (!skipPrefilter) {
        const pre = await prefilter(origUrl);
        if (pre === 'no') return { status: 'not-moe' };
        if (pre === 'retry') return { status: 'fetch-fail', error: 'prefilter' };
      }
      const fr = await fetchImg(origUrl);
      if (!fr.ok) return { status: 'fetch-fail', error: fr.error };
      // 元数据 (ComfyUI workflow 等) 在 moMt chunk 里, 从原始字节提取 → 解码后写回还原图
      let metaChunks = null;
      try {
        const bs = atob(fr.base64);
        const rb = new Uint8Array(bs.length);
        for (let i = 0; i < bs.length; i++) rb[i] = bs.charCodeAt(i);
        metaChunks = Core.pngReadMetaChunks ? Core.pngReadMetaChunks(rb) : null;
      } catch (e) { metaChunks = null; }
      const img = await FMT.blobToImageData(b64ToBlob(fr.base64, fr.mime));
      const dec = Core.decodeImage(img, { salt: cfg.salt });
      if (!dec.ok) return { status: dec.reason };
      const blob = await FMT.decodedToBlob(dec, metaChunks || []);
      return { status: 'decoded', blob, width: dec.width, height: dec.height, layout: dec.layout, hasMeta: !!(metaChunks && metaChunks.length) };
    })();
    cache.set(origUrl, p);
    // 瞬时失败不落缓存 (含预筛阶段的失败) → 下轮可重试
    p.then((r) => {
      if (!r || r.status === 'fetch-fail' || r.status === 'error') {
        cache.delete(origUrl);
        prefilterCache.delete(origUrl);
      }
    }).catch(() => { cache.delete(origUrl); prefilterCache.delete(origUrl); });
    return p;
  }

  /** 把容器改成还原图的真实比例 ----------
   * Discord 把外层容器的 inline aspect-ratio 按【上传的混淆图】算好了,
   * 而混淆图有定位框+补边 → 比例与原图不同。
   * img 自带 min-width/min-height:100% 会把自己撑出容器,
   * 而父层 imageWrapper 是 overflow:hidden → 还原图底部被裁。
   * 修法: 把那个带 aspect-ratio 的容器改成还原图比例 + 松掉 img 的最小尺寸约束。 */
  function fitDecoded(img, w, h) {
    if (!(w > 0 && h > 0)) return;
    try {
      // 大图弹窗 (carouselModal) 走单独一套: 那里靠 img 自身尺寸布局,
      // 改成 100% 会把图拉成弹窗大小。
      if (img.closest('[class*="carouselModal"], [class*="imageDetails"]')) { fitModal(img, w, h); return; }
      img.style.objectFit = 'contain';
      img.style.minWidth = '0';
      img.style.minHeight = '0';
      img.style.maxWidth = '100%';
      img.style.maxHeight = '100%';
      img.style.width = '100%';
      img.style.height = '100%';
      img.removeAttribute('width');
      img.removeAttribute('height');
      const ar = w + ' / ' + h;
      let e = img.parentElement;
      for (let i = 0; i < 6 && e; i++) {
        if (/aspect-ratio/.test(e.getAttribute('style') || '')) { e.style.aspectRatio = ar; break; }
        e = e.parentElement;
      }
    } catch (e) {}
  }

  /** 大图弹窗里的比例修正
   * Discord 按【混淆图】的尺寸给 img 写好了 width/height (如 556×828),
   * 而还原图比例略有不同 (补边+定位框) → 直接换 src 会被拉伸。
   * 做法: 只【缩小】其中一边到真实比例 —— 无失真、不超出原有空间、也不留黑边。 */
  function fitModal(img, w, h) {
    try {
      /* 用 offsetWidth/Height 而不是 getBoundingClientRect:
       * 弹窗带入场动画 (transform: scale), rect 会把缩放算进去 → 算出的
       * 像素值写回 inline 就会越写越小。offsetWidth 是布局尺寸, 不受 transform 影响。 */
      const bw = img.offsetWidth, bh = img.offsetHeight;
      if (!(bw > 1 && bh > 1)) return;
      const want = w / h, got = bw / bh;
      if (Math.abs(want - got) < 0.004) return;
      if (got > want) img.style.width = Math.round(bh * want) + 'px';
      else img.style.height = Math.round(bw / want) + 'px';
      img.style.objectFit = 'contain';
    } catch (e) {}
  }

  /* ---------- 聊天流扫描 (2026 DOM: li 列表) ----------
   * 必须包含 carouselModal: 点开大图时 Discord 把图渲染到 body 下的
   *   layer_xxx > carouselModal 里, 不在 main 内 → 不加就只能看到混淆图。 */
  const MSG_IMG_SEL = '[data-list-id="chat-messages"] img[src], main img[src], [class*="carouselModal"] img[src], [class*="imageDetails"] img[src]';
  const DEV_ANY_IMAGE = !EXT && !!window.__moeDevAnyImage; // 仅本地仿真页使用

  /* ---------- 长图/大图清晰化 ----------
   * Discord 的媒体代理会把图降到请求尺寸 (URL 里的 ?width=&height=&format=webp),
   * 越长的图降得越狠 —— 一张 1024×6000 的长条图被塑到屏幕高,
   * 细字与发丝直接洗成糊块。
   * 做法: 【只在点开大图时】把 src 换成去掉降采样参数的 CDN 原图。
   *   为何不在聊天列表里升: 列表里图本来就只显示 350px 高, 拉原图纯浪费流量。
   *   已解码的喵图本身就是原尺寸 blob, 不需要升。
   * 预加载完再换, 避免中间闪空白。 */
  function upgradeFullRes(img) {
    try {
      if (!img || img.dataset.moeFullRes) return false;
      const s = img.currentSrc || img.src || '';
      if (!s || /^(blob:|data:)/.test(s)) return false;        // 已解码的喵图
      if (!isAttachment(s)) return false;
      let hasDownscale = false;
      try {
        const u = new URL(s, location.href);
        hasDownscale = ['width', 'height', 'format', 'quality', 'size'].some((k) => u.searchParams.has(k));
      } catch (e) { return false; }
      if (!hasDownscale) return false;                          // 本来就是原图
      const full = toOriginalUrl(s);
      if (!full || full === s) return false;
      img.dataset.moeFullRes = 'loading';
      const pre = new Image();
      pre.decoding = 'async';
      pre.onload = () => {
        try {
          img.dataset.moeFullRes = '1';
          img.dataset.moeScan = 'not-moe';                     // 告知扫描器: 这张不用再预筛
          img.dataset.moeScanSrc = full;
          img.removeAttribute('srcset');
          img.src = full;
          stamp('fullres', pre.naturalWidth + 'x' + pre.naturalHeight);
        } catch (e) {}
      };
      pre.onerror = () => { img.dataset.moeFullRes = 'fail'; };
      pre.src = full;
      return true;
    } catch (e) { return false; }
  }


  /** 把解码结果落到 img 上 (扫描与即时置换共用一条路) */
  function applyDecoded(img, raw, r) {
    let url = r.url;
    if (!url) {
      url = URL.createObjectURL(r.blob);
      r.url = url;                                    // 存回去, 后续复用同一个 objectURL
    }
    img.dataset.moeOrig = raw;
    img.dataset.moeScan = 'decoded';
    img.dataset.moeScanSrc = raw;
    /* 【必须先比再写】赋值相同的 src 仍会触发 MutationObserver 记录
     * (DOM 规范: setAttribute 不做相等短路), 而观察器回调里又会回到这里
     * → 微任务无限循环, 页面直接冻住 (3.4.1 实测过)。 */
    if (img.getAttribute('src') !== url) {
      img.removeAttribute('srcset');
      img.src = url;
    }
    fitDecoded(img, r.width, r.height);
    img.dataset.moeDim = r.width + 'x' + r.height;
    img.dataset.moeMeta = r.hasMeta ? '1' : '0';
    decodedSync.set(attachKey(raw), r);
    tagAvatar(img, 'decoded', !!r.hasMeta);
  }

  /** 即时置换: 新 img 插入的同一个任务里就把 src 换掉 (不等 await)
   * 解决【点开大图先闪一下混淆图】: 大图与缩图同一个附件路径,
   *   列表里那张已经解码过 → 直接用现成的 objectURL, 零延迟。
   * 返回 true = 已处理完, 不需要再走异步解码。 */
  function swapIfKnown(img) {
    /* 【关键防循环】已接管的图直接跳。
     * 不能只靠 raw 是不是 blob 来判: 刚写完 img.src 后, currentSrc 还是旧的
     * CDN 地址 (资源选择是异步的) → 又会命中 decodedSync → 又写一次 src → 死循环。 */
    if (img.dataset.moeScan === 'decoded') return true;
    const raw = img.currentSrc || img.src || '';
    if (!raw || /^(blob:|data:)/.test(raw) || !isAttachment(raw)) return false;
    const hit = decodedSync.get(attachKey(raw));
    if (!hit || !hit.url) return false;
    applyDecoded(img, raw, hit);
    return true;
  }
  function scanImages() {
    if (!cfg.autoDecode) { stamp('scan', 'off'); return; }
    let imgs;
    try { imgs = document.querySelectorAll(MSG_IMG_SEL); } catch (e) { stamp('err', 'sel:' + e.message); return; }
    let pend = 0, skip = 0;
    for (const img of imgs) {
      const raw = img.currentSrc || img.src || '';
      // src 变了就重新审视 (Discord 会复用 img 元素: 惰加载占位图→真图、切频道复用)
      if (img.dataset.moeScan && img.dataset.moeScanSrc === raw) continue;
      if (!raw || /^(blob:|data:)/.test(raw)) continue;
      if (img.dataset.moeScan === 'decoded' && img.src.indexOf('blob:') === 0) continue;  // 已接管
      if (!isAttachment(raw) && !DEV_ANY_IMAGE) {
        img.dataset.moeScan = 'skip'; img.dataset.moeScanSrc = raw; skip++; continue;
      }
      // 这张图之前已经解过 (列表里的缩图) → 同步置换, 不给混淆图任何亮相机会
      if (swapIfKnown(img)) continue;
      const orig = DEV_ANY_IMAGE && !isAttachment(raw) ? raw : toOriginalUrl(raw);
      img.dataset.moeScan = 'pending';
      img.dataset.moeScanSrc = raw;
      pend++;
      decodeUrl(orig).then((r) => {
        try {
          stamp('last', r.status + (r.error ? ':' + String(r.error).slice(0, 40) : ''));
          if (r.status === 'decoded' && r.blob) {
            applyDecoded(img, raw, r);
          } else if (r.status === 'resized') {
            img.dataset.moeScan = 'resized';
            tagAvatar(img, 'resized', false);
          } else if (r.status === 'bad-salt') {
            img.dataset.moeScan = 'bad-salt';
            tagAvatar(img, 'bad-salt', false);
          } else if (r.status === 'fetch-fail') {
            // 瞬时失败: 清掉标记 → 下一轮重试 (不能一次失败就永不再试)
            delete img.dataset.moeScan;
            delete img.dataset.moeScanSrc;
          } else {
            img.dataset.moeScan = r.status || 'no';
            // 普通图: 在大图弹窗里就拉原图 (长图不再被降采样糊掉)
            if (img.closest('[class*="carouselModal"], [class*="imageDetails"]')) upgradeFullRes(img);
          }
        } catch (e) { stamp('err', 'apply:' + e.message); }
      }).catch((e) => {
        delete img.dataset.moeScan;
        delete img.dataset.moeScanSrc;
        stamp('err', 'dec:' + (e && e.message));
      });
    }
    stamp('scan', 'imgs=' + imgs.length + ' new=' + pend + ' skip=' + skip);
  }

  /* ---------- 输入框预览: 【先审查 → 再决定混不混】----------
   * 流程铁律 (色情与非色情走同一条路):
   *   图进输入框 → 算感知指纹 → 审查打分 → 得出结论(混/不混)
   *   → 角标显示真实结论 → 用户可点右上角按钮手动推翻
   *   → 上传时 hook 只是【执行】这个已定的结论
   * 绝不允许「先混淆 → 再审查 → 再取消」: 白跑一遍编码, 而且角标会说谎。
   * 角标在左上, 按钮在右上 (主人指定的位置)
   * 指纹 = 尺寸 + 4×4 网格亮度 (对 Discord 的 webp 重压稳定; hook 拿不到 File 名字)
   * -------------------------------------------------- */
  const decisions = [];   // [{fp, obfuscate, score, source, manual}]

  function findDecision(fp) {
    // 指纹可能多命中 (感知哈希不可能零碰撞)
    // 优先级与 review.js resolveAction 保持一致: 手动 > 自动, 同为手动取最新
    let hit = null;
    const better = (a, b) => {
      if (!b) return true;
      if (!!a.manual !== !!b.manual) return !!a.manual;
      if (a.manual) return (a.at || 0) >= (b.at || 0);
      return !!a.obfuscate && !b.obfuscate;
    };
    for (const d of decisions) {
      if (!Core.tagMatches(fp, d.fp)) continue;
      if (better(d, hit)) hit = d;
    }
    return hit;
  }
  function setDecision(fp, v) {
    // 手动操作直接改写当前图自己的条目, 不蹭别人的结论
    // 优先按内容键找 (字节级精确), 没有内容键才退回指纹严格相等
    // at 时间戳: 用户反复切开关时以最后一次为准 (否则取消后仍会发混淆图)
    const stamped = Object.assign({ at: Date.now() }, v);
    let own = null;
    for (const d of decisions) {
      if (stamped.ck && d.ck) { if (d.ck === stamped.ck) { own = d; break; } continue; }
      if (d.fp === fp) { own = d; break; }
    }
    if (own) Object.assign(own, stamped);
    else decisions.push(Object.assign({ fp: fp }, stamped));
    pushDecisions();
  }
  function pushDecisions() {
    window.postMessage({
      __moe: 1,
      decisions: decisions.map((d) => ({ fp: d.fp, ck: d.ck || '', obfuscate: !!d.obfuscate, manual: !!d.manual, at: d.at || 0 })),
    }, '*');
  }

  /** 远端打分: 隔离世界有 chrome API, 让后台代发 (主世界跨域会被 Discord CSP 拦死) */
  function remoteScoreViaBg(img) {
    if (!EXT || !cfg.reviewMode || cfg.reviewMode === 'local') return Promise.resolve(null);
    return new Promise((res) => {
      try {
        const small = FMT.resizeImageData(img, 512);
        chrome.runtime.sendMessage({ action: 'nsfw-check', dataUrl: FMT.imageDataToDataURL(small) }, (r) => {
          res(r && typeof r.score === 'number' ? r.score : null);
        });
      } catch (e) { res(null); }
    });
  }

  /** 审查一张图 → {obfuscate, score, source}; 审查层缺失/异常 → 保守混淆 */
  async function reviewImage(img) {
    const Review = window.__MoeGuardReview;
    if (!Review) return { obfuscate: true, score: 1, source: 'no-review' };
    try {
      return await Review.decide(img, cfg, remoteScoreViaBg);
    } catch (e) {
      stamp('err', 'review:' + e.message);
      return { obfuscate: true, score: 1, source: 'fallback' };
    }
  }

  /* ---------- 预览图开关: 在上传卡另起一个同款胶囊 ----------
   * 主人要的样子: 两个白色胶囊分到卡的两头 ——
   *   【左上角是我们的】(审查分数 + ✕/○ 开关), 右上角是 Discord 原生的(剧透/修改/移除)
   *
   * 定位思路: 不往原生行里塞 (那个行带 translate(25%,-25%), 行一变宽偏移量就跑飞),
   *   而是作为原生定位层的兄弟直接挂在卡的左上角, 用镜像偏移 (-25%,-25%),
   *   与右上角原生胶囊完全对称 → 两边永远顶到卡边, 不用算任何间距。
   * 样式抄原生胶囊与按钮的 className → 背景/圆角/阴影/hover 全部自动一致。
   * -------------------------------------------------- */
  function nativePill(img) {
    const card = img.closest('li[class*="upload"], [class*="uploadContainer"]');
    if (!card) return null;
    const btn = card.querySelector('[class*="actionBar"] [role="button"]');
    if (!btn) return null;
    const pill = btn.parentElement;                       // wrapper = 白色胶囊
    const bar = pill.parentElement;                       // actionBar
    const box = (bar && bar.parentElement) || bar;        // actionBarContainer = 定位锚
    const host = (box && box.parentElement) || card;      // uploadContainer
    return { pill, btnCls: btn.className, host };
  }
  /** 我们自己的胶囊 (不存在则创建, 挂卡的左上角) */
  function moePill(img) {
    const nat = nativePill(img);
    if (!nat) return null;
    const host = nat.host;
    let mine = host.querySelector(':scope > .moe-pill');
    if (!mine) {
      mine = document.createElement('div');
      mine.className = nat.pill.className + ' moe-pill';  // 抄原生胶囊样式
      mine.style.cssText = 'position:absolute;top:0;inset-inline-start:0;' +
        'transform:translate(-25%,-25%);z-index:5;';
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
      host.appendChild(mine);
    }
    mine.dataset.btnCls = nat.btnCls;
    return mine;
  }

  /** 找本图自己的结论: 内容键优先 (字节级精确), 否则回落指纹容差匹配 */
  function findDecisionFor(img, fp) {
    const ck = img && img.dataset ? img.dataset.moeCk : '';
    if (ck) {
      for (const d of decisions) if (d.ck === ck) return d;
    }
    return findDecision(fp);
  }

  function renderDecision(img, fp) {
    const pill = moePill(img);
    const btn = pill && pill.querySelector(':scope > .moe-toggle');
    const chip = pill && pill.querySelector(':scope > .moe-chip');
    const d = findDecisionFor(img, fp);
    const on = d ? !!d.obfuscate : true;
    if (btn) {
      btn.textContent = on ? '✕' : '○';
      btn.setAttribute('aria-label', on ? '已开启混淆 (点击改为原图发送)' : '原图发送 (点击改为混淆)');
      btn.title = btn.getAttribute('aria-label');
    }
    if (chip) {
      /* 降级模式: 拿不到预览字节 (无法审查) ——
       * 不能显示“审查中”卡在那里骗人, 直说默认行为。 */
      chip.textContent = img.dataset.moeDegraded && !d ? (on ? '默认·混' : '默认·原')
        : !d ? '审查中'
        : d.manual ? (on ? '手动·混' : '手动·原')
        : d.source === 'always' ? '混淆'
        : String(d.score) + (on ? '·混' : '·原');
    }
  }

  function makeToggle(img, fp) {
    const pill = moePill(img);
    if (!pill) return;
    if (pill.querySelector(':scope > .moe-toggle')) { renderDecision(img, fp); return; }
    const cls = pill.dataset.btnCls || '';

    const chip = document.createElement('div');
    chip.className = 'moe-chip';
    chip.style.cssText = 'display:flex;align-items:center;height:24px;padding:0 6px;' +
      'font:600 10px/24px ' + FONT + ';color:var(--text-muted,#949ba4);white-space:nowrap;pointer-events:none;';

    const btn = document.createElement('div');
    btn.className = (cls ? cls + ' ' : '') + 'moe-toggle';
    btn.setAttribute('role', 'button');
    btn.setAttribute('tabindex', '0');
    btn.style.fontSize = '13px';
    btn.style.fontWeight = '700';
    btn.style.lineHeight = '1';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const d = findDecisionFor(img, fp);
      const next = !(d && d.obfuscate);
      setDecision(fp, { ck: img.dataset.moeCk || '', obfuscate: next, manual: true });
      renderDecision(img, fp);
      toast(next ? '已改为混淆这张图' : '已取消这张图的混淆 (原图发送)');
    }, true);

    pill.append(chip, btn);
    renderDecision(img, fp);
  }

  /* ══════════════════════════════════════════════════════════════
   * 取预览图字节 —— 三条路依次试
   * ══════════════════════════════════════════════════════════════
   * 【Firefox 丢 UI 的真因】
   *   Discord 的预览卡用 <img src="blob:https://discord.com/…">,
   *   这个 blob 是【页面】创建的, 归属页面的 principal。
   *   Chrome 里隔离世界能直接 fetch 它; Firefox 不行 ——
   *   内容脚本与页面是不同 principal, 读页面的 blob URL 直接失败,
   *   preparePreview 抛异常 → 整个 UI(分数角标 + ✕/○ 开关)全都不出现。
   *   (同族问题见 Mozilla bug 1696174: downloads.download 也读不了页面 blob)
   *
   * 三条路:
   *   1. 直接 fetch —— Chromium 走这条, 最快
   *   2. canvas 重绘 —— 图已经渲染在页面里了, 直接从 <img> 画到 canvas 取像素。
   *      不受 principal 限制, 因为根本不发请求。blob: 与页面同源, canvas 不会被污染。
   *   3. 主世界代取 —— 让 hook.js(MAIN world, 与页面同 principal)fetch 后
   *      把 base64 传回来。留作兜底。
   *
   * ⚠️ 路 2 拿到的是 canvas 重编码的 PNG, 字节与原 File 不同 →
   *   内容键(ck)会对不上上传的 PUT。所以走了路 2 就【不算 ck】,
   *   只用感知指纹匹配。指纹是从像素算的, canvas 重绘不改像素, 照样准。
   */
  function canvasBlobFromImg(img) {
    return new Promise((res) => {
      try {
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        if (!w || !h) { res(null); return; }
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0);
        c.toBlob((b) => res(b || null), 'image/png');
      } catch (e) { res(null); }
    });
  }

  /* 让主世界替我们 fetch 页面自己的 blob: URL */
  let mainGrabSeq = 0;
  const mainGrabWaiters = new Map();
  function mainWorldGrab(url) {
    return new Promise((res) => {
      const seq = ++mainGrabSeq;
      const timer = setTimeout(() => { mainGrabWaiters.delete(seq); res(null); }, 4000);
      mainGrabWaiters.set(seq, { res, timer });
      try { window.postMessage({ __moe: 1, grabReq: seq, url }, '*'); }
      catch (e) { clearTimeout(timer); mainGrabWaiters.delete(seq); res(null); }
    });
  }

  async function grabPreviewBlob(img) {
    const url = img.currentSrc || img.src || '';
    // 路 1: 直接 fetch (Chromium)
    try {
      const r = await fetch(url);
      if (r.ok) {
        const b = await r.blob();
        if (b && b.size) { img.dataset.moeGrab = 'fetch'; return b; }
      }
    } catch (e) {}
    // 路 2: canvas 重绘 (Firefox 主力路径)
    const cb = await canvasBlobFromImg(img);
    if (cb && cb.size) { img.dataset.moeGrab = 'canvas'; return cb; }
    // 路 3: 主世界代取
    const mb = await mainWorldGrab(url);
    if (mb && mb.size) { img.dataset.moeGrab = 'main'; return mb; }
    return null;
  }

  /** 预览图就位 → 指纹 + 内容键 → 审查 → 存结论 → 渲染 */
  async function preparePreview(img) {
    try {
      const blob = await grabPreviewBlob(img);
      if (!blob) throw new Error('no-blob');
      /* 【多图同时上传的关键】除了感知指纹, 再算一个字节级内容键。
       * 预览 blob 与上传 PUT 同源于同一个 File → 字节完全一致,
       * 所以内容键能【精确】把“这个开关”绑到“那笔上传”上,
       * 不会像感知指纹那样在多张相似图之间串位。 */
      /* ⚠️ 只有走“直接 fetch / 主世界代取”拿到原字节时才算 ck。
       *   canvas 重绘路径得到的是重编码的 PNG, 字节与原 File 不同 →
       *   算出来的 ck 是假的, 会让 hook 端永远对不上。
       *   宁可不算, 回落感知指纹 (指纹从像素算, canvas 重绘不改像素)。 */
      let ck = '';
      if (img.dataset.moeGrab !== 'canvas') {
        try { ck = Core.contentKey(new Uint8Array(await blob.arrayBuffer())); } catch (e) {}
      }
      const im = await FMT.blobToImageData(blob);
      const fp = Core.perceptualTag(im);
      img.dataset.moeFp = fp;
      if (ck) img.dataset.moeCk = ck;
      // 只有【本图自己】还没结论时才审查 (按内容键/指纹严格相等判定,
      // 不要因为容差匹配到另一张相近的图就跳过审查)
      let own = null;
      for (const d of decisions) {
        if (ck && d.ck ? d.ck === ck : d.fp === fp) { own = d; break; }
      }
      if (!own) {
        const v = await reviewImage(im);
        setDecision(fp, { ck, obfuscate: v.obfuscate, score: v.score, source: v.source, manual: false });
        stamp('review', v.source + ' ' + v.score + ' → ' + (v.obfuscate ? '混淆' : '原图'));
        tele({ ev: 'review', score: v.score, source: v.source, obfuscate: v.obfuscate });
      }
      makeToggle(img, fp);
    } catch (e) {
      stamp('err', 'prep:' + e.message);
      /* 【不能静默死】拿不到预览字节时, 仍然把 UI 挂上去。
       * 否则用户看到的就是“插件没反应”(Firefox 上就这么丢过 UI)。
       * 没指纹也能翻开关 —— 默认混淆, 点一下就能改成原图发。 */
      try {
        img.dataset.moeDegraded = '1';
        makeToggle(img, img.dataset.moeFp || ('?:' + (img.naturalWidth || 0) + 'x' + (img.naturalHeight || 0)));
      } catch (e2) {}
    }
  }

  function badgeComposerPreviews() {
    if (!cfg.enabled) return;
    try {
      const scopes = document.querySelectorAll('[class*="channelTextArea"], form [class*="uploadArea"], [class*="attachedFiles"]');
      for (const sc of scopes) {
        for (const img of sc.querySelectorAll('img[src^="blob:"], img[src^="data:image"]')) {
          if (img.dataset.moeFp) { makeToggle(img, img.dataset.moeFp); continue; }
          if (img.dataset.moeFpPending) continue;
          img.dataset.moeFpPending = '1';
          preparePreview(img);
        }
      }
    } catch (e) { stamp('err', 'composer:' + e.message); }
  }

  /* ---------- 右键解码弹窗 ---------- */
  let modal = null;
  function closeModal() { if (modal) { modal.remove(); modal = null; } }
  function makeBtn(text, primary) {
    const b = document.createElement('button');
    b.textContent = text;
    b.style.cssText = 'border:none;border-radius:var(--radius-sm,8px);padding:8px 16px;cursor:pointer;' +
      'font:600 14px/16px ' + FONT + ';' +
      (primary
        ? 'background:var(--brand-500,#5865f2);color:#fff;'
        : 'background:var(--interactive-background-hover,rgba(154,158,168,.16));color:var(--text-default,#2e3338);');
    return b;
  }
  function openModal(title, bodyEl, actions) {
    closeModal();
    modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;';
    const box = document.createElement('div');
    box.style.cssText = 'background:var(--background-surface-highest,#fff);color:var(--text-default,#2e3338);' +
      'border-radius:var(--radius-md,12px);max-width:min(88vw,780px);max-height:88vh;padding:16px;' +
      'display:flex;flex-direction:column;gap:12px;box-shadow:var(--shadow-border),var(--shadow-medium);' +
      'font-family:' + FONT + ';';
    const h = document.createElement('div');
    h.style.cssText = 'font:600 16px/20px ' + FONT + ';color:var(--text-default,#2e3338);display:flex;justify-content:space-between;align-items:center;gap:12px;';
    h.textContent = title;
    const x = document.createElement('div');
    x.setAttribute('role', 'button');
    x.setAttribute('tabindex', '0');
    x.setAttribute('aria-label', '关闭');
    x.textContent = '✕';
    x.style.cssText = 'cursor:pointer;color:var(--text-muted,#949ba4);font-size:15px;padding:4px;line-height:1;';
    x.onclick = closeModal;
    h.appendChild(x);
    const body = document.createElement('div');
    body.style.cssText = 'overflow:auto;display:flex;align-items:center;justify-content:center;max-height:70vh;';
    body.appendChild(bodyEl);
    const foot = document.createElement('div');
    foot.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;';
    (actions || []).forEach((a) => foot.appendChild(a));
    box.append(h, body, foot);
    modal.appendChild(box);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
    document.body.appendChild(modal);
  }

  async function decodeUrlModal(rawUrl) {
    const orig = toOriginalUrl(rawUrl);
    toast('正在解码…', 4000);
    // 手动解码跳过预筛 (用户明确要求就不省流量)
    const r = await decodeUrl(orig, true).catch(() => ({ status: 'error' }));
    if (r.status !== 'decoded') {
      const el = document.createElement('div');
      el.style.cssText = 'color:var(--text-default,#2e3338);font:400 14px/1.6 ' + FONT + ';text-align:center;padding:20px;max-width:380px;';
      el.textContent = r.status === 'resized'
        ? '这是喵图，但当前拿到的是被平台重编码的压缩版，无法无损还原。请先「打开原图」再解码。'
        : r.status === 'fetch-fail'
          ? '图片抓取失败: ' + (r.error || '') 
          : '这张图检测不到喵图标记（不是喵图，或盐值不一致）。';
      const b = makeBtn('关闭'); b.onclick = closeModal;
      openModal('解码结果', el, [b]);
      return;
    }
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;align-items:center;';
    const im = document.createElement('img');
    im.src = URL.createObjectURL(r.blob);
    im.style.cssText = 'max-width:100%;max-height:66vh;border-radius:var(--radius-sm,8px);';
    const info = document.createElement('div');
    info.style.cssText = 'font:400 12px/16px ' + FONT + ';color:var(--text-muted,#949ba4);';
    info.textContent = `已无损解码 ${r.width} × ${r.height} · ${(r.blob.size / 1024).toFixed(0)} KB` + (r.hasMeta ? ' · 含工作流元数据' : '');
    wrap.append(im, info);
    const dl = makeBtn('下载原图', true);
    const dataUrl = await blobToDataUrl(r.blob);
    dl.onclick = () => {
      if (EXT) { try { chrome.runtime.sendMessage({ action: 'download', url: dataUrl, filename: 'moeguard-decoded.png' }); return; } catch (e) {} }
      const a = document.createElement('a'); a.href = dataUrl; a.download = 'moeguard-decoded.png'; a.click();
    };
    const c = makeBtn('关闭'); c.onclick = closeModal;
    openModal('解码结果', wrap, [dl, c]);
  }

  /* ---------- 主世界事件 ---------- */
  window.addEventListener('message', (e) => {
    try {
      if (!e.data || e.data.__moe !== 1) return;
      // 审查代发: 主世界发不了跳域请求(CSP), 由后台代发
      if (typeof e.data.reviewReq === 'number' && e.data.dataUrl) {
        const seq = e.data.reviewReq;
        if (!EXT) { window.postMessage({ __moe: 1, reviewRes: seq, score: null }, '*'); return; }
        try {
          chrome.runtime.sendMessage({ action: 'nsfw-check', dataUrl: e.data.dataUrl }, (r) => {
            const score = r && typeof r.score === 'number' ? r.score : null;
            stamp('review', 'score=' + score + ' err=' + ((r && r.error) || '-'));
            window.postMessage({ __moe: 1, reviewRes: seq, score }, '*');
          });
        } catch (err) {
          window.postMessage({ __moe: 1, reviewRes: seq, score: null }, '*');
        }
        return;
      }
      /* 主世界代取预览 blob 的回包 (Firefox 兵库路 3) */
      if (typeof e.data.grabRes === 'number') {
        const w = mainGrabWaiters.get(e.data.grabRes);
        if (w) {
          clearTimeout(w.timer);
          mainGrabWaiters.delete(e.data.grabRes);
          let blob = null;
          try {
            if (e.data.base64) {
              const bin = atob(e.data.base64);
              const u8 = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
              blob = new Blob([u8], { type: e.data.mime || 'image/png' });
            }
          } catch (err) {}
          w.res(blob);
        }
        return;
      }
      if (!e.data.ev) return;
      const d = e.data;
      tele(d);
      if (d.ev === 'tracked') setTimeout(badgeComposerPreviews, 500);
      if (d.ev === 'encoded') badgeComposerPreviews();
      if (d.ev === 'upload-replaced') toast('已混淆上传 · ' + (d.info || ''), 2600);
      if (d.ev === 'skipped') toast((d.msg || '跳过'), 2200);
      if (d.ev === 'review') toast('审查 ' + (d.source || '') + ' 得分 ' + d.score + ' → ' + (d.obfuscate ? '混淆' : '不混淆'), 2400);
      if (d.ev === 'error') toast(d.msg, 4000);
    } catch (err) {}
  });

  /* ---------- 扩展消息 ---------- */
  if (EXT) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg) return;
      if (msg.action === 'decode-url') { decodeUrlModal(msg.url); sendResponse({ ok: true }); return true; }
      if (msg.action === 'scan-all') {
        // 强制重扫: 清标记 + 清缓存
        cache.clear();
        prefilterCache.clear();
        document.querySelectorAll('img[data-moe-scan]').forEach((i) => { delete i.dataset.moeScan; delete i.dataset.moeScanSrc; });
        scanImages();
        sendResponse({ ok: true });
        return true;
      }
      if (msg.action === 'cfg-updated') { syncCfg().then(() => sendResponse({ ok: true })); return true; }
      if (msg.action === 'moe-diag') {
        const out = { ver: DIAG_VER, scanStates: {}, tags: document.querySelectorAll('.moe-msg-tag').length };
        document.querySelectorAll('img[data-moe-scan]').forEach((i) => {
          const s = i.dataset.moeScan;
          out.scanStates[s] = (out.scanStates[s] || 0) + 1;
        });
        if (diagEl) for (const a of diagEl.getAttributeNames()) {
          if (a.indexOf('data-') === 0) out[a.slice(5)] = diagEl.getAttribute(a);
        }
        // 快速 PNG 编码失败原因 (以前被静默吞掉 → Firefox 上查不到首发异常)
        try { if (FMT.lastFastPngErr) out.fastpng = FMT.lastFastPngErr; } catch (e) {}
        sendResponse(out);
        return true;
      }
    });
  } else {
    window.__MoeUI = { scan: scanImages, badgeComposerPreviews, decodeUrlModal, decodeUrl, toOriginalUrl, isAttachment, reviewImage, tagAvatar, retagAll, downloadModal, enhanceLightbox, removeReportEls, unlockEmoji, get decisions() { return decisions.slice(); }, get cfg() { return cfg; } };
  }

  /* ---------- 移除举报入口 (主人要求: 整个 Discord 界面去掉举报) ---------- */
  const REPORT_KEYWORDS = ['report', '举报', '報告', '申告'];
  function looksReportish(el) {
    if (!el || el.tagName !== 'BUTTON' && el.tagName !== 'LI' && el.tagName !== 'DIV' && el.tagName !== 'A' && el.tagName !== 'SPAN') return false;
    const a = (el.getAttribute && (el.getAttribute('aria-label') || '')) || '';
    const t = (el.textContent || '').trim();
    const low = a.toLowerCase() + ' ' + t;
    if (!/report|举报|報告|申告/i.test(low)) return false;
    // 只在交互容器内动手: 菜单 / 弹层 / 工具条
    const inMenu = !!el.closest('[role="menu"], [class*="menu"], [class*="popout"], [class*="toolbar"], [class*="actionBar"], [class*="profile"]');
    return inMenu;
  }
  function removeReportEls() {
    if (!document.body) return 0;
    const all = document.querySelectorAll('button[aria-label], [role="menuitem"], [role="button"][aria-label]');
    let n = 0;
    for (const el of all) {
      if (looksReportish(el) && el.parentNode) {
        // 菜单项直接删; 工具条按钮隐藏 (保留布局完整性)
        const inMenu = !!el.closest('[role="menu"], [class*="menu"], [class*="popout"]');
        if (inMenu) { try { el.remove(); } catch (e) {} }
        else {
          try { el.style.display = 'none'; } catch (e) {}
          const wrap = el.closest('[class*="action"], [class*="toolbar"]');
          if (wrap && wrap.children.length <= 2) { try { wrap.style.display = 'none'; } catch (e) {} }
        }
        n++;
      }
    }
    // 用户弹窗里最常见的 Report: 红色/危险按钮文本略; 补充针对 aria-label
    return n;
  }
  function watchReports() {
    try { removeReportEls(); } catch (e) {}
    const mo = new MutationObserver(() => { try { removeReportEls(); } catch (e) {} });
    mo.observe(document.documentElement || document.body, { childList: true, subtree: true });
    setInterval(() => { try { removeReportEls(); } catch (e) {} }, 1500);
  }

  /* ---------- 图片左下方标签: 自己的「已混淆」/ 别人的「已解析」+ 下载原图 ---------- */
  let myUserId = '';
  /** 自己的 user ID: 从左下角账号面板的头像 URL 直接读
   *  比走 /api/v9/users/@me 靠谱得多: 无请求、无权限、不依赖 token
   *  (实测过 fetch @me 在页面与后台都返 401 —— Discord 把 token 存在内存里不走 cookie) */
  function detectMyId() {
    if (myUserId) return myUserId;
    try {
      const panel = document.querySelector('section[class*="panels"], [class*="panels_"], [class*="panels-"]');
      const av = panel && panel.querySelector('img[src*="/avatars/"]');
      const m = av && av.src.match(/\/avatars\/(\d+)\//);
      if (m) { myUserId = m[1]; stamp('me', myUserId); }
    } catch (e) {}
    return myUserId;
  }
  function fetchMyId() { detectMyId(); }
  /** 从消息 li 里找作者头像 img (avatar URL 含 /avatars/<userId>/) */
  function authorOf(li) {
    if (!li) return null;
    const av = li.querySelector('img[src*="/avatars/"]');
    return av || null;
  }
  function CLIPS(cs) { return /hidden|clip|auto|scroll/.test(cs.overflow + ' ' + cs.overflowX + ' ' + cs.overflowY); }

  /** 消息级徽标: 挂在消息左侧的头像槽 (72px gutter), 但【不绑头像元素】
   * 为何不绑头像: Discord 把同一人连发的多条消息合并成一组,
   *   后续消息根本没有头像元素 → 绑头像的话第二条以后就没有徽标 (主人踩过)。
   * 改成锚在 message__ 容器上 (它本来就是 position:relative),
   *   用 left:16px 落进 gutter; 有头像就排头像下方, 合并组没头像就贴顶部。
   * 一条消息一个徽标 (带图片张数), 不管发几张图、连发几条都不会丢。 */
  function msgAnchor(img) {
    /* 【必须用 closest 而不是 li.querySelector】
     * 原先先拿 li 再向下找第一个 message__ —— 一旦 Discord 在同一个 li 里
     * 放了多个 message 层 (回复引用/转发/系统提示), 第二条的图会被算到第一条头上
     * → 徒标与下载按钮堆到第一条, 第二条看起来“没了”、且下载拿到第一条的图。
     * 用 closest 从图本身往上找, 结果永远是【这张图所属的那条消息】。 */
    return img.closest('[class*="message__"]') || img.closest('li[id^="chat-messages"], li');
  }

  /** 一条消息里【可下载的图】: 已解码的 + 普通附件图
   * 为何不只列已解码的: 一次发 8 张只混淆 1 张时, 只列已解码就只有 1 张
   *   → 看着就是“多选没了”。主人要的是整条消息的图都能选。
   * 尺寸门槛 80px: 排掉头像/表情/徽章图标。 */
  function shotsIn(anchor) {
    if (!anchor) return [];
    return [...anchor.querySelectorAll('img')].filter((i) => {
      if (i.dataset.moeScan === 'decoded') return true;
      const s = i.currentSrc || i.src || '';
      if (!s || /^(blob:|data:)/.test(s)) return false;
      if (!isAttachment(s)) return false;
      return i.getBoundingClientRect().width >= 80;
    });
  }
  const GUTTER_BASE = 'position:absolute;left:16px;z-index:5;box-sizing:border-box;' +
    'font:600 10px/16px var(--font-primary),"Segoe UI","Microsoft YaHei",sans-serif;' +
    'padding:0 5px;border-radius:var(--radius-xs,4px);white-space:nowrap;max-width:64px;overflow:hidden;' +
    'background:var(--background-surface-highest,#fff);color:var(--text-muted,#949ba4);' +
    'box-shadow:var(--shadow-border),var(--shadow-low);';

  function tagAvatar(img, kind, hasMeta) {
    if (!cfg.badge) return;
    try {
      const anchor = msgAnchor(img);
      if (!anchor) return;
      anchor.dataset.moeTagged = '1';
      if (getComputedStyle(anchor).position === 'static') anchor.style.position = 'relative';

      // 本条消息里所有被我们处理过的图 (徒标文案只看这些)
      const shots = [...anchor.querySelectorAll('img[data-moe-scan]')]
        .filter((i) => /^(decoded|resized|bad-salt)$/.test(i.dataset.moeScan || ''));
      if (!shots.length) return;
      const decoded = shots.filter((i) => i.dataset.moeScan === 'decoded');
      const pickable = shotsIn(anchor);            // 下载弹窗能选的 (含未混淆的附件)

      const li = img.closest('li[id^="chat-messages"], li');
      const av = anchor.querySelector('img[src*="/avatars/"]');
      let mine = null;
      if (detectMyId()) {
        if (av) {
          const m = av.src.match(/\/avatars\/(\d+)\//);
          mine = !!(m && m[1] === myUserId);
        } else if (li) {
          // 合并组的后续消息没头像 → 往上找同组首条消息的作者
          let prev = li.previousElementSibling;
          for (let k = 0; k < 30 && prev; k++) {
            const a = prev.querySelector && prev.querySelector('img[src*="/avatars/"]');
            if (a) { const m = a.src.match(/\/avatars\/(\d+)\//); mine = !!(m && m[1] === myUserId); break; }
            prev = prev.previousElementSibling;
          }
        }
      }

      const base = decoded.length ? (mine === true ? '已混淆' : '已解析')
        : (shots[0].dataset.moeScan === 'resized' ? '需原图' : '喵图');
      const label = shots.length > 1 ? base + ' ' + shots.length : base;
      const anyMeta = decoded.some((i) => i.dataset.moeMeta === '1');

      let tag = anchor.querySelector(':scope > .moe-msg-tag');
      if (!tag) {
        tag = document.createElement('div');
        tag.className = 'moe-msg-tag';
        tag.style.cssText = GUTTER_BASE + 'pointer-events:none;';
        anchor.appendChild(tag);
      }
      if (tag.textContent !== label) tag.textContent = label;
      tag.title = (mine === true ? '这条消息的图已混淆上传' : '已自动解码为原图')
        + ' · ' + shots.length + ' 张' + (anyMeta ? ' · 含工作流元数据' : '');

      let dl = anchor.querySelector(':scope > .moe-msg-dl');
      if (decoded.length) {
        if (!dl) {
          dl = document.createElement('div');
          dl.className = 'moe-msg-dl';
          dl.setAttribute('role', 'button');
          dl.setAttribute('tabindex', '0');
          dl.style.cssText = GUTTER_BASE + 'cursor:pointer;';
          dl.addEventListener('mouseenter', () => { dl.style.color = 'var(--text-default,#2e3338)'; });
          dl.addEventListener('mouseleave', () => { dl.style.color = 'var(--text-muted,#949ba4)'; });
          dl.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            /* 【必须当场取锚】不能用创建时闭包里的 anchor:
             * 徒标只建一次, 后续 retagAll 不重绑事件 → 一旦 Discord 重用这个
             * 消息节点渲染其他内容, 旧闭包就会拿到别条消息的图
             * (主人遇到的“第二个点开看见的是第一个图”)。 */
            const host = e.currentTarget && e.currentTarget.parentElement;
            downloadModal(host || anchor);
          }, true);
          anchor.appendChild(dl);
        }
        const dlLabel = pickable.length > 1 ? '下载 ' + pickable.length : '下载';
        if (dl.textContent !== dlLabel) dl.textContent = dlLabel;
        dl.setAttribute('aria-label', pickable.length > 1 ? '下载原图 (可多选)' : '下载原图');
        dl.title = dl.getAttribute('aria-label');
      } else if (dl) { dl.remove(); dl = null; }

      // 位置: 头像下方 (没头像就贴顶)
      const top = av ? (av.offsetTop + av.offsetHeight + 4) : 2;
      tag.style.top = Math.round(top) + 'px';
      if (dl) dl.style.top = Math.round(top + 20) + 'px';
    } catch (e) { stamp('err', 'tag:' + e.message); }
  }

  /** 多选下载弹窗: 一条消息里的每张图各一个勾选框 */
  async function downloadModal(anchor) {
    /* 取【这条消息】的全部附件图 (已解码 + 未混淆的普通图)。
     * 主人反馈的“第二次多选没了”就是因为旧版只列 decoded 的:
     *   一次发 8 张只混淆 1 张 → 清单里只有 1 张, 看着就像没了多选。 */
    const imgs = shotsIn(anchor);
    if (!imgs.length) { toast('这条消息里没找到图片', 2000); return; }

    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px;justify-content:center;max-width:640px;';
    const boxes = [];
    imgs.forEach((im, k) => {
      const isMoe = im.dataset.moeScan === 'decoded' && !!im.dataset.moeOrig;
      const cell = document.createElement('label');
      cell.style.cssText = 'display:flex;flex-direction:column;gap:6px;align-items:center;cursor:pointer;' +
        'padding:8px;border-radius:var(--radius-sm,8px);background:var(--background-surface-higher,rgba(0,0,0,.03));';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.style.cssText = 'width:16px;height:16px;accent-color:var(--brand-500,#5865f2);cursor:pointer;';
      const th = document.createElement('img');
      th.src = im.currentSrc || im.src;                  // 已解码的就是 blob, 普通图就是 CDN 缩图
      th.style.cssText = 'width:120px;height:120px;object-fit:cover;border-radius:var(--radius-xs,4px);' +
        'box-shadow:var(--shadow-border);';
      const cap = document.createElement('div');
      cap.style.cssText = 'font:400 11px/14px ' + FONT + ';color:var(--text-muted,#949ba4);';
      cap.textContent = isMoe
        ? (im.dataset.moeDim || '') + (im.dataset.moeMeta === '1' ? ' · 工作流' : '')
        : '原图';
      cell.append(cb, th, cap);
      wrap.appendChild(cell);
      boxes.push({ cb, img: im, idx: k, isMoe });
    });

    const all = makeBtn('全选/全不选');
    all.onclick = () => {
      const to = !boxes.every((b) => b.cb.checked);
      boxes.forEach((b) => { b.cb.checked = to; });
    };
    const go = makeBtn('下载所选', true);
    go.onclick = async () => {
      const picked = boxes.filter((b) => b.cb.checked);
      if (!picked.length) { toast('没有勾选任何图片', 1800); return; }
      go.disabled = true;
      const total = picked.length;
      let n = 0;
      for (const b of picked) {
        go.textContent = '下载中 ' + (n + 1) + '/' + total;
        try {
          const srcUrl = b.isMoe ? b.img.dataset.moeOrig : (b.img.currentSrc || b.img.src);
          const orig = toOriginalUrl(srcUrl);
          let dataUrl = null;
          if (b.isMoe) {
            const r = await decodeUrl(orig, true);
            if (r.status === 'decoded' && r.blob) dataUrl = await blobToDataUrl(r.blob);
          }
          if (!dataUrl) {
            // 未混淆的图 (或解码失败): 直接拿 CDN 原尺寸字节
            const fr = await fetchImg(orig);
            if (fr && fr.ok && fr.base64) dataUrl = 'data:' + (fr.mime || 'image/png') + ';base64,' + fr.base64;
          }
          if (!dataUrl) continue;
          const name = fileNameOf(srcUrl, b.idx);
          if (EXT) chrome.runtime.sendMessage({ action: 'download', url: dataUrl, filename: name });
          else { const a = document.createElement('a'); a.href = dataUrl; a.download = name; a.click(); }
          n++;
          await new Promise((res) => setTimeout(res, 220));   // 连发太快浏览器会丢
        } catch (e) {}
      }
      toast('已下载 ' + n + ' / ' + total + ' 张', 2600);
      closeModal();
    };
    const c = makeBtn('关闭'); c.onclick = closeModal;
    openModal('下载原图 · 共 ' + imgs.length + ' 张', wrap, [all, go, c]);
  }

  function fileNameOf(url, idx) {
    try {
      const p = new URL(url, location.href).pathname.split('/').pop() || '';
      const stem = p.replace(/\.(png|jpe?g|webp|gif)$/i, '') || ('moeguard-' + (idx + 1));
      return stem.slice(0, 80) + '.png';
    } catch (e) { return 'moeguard-' + (idx + 1) + '.png'; }
  }

  /** 每轮重新贴徽标 (Discord 重渲染会把注入的 DOM 刷掉) */
  function retagAll() {
    try {
      const seen = new Set();
      for (const img of document.querySelectorAll('img[data-moe-scan="decoded"]')) {
        // Discord 重渲染会把 inline aspect-ratio 刷回混淆图的比例 → 每轮重新校准
        const dim = (img.dataset.moeDim || '').split('x');
        if (dim.length === 2) fitDecoded(img, +dim[0], +dim[1]);
        if (img.closest('[class*="carouselModal"], [class*="imageDetails"]')) continue;  // 大图弹窗不贴徒标
        const a = msgAnchor(img);
        if (a && !seen.has(a)) { seen.add(a); tagAvatar(img, 'decoded', img.dataset.moeMeta === '1'); }
      }
      for (const s of ['resized', 'bad-salt']) {
        for (const img of document.querySelectorAll('img[data-moe-scan="' + s + '"]')) {
          if (img.closest('[class*="carouselModal"], [class*="imageDetails"]')) continue;
          const a = msgAnchor(img);
          if (a && !seen.has(a)) { seen.add(a); tagAvatar(img, s, false); }
        }
      }
      // 图/消息被删 → 徽标跟着没
      document.querySelectorAll('[data-moe-tagged="1"]').forEach((a) => {
        if (!a.querySelector('img[data-moe-scan="decoded"], img[data-moe-scan="resized"], img[data-moe-scan="bad-salt"]')) {
          a.querySelectorAll(':scope > .moe-msg-tag, :scope > .moe-msg-dl').forEach((e) => e.remove());
          delete a.dataset.moeTagged;
        }
      });
      enhanceLightbox();
    } catch (e) {}
  }

  /* ---------- 点开大图 (Discord carousel) 的增强 ----------
   * 两个问题:
   *   1. 大图走的是 layer_xxx > carouselModal, 不在 main 里 → 原来的扫描选择器抓不到
   *      → 点开看到的还是混淆图。已把 modal 加进 MSG_IMG_SEL。
   *   2. Discord 自带滚轮缩放上限很小。这里接管滚轮做 1x–8x 缩放 + 拖拽平移,
   *      并把祖先的 overflow:hidden 放开, 否则放大后被裁。
   * -------------------------------------------------- */
  function enhanceLightbox() {
    const modal = document.querySelector('[class*="carouselModal"]');
    if (!modal) return;
    /* 【挑真正的大图】modal.querySelector('img') 会拿到弹窗里的头像 (40×40)
     * 或徽章图标 (14×14) —— 实测就把缩放装到了头像上。
     * 不能用“宽度≥200”筛: 一张 1024×6000 的长条图按高度缩进弹窗后宽只剩 132px,
     *   直接被排掉 → 长图的滚轮缩放根本没装上 (主人反馈的问题)。
     * 改成按【位置】判: 真正的媒体在 mediaArea 里, 头像/徽章都不在;
     *   再配一个小面积下限排掉图标。 */
    let img = null, best = 0;
    for (const i of modal.querySelectorAll('img')) {
      const w = i.offsetWidth, h = i.offsetHeight;   // 布局尺寸, 不受入场动画的 transform 影响
      if (w < 60 && h < 60) continue;                // 图标级小图
      if (i.closest('[class*="avatar"], [class*="badge"]')) continue;
      const inMedia = !!i.closest('[class*="mediaArea"], [class*="imageWrapper"]');
      const score = (inMedia ? 1e9 : 0) + w * h;     // 媒体区的优先
      if (score > best) { best = score; img = i; }
    }
    if (!img || img.dataset.moeZoom === '1') return;
    img.dataset.moeZoom = '1';
    // 已解码的大图: 把 Discord 按混淆图尺寸写的框校回真实比例
    const dim = (img.dataset.moeDim || '').split('x');
    if (dim.length === 2) fitModal(img, +dim[0], +dim[1]);
    // 普通图 (非喵图): 拉 CDN 原图替掉降采样版 → 长图不再糊
    upgradeFullRes(img);

    // 放开裁剪, 否则放大部分被切掉
    let e = img.parentElement;
    for (let i = 0; i < 5 && e && e !== modal; i++) {
      if (CLIPS(getComputedStyle(e))) e.style.overflow = 'visible';
      e = e.parentElement;
    }
    img.style.transformOrigin = '50% 50%';
    img.style.transition = 'none';
    img.style.willChange = 'transform';
    /* 【超长图清晰化】缩放时用高质量重采样
     * 长条图 (如 1024×6000) 在弹窗里被缩到只有屏幕高, 缩放比不到 0.15,
     * 浏览器默认的快速降采样会把细节洗没 (细字、发丝变成糊块)。
     * 放大时反过来要保边缘 → 分两档切。 */
    img.style.imageRendering = 'high-quality';

    let scale = 1, tx = 0, ty = 0, drag = null;
    const apply = () => {
      img.style.transform = 'translate(' + tx.toFixed(1) + 'px,' + ty.toFixed(1) + 'px) scale(' + scale.toFixed(3) + ')';
      img.style.cursor = scale > 1 ? (drag ? 'grabbing' : 'grab') : '';
      // 缩小时高质重采样 (长图不糊), 放大过 1:1 后用 pixelated 保住像素边缘
      const eff = scale * (img.offsetWidth || 1) / Math.max(1, img.naturalWidth);
      img.style.imageRendering = eff > 1.25 ? 'pixelated' : 'high-quality';
    };
    /* 以光标为定点缩放。推导:
     *   屏幕位置 S = C0 + t + s·p   (C0 = 布局中心, p = 局部坐标, transformOrigin 居中)
     *   缩放前后要让光标下那个点 p 不动, 记 d = S_cursor − C0, k = s'/s:
     *   t' = d − k·(d − t)
     * C0 由当前 rect 中心减去 t 得到 (居中缩放不移动中心)。 */
    const zoomAt = (cx, cy, factor) => {
      const next = Math.min(8, Math.max(1, scale * factor));
      if (Math.abs(next - scale) < 1e-4) return;
      const r = img.getBoundingClientRect();
      const c0x = (r.left + r.right) / 2 - tx;
      const c0y = (r.top + r.bottom) / 2 - ty;
      const dx = cx - c0x, dy = cy - c0y;
      const k = next / scale;
      tx = dx - k * (dx - tx);
      ty = dy - k * (dy - ty);
      scale = next;
      if (scale <= 1.0001) { scale = 1; tx = 0; ty = 0; }
      apply();
    };
    modal.addEventListener('wheel', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      zoomAt(ev.clientX, ev.clientY, ev.deltaY < 0 ? 1.18 : 1 / 1.18);
    }, { capture: true, passive: false });
    img.addEventListener('mousedown', (ev) => {
      if (scale <= 1 || ev.button !== 0) return;
      ev.preventDefault(); ev.stopPropagation();
      drag = { x: ev.clientX, y: ev.clientY, tx, ty };
      apply();
    }, true);
    window.addEventListener('mousemove', (ev) => {
      if (!drag) return;
      tx = drag.tx + (ev.clientX - drag.x);
      ty = drag.ty + (ev.clientY - drag.y);
      apply();
    }, true);
    window.addEventListener('mouseup', () => { if (drag) { drag = null; apply(); } }, true);
    /* 【拦住 Discord 自带的点击缩放】
     * 主人实测: 单击大图会触发 Discord 自己的 zoom 切换 —— 它会重建
     * 图节点/换回 CDN src, 把我们的解码结果刷掉 → 看到混淆图。
     * 我们自己不接点击不够, 还得把它的拦下来 (滚轮已能完全代替)。
     * 只拦媒体区域的左键点击; 关闭按钮、下载、切下一张都不受影响。 */
    const media = img.closest('[class*="mediaArea"]') || img.parentElement || img;
    const eatClick = (ev) => {
      if (ev.button !== 0 && ev.type !== 'click') return;
      if (ev.target !== img && !img.contains(ev.target)) return;
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
    };
    for (const type of ['click', 'dblclick', 'mouseup', 'pointerup']) {
      media.addEventListener(type, eatClick, true);
    }
  }

  /* ---------- emoji 全解锁 (CSS 去灰 + 点击劫持) ---------- */
  const EMOJI_CSS = `
    /* 去灰 + 恢复可点 (Discord 用 aria-disabled + lockedEmoji 双重标记) */
    [class*="emojiItem"][aria-disabled="true"],
    [class*="emoji"][aria-disabled="true"],
    img[class*="lockedEmoji"],
    button[aria-disabled="true"] img[class*="emoji"] {
      filter: none !important;
      opacity: 1 !important;
      pointer-events: auto !important;
      cursor: pointer !important;
    }
    /* 各种锁图标 (实测拓扑得来的类名) */
    [class*="categoryItemLockIcon"],
    [class*="emojiLockIcon"],
    [class*="emojiLockIconContainer"],
    [class*="nitroTopDividerLockCircle"],
    [class*="lockIcon"],
    [class*="lockedIcon"],
    [class*="premiumIcon"] {
      display: none !important;
    }
    /* 【彩色背景】真正的元凶: categorySectionNitroLocked 带粉紫渐变
     *   包住整个被锁分区 (实测 440x188)。上一版只盯了 upsellContainer,
     *   没盖到它 → 主人反馈“彩色背景还在”。 */
    [class*="categorySectionNitroLocked"],
    [class*="categorySectionNitroDivider"],
    [class*="nitroTopDivider"] {
      background: none !important;
      background-image: none !important;
    }
    /* Nitro 推销位与彩色小标签 */
    [class*="upsellContainer"],
    [class*="topGuildEmojiBadge"],
    [class*="newlyAddedBadge"],
    [class*="tooltipPremiumFooterContainer"],
    [class*="premiumUpsell"],
    [class*="nitroUpsell"] {
      display: none !important;
    }
    /* 被锁表情自身的高亮底色也抹平, 与普通表情一致 */
    button[class*="emojiItem"] {
      background-image: none !important;
    }
    /* 贴纸面板: 去灰 + 去锁标 + 去 Nitro 推销
     * 【黑白滤镜的源头】stickerUnsendable 带 filter:grayscale(1),
     *   它加在 stickerNode 上 (不是 img 也不是 sticker_ 本体) →
     *   上一版只给 img 和 sticker_ img 去 filter, 根本没盖到。 */
    [class*="stickerUnsendable"],
    [class*="stickerNode"],
    [class*="sticker"][aria-disabled="true"],
    [class*="stickerAsset"],
    [class*="sticker_"] img {
      filter: none !important;
      opacity: 1 !important;
      pointer-events: auto !important;
    }
    [class*="stickerLock"],
    [class*="stickerPremium"],
    [class*="premiumSticker"] {
      display: none !important;
    }
  `;
  function unlockEmoji() {
    try {
      let st = document.getElementById('moe-emoji-css');
      if (!st) {
        st = document.createElement('style');
        st.id = 'moe-emoji-css';
        st.textContent = EMOJI_CSS;
        (document.head || document.documentElement).appendChild(st);
      }
    } catch (e) {}
    try {
      // 去掉禁用标记 (Discord 用 aria-disabled 拦点击)
      document.querySelectorAll('[class*="emojiItem"][aria-disabled="true"], button[data-type="emoji"][aria-disabled="true"]').forEach((el) => {
        el.removeAttribute('aria-disabled');
      });
      /* 不再给 lockedEmoji 图打 data-moe-unlocked 标记 —— 实测发现面板里
       * 【所有 57 个表情】的图都带这个类名, 拿它当锁信号会把本服可用表情
       * 也当成锁住的 → 本可以原生发的表情反而被我们换成了链接。
       * 锁定判定改由 emojiLocked() 根据 emojiLockIcon 元素实时判断。 */
    } catch (e) {}
  }

  /** 把文本插进 Discord 输入框 (Slate 编辑器)
   * 【实测踩坑记录】Discord 的 Slate 有两份状态: DOM 与内部 model,
   *   两者不同步时以 model 为准 —— 发送时读的是 model。
   *   · execCommand('insertText'): 只改了 DOM, model 完全没动
   *     → 输入框里能看到字, 但发出去是空的 / 或者根本发不出去。
   *       (主人看到的「表情有问题」正是这个: 框里有 URL, 发送无效)
   *   · ClipboardEvent('paste'): model 真的更新了, DOM 由 Slate 自己重绘
   *     → 这才是正确通道。
   * 所以主用 paste, execCommand 只当最后的兜底。 */
  function composerEl() {
    return document.querySelector('[class*="slateTextArea"] [contenteditable="true"], [contenteditable="true"][role="textbox"], textarea[role="textbox"]');
  }
  function insertIntoComposer(text) {
    const input = composerEl();
    if (!input) return false;
    input.focus();
    // 主通道: 伪造粘贴 (Slate 有正式的 paste 处理, 会写进 model)
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      input.dispatchEvent(ev);
      return true;
    } catch (e) {}
    try {
      if (document.execCommand && document.execCommand('insertText', false, text)) return true;
    } catch (e) {}
    return false;
  }

  /* ---------- 点击劫持: 被锁的表情改成插入 CDN 图链接 ----------
   * 为何不能插 :name: 或 <:name:id> —— 主人实测过:
   *   两种写法发出去服务端都不解析 (外部/动图表情需 Nitro),
   *   对方只看到字面文本。
   * 而自定义表情本质就是一张公开 CDN 图 → 插 URL, Discord 自动展开成图。
   *
   * 【锁定判定的坑】实测发现 img 的 lockedEmoji 类名【所有 57 个表情都有】,
   *   根本不能用它判断。真正的锁信号是按钮里的 emojiLockIcon 元素。
   *   实测分布: 本服静态 16 个(无锁, 原生可用) /
   *              本服动图 32 个(带锁 —— 主人说的“本服动图没解锁”) /
   *              外部服务器 9 个(在 NitroLocked 分区)。
   * 【动图判定的坑】面板里预览图用的是 .webp 静态帧,
   *   用 /\.gif/.test(img.src) 永远为 false → 动图会被当成静图插出去。
   *   正确做法: 读按钮的 data-animated 属性 (Discord 自己写的)。
   * -------------------------------------------------- */
  function emojiCdnUrl(id, animated) {
    return 'https://cdn.discordapp.com/emojis/' + id + (animated ? '.gif' : '.webp') + '?size=96';
  }
  /** 这个表情是不是被锁 (需要我们接手) */
  function emojiLocked(host) {
    if (!host) return false;
    if (host.getAttribute('aria-disabled') === 'true') return true;
    if (host.querySelector('[class*="emojiLockIcon"]')) return true;
    if (host.closest('[class*="NitroLocked"]')) return true;
    const li = host.closest('li');
    if (li && li.querySelector('[class*="emojiLockIcon"]')) return true;
    return false;
  }
  function hijackEmojiClicks() {
    try {
      document.addEventListener('click', (e) => {
        try {
          const t = e.target;
          if (!t || !t.closest) return;
          const item = t.closest('button[data-type="emoji"], [class*="emojiItem"], li[role="gridcell"]');
          if (!item) return;
          const btn = item.matches('button[data-type="emoji"]') ? item : item.querySelector('button[data-type="emoji"]');
          const host = btn || item;
          if (!emojiLocked(host)) return;                // 能用的让 Discord 原生处理
          const id = host.dataset ? host.dataset.id : '';
          if (!id) return;                               // 拿不到 id 就不插, 宁可不做
          const animated = host.getAttribute('data-animated') === 'true';
          e.preventDefault();
          e.stopPropagation();
          insertIntoComposer(emojiCdnUrl(id, animated) + ' ');   // 不弹 toast (主人要求)
        } catch (err) {}
      }, true);
    } catch (e) {}
  }
  /* ---------- 贴纸解锁 ----------
   * 贴纸与表情同理: 本质就是一张公开 CDN 图,
   *   media.discordapp.net/stickers/<id>.<ext> 无需凭证就能拿 (实测 206 OK)。
   *   而 cdn.discordapp.com/stickers/ 会被 CORS 卡 → 必须用 media 域。
   * 格式编号 (Discord 的 format_type, DOM 上是 data-format-type):
   *   1=PNG  2=APNG  3=Lottie(JSON 动画)  4=GIF
   *   Lottie 发链接没意义 (对方看到的是 JSON), 实测拿 .json 也直接 400 → 不拦。
   * 只拦【外服务器】的贴纸; 本服可用的让 Discord 原生发。
   * 判定靠 React fiber 里的 guild_id —— 实测贴纸面板 DOM 上没有任何锁标记
   *   (aria-disabled 为 null, opacity 也是 1), 只有 fiber 能区分。
   * -------------------------------------------------- */
  const STICKER_EXT = { 1: 'png', 2: 'png', 4: 'gif' };   // 3=Lottie 故意不列
  function stickerCdnUrl(id, fmt) {
    const ext = STICKER_EXT[+fmt];
    if (!ext) return null;
    return 'https://media.discordapp.net/stickers/' + id + '.' + ext + '?size=160';
  }
  /** 从 React fiber 读贴纸实体 (DOM 上拿不到 guild_id) */
  function stickerEntity(el) {
    try {
      const fk = Object.keys(el).find((k) => k.indexOf('__reactFiber$') === 0);
      if (!fk) return null;
      let f = el[fk];
      const walk = (o, d) => {
        if (!o || d > 4 || typeof o !== 'object') return null;
        if (('format_type' in o) && ('id' in o)) return o;
        for (const k of Object.keys(o)) { const r = walk(o[k], d + 1); if (r) return r; }
        return null;
      };
      for (let i = 0; i < 10 && f; i++) { const e = walk(f.memoizedProps, 0); if (e) return e; f = f.return; }
    } catch (e) {}
    return null;
  }
  function hijackStickerClicks() {
    try {
      document.addEventListener('click', (e) => {
        try {
          const t = e.target;
          if (!t || !t.closest) return;
          const el = t.closest('[data-type="sticker"], [class*="sticker_"][data-id]');
          if (!el || !el.dataset || !el.dataset.id) return;
          /* 【锁定判定以 stickerUnsendable 为主】
           * Discord 自己就把“发不了”的贴纸标上 stickerUnsendable (带 grayscale 滤镜),
           * 这比我们拿 guild_id 自己推更准 —— 实测有贴纸虽然 guild_id 不同但仍可发
           * (9 张里有 2 张不一致)。guild_id 只作辅助。 */
          const node = el.querySelector('[class*="stickerNode"]') || el.closest('[class*="stickerNode"]');
          const unsendable = !!(node && /stickerUnsendable/.test(node.getAttribute('class') || ''));
          if (!unsendable) return;                       // Discord 说能发 → 交回原生
          const ent = stickerEntity(el);
          const fmt = el.dataset.formatType || (ent && ent.format_type) || 1;
          const url = stickerCdnUrl(el.dataset.id, fmt);
          if (!url) return;                              // Lottie 等不可链接化 → 交回 Discord
          e.preventDefault();
          e.stopPropagation();
          insertIntoComposer(url + ' ');
        } catch (err) {}
      }, true);
    } catch (e) {}
  }

  function watchEmoji() {
    try { unlockEmoji(); hijackEmojiClicks(); hijackStickerClicks(); } catch (e) {}
    const mo = new MutationObserver(() => { try { unlockEmoji(); } catch (e) {} });
    mo.observe(document.documentElement || document.body, { childList: true, subtree: true });
    setInterval(() => { try { unlockEmoji(); } catch (e) {} }, 1200);
  }

  /* ---------- 启动 & 调度 ----------
   * 为何不只靠定时轮询: 1.2s 一轮 → 新图最差要等 1.2s 才开始解码,
   *   加上下载+解码, 人眼就是「没自动」。
   * 改成 MutationObserver 即时触发 + 定时轮询兜底(处理重渲染/满屏情况)。
   * -------------------------------------------------- */
  async function syncCfg() {
    Object.assign(cfg, await storageGet());
    stamp('cfg', 'en=' + cfg.enabled + ' auto=' + cfg.autoDecode + ' badge=' + cfg.badge + ' T=' + (cfg.tile || 'auto') + ' salt=' + (cfg.salt ? 'yes' : 'no'));
    window.postMessage({ __moe: 1, cfg: { enabled: cfg.enabled, tile: cfg.tile, salt: cfg.salt, maxDim: cfg.maxDim, skipAnimated: cfg.skipAnimated, nsfwOnly: cfg.nsfwOnly, nsfwThreshold: cfg.nsfwThreshold, reviewMode: cfg.reviewMode } }, '*');
  }
  function loop() {
    try { detectMyId(); scanImages(); retagAll(); badgeComposerPreviews(); } catch (e) { stamp('err', 'loop:' + e.message); }
    setTimeout(loop, 1200);
  }

  /** 新图入场就立即扫 (不等下一轮轮询) — 合并触发避免拖动时抖 */
  let watchTimer = 0;
  function watchImages() {
    const kick = () => {
      if (watchTimer) return;
      watchTimer = setTimeout(() => {
        watchTimer = 0;
        try { scanImages(); retagAll(); badgeComposerPreviews(); } catch (e) {}
      }, 120);
    };
    try {
      const mo = new MutationObserver((recs) => {
        /* 【同步抢先】先在本回调里直接把已知的图置换掉 —— 不等 120ms 去抖。
         * 不这么做的后果: 点开大图时那张混淆图已经渲染一帧,
         *   主人会看到“先变成混淆图, 然后再解码”的闪动。 */
        let sawImg = false;
        for (const r of recs) {
          if (r.type === 'attributes' && r.target && r.target.tagName === 'IMG') {
            sawImg = true;
            try { swapIfKnown(r.target); } catch (e) {}
            continue;
          }
          for (const n of r.addedNodes || []) {
            if (n.nodeType !== 1) continue;
            if (n.tagName === 'IMG') { sawImg = true; try { swapIfKnown(n); } catch (e) {} }
            else if (n.querySelector && n.querySelector('img')) {
              sawImg = true;
              try { n.querySelectorAll('img').forEach((im) => swapIfKnown(im)); } catch (e) {}
            }
          }
        }
        if (sawImg) kick();
      });
      mo.observe(document.documentElement || document.body, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset'],
      });
    } catch (e) { stamp('err', 'watch:' + e.message); }
    // 图片惰加载/滚动加载时 currentSrc 才落定 → 滚动也踢一下
    try {
      window.addEventListener('scroll', kick, { passive: true, capture: true });
      document.addEventListener('load', (e) => { if (e.target && e.target.tagName === 'IMG') kick(); }, true);
      // 窗口缩放 / 侧边栏开合 → 图片重排, 标签坐标要重算
      window.addEventListener('resize', () => { try { retagAll(); } catch (e) {} }, { passive: true });
    } catch (e) {}
  }
  syncCfg().then(() => {
    fetchMyId();
    watchReports();
    watchEmoji();
    watchImages();
    loop();
  }).catch((e) => { stamp('err', 'boot:' + e.message); watchImages(); loop(); });
})();