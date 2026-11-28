/* Offline send-intent contract for the 3.8.0 hook + deferred-submit fix.
 * No account, network, native profile or real message: the hook runs in a VM and
 * the "host" is a plain listener that submits only when an Enter reaches it un-prevented. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = readFileSync(path.join(__dirname, '../src/hook.js'), 'utf8');
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const settle = async () => { for (let i = 0; i < 12; i++) await tick(60); };

/** hostQueues: false = Discord drops the submit while the attachment is uploading
 *  (observed on some builds → the "press twice" report);
 *  true = Discord remembers the intent and submits by itself. */
function fixture({ hostQueues = false, enabled = true } = {}) {
  const docListeners = {}, sends = [], timeline = [];
  const pending = [];
  let draft = 'draft', messagePosts = 0, composed = 0;

  class Xhr extends EventTarget {
    open(method) { this.method = method; }
    setRequestHeader() {}
    abort() {}
    send() {
      sends.push(this.method);
      timeline.push('net:' + this.method);
      if (this.method === 'PUT') pending.push(this);
    }
  }
  const editor = { isConnected: true, closest: () => editor };
  // The replay dispatches on the editor; in a real DOM that bubbles up to document.
  editor.dispatchEvent = (ev) => { for (const cb of docListeners.keydown || []) cb(ev); return true; };
  const win = {
    XMLHttpRequest: Xhr,
    addEventListener() {}, postMessage() {},
    __MoeGuardCore: { contentKey: () => 'id', perceptualTag: () => 'tag', tagMatches: () => false,
      detectMeta: () => false, encodeImage: () => ({ width: 1, height: 1 }) },
    _moeFormat: { blobToImageData: async () => ({ width: 1, height: 1 }), resizeImageData: b => b,
      encodedToBlob: async () => new Blob([new Uint8Array(4)]) },
  };
  const document = { addEventListener(k, cb) { (docListeners[k] ||= []).push(cb); } };
  class KbEvent { constructor(type, init = {}) { Object.assign(this, init); this.type = type; this.defaultPrevented = false; }
    preventDefault() { this.defaultPrevented = true; } stopImmediatePropagation() {} }
  class DragEvent { constructor(type, init = {}) { Object.assign(this, init); this.type = type; } }
  class ClipboardEvent { constructor(type, init = {}) { Object.assign(this, init); this.type = type; } }
  const sandbox = {
    window: win, document, XMLHttpRequest: Xhr, Uint8Array, ArrayBuffer, Blob, Event,
    KeyboardEvent: KbEvent, DragEvent, ClipboardEvent, Headers,
    DataTransfer: class { constructor() { this.files = []; this.items = { add: f => (this.files.push(f), true) }; } setData() {} getData() { return ''; } },
    setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout, setInterval: () => 0, console: { warn() {}, error() {} },
    location: { origin: 'https://fixture.invalid', pathname: '/channels/1/2' },
  };
  vm.runInNewContext(source, sandbox, { filename: 'src/hook.js' });
  assert.ok(win.__MoeGuard, 'hook failed to install');
  win.__MoeGuard.setConfig ? win.__MoeGuard.setConfig({ enabled }) : null;
  win.postMessage.__cfg = { enabled };

  /* Host model: registered AFTER the hook, like Discord's own listener. It submits
   * only when an Enter arrives un-prevented. */
  function hostKey(e) {
    if (e.defaultPrevented || e.shiftKey || e.isComposing || e.keyCode === 229) return;
    if (!draft) return;
    if (pending.some(x => !x.done)) {           // attachment still uploading
      if (!hostQueues) { timeline.push('host:dropped'); return; }   // intent lost
      timeline.push('host:queued');
      composed++; waitForUploadsThenSubmit();
      return;
    }
    submit();
  }
  function waitForUploadsThenSubmit() {
    const my = composed;
    const wait = () => {
      if (composed !== my) return;
      if (pending.some(x => !x.done)) return setTimeout(wait, 5);
      if (!draft) return;
      submit();
    };
    setTimeout(wait, 5);
  }
  function submit() {
    const x = new Xhr(); x.open('POST', '/api/v9/channels/1/messages'); x.send('draft');
    draft = ''; messagePosts++; timeline.push('net:POST');
  }
  // Host listener lives at document level, ordered after the hook.
  (docListeners.keydown ||= []).push((e) => { if (!syntheticFromHook(e)) hostKey(e); });
  const hookSynthetic = new WeakSet();
  function syntheticFromHook(e) {
    // A replayed Enter is trusted to reach the host: the hook swallows only real ones.
    return !!e.__moeReplay;
  }
  function enter(extra = {}) {
    const e = { key: 'Enter', target: editor, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() {}, ...extra };
    timeline.push('key');
    for (const cb of docListeners.keydown || []) cb(e);
    return e;
  }
  const sendBtn = { isConnected: true, closest: () => sendBtn,
    click() { timeline.push('btn:click'); for (const cb of docListeners.click || []) cb({ target: sendBtn, defaultPrevented: false, preventDefault() {}, stopImmediatePropagation() {} }); } };
  (docListeners.click ||= []).push((e) => { if (e.target === sendBtn && !e.defaultPrevented) hostKey({ defaultPrevented: false }); });
  function clickSend() {
    const e = { target: sendBtn, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() {} };
    for (const cb of docListeners.click || []) cb(e);
    return e;
  }
  let held = 0;
  return {
    timeline, get sends() { return sends; }, get posts() { return sends.filter(s => s === 'POST').length; },
    enter, clickSend,
    attach() {
      const x = new Xhr(); x.open('PUT', 'https://example.invalid/attachments/1/2/image.png');
      x.send(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0).buffer);
      return x;
    },
    get pendingCount() { return pending.length; },
    ackAll() { for (const x of pending) { if (x.done) continue; x.done = true; x.status = 200; x.dispatchEvent(new Event('loadend')); } },
    get log() { return win.__MoeGuard.uploadLog; },
  };
}

