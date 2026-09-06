/* ══════════════════════════════════════════════════════════════════
 * MoeGuard 喵图混淆 —— 页面内上传拦截 (MAIN world, document_start) v1.5
 *
 * 关键认知 (2026 Discord 实测):
 *   Discord 上传前会用 wasm Worker 把图片重压缩成 webp
 *   (152KB PNG → 10.5KB webp, science 事件 was_converted:true),
 *   然后用 "httputils"(XMLHttpRequest) PUT 到
 *   discord-attachments-uploads-prd.storage.googleapis.com。
 *   所以在 File/Blob 层做手脚全都命不中 —— 必须拦最终的 PUT 上传体。
 *
 * 拦截点 (三管齐下, 覆盖任意实现):
 *   A. XMLHttpRequest.prototype.send  ← Discord 2026 实际走这条
 *   B. window.fetch                    ← 老版本 / 备用路径
 *   C. Beacon/Worker 不涉及上传体, 无需处理
 *
 * 拦截逻辑: 若 URL 命中上传地址且 body 是图片字节
 *   → 后台解码像素 → 分块混淆 → PNG 编码 → 替换 body 后发出
 *   (声明的 file_size 无需改写: 实测 Discord/GCS 不校验大小一致性)
 *
 * 依赖: window.__MoeGuardCore (core.js), window._moeFormat (format.js)
 * ══════════════════════════════════════════════════════════════════ */
