/* ══════════════════════════════════════════════════════════════════
 * MoeGuard 喵图混淆 —— 图片载体工具 (Blob ↔ ImageData ↔ PNG)
 * 依赖 document/canvas, 供 hook(页面主世界) 与 content(隔离世界) 共用
 *
 * ══ Firefox 隔离世界的 realm 规则 (152 实测, 2026-09, 见下方逐条注释) ══
 *   隔离世界(content script)运行在沙箱 realm, 页面的 DOM 对象透过 Xray 包装可见。
 *   方向是【不对称】的:
 *     页面 → 沙箱  读:  沙箱数组.set(xray的 imageData.data)      ✓ 可以
 *     沙箱 → 页面  写:  xray的 imageData.data.set(沙箱数组)      ✗ Permission denied
 *                       new ImageData(沙箱数组,w,h) → putImageData ✗ Failed to extract…
 *                       compressionWriter.write(沙箱数组)          ✗ TypeError 转换失败
 *   所有【把沙箱字节交给页面 realm API】的地方都必须先过一道:
 *     · cloneInto(u8, window.wrappedJSObject)   → 结构化克隆到页面 realm
 *     · 或塞进 Blob (BlobPart 转换不走 ArrayBufferView 联合类型, 沙箱数组照收)
 *   Chrome 的隔离世界没有这层限制, 所以这些坑只在 Firefox 暴露。
 * ══════════════════════════════════════════════════════════════════ */
