/* ══════════════════════════════════════════════════════════════════
 * MoeGuard 审查模块 —— 「只混淆色情图片」的判定层
 * ══════════════════════════════════════════════════════════════════
 * 定位: 纯逻辑, 不依赖 DOM / 不发网络请求 → Node / 主世界 / SW 三端复用
 *
 * 两级判定 (所有图片都会走一遍):
 *   1. 本地启发式 localScore(img)  ← 默认, 零网络零隐私风险
 *   2. 可选远端 API (由调用方注入 remoteFn) ← 需用户显式开启
 *
 * ⚠️ 诚实声明: localScore 是「肤色面积 + 集中度 + 平滑度」的启发式,
 *   不是真正的分类模型。它能拦住大面积裸露, 但对艺术插画/泳装/特写会误判。
 *   要认真做只能上模型 (本地 nsfwjs/WASM) 或商用审查 API。
 *   因此默认策略是 **全部混淆** (nsfwOnly=false), 审查只是可选优化。
 *
 * 失败策略: 任何一步出错 → 判定为「需要混淆」(保守, 宁可多混淆不可漏)
 * ══════════════════════════════════════════════════════════════════ */
'use strict';
(function (root) {

  /** 单像素肤色判定: Kovac RGB 规则 + YCbCr 区间双重确认 */
  function isSkin(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (!(r > 95 && g > 40 && b > 20 && mx - mn > 15 && Math.abs(r - g) > 15 && r > g && r > b)) return false;
    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    return cr >= 133 && cr <= 180 && cb >= 74 && cb <= 130;
  }

  /**
   * 本地启发式打分
   * @param img {width,height,data}
   * @returns {score:0..1, skinRatio, concentration, smoothness, samples}
   */
  function localScore(img) {
    const w = img.width | 0, h = img.height | 0, d = img.data;
    if (!(w > 7 && h > 7) || !d || !d.length) {
      return { score: 0, skinRatio: 0, concentration: 0, smoothness: 0, samples: 0, reason: 'too-small' };
    }
    // 采样到长边约 160px, 控制开销
    const step = Math.max(1, Math.round(Math.max(w, h) / 160));
    const G = 8;                                  // 8×8 粗网格做集中度
    const cellSkin = new Int32Array(G * G);
    const cellAll = new Int32Array(G * G);
    let skin = 0, total = 0;
    let gradSum = 0, gradN = 0;

    for (let y = 0; y < h; y += step) {
      const gy = Math.min(G - 1, ((y * G) / h) | 0);
      for (let x = 0; x < w; x += step) {
        const i = (y * w + x) * 4;
        const a = d[i + 3];
        if (a < 24) continue;                     // 透明区不算
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const gx = Math.min(G - 1, ((x * G) / w) | 0);
        const c = gy * G + gx;
        cellAll[c]++;
        total++;
        const sk = isSkin(r, g, b);
        if (sk) { skin++; cellSkin[c]++; }
        // 肤色区的局部梯度: 裸露皮肤大而平滑, 花衣服/文字/UI 图梯度高
        if (sk && x + step < w) {
          const j = (y * w + (x + step)) * 4;
          gradSum += Math.abs(r - d[j]) + Math.abs(g - d[j + 1]) + Math.abs(b - d[j + 2]);
          gradN++;
        }
      }
    }
    if (!total) return { score: 0, skinRatio: 0, concentration: 0, smoothness: 0, samples: 0, reason: 'no-opaque-px' };

    const skinRatio = skin / total;

    // 集中度: 肤色占比 > 45% 的格子里最大的四连通块 / 总格子数
    const hot = new Uint8Array(G * G);
    for (let c = 0; c < G * G; c++) hot[c] = cellAll[c] > 0 && cellSkin[c] / cellAll[c] > 0.45 ? 1 : 0;
    let best = 0;
    const seen = new Uint8Array(G * G);
    const stack = [];
    for (let c0 = 0; c0 < G * G; c0++) {
      if (!hot[c0] || seen[c0]) continue;
      let size = 0;
      stack.length = 0;
      stack.push(c0);
      seen[c0] = 1;
      while (stack.length) {
        const c = stack.pop();
        size++;
        const cy = (c / G) | 0, cx = c % G;
        const nb = [];
        if (cx > 0) nb.push(c - 1);
        if (cx < G - 1) nb.push(c + 1);
        if (cy > 0) nb.push(c - G);
        if (cy < G - 1) nb.push(c + G);
        for (const n of nb) if (hot[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
      }
      if (size > best) best = size;
    }
    const concentration = best / (G * G);

    // 平滑度: 梯度越低越平滑 (0..1)
    const avgGrad = gradN ? gradSum / gradN : 255;
    const smoothness = Math.max(0, Math.min(1, 1 - avgGrad / 90));

    // 加权: 面积为主, 集中成片与平滑作为加成
    const areaTerm = Math.max(0, Math.min(1, (skinRatio - 0.14) / 0.42));
    const score = Math.max(0, Math.min(1,
      areaTerm * 0.62 + concentration * 0.26 + areaTerm * smoothness * 0.12));

    return {
      score: +score.toFixed(3),
      skinRatio: +skinRatio.toFixed(3),
      concentration: +concentration.toFixed(3),
      smoothness: +smoothness.toFixed(3),
      samples: total,
    };
  }

  /**
   * 判定是否需要混淆 —— 所有图片都会走这里
   * @param img      {width,height,data}
   * @param cfg      {nsfwOnly, nsfwThreshold, reviewMode}
   *                 reviewMode: 'local' | 'remote' | 'both'
   * @param remoteFn 可选 async (img) => number 0..1  (由调用方注入; 走网络)
   * @returns {obfuscate:boolean, score:number, source:string, detail?}
   */
  async function decide(img, cfg, remoteFn) {
    cfg = cfg || {};
    // 默认策略: 不启用审查 → 全部混淆
    if (cfg.nsfwOnly !== true) return { obfuscate: true, score: 1, source: 'always' };
    const th = typeof cfg.nsfwThreshold === 'number' ? cfg.nsfwThreshold : 0.7;
    const mode = cfg.reviewMode || 'local';
    let local = null, remote = null;

    if (mode === 'local' || mode === 'both') {
      try { local = localScore(img); } catch (e) { local = null; }
    }
    if ((mode === 'remote' || mode === 'both') && typeof remoteFn === 'function') {
      try {
        const v = await remoteFn(img);
        if (typeof v === 'number' && isFinite(v)) remote = Math.max(0, Math.min(1, v));
      } catch (e) { remote = null; }
    }

    // 远端拿到分就以远端为准 (更准); 否则退回本地; 两者都没有 → 保守混淆
    let score, source;
    if (remote !== null && local) { score = Math.max(remote, local.score); source = 'both'; }
    else if (remote !== null) { score = remote; source = 'remote'; }
    else if (local) { score = local.score; source = 'local'; }
    else return { obfuscate: true, score: 1, source: 'fallback' };

    return { obfuscate: score >= th, score: +score.toFixed(3), source, detail: local || undefined };
  }

  /**
   * 【流程铁律】上传时的最终动作解析 —— 先审查, 后编码
   *   色情与非色情走同一条路: 先查预览阶段的既定结论, 没有则现场审查。
   *   调用方拿到 obfuscate=false 就绝不得调 encodeImage。
   * @param img       {width,height,data}
   * @param decisions [{fp, obfuscate}] 预览阶段定下的结论 (可为空)
   * @param cfg       同 decide
   * @param deps      {tag(img)→string, tagMatches(a,b)→bool, remoteFn?}
   * @returns {obfuscate, score, source}  source 带 '/decided' 表示命中既定结论
   */
  async function resolveAction(img, decisions, cfg, deps) {
    deps = deps || {};
    const list = Array.isArray(decisions) ? decisions : [];
    if (list.length && typeof deps.tag === 'function' && typeof deps.tagMatches === 'function') {
      const t = deps.tag(img);
      /* 【安全序解析】指纹是感知哈希, 不可能零碰撞:
       *   两张色调相近的图可能同时命中。若只取第一个命中项,
       *   用户对 B 图点的「改成混淆」会被 A 图的「不混淆」遮蔽 → 漏发原图。
       * 优先级: 手动 > 自动; 同为手动取【时间最新】(用户反复切时以最后一次为准);
       *   同为自动则混淆优先 (漏发原图的代价远大于多混一张)。 */
      let hit = null;
      const better = (a, b) => {                        // a 是否比 b 更该采用
        if (!b) return true;
        if (!!a.manual !== !!b.manual) return !!a.manual;
        if (a.manual) return (a.at || 0) >= (b.at || 0);  // 手动: 取最新
        return !!a.obfuscate && !b.obfuscate;            // 自动: 混淆优先
      };
      for (const d of list) {
        if (!deps.tagMatches(t, d.fp)) continue;
        if (better(d, hit)) hit = d;
      }
      if (hit) {
        return { obfuscate: !!hit.obfuscate, score: hit.score == null ? null : hit.score, source: 'decided' };
      }
      /* 指纹没命中, 但用户手动要求过混淆 → 宁可多混不可漏发
       * 为何会没命中: Discord 上传前会重压/缩尺寸(webp), 而 tagMatches 要求尺寸严格相等;
       *   尺寸一变指纹永远对不上 → 手动结论就会被静默丢掉, 发出原图。
       * 只看【最新的手动结论】: 它说混就混, 说不混就回落审查
       *   (若不看时间只看“存在任何手动混淆”, 用户取消后仍会发混淆图) */
      let lastManual = null;
      for (const d of list) {
        if (!d.manual) continue;
        if (!lastManual || (d.at || 0) >= (lastManual.at || 0)) lastManual = d;
      }
      if (lastManual && lastManual.obfuscate) {
        return { obfuscate: true, score: null, source: 'manual-fallback' };
      }
    }
    const r = await decide(img, cfg, deps.remoteFn);
    return { obfuscate: r.obfuscate, score: r.score, source: r.source + '/inline' };
  }

  const API = { isSkin, localScore, decide, resolveAction };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.__MoeGuardReview = API;
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null));