'use strict';
(function () {
  if (window.__moeGuardInstalled) return;
  Object.defineProperty(window, '__moeGuardInstalled', { value: true, configurable: false });

  const Core = window.__MoeGuardCore;
  const FMT = window._moeFormat;
  if (!Core || !FMT) return;

  /* 【初值故意保守】这里是主世界, 真配置要等 content.js 通过 postMessage 送过来。
   * 在那之前如果先写成 nsfwOnly:true, 万一有图在这个窗口期上传,
   * 就会走“只混淆高分图”→ 启发式漏判就把原图直发出去了。
   * false = 全部混淆, 是安全的那一侧 —— 不是默认值, 只是未同步前的兵库。
   * (真正的默认值在 content.js / options.js 的 DEFAULTS 里, 已改成 true) */
  const cfg = {
    enabled: true, tile: 0, salt: '', maxDim: 0, skipAnimated: true,
    nsfwOnly: false, nsfwThreshold: 0.7, reviewMode: 'local', reviewTimeoutMs: 6000,
  };

  function log(obj) {
    try { window.postMessage(Object.assign({ __moe: 1 }, obj), '*'); } catch (e) {}
  }

  /* ---------- 上传地址识别 ---------- */
  function isUploadUrl(u) {
    const s = String(u || '');
    return /discord-attachments-uploads-prd\.storage\.googleapis\.com\//.test(s) ||
           /\/attachments\/[^/]+\/[^/]+\//.test(s) ||
           /ephemeral-attachments\//.test(s);
  }

  /* 发送消息的接口 (用户按下发送键) —— 校正重传的时机锚点
   *   POST https://discord.com/api/v9/channels/<id>/messages */
  function isMessagePost(method, u) {
    return method === 'POST' && /\/api\/v\d+\/channels\/\d+\/messages(\?|$)/.test(String(u || ''));
  }

  /* ---------- 字节 → 图片类型嗅探 (Discord 会转成 webp, 不能只看 MIME) ---------- */
  function sniffImage(u8) {
    if (!u8 || u8.length < 12) return null;
    if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) return 'image/png';
    if (u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return 'image/jpeg';
    if (u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 &&
        u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50) {
      // WEBP: 判断是否动画 (VP8X + ANIM chunk)
      const isVp8x = u8[12] === 0x56 && u8[13] === 0x50 && u8[14] === 0x38 && u8[15] === 0x58;
      if (isVp8x && (u8[20] & 0x02)) return 'image/webp-animated';
      return 'image/webp';
    }
    if (u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) return 'image/gif';
    if (u8[0] === 0x42 && u8[1] === 0x4d) return 'image/bmp';
    return null;
  }

  /* ---------- 决策层: 【先审查 → 再决定混不混】----------
   * 流程铁律 (色情与非色情走同一条路, 顺序不可颠倒):
   *   1. 拿到上传字节 → 解成像素
   *   2. 查预览阶段已定的结论 (content.js 通过 postMessage 下发 decisions)
   *   3. 没有结论 (直接粘贴/拖拽秒发, 预览来不及审) → 现场审查
   *   4. 只有结论为「混淆」时才调 encodeImage
   * 绝不允许先编码再审查: 那是白跑一遍 CPU, 且和角标显示的结论不一致。
   *
   * decisions 由隔离世界维护并同步过来: [{fp, obfuscate}]
   *   fp = Core.perceptualTag(img), 用 tagMatches 做容差匹配
   *   (Discord 上传前会把图重压成 webp → 字节哈希必然对不上, 指纹会微漂)
   * -------------------------------------------------- */
  let decisions = [];     // 隔离世界下发的既定结论

  /** 远端打分: 主世界跨域会被 Discord 的 CSP 拦死 → 让隔离世界转交后台代发 */
  let reviewSeq = 0;
  const reviewWaiters = new Map();     // seq → {resolve, timer}
  function remoteScore(img) {
    if (!cfg.reviewMode || cfg.reviewMode === 'local') return Promise.resolve(null);
    return new Promise((resolve) => {
      const seq = ++reviewSeq;
      const timer = setTimeout(() => { reviewWaiters.delete(seq); resolve(null); }, cfg.reviewTimeoutMs || 6000);
      reviewWaiters.set(seq, { resolve, timer });
      try {
        // 只传缩小的 dataURL, 降带宽也降泄露面
        const small = FMT.resizeImageData(img, 512);
        window.postMessage({ __moe: 1, reviewReq: seq, dataUrl: FMT.imageDataToDataURL(small) }, '*');
      } catch (e) {
        clearTimeout(timer);
        reviewWaiters.delete(seq);
        resolve(null);
      }
    });
  }

  /* ---------- 上传回放日志 (调试用, 环形缓冲) ----------
   * 为何需要: 页面注入的探针 (包 resolveAction 等) 会在 Discord 刷新/跳频道时丢失,
   *   而上传恰好发生在那之后 → 抓不到现场。所以把关键判定存在 hook 自己里面。
   * 只存最近 120 条, 不含图像字节, 无隐私风险。
   * 读取: window.__MoeGuard.uploadLog / window.__MoeGuard.report() */
  const uploadLog = [];
  const T0 = Date.now();
  function rec(entry) {
    try {
      uploadLog.push(Object.assign({
        t: new Date().toTimeString().slice(0, 12),
        ms: Date.now() - T0,
      }, entry));
      if (uploadLog.length > 120) uploadLog.shift();
    } catch (e) {}
  }
  /** 指纹缩写: 日志里不必展开 80 位 */
  function fpShort(fp) {
    if (!fp) return null;
    const p = String(fp).split(':');
    if (p.length < 2) return String(fp).slice(0, 24);
    return p[0] + ':' + p[1].slice(0, 8) + '…' + (p[2] ? p[2].slice(0, 4) : '');
  }

  /* 未经修改的原生 fetch —— 内部重传时用它, 避免递归进自己的拦截 */
  const rawFetch = window.fetch ? window.fetch.bind(window) : null;

  /* ═══════════════════════════════════════════════════════════════
   * 【挂起上传】—— 盖住上传通道, 只在按发送键时才真正传
   * ═══════════════════════════════════════════════════════════════
   * 为什么必须这样 (走过的两条死路):
   *   1. 拖入即传 + 事后覆盖签名 URL: PUT 返回 200 但 CDN 字节仍是原图
   *      —— Discord 已经把暂存对象转存走了, 覆盖暂存位置没有意义。
   *   2. 点开关的瞬间重传: 反复切开关就反复上传, 且 GCS 对 header 敏感易 503。
   *
   * 实测事实: Discord 在文件拖进输入框的那一刻就 PUT 到 CDN
   *   (预览卡上那个进度条就是它); 按发送只发一条引用已上传文件的消息。
   *   所以用户点 ✕/○ 必然晚于上传 —— 这是时序上的物理矛盾。
   *
   * 解法: 把 PUT 挂住不发, 只记进队列;
   *   等到用户按【发送】(Enter / 发送按钮) 那一刻,
   *   按【当时的结论】编码, 依次放行 PUT。
   *   → 用户怎么切开关都不产生网络流量, 发出去的一定是最终结论。
   *   ⚠️ 不能等 POST /messages: Discord 会等上传完成才发消息 → 死锁 (详见下方)。
   *
   * UI 影响: 预览卡的进度条会一直转到按发送为止 —— 这是预期的,
   *   因为图确实还没传。Discord 不会因此报错 (它只等 XHR 完成)。
   *
   * 兜底: 删除预览图/切频道会调 xhr.abort() → 队列项标记 aborted 并丢弃;
   *   HOLD_TTL 之后自动放行, 避免因为某种未知路径而永久悬空。
   * ═══════════════════════════════════════════════════════════════ */
  const HOLD_TTL = 45 * 1000;           // 挂起上限: 超过就自己放行 (兜底, 避免悬空)
  const held = [];                       // [{id, xhr, url, hdrs, u8, mime, fp, sendArgs, state}]
  let heldSeq = 0;

  function dropStale() {
    const now = Date.now();
    for (let i = held.length - 1; i >= 0; i--) {
      if (now - held[i].at > HOLD_TTL) {
        rec({ ev: 'hold-expire', id: held[i].id, fp: fpShort(held[i].fp) });
        releaseOne(held[i], 'ttl');
      }
    }
  }
  // 周期扫一下: 即使用户什么都不做, 超时的也会自己放行
  setInterval(() => { try { if (held.length) dropStale(); } catch (e) {} }, 5000);

  /** 按当前结论编码 → 放行这一笔 PUT */
  async function releaseOne(item, trigger) {
    const idx = held.indexOf(item);
    if (idx >= 0) held.splice(idx, 1);
    if (item.state !== 'held') { rec({ ev: 'release-skip', id: item.id, state: item.state }); return; }
    item.state = 'releasing';

    let body = null, label = '原图', why = '';
    try {
      const img = await FMT.blobToImageData(new Blob([item.u8], { type: item.mime }));
      if (Core.detectMeta(img, cfg.salt)) {
        why = 'already-moe';
      } else {
        /* 【内容键优先】同时上传多张图时, 感知指纹会串位
         * (四张相似的图彼此容差匹配) → A 图的「不混淆」可能被拿去给 B 图。
         * 预览 blob 与这笔 PUT 同源于同一个 File → 字节完全一致,
         * 所以先拿字节键做精确匹配, 匹不上才走感知指纹。 */
        let exact = null;
        if (item.ck) {
          for (const d of decisions) if (d.ck && d.ck === item.ck) { exact = d; break; }
        }
        let act;
        if (exact) {
          act = { obfuscate: !!exact.obfuscate, score: exact.score == null ? null : exact.score, source: 'exact' };
        } else {
          const Review = window.__MoeGuardReview;
          act = Review
            ? await Review.resolveAction(img, decisions, cfg, {
                tag: Core.perceptualTag, tagMatches: Core.tagMatches, remoteFn: remoteScore,
              }).catch((e) => {
                log({ ev: 'error', msg: 'review: ' + (e && e.message) });
                return { obfuscate: true, score: 1, source: 'fallback' };
              })
            : { obfuscate: true, score: 1, source: 'no-review' };
        }
        why = act.source;
        rec({
          ev: 'release-decide', id: item.id, trigger, ck: (item.ck || '').slice(0, 12),
          fp: fpShort(item.fp), obfuscate: act.obfuscate, source: act.source, score: act.score,
          decisions: decisions.map((d) => ({ fp: fpShort(d.fp), obf: !!d.obfuscate, man: !!d.manual,
                                             ckHit: !!(item.ck && d.ck === item.ck), hit: Core.tagMatches(item.fp, d.fp) })),
        });
        if (act.obfuscate) {
          const t0 = Date.now();
          const src = cfg.maxDim > 0 ? FMT.resizeImageData(img, cfg.maxDim) : img;
          const enc = Core.encodeImage(src, { tile: cfg.tile || undefined, salt: cfg.salt });
          let chunks = null;
          try { chunks = Core.pngGetTextChunks(item.u8); } catch (e) {}
          const blob = await FMT.encodedToBlob(enc, chunks);
          body = await blob.arrayBuffer();
          label = '混淆图';
          rec({ ev: 'release-encode', id: item.id, in: item.u8.length, out: body.byteLength, dim: enc.width + 'x' + enc.height, ms: Date.now() - t0 });
          log({ ev: 'encoded', name: 'upload', origSize: item.u8.length, newSize: body.byteLength, w: enc.width, h: enc.height });
        }
      }
    } catch (e) {
      rec({ ev: 'release-error', id: item.id, err: String(e && e.message || e) });
      log({ ev: 'error', msg: 'release: ' + (e && e.message ? e.message : e) });
    }

    item.state = 'sent';
    rec({ ev: 'release', id: item.id, trigger, as: label, why, bytes: body ? body.byteLength : item.u8.length });
    /* 【obf 必须带上】不然隔离世界不知道这笔到底换没换,
     * 会把原图直通也报成「已混淆上传 · 原图」(主人抓到的矛盾文案)。 */
    log({ ev: 'upload-replaced', obf: !!body, as: label,
          kb: ((body ? body.byteLength : item.u8.length) / 1024).toFixed(0) + 'KB',
          info: label + ' · ' + ((body ? body.byteLength : item.u8.length) / 1024).toFixed(0) + 'KB' });
    try {
      origSend.call(item.xhr, body || item.sendBody);
    } catch (e) {
      rec({ ev: 'release-send-err', id: item.id, err: String(e && e.message || e) });
    }
  }

  /** 用户按发送 → 放行所有挂起的 PUT (按当时结论), 全部完成后再发消息 */
  function releaseAll(trigger) {
    dropStale();
    const items = held.filter((h) => h.state === 'held');
    rec({ ev: 'release-all', trigger, count: items.length,
          decisions: decisions.map((d) => ({ fp: fpShort(d.fp), obf: !!d.obfuscate, man: !!d.manual })) });
    return Promise.all(items.map((it) => releaseOne(it, trigger)));
  }

  /* ═══════════════════════════════════════════════════════════════
   * 发送意图探测 —— 为何不能等 POST /messages
   * ═══════════════════════════════════════════════════════════════
   * 实测到的死锁: Discord 会【等附件上传完成才发消息】,
   *   而我们【等消息 POST 才放行上传】—— 两边互等,
   *   结果进度条永远 0% 且 POST /messages 永远不出现 (偷听验证过)。
   *
   * 所以改用【用户动作】作为信号 —— 这些都在 Discord 的上传门禁之前:
   *   1. 在输入框按 Enter (非 Shift+Enter)
   *   2. 点发送按钮
   *   3. POST /messages (万一存在就也算, 无害)
   * 放行后 PUT 正常跑完, Discord 看到上传完成就把消息发出去。
   * ═══════════════════════════════════════════════════════════════ */
  function inComposer(el) {
    try {
      return !!(el && el.closest && el.closest('[class*="channelTextArea"], [class*="slateTextArea"], [class*="form"], [role="textbox"]'));
    } catch (e) { return false; }
  }
  function looksLikeSendButton(el) {
    try {
      if (!el || !el.closest) return false;
      if (el.closest('.moe-pill, .moe-toggle, .moe-chip, .moe-side-tag, .moe-side-dl')) return false;  // 自己的 UI 不算
      const b = el.closest('button, [role="button"]');
      if (!b) return false;
      const cls = (b.className || '').toString();
      if (/moe-/.test(cls)) return false;
      if (/sendButton|send-button/i.test(cls)) return true;
      const label = (b.getAttribute('aria-label') || '').trim();
      /* 【必须严格匹配】历史教训: 用 /send|发送/ 宽匹配会误伤
       *   「发送礼物」按钮, 以及我们自己 aria-label 里带「发送」字样的切换按钮
       *   → 用户一点✕ 就被当成发送, 按当时的结论(混淆)直接上传。 */
      return /^(send message|send|发送消息|發送訊息|发送)$/i.test(label);
    } catch (e) { return false; }
  }
  function onSendIntent(why) {
    if (!held.some((h) => h.state === 'held')) return;
    rec({ ev: 'send-intent', why, held: held.filter((h) => h.state === 'held').length });
    releaseAll('intent:' + why);
  }
  document.addEventListener('keydown', (e) => {
    try {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
      if (!inComposer(e.target)) return;
      onSendIntent('enter');
    } catch (err) {}
  }, true);
  document.addEventListener('click', (e) => {
    try { if (looksLikeSendButton(e.target)) onSendIntent('send-button'); } catch (err) {}
  }, true);


  /* ---------- 核心: 字节 → (审查通过则) 混淆后的 PNG Blob ----------
   * 只给 fetch 备用路径与调试 API 用; XHR 主路径走【挂起 + releaseOne】。
   * 返回 null = 不换体, 原样发送 */
  async function obfuscateBytes(u8, mime) {
    const img = await FMT.blobToImageData(new Blob([u8], { type: mime }));
    if (Core.detectMeta(img, cfg.salt)) {
      rec({ ev: 'pass', why: 'already-moe', dim: img.width + 'x' + img.height });
      return null;                                       // 已是喵图 → 直通
    }

    // 【先审查】既定结论 → 没有则现场审查; 全部在 review.js 里统一判定
    const Review = window.__MoeGuardReview;
    const upFp = Core.perceptualTag(img);
    const act = Review
      ? await Review.resolveAction(img, decisions, cfg, {
          tag: Core.perceptualTag, tagMatches: Core.tagMatches, remoteFn: remoteScore,
        }).catch((e) => {
          log({ ev: 'error', msg: 'review: ' + (e && e.message) });
          return { obfuscate: true, score: 1, source: 'fallback' };
        })
      : { obfuscate: true, score: 1, source: 'no-review' };

    rec({
      ev: 'decide', dim: img.width + 'x' + img.height, mime, bytes: u8.length,
      upFp: fpShort(upFp), obfuscate: act.obfuscate, source: act.source, score: act.score,
      nsfwOnly: cfg.nsfwOnly, salt: cfg.salt ? 'yes' : 'no',
      decisions: decisions.map((d) => ({ fp: fpShort(d.fp), obf: !!d.obfuscate, man: !!d.manual, hit: Core.tagMatches(upFp, d.fp) })),
    });

    log({ ev: 'review', score: act.score, source: act.source, obfuscate: act.obfuscate });
    if (!act.obfuscate) {
      log({ ev: 'skipped', name: 'upload', msg: act.source === 'decided' ? '按既定结论原图发送' : '审查判定无需混淆' });
      return null;
    }

    // 【后编码】只有结论为混淆才动 CPU
    const src = cfg.maxDim > 0 ? FMT.resizeImageData(img, cfg.maxDim) : img;
    const enc = Core.encodeImage(src, { tile: cfg.tile || undefined, salt: cfg.salt });
    // 保留原图文本元数据 (ComfyUI workflow 等 PNG tEXt) → moMt chunk
    let chunks = null;
    try {
      if (Core.pngGetTextChunks) chunks = Core.pngGetTextChunks(u8);
    } catch (e) { chunks = null; }
    const blob = await FMT.encodedToBlob(enc, chunks); // 带 moEg 标记块 + moMt 元数据
    rec({ ev: 'encoded', in: u8.length, out: blob.size, dim: enc.width + 'x' + enc.height });
    log({ ev: 'encoded', name: 'upload', origSize: u8.length, newSize: blob.size, w: enc.width, h: enc.height });
    return blob;
  }

  async function bodyToU8(body) {
    if (!body) return null;
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    if (body && body.buffer instanceof ArrayBuffer && typeof body.byteLength === 'number') {
      return new Uint8Array(body.buffer, body.byteOffset || 0, body.byteLength);
    }
    if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
    return null; // string / FormData / stream → 不处理
  }

  /* ---------- A. XMLHttpRequest 拦截 (Discord 2026 走这条) ---------- */
  const XHRProto = XMLHttpRequest.prototype;
  const origOpen = XHRProto.open;
  const origSend = XHRProto.send;

  XHRProto.open = function (method, url) {
    try {
      this.__moeMethod = String(method || '').toUpperCase();
      this.__moeUrl = String(url || '');
      this.__moeHdrs = {};
    } catch (e) {}
    return origOpen.apply(this, arguments);
  };

  /* 记住原始 PUT 的 header —— GCS 签名 URL 会校验它们,
   * 校正重传时必须原样重放 (自编 content-type 会直接 HTTP 503) */
  const origSetHeader = XHRProto.setRequestHeader;
  XHRProto.setRequestHeader = function (name, value) {
    try {
      if (this.__moeHdrs) this.__moeHdrs[String(name)] = String(value);
    } catch (e) {}
    return origSetHeader.apply(this, arguments);
  };

  /* abort → 丢弃挂起项 (用户删预览图/切频道) */
  const origAbort = XHRProto.abort;
  XHRProto.abort = function () {
    try {
      const it = this.__moeHeld;
      if (it && it.state === 'held') {
        it.state = 'aborted';
        const i = held.indexOf(it);
        if (i >= 0) held.splice(i, 1);
        rec({ ev: 'hold-abort', id: it.id, fp: fpShort(it.fp) });
      }
    } catch (e) {}
    return origAbort.apply(this, arguments);
  };

  XHRProto.send = function (body) {
    const self = this;
    try {
      /* POST /messages 也当作发送信号 (万一存在就多一道保险)
       * 但【不能阻塞它】—— Discord 会等上传完成才发消息, 互等就死锁了。
       * 真正的放行靠上面的 keydown/click 监听 (那些在上传之前就触发)。 */
      if (cfg.enabled && isMessagePost(this.__moeMethod, this.__moeUrl)) {
        onSendIntent('post-messages');
      }
      if (!cfg.enabled || this.__moeMethod !== 'PUT' || !isUploadUrl(this.__moeUrl)) {
        return origSend.apply(this, arguments);
      }
      log({ ev: 'upload-seen', url: String(this.__moeUrl).slice(0, 90) });

      /* 【挂住上传】不立刻发 —— 只记进队列, 等按发送键才按当时结论编码并放行。
       * 这样用户切多少次开关都不产生流量, 发出去的一定是最终结论。 */
      const args = arguments;
      bodyToU8(body).then(async (u8) => {
        try {
          if (!u8) { log({ ev: 'upload-pass', why: 'body-not-bytes:' + (body && body.constructor ? body.constructor.name : typeof body) }); return origSend.apply(self, args); }
          const mime = sniffImage(u8);
          if (!mime) { log({ ev: 'upload-pass', why: 'not-image bytes[0..3]=' + Array.from(u8.slice(0, 4)).join(',') }); return origSend.apply(self, args); }
          if (mime === 'image/gif' || mime === 'image/webp-animated') {
            if (cfg.skipAnimated) { log({ ev: 'skipped', name: 'upload', msg: '动画图原样发送' }); return origSend.apply(self, args); }
          }
          const realMime = mime === 'image/webp-animated' ? 'image/webp' : mime;
          // 算指纹 + 内容键 (给结论匹配用); 失败也不影响挂起
          let fp = null, ck = '';
          try { ck = Core.contentKey(u8); } catch (e) {}
          try {
            const im = await FMT.blobToImageData(new Blob([u8], { type: realMime }));
            fp = Core.perceptualTag(im);
          } catch (e) {}
          dropStale();
          const item = {
            id: ++heldSeq, xhr: self, url: self.__moeUrl, hdrs: self.__moeHdrs,
            u8, mime: realMime, fp, ck, sendBody: body, state: 'held', at: Date.now(),
          };
          self.__moeHeld = item;
          held.push(item);
          rec({ ev: 'hold', id: item.id, fp: fpShort(fp), ck: ck.slice(0, 12), bytes: u8.length, mime: realMime, heldTotal: held.length });
          log({ ev: 'tracked', name: 'upload', size: u8.length, type: realMime });
          // 不调 origSend —— 等 releaseAll
        } catch (e) {
          log({ ev: 'error', msg: 'xhr-hold: ' + (e && e.message ? e.message : e) });
          try { return origSend.apply(self, args); } catch (e2) {}
        }
      }).catch((e) => {
        log({ ev: 'error', msg: 'xhr-body: ' + (e && e.message ? e.message : e) });
        try { origSend.apply(self, args); } catch (e2) {}
      });
      return undefined; // 挂起
    } catch (e) {
      return origSend.apply(this, arguments);
    }
  };

  /* ---------- B. fetch 拦截 (备用路径) ---------- */
  const nativeFetch = window.fetch ? window.fetch.bind(window) : null;
  if (nativeFetch && !window.__moeFetchPatched) {
    Object.defineProperty(window, '__moeFetchPatched', { value: true, configurable: false });
    window.fetch = async function moeFetch(input, init) {
      try {
        let url, method, headers, body;
        if (input instanceof Request) {
          url = input.url; method = input.method; headers = input.headers; body = input.body;
        } else {
          url = String(input);
          method = (init && init.method) || 'GET';
          headers = init ? init.headers : undefined;
          body = init ? init.body : undefined;
        }
        method = (method || 'GET').toUpperCase();
        // POST /messages 也当发送信号 (不阻塞, 避免与 Discord 等上传形成死锁)
        if (cfg.enabled && isMessagePost(method, url)) {
          onSendIntent('post-messages/fetch');
          return nativeFetch(input, init);
        }
        if (!cfg.enabled || method !== 'PUT' || !isUploadUrl(url)) return nativeFetch(input, init);
        log({ ev: 'upload-seen', url: String(url).slice(0, 90) });

        let u8 = await bodyToU8(body);
        if (!u8 && input instanceof Request) {
          const b = await input.clone().arrayBuffer().catch(() => null);
          if (b) u8 = new Uint8Array(b);
        }
        if (!u8) { log({ ev: 'upload-pass', why: 'fetch-body-not-bytes' }); return nativeFetch(input, init); }
        const mime = sniffImage(u8);
        if (!mime) { log({ ev: 'upload-pass', why: 'fetch-not-image' }); return nativeFetch(input, init); }
        if ((mime === 'image/gif' || mime === 'image/webp-animated') && cfg.skipAnimated) {
          log({ ev: 'skipped', name: 'upload', msg: '动画图原样发送' });
          return nativeFetch(input, init);
        }
        const blob = await obfuscateBytes(u8, mime === 'image/webp-animated' ? 'image/webp' : mime);
        if (!blob) { log({ ev: 'upload-pass', why: 'fetch-skip-or-review-pass' }); return nativeFetch(input, init); }
        const h = new Headers(headers || {});
        h.delete('content-length');
        h.set('content-type', 'image/png');
        log({ ev: 'upload-replaced', obf: true, as: '混淆图',
              kb: (blob.size / 1024).toFixed(0) + 'KB',
              info: u8.length + 'B(' + mime + ') → ' + blob.size + 'B(png) [fetch]' });
        return nativeFetch(url, { method: 'PUT', headers: h, body: blob });
      } catch (e) {
        log({ ev: 'error', msg: 'fetch: ' + (e && e.message ? e.message : e) });
      }
      return nativeFetch(input, init);
    };
  }

  /* ---------- 输入框预览角标用: 追踪用户选的文件 ---------- */
  function trackFile(f) {
    try {
      if (!cfg.enabled || !f || !/^image\//i.test(f.type || '')) return;
      log({ ev: 'tracked', name: f.name || 'image', size: f.size || 0, type: f.type });
    } catch (e) {}
  }
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el && el.type === 'file') { for (const f of el.files || []) trackFile(f); }
  }, true);
  document.addEventListener('drop', (e) => {
    for (const f of (e.dataTransfer || {}).files || []) trackFile(f);
  }, true);
  document.addEventListener('paste', (e) => {
    for (const f of (e.clipboardData || {}).files || []) trackFile(f);
  }, true);

  /* ---------- 配置同步 (隔离世界 → 主世界) ---------- */
  window.addEventListener('message', (e) => {
    try {
      if (e.data && e.data.__moe === 1 && typeof e.data.reviewRes === 'number') {
        const w = reviewWaiters.get(e.data.reviewRes);
        if (w) {
          clearTimeout(w.timer);
          reviewWaiters.delete(e.data.reviewRes);
          w.resolve(typeof e.data.score === 'number' ? e.data.score : null);
        }
      }
      /* 【Firefox 专用】隔离世界读不了页面创建的 blob: URL (principal 不同),
       * 由我们 (MAIN world, 与页面同 principal) 代取后回传 base64。
       * 注: 这只是兵库 —— content.js 会先试直接 fetch 与 canvas 重绘。 */
      if (e.data && e.data.__moe === 1 && typeof e.data.grabReq === 'number' && e.data.url) {
        const seq = e.data.grabReq;
        const reply = (base64, mime) => {
          try { window.postMessage({ __moe: 1, grabRes: seq, base64: base64 || '', mime: mime || '' }, '*'); } catch (err) {}
        };
        (rawFetch ? rawFetch(e.data.url) : fetch(e.data.url))
          .then((r) => (r.ok ? r.arrayBuffer().then((buf) => ({ buf, mime: r.headers.get('content-type') || 'image/png' })) : null))
          .then((o) => {
            if (!o) { reply(''); return; }
            const u8 = new Uint8Array(o.buf);
            let bin = '';
            for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
            reply(btoa(bin), o.mime);
          })
          .catch(() => reply(''));
        return;
      }
      if (e.data && e.data.__moe === 1 && Array.isArray(e.data.decisions)) {
        const prev = decisions.length;
        decisions = e.data.decisions.filter((d) => d && typeof d.fp === 'string');
        // 不在这里放行上传 —— 用户反复切开关不应产生流量。
        // 放行时机在【发送动作】(Enter / 发送按钮)。
        rec({
          ev: 'decisions-sync', was: prev, now: decisions.length,
          list: decisions.map((d) => ({ fp: fpShort(d.fp), ck: (d.ck || '').slice(0, 12), obf: !!d.obfuscate, man: !!d.manual })),
          heldCount: held.filter((h) => h.state === 'held').length,
        });
      }
      if (e.data && e.data.__moe === 1 && e.data.cfg && !e.data.ev) {
        const c = e.data.cfg;
        if (typeof c.enabled !== 'undefined') cfg.enabled = !!c.enabled;
        if (typeof c.tile !== 'undefined') cfg.tile = +c.tile || 0;
        if (typeof c.salt !== 'undefined') cfg.salt = String(c.salt || '');
        if (typeof c.maxDim !== 'undefined') cfg.maxDim = +c.maxDim || 0;
        if (typeof c.skipAnimated !== 'undefined') cfg.skipAnimated = !!c.skipAnimated;
        if (typeof c.nsfwOnly !== 'undefined') cfg.nsfwOnly = !!c.nsfwOnly;
        if (typeof c.nsfwThreshold !== 'undefined') cfg.nsfwThreshold = +c.nsfwThreshold || 0.7;
        if (typeof c.reviewMode !== 'undefined') cfg.reviewMode = String(c.reviewMode || 'local');
        if (typeof c.reviewTimeoutMs !== 'undefined') cfg.reviewTimeoutMs = +c.reviewTimeoutMs || 6000;
      }
    } catch (err) {}
  });

  /* ---------- 调试 API ---------- */
  window.__MoeGuard = {
    get config() { return Object.assign({}, cfg); },
    setConfig(c) { Object.assign(cfg, c || {}); },
    isUploadUrl: isUploadUrl,
    isMessagePost: isMessagePost,
    get heldUploads() { return held.map((u) => ({ id: u.id, fp: fpShort(u.fp), ck: (u.ck || '').slice(0, 12), state: u.state, bytes: u.u8 ? u.u8.length : 0, ageMs: Date.now() - u.at })); },
    /** 人眼可读的时间线 —— 直接 copy(__MoeGuard.report()) 给我看 */
    report: function () {
      const rows = uploadLog.map((e) => {
        const parts = [];
        for (const k in e) {
          if (k === 't' || k === 'ms' || k === 'ev') continue;
          const v = e[k];
          if (v == null) continue;
          parts.push(k + '=' + (typeof v === 'object' ? JSON.stringify(v) : v));
        }
        return e.t + ' +' + e.ms + 'ms  [' + e.ev + '] ' + parts.join(' ');
      });
      return [
        '=== MoeGuard 上传时间线 (' + uploadLog.length + ' 条) ===',
        'cfg: enabled=' + cfg.enabled + ' nsfwOnly=' + cfg.nsfwOnly + ' tile=' + (cfg.tile || 'auto') + ' salt=' + (cfg.salt ? 'yes' : 'no'),
        'decisions: ' + JSON.stringify(decisions.map((d) => ({ fp: fpShort(d.fp), ck: (d.ck || '').slice(0, 12), obf: !!d.obfuscate, man: !!d.manual }))),
        'held: ' + JSON.stringify(held.map((u) => ({ id: u.id, fp: fpShort(u.fp), state: u.state }))),
        '',
      ].concat(rows).join('\n');
    },
    sniffImage: sniffImage,
    obfuscateBytes: obfuscateBytes,
    get uploadLog() { return uploadLog.slice(); },
    get decisions() { return decisions.slice(); },
    decodeBlob: async function (b) {
      const img = await FMT.blobToImageData(b);
      const dec = Core.decodeImage(img, { salt: cfg.salt });
      if (!dec.ok) return { ok: false, reason: dec.reason };
      return { ok: true, blob: await FMT.imageDataToBlob(dec, 'image/png'), width: dec.width, height: dec.height };
    },
  };
  log({ ev: 'ready' });
})();