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

  /* ---------- fiber 挖掘 (主世界专属能力, 隔离世界看不见 __reactFiber$) ----------
   * 【为什么在这】content.js 跑在 ISOLATED 世界, Chrome 每个世界有独立 DOM wrapper,
   * React 挂的 __reactFiber$ 只在主世界可枚举 —— 实页实锢 2026-11-16:
   * content.js 里同款代码永远拿不到 fiber (Object.keys 为空), 而主世界
   * 同代码 depth 13 就命中 <a:fxxkpig:id>。所以 fiber 读取放这,
   * content.js 用 moeFibReq/moeFibRes 消息同步请求。
   * DOM 节点不能跨消息序列化 → 用「标记法」: content 先给目标 img 打 data-moe-fibq,
   * 主世界 querySelector 找到它再挖。 */
  function digContentToken(el) {
    try {
      const reTok = /<a?:[a-zA-Z0-9_]{2,64}:[0-9]{15,25}>/;
      const fk = Object.keys(el).find((k) => k.indexOf('__reactFiber$') === 0);
      let f = fk ? el[fk] : null;
      for (let i = 0; i < 24 && f; i++) {
        for (const bag of [f.memoizedProps, f.pendingProps]) {
          if (!bag || typeof bag !== 'object') continue;
          for (const k of Object.keys(bag)) {
            const v = bag[k];
            if (typeof v === 'string' && reTok.test(v)) return v;
            if (!v || typeof v !== 'object') continue;
            for (const kk of Object.keys(v)) {
              const vv = v[kk];
              if (typeof vv === 'string' && reTok.test(vv)) return vv;
            }
          }
        }
        f = f.return;
      }
    } catch (e) {}
    return null;
  }
  window.addEventListener('message', (e) => {
    try {
      if (!e.data || e.data.__moe !== 1) return;
      /* 隔离世界要挖某颗表情的原始 content: 标记 → 主世界找到 → 挖 → 回包
       * (标记在 img 或字面 span 上都行) */
      if (e.data.moeFibReq) {
        /* 标记带 seq: 同帧多颗各自挖各自的, 不再单标记撞车 (2026-11-16
         * 单标记版把多图请求串成乱马, 动图全被判错) */
        const q = document.querySelector('[data-moe-fibq="' + String(e.data.moeFibReq) + '"]');
        const content = q ? digContentToken(q) : null;
        try { if (q) q.removeAttribute('data-moe-fibq'); } catch (err) {}
        log({ moeFibRes: e.data.moeFibReq, content: content });
      }
    } catch (err) {}
  });

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
   * 【入队即编码·立即放行】—— 2026-11-28 根治双回车后的模型: 字节一登记完立刻按当时结论编码并放行 PUT, 进度条正常走, 按发送时一次回车原生发送; 键盘/按钮完全不碰。以下历史注记保留 (为什么不能事后覆盖/反复重传)
   * 旧模型(挂起等发送)的死因
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
   * 旧解法 (已废弃): PUT 挂住, 按发送才编码放行 —— 附件 0% 时宿主丢发送意图,
   *   必然双回车; 3.8.2 扣键+补发合成回车也被证实无效 (isTrusted=false 被丢弃)。
   *   开关后改: decisions 更新钩子按新结论 correction 重传, PUT 从不长期挂起。
   *
   * 兜底: 删除预览图/切频道会调 xhr.abort() → 队列项标记 aborted 并丢弃;
   *   HOLD_TTL 之后自动放行, 避免因为某种未知路径而永久悬空。
   * ═══════════════════════════════════════════════════════════════ */
  const HOLD_TTL = 45 * 1000;           // 挂起上限: 超过就自己放行 (兜底, 避免悬空)
  /* 【预编码·挂起模型】PUT 一直挂着不传 (同 3.8.0 语义: 开关翻到发送前都算数),
   * 但结论一到就【预先编码】把 body 做好 —— 按发送那一刻 origSend 的延迟≈0,
   * Discord 的草稿队列接得住 (附件 0%→就绪 的窗口压到最短)。
   * 8 秒还没结论 → 现场审查结论先编出来占位; 开关再翻就重编 (纯本地, 零流量)。
   * 45s TTL 兜底放行, 绝不无限悬空。 */
  let DECISION_WAIT_MS = 3000;
  const held = [];                       // [{id, xhr, url, hdrs, u8, mime, fp, sendArgs, state}]
  let heldSeq = 0;
  /* 【同步占位登记】拖入太快+发送太快时: XHR send 返回 undefined(挂起) 与
   * 字节登记进 held 之间有一段异步窗口 (bodyToU8 / 图片嗅探 / 指纹都是 await)。
   * 用户在这个窗口里按发送 → releaseAll 看到 held 为空 → 消息先走,
   * 图稍后才登记 → 没人再触发放行 → 等 45s TTL 原图放行 (未评分就发送, 实锤复现)。
   * 修: send 拦截【命中上传 URL 的那一刻】就同步推一个 placeholder
   * (state='registering'), releaseAll 先等所有 registering 落地再放行。 */
  function registerPlaceholder(self, body) {
    const it = {
      id: ++heldSeq, xhr: self, url: self.__moeUrl, hdrs: self.__moeHdrs,
      u8: null, mime: '', fp: null, ck: '', sendBody: body,
      state: 'registering', at: Date.now(), reg: null,
    };
    it.reg = new Promise((res) => { it.regDone = res; });
    self.__moeHeld = it;
    held.push(it);
    return it;
  }
  /** registering → held 的完成信号; 失败/放行/中止也要 resolve, 别让等待者悬死 */
  function settleReg(it) { try { if (it.regDone) it.regDone(); } catch (e) {} }
  /** 等 held 里全部 registering 项落地 (最多 waitMs, 超时按原图放行) */
  function awaitRegistrations(waitMs) {
    const regs = held.filter((h) => h.state === 'registering');
    if (!regs.length) return Promise.resolve();
    log({ ev: 'release-wait-registering', count: regs.length });
    return Promise.race([
      Promise.all(regs.map((h) => h.reg)),
      new Promise((r) => setTimeout(r, Math.max(200, waitMs | 0))),
    ]).then(() => {
      // 超时还没落地的 → 直接标 held (拿不到字节, releaseOne 会按原图放)
      for (const h of held) {
        if (h.state === 'registering') {
          rec({ ev: 'register-timeout', id: h.id, url: String(h.url || '').slice(0, 90) });
          h.state = 'held';
          settleReg(h);
        }
      }
    });
  }

  /* 【找这张图自己的结论】ck 精确优先, 指纹严格相等次之, 容差只信手动 */
  function decisionFor(item) {
    if (item.ck) {
      for (const d of decisions) if (d.ck && d.ck === item.ck) return d;
    }
    if (item.fp) {
      for (const d of decisions) if (!d.ck && d.fp && d.fp === item.fp) return d;
      for (const d of decisions) {
        if (!d.ck && d.fp && d.manual && Core.tagMatches && Core.tagMatches(item.fp, d.fp)) return d;
      }
    }
    return null;
  }
  /* 【预编码·挂起】结论一到就先把编码 body 做好挂在 item 上 (不放行);
   * 手动翻转 → 重编 (纯本地零流量); 超时没结论 → 现场审查先编一版占位。
   * 放行统一走 send-intent (Enter/按钮/POST) 与 45s TTL。 */
  function preencode(item) {
    if (item.state !== 'held' || item.encoding) return;
    item.encoding = true;
    (async () => {
      try {
        const d = decisionFor(item);
        const act = d
          ? { obfuscate: !!d.obfuscate, score: d.score == null ? null : d.score, source: 'pre:' + (d.manual ? 'manual' : 'auto') }
          : null;
        if (act) { await encodeInto(item, act); item.encoded = true; rec({ ev: 'pre-encode', id: item.id, as: act.obfuscate ? '混淆图' : '原图', source: act.source }); }
      } catch (e) {
        rec({ ev: 'pre-encode-err', id: item.id, err: String(e && e.message || e) });
      } finally { item.encoding = false; }
    })();
  }
  /* releaseOne 的编码体抽取成可复用函数: 结论 → body (或 null=原图) */
  async function encodeInto(item, act) {
    let body = null;
    const img = await FMT.blobToImageData(new Blob([item.u8], { type: item.mime }));
    if (act.obfuscate && !Core.detectMeta(img, cfg.salt)) {
      const t0 = Date.now();
      const src = cfg.maxDim > 0 ? FMT.resizeImageData(img, cfg.maxDim) : img;
      const enc = Core.encodeImage(src, { tile: cfg.tile || undefined, salt: cfg.salt });
      let chunks = null;
      try { chunks = Core.pngGetTextChunks(item.u8); } catch (e) {}
      const blob = await FMT.encodedToBlob(enc, chunks);
      body = await blob.arrayBuffer();
      rec({ ev: 'encode', id: item.id, in: item.u8.length, out: body.byteLength, ms: Date.now() - t0 });
    }
    item.preBody = body;        // null = 原图直通; ArrayBuffer = 混淆体
    item.preAct = act;
    item.preDone = true;        // 编码结论已出 (原图也是结论, 别让超时路径再跑一遍)
    return body;
  }

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
    if (item.state !== 'held') { rec({ ev: 'release-skip', id: item.id, state: item.state, trigger }); return; }
    item.state = 'releasing';

    /* 登记超时的占位项: 拿不到字节无从评分/混淆 → 原样放行 (失败必须外显) */
    if (!item.u8) {
      rec({ ev: 'release-empty', id: item.id, trigger, url: String(item.url || '').slice(0, 90) });
      log({ ev: 'upload-pass', why: 'register-timeout-no-bytes' });
      item.state = 'sent';
      try { origSend.call(item.xhr, item.sendBody); } catch (e2) {}
      return;
    }

    /* 预编码产物直接用 —— 按发送那一刻零编码延迟 (双回车根治的核心保证)。
     * preAct 里的结论就是放行结论 (翻转已把 preBody 重编成最新)。 */
    if (item.preAct) {
      const body0 = item.preBody, act0 = item.preAct;
      /* 放行前终检 (aborted) 同样适用 */
      if (item.state === 'aborted' || (item.xhr && item.xhr.__moeAbort)) {
        item.state = 'aborted';
        rec({ ev: 'release-abort', id: item.id, trigger });
        return;
      }
      item.state = 'sent';
      rec({ ev: 'release', id: item.id, trigger, as: body0 ? '混淆图' : '原图', why: act0.source, bytes: body0 ? body0.byteLength : item.u8.length, pre: true });
      log({ ev: 'upload-replaced', obf: !!body0, as: body0 ? '混淆图' : '原图',
            kb: ((body0 ? body0.byteLength : item.u8.length) / 1024).toFixed(0) + 'KB',
            info: (body0 ? '混淆图' : '原图') + ' · 预编码' });
      item.done = new Promise((res) => {
        const x = item.xhr;
        const fin = () => { try { x.removeEventListener('loadend', fin); x.removeEventListener('error', fin); } catch (e) {} res(); };
        try { x.addEventListener('loadend', fin); x.addEventListener('error', fin); } catch (e) { res(); return; }
        setTimeout(fin, 10000);
      });
      try { origSend.call(item.xhr, body0 || item.sendBody); } catch (e) { rec({ ev: 'release-send-err', id: item.id, err: String(e && e.message || e) }); }
      return;
    }

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

    /* 【放行前终检】编码期间用户可能删预览/切频道 (state→aborted):
     * 这时绝不能再 PUT —— 上传了一半的取消才是真取消。
     * (放在 state='sent' 之前, 否则会被覆盖成 sent) */
    if (item.state === 'aborted' || (item.xhr && item.xhr.__moeAbort)) {
      item.state = 'aborted';
      rec({ ev: 'release-abort', id: item.id, trigger });
      return;
    }
    item.state = 'sent';
    rec({ ev: 'release', id: item.id, trigger, as: label, why, bytes: body ? body.byteLength : item.u8.length });
    /* 【obf 必须带上】不然隔离世界不知道这笔到底换没换,
     * 会把原图直通也报成「已混淆上传 · 原图」(主人抓到的矛盾文案)。 */
    log({ ev: 'upload-replaced', obf: !!body, as: label,
          kb: ((body ? body.byteLength : item.u8.length) / 1024).toFixed(0) + 'KB',
          info: label + ' · ' + ((body ? body.byteLength : item.u8.length) / 1024).toFixed(0) + 'KB' });
    /* 上传结束信号: correction 重传与兜底放行要用「这一笔真正落地」的时机。 */
    item.done = new Promise((res) => {
      const x = item.xhr;
      const fin = () => { try { x.removeEventListener('loadend', fin); x.removeEventListener('error', fin); } catch (e) {} res(); };
      try { x.addEventListener('loadend', fin); x.addEventListener('error', fin); } catch (e) { res(); return; }
      setTimeout(fin, 10000);
    });
    try {
      origSend.call(item.xhr, body || item.sendBody);
    } catch (e) {
      rec({ ev: 'release-send-err', id: item.id, err: String(e && e.message || e) });
    }
  }

  /** 兜底放行: 极快发送(TTL/POST 先于登记)时把还没放行的 PUT 一次性放掉。 */
  function releaseAll(trigger) {
    dropStale();
    /* 先等正在登记中的占位项落地 (拖入快+发送快的窗口), 否则这些图会被漏掉 */
    return awaitRegistrations(3000).then(() => {
      const items = held.filter((h) => h.state === 'held');
      rec({ ev: 'release-all', trigger, count: items.length,
            decisions: decisions.map((d) => ({ fp: fpShort(d.fp), obf: !!d.obfuscate, man: !!d.manual })) });
      return Promise.all(items.map((it) => releaseOne(it, trigger)))
        .then(() => Promise.all(items.map((it) => it.done)));
    });
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
  /* 输入框判定: Enter 的 target 必须是聊天输入框 (contenteditable / textarea)。
   * 搜索框 (role=combobox) 等不算。 */
  function inComposer(el) {
    try {
      if (!el || !el.closest) return false;
      return !!el.closest('[contenteditable="true"][role="textbox"], textarea, [class*="slateTextArea"]');
    } catch (e) { return false; }
  }
  function pendingUploads() {
    return held.some((h) => h.state === 'held' || h.state === 'registering');
  }
  function onSendIntent(why) {
    /* 发送意图 = 放行挂着的 PUT (预编码 body, 零延迟)。
     * 不扣键盘、不改事件 —— 只监听, 原生流程原样走。 */
    if (!pendingUploads()) return;
    rec({ ev: 'send-intent', why,
          held: held.filter((h) => h.state === 'held').length,
          registering: held.filter((h) => h.state === 'registering').length });
    return releaseAll('intent:' + why);
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

  /* messagePosts: POST /messages 计数 (调试与 correction 判据, 不再扣键) */
  let messagePosts = 0;



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
      /* registering 也要一并作废 —— 立即放行模型下登记窗口很短,
       * 但用户删预览图正发生在这窗口里时, 字节就绪后绝不能再 PUT。 */
      if (it && (it.state === 'held' || it.state === 'registering' || it.state === 'releasing')) {
        it.state = 'aborted';
        const i = held.indexOf(it);
        if (i >= 0) held.splice(i, 1);
        settleReg(it);
        rec({ ev: 'hold-abort', id: it.id, state: it.state, fp: fpShort(it.fp) });
      }
    } catch (e) {}
    return origAbort.apply(this, arguments);
  };

  XHRProto.send = function (body) {
    const self = this;
    try {
      /* POST /messages: 只计数 + 兜底放行尚未处理的项 (不阻塞) */
      if (cfg.enabled && isMessagePost(this.__moeMethod, this.__moeUrl)) {
        messagePosts++;
        onSendIntent('post-messages');
      }
      if (!cfg.enabled || this.__moeMethod !== 'PUT' || !isUploadUrl(this.__moeUrl)) {
        return origSend.apply(this, arguments);
      }
      log({ ev: 'upload-seen', url: String(this.__moeUrl).slice(0, 90) });

      /* 同步占位 (registering), 字节一就绪 → 立即编码放行 (immediate-release)。 */
      const args = arguments;
      const placeholder = registerPlaceholder(self, body);
      bodyToU8(body).then(async (u8) => {
        try {
          if (!u8) { placeholder.state = 'aborted'; settleReg(placeholder); log({ ev: 'upload-pass', why: 'body-not-bytes:' + (body && body.constructor ? body.constructor.name : typeof body) }); return origSend.apply(self, args); }
          const mime = sniffImage(u8);
          if (!mime) { placeholder.state = 'aborted'; settleReg(placeholder); log({ ev: 'upload-pass', why: 'not-image bytes[0..3]=' + Array.from(u8.slice(0, 4)).join(',') }); return origSend.apply(self, args); }
          if (mime === 'image/gif' || mime === 'image/webp-animated') {
            if (cfg.skipAnimated) { placeholder.state = 'aborted'; settleReg(placeholder); log({ ev: 'skipped', name: 'upload', msg: '动画图原样发送' }); return origSend.apply(self, args); }
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
          /* 字节/指纹就绪 → 原地升级占位项 (不新建, 保持引用不变) */
          placeholder.u8 = u8;
          placeholder.mime = realMime;
          placeholder.fp = fp;
          placeholder.ck = ck;
          if (placeholder.state === 'aborted') return;   // 登记期被 abort
          placeholder.state = 'held';
          settleReg(placeholder);
          rec({ ev: 'hold', id: placeholder.id, fp: fpShort(fp), ck: ck.slice(0, 12), bytes: u8.length, mime: realMime, heldTotal: held.length });
          log({ ev: 'tracked', name: 'upload', size: u8.length, type: realMime });
          /* 【预编码·挂起】结论一到就先编码 (不放行, PUT 挂着);
           * 3s 没结论 → 现场审查编一版占位 (开关翻动会重编)。
           * 放行只由 send-intent / 45s TTL / abort 触发。 */
          preencode(placeholder);
          setTimeout(() => {
            if (placeholder.state === 'held' && !placeholder.preDone && !placeholder.encoding) {
              /* 没结论 → 现场审查一版编好, 占位等发送 */
              (async () => {
                try {
                  const Review = window.__MoeGuardReview;
                  const img = await FMT.blobToImageData(new Blob([placeholder.u8], { type: placeholder.mime }));
                  const act = Review
                    ? await Review.resolveAction(img, placeholder.ck ? [] : decisions, cfg, { tag: Core.perceptualTag, tagMatches: Core.tagMatches, remoteFn: remoteScore })
                        .catch(() => ({ obfuscate: true, score: 1, source: 'fallback' }))
                    : { obfuscate: true, score: 1, source: 'no-review' };
                  await encodeInto(placeholder, act);
                  rec({ ev: 'pre-encode', id: placeholder.id, as: act.obfuscate ? '混淆图' : '原图', source: 'timeout:' + act.source });
                } catch (e) { rec({ ev: 'pre-encode-err', id: placeholder.id, err: String(e && e.message || e) }); }
              })();
            }
          }, DECISION_WAIT_MS);
        } catch (e) {
          log({ ev: 'error', msg: 'xhr-hold: ' + (e && e.message ? e.message : e) });
          try { return origSend.apply(self, args); } catch (e2) {}
        }
      }).catch((e) => {
        settleReg(placeholder);
        if (placeholder.state === 'registering') placeholder.state = 'aborted';
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
          messagePosts++;
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
        /* 手动翻转 ✕/○ → 挂着的 PUT 【重编】新结论 (不产生流量, 放行仍在发送时)。
         * 翻多少次都行: 每次重编都是纯本地, 发出去的一定是最后一次的结论。 */
        const flip = e.data.manualFlip;
        if (flip && (flip.ck || flip.fp)) {
          for (const h of held) {
            if (h.state !== 'held') continue;
            const hit = (flip.ck && h.ck === flip.ck) ||
                        (!flip.ck && flip.fp && h.fp && Core.tagMatches && Core.tagMatches(h.fp, flip.fp));
            if (!hit) continue;
            h.preBody = null; h.preAct = null;      // 旧编码作废
            preencode(h);
            rec({ ev: 'flip-reencode', id: h.id });
          }
        }
        rec({
          ev: 'decisions-sync', was: prev, now: decisions.length,
          flip: flip ? flip.ck.slice(0, 12) : null,
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
    setConfig(c) { Object.assign(cfg, c || {}); if (c && typeof c.decisionWaitMs === 'number') DECISION_WAIT_MS = Math.max(0, c.decisionWaitMs); },
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