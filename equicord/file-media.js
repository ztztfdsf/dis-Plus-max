'use strict';
// Shared by browser drafts and the Equicord adapter. No transport or host APIs.
globalThis.MoeGuardFileMedia = function createFileMedia(core) {
    const maxBytes = 32 * 1024 * 1024;
    const maxPixels = 12 * 1024 * 1024;
    function dimensions(w, h, limit = maxPixels) {
        if (!(w > 0 && h > 0 && w <= 65535 && h <= 65535 && w * h <= limit)) throw new Error('图片尺寸超过本地处理上限');
    }
    // Carrier padding/frame can make an otherwise supported input a little larger.
    const maxCarrierPixels = 16 * 1024 * 1024;
    function checkPng(bytes, limit) {
        if (bytes.length < 33 || !core.isPng(bytes)) throw new Error('PNG 文件头不完整');
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) throw new Error('缺少 PNG 尺寸头');
        dimensions(view.getUint32(16), view.getUint32(20), limit);
        for (let i = 8; i + 12 <= bytes.length;) {
            const len = view.getUint32(i), type = view.getUint32(i + 4);
            if (len > bytes.length - i - 12) throw new Error('PNG 数据块不完整');
            if (type === 0x6163544c) throw new Error('不支持动画 PNG，未将其转换成单帧'); // acTL precedes IDAT
            if (type === 0x49444154) return;
            i += len + 12;
        }
        throw new Error('缺少 PNG 像素数据');
    }
    // Reject unsupported or oversized JPEGs before the browser allocates the bitmap.
    function checkJpeg(bytes) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (bytes.length < 4 || view.getUint16(0) !== 0xffd8) throw new Error('不是 JPEG 文件');
        for (let i = 2; i < bytes.length;) {
            if (bytes[i++] !== 0xff) break;
            while (i < bytes.length && bytes[i] === 0xff) i++;
            const marker = bytes[i++];
            if (marker === 0xd9 || marker === 0xda || i + 2 > bytes.length) break;
            if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
            const n = view.getUint16(i);
            if (n < 2 || n > bytes.length - i) break;
            if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
                if (n < 8) break;
                dimensions(view.getUint16(i + 5), view.getUint16(i + 3));
                return;
            }
            i += n;
        }
        throw new Error('缺少 JPEG 尺寸头');
    }
    async function pixels(blob, limit, maxDim = 0) {
        const bmp = await createImageBitmap(blob);
        try {
            dimensions(bmp.width, bmp.height, limit);
            const scale = maxDim > 0 ? Math.min(1, maxDim / Math.max(bmp.width, bmp.height)) : 1;
            const c = new OffscreenCanvas(Math.max(1,Math.round(bmp.width*scale)), Math.max(1,Math.round(bmp.height*scale)));
            const ctx = c.getContext('2d', { willReadFrequently: true });
            if (!ctx) throw new Error('无法读取图片像素');
            ctx.drawImage(bmp, 0, 0, c.width, c.height);
            return ctx.getImageData(0, 0, c.width, c.height);
        } finally { bmp.close(); }
    }
    async function makeCarrier(img, inputBytes, salt, tile = 0) {
        dimensions(img.width, img.height);
        const t = tile ? Math.min(tile,core.V3_CAP_TILE || 256) : core.v3TileSize(img.width, img.height), pad = 2 * core.V3_FRAME;
        dimensions(Math.ceil(img.width / t) * t + pad, Math.ceil(img.height / t) * t + pad, maxCarrierPixels);
        const enc = core.encodeImage(img, { salt, tile });
        let bytes = await core.encodePngFast(enc);
        const chunks = core.pngGetTextChunks(inputBytes);
        if (chunks?.length) bytes = core.pngPutTextChunks(bytes, chunks);
        bytes = core.pngAddMarker(bytes, enc.meta);
        const m = core.pngReadMarker(bytes.subarray(0, 128), salt);
        if (!m?.saltOk || m.w !== img.width || m.h !== img.height) throw new Error('输出标记校验失败');
        return bytes;
    }
    async function encodeFile(file, salt, opts = {}) {
        if (!file.size || file.size > maxBytes || !['image/png', 'image/jpeg'].includes(file.type)) throw new Error('请选择 32 MiB 以内的 PNG 或 JPEG');
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (core.pngMarkerPayload(bytes.subarray(0, 128))) throw new Error('已经是 MoeGuard 图，未重复混淆');
        if (file.type === 'image/png') checkPng(bytes, maxPixels);
        else checkJpeg(bytes);
        const carrier = await makeCarrier(await pixels(file, maxPixels, opts.maxDim), bytes, salt, opts.tile);
        if (carrier.byteLength > maxBytes) throw new Error('生成的 PNG 超过本插件的 32 MiB 上限，未加入草稿');
        return new File([carrier], (file.name.replace(/\.[^.]*$/, '') || 'image') + '.png', { type: 'image/png' });
    }
    async function restorePixels(img, bytes, salt) {
        dimensions(img.width, img.height, maxCarrierPixels);
        const dec = core.decodeImage(img, { salt });
        if (!dec.ok) throw new Error('无法还原：' + dec.reason);
        let out = await core.encodePngFast(dec);
        const chunks = core.pngReadMetaChunks(bytes);
        if (chunks?.length) out = core.pngRestoreTextChunks(out, chunks);
        return out;
    }
    async function decodeFile(file, salt) {
        if (!file.size || file.size > maxBytes) throw new Error('文件为空或超过 32 MiB');
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (!core.pngMarkerPayload(bytes.subarray(0, 128))) throw new Error('不是带 MoeGuard 标记的 PNG 原文件');
        if (core.pngReadMarker(bytes.subarray(0, 128), salt)?.saltOk === false) throw new Error('盐值不匹配');
        // restorePixels verifies the actual image metadata and both salt bytes before producing output.
        checkPng(bytes, maxCarrierPixels);
        return new Blob([await restorePixels(await pixels(file, maxCarrierPixels), bytes, salt)], { type: 'image/png' });
    }
    return {maxBytes, makeCarrier, encodeFile, restorePixels, decodeFile};
};
