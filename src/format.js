/* ══════════════════════════════════════════════════════════════════
 * MoeGuard 喵图混淆 —— 图片载体工具 (Blob ↔ ImageData ↔ PNG)
 * 依赖 document/canvas, 供 hook(页面主世界) 与 content(隔离世界) 共用
 * ══════════════════════════════════════════════════════════════════ */
'use strict';
(function (global) {
  const w = (global._moeFormat = {});

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
      return { width: id.width, height: id.height, data: id.data };
    } finally {
      try { bmp.close(); } catch (e) {}
    }
  };

  w.imageDataToCanvas = function (im) {
    const c = document.createElement('canvas');
    c.width = im.width;
    c.height = im.height;
    c.getContext('2d').putImageData(new ImageData(im.data, im.width, im.height), 0, 0);
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
      try { u8 = await Core.encodePngFast(enc); } catch (e) { u8 = null; }
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
      try { u8 = await Core.encodePngFast(im); } catch (e) { u8 = null; }
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