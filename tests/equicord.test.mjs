// Run: node build-equicord.js && node --test tests/equicord.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import mediaCore from '../src/core.js';
import pngDecode from './png-decode.js';
import { encodeFile, makeCarrier, restorePixels } from '../dist/equicord/moeGuard/media.mjs';

const img = { width: 47, height: 31, data: Uint8ClampedArray.from({length: 47*31*4}, (_,i) => (i*17 + (i >>> 2)) & 255) };
const empty = new Uint8Array();
test('mislabeled JPEG is rejected before invoking the pixel decoder', async () => {
    await assert.rejects(encodeFile(new File(['not a photo'], 'sample.jpg', { type: 'image/jpeg' }), ''), /不是 JPEG/);
});
test('truncated JPEG does not reach the pixel decoder', async () => {
    await assert.rejects(encodeFile(new File([new Uint8Array([255,216,255,224])], 'sample.jpg', { type: 'image/jpeg' }), ''), /缺少 JPEG 尺寸头/);
});
for (const salt of ['', 'test-group']) {
    test('Equicord → browser: RGBA, marker, dimensions, salt: '+JSON.stringify(salt), async () => {
        const bytes = await makeCarrier(img, empty, salt);
        const m = mediaCore.pngReadMarker(bytes.subarray(0,128),salt);
        assert.equal(m.saltOk,true); assert.equal(m.w,img.width); assert.equal(m.h,img.height);
        const pixels = pngDecode(Buffer.from(bytes));
        const dec = mediaCore.decodeImage(pixels, {salt});
        assert.equal(dec.ok,true); assert.deepEqual(dec.data,img.data);
        assert.equal(mediaCore.decodeImage(pixels, {salt:salt+'wrong'}).ok,false);
    });
    test('browser → Equicord: decoded PNG RGBA and text chunk: '+JSON.stringify(salt), async () => {
        const chunks = [{k:'Comment',v:'regression-fixture'}];
        const enc = mediaCore.encodeImage(img,{salt});
        const carrier = mediaCore.pngAddMarker(mediaCore.pngPutTextChunks(mediaCore.encodePngStore(enc),chunks),enc.meta);
        const pixels = pngDecode(Buffer.from(carrier));
        const plain = await restorePixels(pixels,carrier,salt);
        assert.deepEqual(pngDecode(Buffer.from(plain)).data,img.data);
        assert.deepEqual(mediaCore.pngGetTextChunks(plain),chunks);
        await assert.rejects(restorePixels(pixels,carrier,salt+'wrong'),/bad-salt/);
    });
}
