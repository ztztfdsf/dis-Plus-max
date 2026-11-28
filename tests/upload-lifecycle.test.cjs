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
  const win = {
    XMLHttpRequest: Xhr, addEventListener() {}, postMessage() {},
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
    setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout, setInterval: () => 0,
    location: { origin: 'https://fixture.invalid', pathname: '/channels/1/2' },
  });
  assert.ok(win.__MoeGuard, 'hook failed to install');
  return {
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
  test(name + ': 字节就绪即自动放行 PUT (immediate-release, 无需按键)', async () => {
    const f = fixture(code);
    f.upload();
    await tick(30);
    assert.equal(f.sends.filter(s => s.method === 'PUT').length, 1, '无需按键就应放行');
    f.press();
    assert.equal(f.sends.filter(s => s.method === 'PUT').length, 1, '按键不产生第二笔 PUT');
  });

  test(name + ': 编码失败 → 仍按原图放行（不阻断、不弹窗、不丢附件）', async () => {
    const f = fixture(code, { encodeThrows: true });
    f.upload();
    await tick(30);
    f.press();
    await settle();
    const put = f.sends.filter(s => s.method === 'PUT');
    assert.equal(put.length, 1, '附件必须照常上传');
    assert.equal(f.encodeCalls, 1, '编码确实被尝试过一次');
    assert.ok(f.log.some(e => e.ev === 'release'), '放行事件有记录');
  });

  test(name + ': 正常编码 → 放行的字节被替换为 PNG', async () => {
    const f = fixture(code);
    f.upload();
    await tick(30);
    f.press();
    await settle();
    assert.ok(f.encodeCalls >= 1);
    assert.equal(f.sends.filter(s => s.method === 'PUT').length, 1);
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

  test(name + ': 登记期取消（abort 先于编码完成）→ 不上传', async () => {
    const f = fixture(code, { slowEncode: true });
    const x = f.upload();
    await tick(5);          // registering 窗口内 abort
    x.abort();
    await settle();
    assert.equal(f.sends.filter(s => s.method === 'PUT').length, 0, '已取消的附件不该被上传');
  });
}