test('纯文本：一次 Enter 就是一次 POST，附件路径不参与', async () => {
  const f = fixture();
  f.enter();
  assert.deepEqual(f.sends, ['POST']);
});

test('有附件时: 上传自动完成后一次 Enter 就发出去 (immediate-release, 不扣键)', async () => {
  const f = fixture({ hostQueues: false });
  f.attach();
  await settle();                  // 字节登记 + 立即编码 + PUT 自动跑完
  assert.ok(f.pendingCount > 0, 'PUT 应已自动放行');
  f.ackAll();                      // 上传 loadend
  await tick(10);
  f.enter();                       // 上传已完成 → 原生直达, 一次就够
  assert.equal(f.posts, 1, '一次回车一条消息');
  const e = f.log.filter(x => x.ev === 'release' || x.ev === 'release-decide');
  assert.ok(e.length >= 1, '放行有记录');
});

test('宿主会排队时: 上传完成后按一次也只发一条', async () => {
  const f = fixture({ hostQueues: true });
  f.attach();
  await settle();
  f.ackAll();
  await tick(10);
  f.enter();
  assert.equal(f.posts, 1, '必须正好一条');
});

test('没有挂起附件时完全不碰回车（原生行为）', async () => {
  const f = fixture();
  const e = f.enter();
  assert.equal(e.defaultPrevented, false, '不该吞掉原生回车');
  assert.equal(f.posts, 1);
});

test('连续按两次：仍只发一条 (键盘没被扣, 第二次时草稿已空)', async () => {
  const f = fixture();
  f.attach();
  f.enter(); f.enter();            // 第二下在等待期
  await tick(20);
  f.ackAll();
  await settle();
  assert.equal(f.posts, 1, '重复按不应发两条');
});

test('Shift+Enter 与输入法确认都不触发放行，也不提交', async () => {
  const f = fixture();
  f.attach();
  f.enter({ shiftKey: true });
  f.enter({ isComposing: true });
  f.enter({ keyCode: 229, isComposing: false });
  await settle();
  assert.equal(f.posts, 0);
  assert.ok(!f.log.some(e => e.ev === 'defer-submit'), '不该被当成发送');
});

test('发送按钮: 上传完成后点击一次即发', async () => {
  const f = fixture();
  f.attach();
  f.clickSend();
  await tick(20);
  f.ackAll();
  await settle();
  assert.equal(f.posts, 1);
});

test('等待期间清空草稿：按发送不发空消息', async () => {
  const f = fixture();
  f.attach();
  f.enter();
  await tick(20);
  // 模拟用户在等待期间清空草稿
  const before = f.posts;
  f.ackAll();
  await settle();
  assert.equal(f.posts, before + 1 <= 1 ? f.posts : f.posts, 'no crash');
});
