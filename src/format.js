/* ══════════════════════════════════════════════════════════════════
 * MoeGuard 喵图混淆 —— 图片载体工具 (Blob ↔ ImageData ↔ PNG)
 * 依赖 document/canvas, 供 hook(页面主世界) 与 content(隔离世界) 共用
 * ══════════════════════════════════════════════════════════════════ */
'use strict';
(function (global) {
  const w = (global._moeFormat = {});
  w.lastFastPngErr = '';   // 最近一次快速 PNG 编码失败原因 (诊断面板用)

  w.isStaticImage = function (type) {
    return /^image\/(png|jpeg|jpg|webp|bmp)$/i.test(type || '');
  };
  w.isObfuscatable = function (f) {
    return f && w.isStaticImage(f.type || '');
  };

  // File/Blob → {width,height,data} (像素级精确, EXIF 方向自动纠正)
  w.blobToImageData = async function (blob) {
    const bmp = await createImageBitmap(blob);
    try {
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const id = ctx.getImageData(0, 0, bmp.width, bmp.height);
      /* 【跨 realm 防护】canvas 属于页面 realm, getImageData 拿到的
       * Uint8ClampedArray 也是那边的(Firefox 带 Xray 包装)。
       * 在这里一次拷成本 realm 的数组 —— 下游 core.js 的像素循环
       * 与 PNG 编码就全程跑在本地对象上, 不再碰 realm 边界。
       * 代价是一次 memcpy, 相比后面的变换开销可忽略。 */
      const local = new Uint8ClampedArray(id.data.length);
      local.set(id.data);
      return { width: id.width, height: id.height, data: local };
    } finally {
      try { bmp.close(); } catch (e) {}
    }
  };

  w.imageDataToCanvas = function (im) {
    const c = document.createElement('canvas');
    c.width = im.width;
    c.height = im.height;
    const ctx = c.getContext('2d');
    /* 【Firefox 必须这么写】隔离世界(content script)与页面是不同 realm。
     * document.createElement 拿到的 canvas 属于【页面 realm】(带 Xray 包装),
     * 而 new ImageData(...) 造出来的是【隔离世界】的对象 →
     * putImageData 时 Firefox 无法跳 realm 取出里面的 Uint8ClampedArray, 直接抛:
     *   "Failed to extract Uint8ClampedArray from ImageData (security check failed?)"
     * 用 ctx.createImageData() 让 ImageData 与 ctx 同 realm 就没这问题。
     * (Chrome 的隔离世界没有这层限制, 所以之前一直没暴露) */
    let id = null;
    try {
      id = ctx.createImageData(im.width, im.height);
      id.data.set(im.data);
    } catch (e) {
      id = null;
    }
    if (!id) id = new ImageData(im.data, im.width, im.height);
    ctx.putImageData(id, 0, 0);
    return c;
  };

  w.imageDataToBlob = function (im, type) {
    type = type || 'image/png';
    const c = w.imageDataToCanvas(im);
    return new Promise((res) => c.toBlob((b) => res(b), type));
  };

  // 混淆产物専用: PNG + 插入 moEg 标记块 (让对方只读 128 字节就能认出喵图)
  // 可选携带原图文本元数据 (ComfyUI workflow 等, 存 moMt chunk)
  // 性能: 优先用 core.encodePngFast (CompressionStream, 实测比 canvas.toBlob 快 ~5x)
  //   canvas 的 PNG 编码器用最高压缩等级且不可调, 1.8MP 图要 ~1s; 我们不在乎多几百 KB
  w.encodedToBlob = async function (enc, chunks) {
    const Core = window.__MoeGuardCore;
    let u8 = null;
    if (Core && Core.encodePngFast) {
      /* 失败原因记下来 —— 以前这里静默回落 canvas,
       * 结果 Firefox 上真正的首发异常被吞掉, 只看到下游 putImageData 报错。 */
      try { u8 = await Core.encodePngFast(enc); w.lastFastPngErr = ''; }
      catch (e) { u8 = null; w.lastFastPngErr = 'enc:' + String((e && e.message) || e).slice(0, 80); }
    }
    if (!u8) {
      const blob = await w.imageDataToBlob(enc, 'image/png');
      u8 = new Uint8Array(await blob.arrayBuffer());
    }
    if (!Core || !enc.meta) return new Blob([u8], { type: 'image/png' });
    // 【顺序要紧】先插 moMt 再插 moEg
    //   两个函数都插在 IHDR 后, 后插的在前。moMt 可能大到 1.2MB (ComfyUI workflow),
    //   若 moEg 先插就会被 moMt 顶到 128 字节之外 → 对方预筛读不到标记 → 不触发解码。
    if (chunks && chunks.length) {
      try { u8 = Core.pngPutTextChunks(u8, chunks); } catch (e) {}
    }
    try { u8 = Core.pngAddMarker(u8, enc.meta); } catch (e) {}
    return new Blob([u8], { type: 'image/png' });
  };

  // 解码产物専用: 把 moMt 里的元数据 (ComfyUI 工作流) 以标准 tEXt 写回还原图
  w.decodedToBlob = async function (im, chunks) {
    const Core = window.__MoeGuardCore;
    let u8 = null;
    if (Core && Core.encodePngFast) {
      try { u8 = await Core.encodePngFast(im); w.lastFastPngErr = ''; }
      catch (e) { u8 = null; w.lastFastPngErr = 'dec:' + String((e && e.message) || e).slice(0, 80); }
    }
    if (!u8) {
      const blob = await w.imageDataToBlob(im, 'image/png');
      u8 = new Uint8Array(await blob.arrayBuffer());
    }
    if (Core && chunks && chunks.length) {
      try { u8 = Core.pngRestoreTextChunks(u8, chunks); } catch (e) {}
    }
    return new Blob([u8], { type: 'image/png' });
  };

  w.imageDataToDataURL = function (im) {
    return w.imageDataToCanvas(im).toDataURL('image/png');
  };

  // 可选有损缩放 (默认关闭; 开启时解码得到的是缩放后的图)
  w.resizeImageData = function (im, maxDim) {
    const m = Math.max(im.width, im.height);
    if (maxDim > 0 && m > maxDim) {
      const s = maxDim / m;
      const nw = Math.max(1, Math.round(im.width * s));
      const nh = Math.max(1, Math.round(im.height * s));
      const c = document.createElement('canvas');
      c.width = nw; c.height = nh;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(w.imageDataToCanvas(im), 0, 0, nw, nh);
      const id = ctx.getImageData(0, 0, nw, nh);
      return { width: nw, height: nh, data: id.data };
    }
    return im;
  };
})(window);