'use strict';
(function (global) {
  const w = (global._moeFormat = {});
  w.lastFastPngErr = '';   // 最近一次 PNG 编码回落原因 (诊断面板用)
  w.lastPngPath = '';      // 最近一次实际走的编码路径: fast | canvas | store

  /* ---------- realm 桥 ----------
   * pageBytes(u8): 把本 realm 的字节变成【页面 realm 能接受】的同内容对象。
   *   Firefox 隔离世界 → cloneInto (一次结构化克隆)
   *   Chrome / 主世界   → 原样返回 (无 realm 边界, 零开销)
   * 只在必须交给 canvas/ImageData 的地方调, 不要污染纯计算路径。 */
  const PAGE = (function () {
    try { return (typeof window !== 'undefined' && window.wrappedJSObject) || null; }
    catch (e) { return null; }
  })();
  const CAN_CLONE = PAGE && typeof cloneInto === 'function';
  w.crossRealm = !!CAN_CLONE;                       // 诊断用: 是否处于需要跨 realm 的沙箱
  function pageBytes(u8) {
    if (!CAN_CLONE) return u8;
    try { return cloneInto(u8, PAGE); } catch (e) { return u8; }
  }

  /** 页面 realm 的 TypedArray → 本 realm 的副本
   * getImageData 拿到的数组带 Xray 包装, 逐元素读虽然合法但慢, 且传不回页面 API。
   * 一次 memcpy 换来下游全程零边界。 */
  function localBytes(src) {
    const out = new Uint8ClampedArray(src.length);
    out.set(src);
    return out;
  }

  /* ---------- Blob → 本 realm 字节 (所有 PNG 字节都得走这里) ----------
   * 【Firefox 隔离世界必须拷一次】blob.arrayBuffer() / Response / FileReader 拿到的
   * ArrayBuffer 属于页面 realm。包出来的 Uint8Array 视图看着完全正常
   * (length 对、下标读得出、循环求和都对), 但只要碰【派生】操作就炸:
   *     u8.subarray(a, b)                   → Error: Permission denied to access property "constructor"
   *     new TextDecoder().decode(u8.subarray(…)) → 同上
   *   (TypedArray 派生要读 @@species 构造器, 跨 realm 不给访问)
   * core.js 里 PNG chunk 的读写全靠 subarray + TextDecoder →
   * 直接喂这种视图会让 moEg/moMt 【静默丢失】(外面全是 try/catch):
   * 对方预筛读不到标记 → 根本不触发解码, 表现就是「插件没反应」。
   * u8.set(跨 realm 视图) 是允许的 (只读源、目标在本 realm) → 一次 memcpy 解决。 */
  w.blobToBytes = async function (blob) {
    const src = new Uint8Array(await blob.arrayBuffer());
    const out = new Uint8Array(src.length);
    out.set(src);
    return out;
  };

  w.isStaticImage = function (type) {
    return /^image\/(png|jpeg|jpg|webp|bmp)$/i.test(type || '');
  };
  w.isObfuscatable = function (f) {
    return f && w.isStaticImage(f.type || '');
  };

  /* ---------- 输入: File/Blob → {width,height,data} ----------
   * 像素级精确, EXIF 方向由 createImageBitmap 自动纠正。
   * 这条路是【页面 → 沙箱】方向, Firefox 允许, 只需把结果拷成本 realm 数组。 */
  w.blobToImageData = async function (blob) {
    const bmp = await createImageBitmap(blob);
    try {
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const id = ctx.getImageData(0, 0, bmp.width, bmp.height);
      return { width: id.width, height: id.height, data: localBytes(id.data) };
    } finally {
      try { bmp.close(); } catch (e) {}
    }
  };

  /* ---------- 输出: ImageData → canvas ----------
   * 【Firefox 隔离世界必须 cloneInto】两条写法都会被拒:
   *   ctx.createImageData(w,h).data.set(沙箱数组)
   *     → Error: Permission denied to access object
   *   new ImageData(沙箱数组, w, h) → putImageData
   *     → InvalidStateError: Failed to extract Uint8ClampedArray from ImageData (security check failed?)
   * v3.6.3 只换成 createImageData 是没用的 —— 拒收点在 .data.set 那一步,
   * 换谁造 ImageData 都一样, 真正的关口是【字节属于哪个 realm】。 */
  w.imageDataToCanvas = function (im) {
    const c = document.createElement('canvas');
    c.width = im.width;
    c.height = im.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const bytes = pageBytes(im.data);
    const id = ctx.createImageData(im.width, im.height);
    id.data.set(bytes);
    ctx.putImageData(id, 0, 0);
    return c;
  };

  /* ---------- 统一 PNG 编码入口 (三级回落) ----------
   * 1. Core.encodePngFast   CompressionStream, 走 Blob 输入 → 无 realm 问题, 最快
   * 2. canvas.toBlob        压缩率最高但极慢 (1.8MP ~1s), 且需 cloneInto 过桥
   * 3. Core.encodePngStore  纯 JS 不压缩, 零浏览器 API —— 一定能出结果
   * 每级失败都记进 lastFastPngErr, 不再静默吞掉首发异常
   * (v3.6.3 之前吞掉了, 结果 Firefox 上只能看到下游 putImageData 报错, 查不到根因) */
  w.encodePng = async function (im) {
    const Core = window.__MoeGuardCore;
    const errs = [];
    if (Core && Core.encodePngFast) {
      try {
        const u8 = await Core.encodePngFast(im);
        w.lastFastPngErr = '';
        w.lastPngPath = 'fast';
        return u8;
      } catch (e) { errs.push('fast:' + msg(e)); }
    } else {
      errs.push('fast:no-core');
    }
    try {
      const blob = await new Promise((res, rej) => {
        try { w.imageDataToCanvas(im).toBlob((b) => (b ? res(b) : rej(new Error('null-blob'))), 'image/png'); }
        catch (e) { rej(e); }
      });
      w.lastFastPngErr = errs.join(' | ');
      w.lastPngPath = 'canvas';
      // 必须过 blobToBytes: 直接 new Uint8Array(await blob.arrayBuffer()) 在 Firefox
      // 隔离世界里 subarray 会被拒 → 后面插 moEg/moMt 全部静默失败
      return await w.blobToBytes(blob);
    } catch (e) { errs.push('canvas:' + msg(e)); }
    if (Core && Core.encodePngStore) {
      try {
        const u8 = Core.encodePngStore(im);
        w.lastFastPngErr = errs.join(' | ');
        w.lastPngPath = 'store';
        return u8;
      } catch (e) { errs.push('store:' + msg(e)); }
    }
    w.lastFastPngErr = errs.join(' | ');
    w.lastPngPath = 'none';
    throw new Error('png-encode-failed: ' + errs.join(' | '));
  };
  function msg(e) { return String((e && e.message) || e).slice(0, 70); }

  w.imageDataToBlob = async function (im, type) {
    // 只有 PNG 走无损快路; 其它格式(极少用)才落 canvas
    if (!type || type === 'image/png') {
      return new Blob([await w.encodePng(im)], { type: 'image/png' });
    }
    const c = w.imageDataToCanvas(im);
    return new Promise((res) => c.toBlob((b) => res(b), type));
  };

  // 混淆产物専用: PNG + 插入 moEg 标记块 (让对方只读 128 字节就能认出喵图)
  // 可选携带原图文本元数据 (ComfyUI workflow 等, 存 moMt chunk)
  w.encodedToBlob = async function (enc, chunks) {
    const Core = window.__MoeGuardCore;
    let u8 = await w.encodePng(enc);
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
    let u8 = await w.encodePng(im);
    if (Core && chunks && chunks.length) {
      try { u8 = Core.pngRestoreTextChunks(u8, chunks); } catch (e) {}
    }
    return new Blob([u8], { type: 'image/png' });
  };

  /* dataURL: 只给远端审查用 (缩到 512 后再转, 降带宽也降泄露面)
   * canvas.toDataURL 必须先过 cloneInto 桥, imageDataToCanvas 已经处理。 */
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
      // 拷回本 realm: 缩放结果会继续喂给编码器/审查层
      return { width: nw, height: nh, data: localBytes(id.data) };
    }
    return im;
  };
})(window);
