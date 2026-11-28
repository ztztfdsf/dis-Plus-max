/* Offline upload lifecycle contract for the 3.8.0 hook (hold + release).
 * No account, network, native profile or real upload: the hook runs in a VM. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = f => readFileSync(path.join(root, f), 'utf8');
const built = read('dist/moeguard.user.js');
const start = built.indexOf('/* ─────── 3. 上传拦截'), end = built.indexOf('/* ─────── 4. 页面 UI', start);
assert.ok(start >= 0 && end > start, 'could not isolate shipped hook; never substitute the source');
const variants = { extension: read('src/hook.js'), userscript: built.slice(start, end) };
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const settle = async () => { for (let i = 0; i < 10; i++) await tick(50); };

const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
  0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0, 0, 0);

function fixture(code, { encodeThrows = false, alreadyMoe = false, slowEncode = false } = {}) {
  const docListeners = {}, sends = [], pending = [];
  let encodeCalls = 0, aborted = 0;
  class Xhr extends EventTarget {
    open(m) { this.method = m; }
    setRequestHeader() {}
    abort() { aborted++; }
    send(body) { sends.push({ method: this.method, body }); if (this.method === 'PUT') pending.push(this); }
  }
  const editor = { isConnected: true, closest: () => editor };
  editor.dispatchEvent = (ev) => { for (const cb of docListeners.keydown || []) cb(ev); return true; };
  const winListeners = {};
  const win = {
    XMLHttpRequest: Xhr, addEventListener(k, cb) { (winListeners[k] ||= []).push(cb); }, postMessage() {},
    __MoeGuardCore: {
      contentKey: () => 'ck', perceptualTag: () => 'tag', tagMatches: () => false,
      detectMeta: () => alreadyMoe,
      encodeImage: async () => {
        encodeCalls++;
        if (slowEncode) await tick(200);
        if (encodeThrows) throw Error('encoder refused');
        return { width: 2, height: 2 };
      },
    },
    _moeFormat: {
      blobToImageData: async () => ({ width: 2, height: 2, data: new Uint8ClampedArray(16) }),
      resizeImageData: b => b, encodedToBlob: async (enc) => { await enc; return new Blob([new Uint8Array([1, 2, 3, 4])]); },
    },
  };
  const document = { addEventListener(k, cb) { (docListeners[k] ||= []).push(cb); } };
  vm.runInNewContext(code, {
    window: win, PAGE: win, document, XMLHttpRequest: Xhr, Uint8Array, ArrayBuffer, Blob, Event,
    KeyboardEvent: class { constructor(t, i = {}) { Object.assign(this, i); this.defaultPrevented = false; }
      preventDefault() { this.defaultPrevented = true; } stopImmediatePropagation() {} },
    Headers, console: { warn() {}, error() {} },
    setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout,
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); try { t.unref(); } catch (e) {} return t; }, clearInterval,
    location: { origin: 'https://fixture.invalid', pathname: '/channels/1/2' },
  });
  assert.ok(win.__MoeGuard, 'hook failed to install');
  try { win.__MoeGuard.setConfig({ decisionWaitMs: 150 }); } catch (e) {}
  return {
    /* 模拟 content.js 手动翻 ✕/○: decisions + manualFlip 消息 */
    flip(ck, obf) {
      for (const cb of winListeners.message || []) cb({ data: { __moe: 1, decisions: [{ fp: 'tag', ck, obfuscate: obf, manual: true, at: Date.now() }], manualFlip: { ck, fp: 'tag' } } });
    },
    get sends() { return sends; }, get encodeCalls() { return encodeCalls; }, get aborted() { return aborted; },
    editor,
    upload(bytes = PNG) {
      const x = new Xhr(); x.open('PUT', 'https://example.invalid/attachments/1/2/a.png'); x.send(bytes.buffer); return x;
    },
    press() {
      const e = { key: 'Enter', target: editor, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() {} };
      for (const cb of docListeners.keydown || []) cb(e);
      return e;
    },
    ackAll() { for (const x of pending) { if (x.__done) continue; x.__done = true; x.status = 200; x.dispatchEvent(new Event('loadend')); } },
    get log() { return win.__MoeGuard.uploadLog; },
  };
}

for (const [name, code] of Object.entries(variants)) {
  test(name + ': PUT 挂着不放 (无按键零流量), 按 Enter 才放行', async () => {
    const f = fixture(code);
    f.upload();
    await tick(400);          // 超时预编码跑完, 但不放行
    assert.equal(f.sends.filter(s => s.method === 'PUT').length, 0, '没按键就不该有 PUT');
    f.press();
    await settle();
    assert.equal(f.sends.filter(s => s.method === 'PUT').length, 1, '按键后放行一笔');
    f.press();
    await tick(60);
    assert.equal(f.sends.filter(s => s.method === 'PUT').length, 1, '第二笔按键不产生第二笔 PUT');
  });

  test(name + ': 编码失败 → 仍按原图放行（不阻断、不弹窗、不丢附件）', async () => {
    const f = fixture(code, { encodeThrows: true });
    f.upload();
    await tick(400);          // 超时预编码: 编码器被调, 抛错 → preBody null
    f.press();
    await settle();
    const put = f.sends.filter(s => s.method === 'PUT');
    assert.equal(put.length, 1, '附件必须照常上传');
    assert.ok(f.encodeCalls >= 1, '编码确实被尝试过');
    assert.ok(f.log.some(e => e.ev === 'release'), '放行事件有记录');
  });

  test(name + ': 正常编码 → 按 Enter 后放行的字节是混淆 PNG', async () => {
    const f = fixture(code);
    f.upload();
    await tick(400);          // 超时预编码完成 (混淆)
    assert.equal(f.sends.length, 0, '没按键不放行');
    f.press();
    await settle();
    assert.ok(f.encodeCalls >= 1);
    assert.equal(f.sends.filter(s => s.method === 'PUT').length, 1);
    const put = f.sends.filter(s => s.method === 'PUT');
    assert.notEqual(put[0].body.byteLength, PNG.length, '字节被替换');
  });

  test(name + ': 已经是喵图 → 不重复编码', async () => {
    const f = fixture(code, { alreadyMoe: true });
    f.upload();
    await tick(30);
    f.press();
    await settle();
    assert.equal(f.encodeCalls, 0, '已是喵图不应再编码');
  });

  test(name + ': 非图片字节 → 原样放行，不编码', async () => {
    const f = fixture(code);
    f.upload(Uint8Array.of(0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c));
    await tick(30);
    f.press();
    await settle();
    assert.equal(f.encodeCalls, 0);
  });

  test(name + ': 评分不够 → 手动 ✕ 翻转 → 按 Enter 发出的是混淆图', async () => {
    const f = fixture(code, { slowEncode: true });
    f.upload();
    await tick(60);                 // 挂着, 编码未跑
    f.flip('ck', true);             // 用户点 ✕: 手动要混淆
    await tick(500);                // 重编完成 (慢编码 200ms)
    assert.equal(f.sends.length, 0, '翻转不产生流量');
    f.press();
    await settle();
    const put = f.sends.filter(s => s.method === 'PUT');
    assert.equal(put.length, 1, '正好一笔 PUT');
    assert.ok(put[0].body && put[0].body.byteLength > 0, '有字节');
    assert.equal(f.encodeCalls, 1, '编码器跑了一次 (混淆)');
  });

  test(name + ': 评分够了 → 手动 ○ 翻转 → 按 Enter 发原图零编码', async () => {
    const f = fixture(code, { slowEncode: true });
    f.upload();
    await tick(60);
    f.flip('ck', false);            // 手动取消混淆
    await tick(300);                // 重编: obf=false → 不调编码器
    f.press();
    await settle();
    const put = f.sends.filter(s => s.method === 'PUT');
    assert.equal(put.length, 1);
    assert.equal(f.encodeCalls, 0, '不该编码 (原图直通)');
    assert.ok(put[0].body && put[0].body.byteLength > 0, '原始字节放行');
  });

  test(name + ': 反复翻转 (✕→○→✕) → 最后一次结论生效', async () => {
    const f = fixture(code, { slowEncode: false });
    f.upload();
    await tick(60);
    f.flip('ck', true);
    await tick(150);
    f.flip('ck', false);
    await tick(150);
    f.flip('ck', true);
    await tick(250);
    f.press();
    await settle();
    const put = f.sends.filter(s => s.method === 'PUT');
    assert.equal(put.length, 1);
    assert.ok(f.encodeCalls >= 2, '✕ 至少编了两次 (中间 ○ 那次不编码)');
    assert.notEqual(put[0].body.byteLength, PNG.length, '发出的是混淆字节');
  });

  test(name + ': 登记期取消（abort 先于编码完成）→ 不上传', async () => {
    const f = fixture(code, { slowEncode: true });
    const x = f.upload();
    await tick(5);          // registering 窗口内 abort
    x.abort();
    await settle();
    assert.equal(f.sends.filter(s => s.method === 'PUT').length, 0, '已取消的附件不该被上传');
  });
}
