/* MoeGuard 核心算法单元测试 (Node) */
'use strict';
const assert = require('assert');
const core = require('../src/core.js');
const { encodeImage, decodeImage, detectMeta, makePRNG } = core;

let passed = 0, failed = 0;
const queue = [];
/* 同步/异步用例通吃: 异步用例必须 await, 否则 rejected promise 会被吞掉误报 PASS */
function test(name, fn) { queue.push([name, fn]); }
async function runAll() {
  for (const [name, fn] of queue) {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + e.message); }
  }
}

// 确定性伪随机数据生成器
function makeData(w, h, seedStr) {
  const next = makePRNG(seedStr || 'test-data');
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = next() & 255; data[i + 1] = next() & 255;
    data[i + 2] = next() & 255; data[i + 3] = 255;
  }
  return { width: w, height: h, data };
}

function assertPixelEqual(a, b, msg) {
  assert.strictEqual(a.width, b.width, msg + ': width');
  assert.strictEqual(a.height, b.height, msg + ': height');
  assert.deepStrictEqual(Array.from(a.data), Array.from(b.data), msg + ': pixels');
}

/* ---------- moEg PNG 标记块 (廉价预筛用) ---------- */
const fs = require('fs');
const path = require('path');
const pngDecode = require('./png-decode.js');
const { writePng } = require('./png-write.js');

test('moEg 标记块: 写入 → 只读前 128 字节即可识别', () => {
  const orig = makeData(200, 140, 'marker');
  const enc = encodeImage(orig, { salt: '' });
  const png = writePng(enc);
  const marked = core.pngAddMarker(new Uint8Array(png), enc.meta);
  assert.ok(marked.length > png.length, '标记块已插入');
  assert.ok(marked.length - png.length < 40, '标记块极小(<40B)');
  const head = marked.slice(0, 128);
  const mk = core.pngReadMarker(head, '');
  assert.ok(mk, '前128字节能读到标记');
  assert.strictEqual(mk.B, 16);
  assert.strictEqual(mk.w, 200);
  assert.strictEqual(mk.h, 140);
  assert.strictEqual(mk.saltOk, true);
});

test('moEg 标记块: 盐值不符时 saltOk=false', () => {
  const orig = makeData(96, 96, 'marker-salt');
  const enc = encodeImage(orig, { salt: 'groupA' });
  const marked = core.pngAddMarker(new Uint8Array(writePng(enc)), enc.meta);
  const head = marked.slice(0, 128);
  assert.strictEqual(core.pngReadMarker(head, 'groupA').saltOk, true);
  assert.strictEqual(core.pngReadMarker(head, 'groupB').saltOk, false);
  assert.strictEqual(core.pngReadMarker(head, '').saltOk, false);
});

test('moEg 标记块: 普通 PNG 不误报, 且加块后仍是合法 PNG', () => {
  const plain = makeData(80, 60, 'plain-png');
  const plainPng = new Uint8Array(writePng(plain));
  assert.strictEqual(core.pngReadMarker(plainPng.slice(0, 128), ''), null, '普通图无标记');
  // 加块后依然能被标准解码器读出, 且像素不变
  const enc = encodeImage(plain, {});
  const marked = core.pngAddMarker(new Uint8Array(writePng(enc)), enc.meta);
  const back = pngDecode(Buffer.from(marked));
  assert.strictEqual(back.width, enc.width);
  assert.strictEqual(back.height, enc.height);
  const dec = decodeImage(back, {});
  assert.strictEqual(dec.ok, true, '带标记块的图仍可解码');
  assertPixelEqual(dec, plain, '带标记块解码无损');
});

test('moEg 标记块: 非 PNG 输入安全返回', () => {
  const jpegish = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.strictEqual(core.isPng(jpegish), false);
  assert.strictEqual(core.pngReadMarker(jpegish, ''), null);
  assert.strictEqual(core.pngAddMarker(jpegish, { w: 1, h: 1, B: 16 }), jpegish, '非 PNG 原样返回');
});

/* ---------- 审查层: 只混淆色情图片 (所有图都过一遍) ---------- */
const review = require('../src/review.js');

function paint(w, h, fn) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = fn(x / w, y / h);
      const i = (y * w + x) * 4;
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = c[3] == null ? 255 : c[3];
    }
  }
  return { width: w, height: h, data: d };
}

test('审查: 大面积平滑肤色 → 高分; 风景/UI/花衣服 → 低分', () => {
  const nude = paint(320, 240, (u, v) => [228 - 20 * v, 180 - 18 * v, 158 - 16 * v]);
  const sky = paint(320, 240, (u, v) => [90 + 40 * v, 140 + 60 * v, 220 - 30 * v]);
  const ui = paint(320, 240, (u, v) => (((v * 60) | 0) % 4 === 0 ? [35, 35, 42] : [240, 240, 244]));
  const cloth = paint(320, 240, (u, v) => {
    const k = (((u * 40) | 0) + ((v * 40) | 0)) % 3;
    return k === 0 ? [220, 60, 90] : k === 1 ? [60, 90, 200] : [240, 230, 80];
  });
  assert.ok(review.localScore(nude).score > 0.7, '裸露应高分, 实测 ' + review.localScore(nude).score);
  assert.ok(review.localScore(sky).score < 0.3, '风景应低分');
  assert.ok(review.localScore(ui).score < 0.3, 'UI 截图应低分');
  assert.ok(review.localScore(cloth).score < 0.3, '花衣服应低分');
});

test('审查: nsfwOnly=false 时一律混淆 (默认策略)', async () => {
  const sky = paint(200, 150, () => [80, 150, 230]);
  const r = await review.decide(sky, {});
  assert.strictEqual(r.obfuscate, true);
  assert.strictEqual(r.source, 'always');
});

test('审查: nsfwOnly=true 时按分数决定', async () => {
  const nude = paint(320, 240, (u, v) => [228 - 20 * v, 180 - 18 * v, 158 - 16 * v]);
  const sky = paint(320, 240, (u, v) => [90 + 40 * v, 140 + 60 * v, 220 - 30 * v]);
  const cfg = { nsfwOnly: true, nsfwThreshold: 0.7, reviewMode: 'local' };
  assert.strictEqual((await review.decide(nude, cfg)).obfuscate, true, '色情图 → 混淆');
  assert.strictEqual((await review.decide(sky, cfg)).obfuscate, false, '风景 → 不混淆');
});

test('审查: 远端打分可覆盖, 远端失败回落本地', async () => {
  const sky = paint(320, 240, (u, v) => [90 + 40 * v, 140 + 60 * v, 220 - 30 * v]);
  const cfg = { nsfwOnly: true, nsfwThreshold: 0.7, reviewMode: 'both' };
  const hi = await review.decide(sky, cfg, () => Promise.resolve(0.95));
  assert.strictEqual(hi.obfuscate, true, '远端高分 → 混淆');
  const thrown = await review.decide(sky, cfg, () => { throw new Error('api down'); });
  assert.strictEqual(thrown.source, 'local', '远端挂掉 → 回落本地');
  assert.strictEqual(thrown.obfuscate, false);
});

test('审查: 异常输入保守处理 (仍然混淆)', async () => {
  const cfg = { nsfwOnly: true, reviewMode: 'remote' };
  // remote 模式且没有 remoteFn → 无分可用 → 保守混淆
  const r = await review.decide(paint(64, 64, () => [10, 10, 10]), cfg);
  assert.strictEqual(r.obfuscate, true);
  // 太小的图 → localScore 给 0 分但不崩
  const tiny = review.localScore({ width: 2, height: 2, data: new Uint8ClampedArray(16) });
  assert.strictEqual(tiny.score, 0);
});

test('审查: 全透明图不误判 (alpha<24 的像素跳过)', () => {
  const ghost = paint(200, 150, () => [230, 185, 160, 0]);
  const s = review.localScore(ghost);
  assert.strictEqual(s.samples, 0);
  assert.strictEqual(s.score, 0);
});


/* ---------- ✕ 取消混淆的感知指纹 ---------- */

test('指纹: 对有损重编码稳定, 不同图/不同尺寸不误匹配', () => {
  const a = makeData(320, 240, 'fp-a');
  const tagA = core.perceptualTag(a);
  // 模拟有损重压: 每像素 ±8 拖动
  const j = Uint8ClampedArray.from(a.data);
  for (let i = 0; i < j.length; i += 4) {
    const dv = ((i * 2654435761) >>> 0) % 17 - 8;
    for (let k = 0; k < 3; k++) j[i + k] = j[i + k] + dv;
  }
  const tagJ = core.perceptualTag({ width: 320, height: 240, data: j });
  assert.ok(core.tagMatches(tagA, tagJ), '拖动后应仍匹配');

  const b = makeData(320, 240, 'fp-b');
  assert.strictEqual(core.tagMatches(tagA, core.perceptualTag(b)), false, '不同图不该匹配');
  assert.strictEqual(core.tagMatches(a && '640x400:' + 'a'.repeat(64) + ':' + 'a'.repeat(16), '320x200:' + 'a'.repeat(64) + ':' + 'a'.repeat(16)), false, '尺寸不同不该匹配');
  assert.strictEqual(core.tagMatches(null, tagA), false, 'null 安全');
});

test('指纹: 容差阈值边界 (亮度段10 / 色差段6)', () => {
  const L = (c) => c.repeat(64), C = (c) => c.repeat(16);
  // 亮度 64 桶全差 1 → 累计 64 > 10 → 不匹配
  assert.strictEqual(core.tagMatches('10x10:' + L('1') + ':' + C('1'), '10x10:' + L('2') + ':' + C('1')), false);
  // 只有 3 个亮度桶差 1 → 累计 3 ≤ 10 → 匹配
  assert.strictEqual(core.tagMatches('10x10:' + L('1') + ':' + C('1'), '10x10:222' + '1'.repeat(61) + ':' + C('1')), true);
  // 亮度完全相同但色差全差 1 → 累计 16 > 6 → 不匹配 (这就是旧版撞车的那种情况)
  assert.strictEqual(core.tagMatches('10x10:' + L('1') + ':' + C('1'), '10x10:' + L('1') + ':' + C('2')), false);
  // 尺寸不同永不匹配
  assert.strictEqual(core.tagMatches('640x400:' + L('a') + ':' + C('a'), '320x200:' + L('a') + ':' + C('a')), false);
});


/* ---------- 【流程铁律】先审查 → 再决定混不混 ---------- */

/** 带调用计数的编码器: 用来断言「不混淆的图从未调过 encodeImage」 */
function makeSpyPipeline() {
  const calls = { encode: 0, review: 0 };
  const origEncode = core.encodeImage;
  /* 完整复刻 hook.js 的 obfuscateBytes 决策顺序 (纯逻辑部分) */
  async function pipeline(img, decisions, cfg, remoteFn) {
    if (core.detectMeta(img, cfg.salt || '')) return { action: 'passthrough', why: 'already-moe' };
    calls.review++;
    const act = await review.resolveAction(img, decisions, cfg, {
      tag: core.perceptualTag, tagMatches: core.tagMatches, remoteFn,
    });
    if (!act.obfuscate) return { action: 'passthrough', why: act.source, score: act.score };
    calls.encode++;
    const enc = origEncode(img, { salt: cfg.salt || '' });
    return { action: 'obfuscated', why: act.source, score: act.score, enc };
  }
  return { pipeline, calls };
}

const NUDE = () => paint(320, 240, (u, v) => [228 - 20 * v, 180 - 18 * v, 158 - 16 * v]);
const SKY = () => paint(320, 240, (u, v) => [90 + 40 * v, 140 + 60 * v, 220 - 30 * v]);

test('流程: 审查判定不混淆 → 从未调用 encodeImage', async () => {
  const { pipeline, calls } = makeSpyPipeline();
  const cfg = { nsfwOnly: true, nsfwThreshold: 0.7, reviewMode: 'local' };
  const r = await pipeline(SKY(), [], cfg);
  assert.strictEqual(r.action, 'passthrough', '风景应原图直通');
  assert.strictEqual(calls.review, 1, '审查跑了 1 次');
  assert.strictEqual(calls.encode, 0, '绝不能编码 (先审查后编码)');
});

test('流程: 审查判定混淆 → 审查先于编码, 且编码只跑 1 次', async () => {
  const { pipeline, calls } = makeSpyPipeline();
  const cfg = { nsfwOnly: true, nsfwThreshold: 0.7, reviewMode: 'local' };
  const r = await pipeline(NUDE(), [], cfg);
  assert.strictEqual(r.action, 'obfuscated');
  assert.strictEqual(calls.review, 1);
  assert.strictEqual(calls.encode, 1);
});

test('流程: 关闭审查 (默认) → 所有图都混淆, 但仍是先判定后编码', async () => {
  const { pipeline, calls } = makeSpyPipeline();
  const r = await pipeline(SKY(), [], {});
  assert.strictEqual(r.action, 'obfuscated');
  assert.strictEqual(r.why, 'always/inline');
  assert.strictEqual(calls.encode, 1);
});

test('流程: 既定结论(用户点过按钮) 优先于审查', async () => {
  const cfg = { nsfwOnly: true, nsfwThreshold: 0.7, reviewMode: 'local' };
  // ① 色情图但用户手动取消 → 必须原图直通, 且不编码
  {
    const { pipeline, calls } = makeSpyPipeline();
    const img = NUDE();
    const fp = core.perceptualTag(img);
    const r = await pipeline(img, [{ fp, obfuscate: false }], cfg);
    assert.strictEqual(r.action, 'passthrough', '手动取消应生效');
    assert.strictEqual(r.why, 'decided');
    assert.strictEqual(calls.encode, 0, '手动取消时不得编码');
  }
  // ② 普通图但用户手动要求混淆 → 必须混淆
  {
    const { pipeline, calls } = makeSpyPipeline();
    const img = SKY();
    const fp = core.perceptualTag(img);
    const r = await pipeline(img, [{ fp, obfuscate: true }], cfg);
    assert.strictEqual(r.action, 'obfuscated', '手动要求混淆应生效');
    assert.strictEqual(r.why, 'decided');
    assert.strictEqual(calls.encode, 1);
  }
});

test('流程: 结论用容差匹配 (webp 重压后指纹微漂仍命中)', async () => {
  const { pipeline, calls } = makeSpyPipeline();
  const img = NUDE();
  const fp = core.perceptualTag(img);
  // 模拟 Discord 重压: 每像素 ±8 抖动
  const j = Uint8ClampedArray.from(img.data);
  for (let i = 0; i < j.length; i += 4) {
    const dv = ((i * 2654435761) >>> 0) % 17 - 8;
    for (let k = 0; k < 3; k++) j[i + k] = j[i + k] + dv;
  }
  const shifted = { width: img.width, height: img.height, data: j };
  const r = await pipeline(shifted, [{ fp, obfuscate: false }], { nsfwOnly: true, reviewMode: 'local' });
  assert.strictEqual(r.why, 'decided', '重压后仍应命中既定结论');
  assert.strictEqual(calls.encode, 0);
});

test('流程: 已是喵图 → 直通, 不重复审查也不重复编码', async () => {
  const { pipeline, calls } = makeSpyPipeline();
  const enc = encodeImage(SKY(), { salt: '' });
  const r = await pipeline(enc, [], { nsfwOnly: true, reviewMode: 'local' });
  assert.strictEqual(r.action, 'passthrough');
  assert.strictEqual(r.why, 'already-moe');
  assert.strictEqual(calls.review, 0);
  assert.strictEqual(calls.encode, 0);
});

test('流程: 远端审查失败 → 回落本地, 不影响顺序', async () => {
  const { pipeline, calls } = makeSpyPipeline();
  const cfg = { nsfwOnly: true, nsfwThreshold: 0.7, reviewMode: 'both' };
  const r = await pipeline(SKY(), [], cfg, () => { throw new Error('api down'); });
  assert.strictEqual(r.action, 'passthrough', '远端挂掉时本地说不混淆就不混淆');
  assert.strictEqual(r.why, 'local/inline');
  assert.strictEqual(calls.encode, 0);
});

test('指纹: 色调相近的不同图不该撞车 (8×8 亮度 + 色差)', () => {
  // 两张都是暖调渐变人像风, 旧版 4×4 亮度指纹会完全相同
  const warmA = paint(640, 480, (u, v) => [200 - 30 * v, 150 - 20 * v, 140 - 15 * v]);
  const warmB = paint(640, 480, (u, v) => [190 + 20 * u - 30 * v, 150 - 20 * v, 120 + 10 * u]);
  const cool = paint(640, 480, (u, v) => [90 + 40 * v, 140 + 60 * v, 220 - 30 * v]);
  const fa = core.perceptualTag(warmA), fb = core.perceptualTag(warmB), fc = core.perceptualTag(cool);
  assert.strictEqual(core.tagMatches(fa, fa), true, '自己必匹配');
  assert.strictEqual(core.tagMatches(fa, fc), false, '暖色 vs 冷色不匹配');
  assert.ok(fa.split(':')[1].length === 64, '亮度段 64 桶');
  assert.ok(fa.split(':')[2].length === 16, '色差段 16 桶');
});

test('流程: 指纹多命中时手动混淆优先 (不被早前的「不混淆」遮蔽)', async () => {
  const { pipeline, calls } = makeSpyPipeline();
  const cfg = { nsfwOnly: true, nsfwThreshold: 0.7, reviewMode: 'local' };
  const img = SKY();                                   // 低分 → 审查会说不用混
  const fp = core.perceptualTag(img);
  // 同一个指纹上同时存在两条结论: 先自动不混, 后手动要混
  const decisions = [
    { fp, obfuscate: false, manual: false },
    { fp, obfuscate: true, manual: true },
  ];
  const r = await pipeline(img, decisions, cfg);
  assert.strictEqual(r.action, 'obfuscated', '手动结论必须赢');
  assert.strictEqual(r.why, 'decided');
  assert.strictEqual(calls.encode, 1);
});

test('流程: 手动混淆后又取消 → 发原图 (同为手动取最新)', async () => {
  const { pipeline, calls } = makeSpyPipeline();
  const cfg = { nsfwOnly: true, nsfwThreshold: 0.7, reviewMode: 'local' };
  const img = SKY();                                   // 低分 → 审查本来也说不混
  const fp = core.perceptualTag(img);
  // 用户先点混淆(t=100), 后又取消(t=200) → 应取最新的「不混淆」
  const decisions = [{ fp, obfuscate: true, manual: true, at: 100 }, { fp, obfuscate: false, manual: true, at: 200 }];
  const r = await pipeline(img, decisions, cfg);
  assert.strictEqual(r.action, 'passthrough', '取消后应发原图');
  assert.strictEqual(calls.encode, 0, '不该编码');
});

test('流程: 手动取消后又改回混淆 → 发混淆图', async () => {
  const { pipeline, calls } = makeSpyPipeline();
  const cfg = { nsfwOnly: true, nsfwThreshold: 0.7, reviewMode: 'local' };
  const img = SKY();
  const fp = core.perceptualTag(img);
  const decisions = [{ fp, obfuscate: false, manual: true, at: 100 }, { fp, obfuscate: true, manual: true, at: 200 }];
  const r = await pipeline(img, decisions, cfg);
  assert.strictEqual(r.action, 'obfuscated', '改回混淆后应发混淆图');
  assert.strictEqual(calls.encode, 1);
});

test('流程: 指纹失配 + 手动取消是最新结论 → 不再强制混淆', async () => {
  const { pipeline } = makeSpyPipeline();
  const cfg = { nsfwOnly: true, nsfwThreshold: 0.7, reviewMode: 'local' };
  const sky = SKY();
  const otherSize = { width: sky.width + 40, height: sky.height + 40, data: new Uint8ClampedArray((sky.width + 40) * (sky.height + 40) * 4).fill(200) };
  const staleFp = core.perceptualTag(otherSize);
  // 最新的手动结论是「不混淆」→ manual-fallback 不应触发
  const decisions = [{ fp: staleFp, obfuscate: true, manual: true, at: 100 }, { fp: staleFp, obfuscate: false, manual: true, at: 200 }];
  const r = await pipeline(sky, decisions, cfg);
  assert.strictEqual(r.action, 'passthrough', '最新手动说不混 → 回落审查(也说不混)');
  assert.ok(String(r.why).indexOf('/inline') >= 0, '走现场审查');
});

test('流程: 指纹失配但用户手动要求混淆 → 仍混淆 (宁可多混不可漏发)', async () => {
  const { pipeline, calls } = makeSpyPipeline();
  const cfg = { nsfwOnly: true, nsfwThreshold: 0.7, reviewMode: 'local' };
  const sky = SKY();                                  // 低分图 (审查会说不用混)
  // 预览阶段的指纹来自不同尺寸 → tagMatches 必然失配
  const otherSize = { width: sky.width + 40, height: sky.height + 40, data: new Uint8ClampedArray((sky.width + 40) * (sky.height + 40) * 4).fill(200) };
  const staleFp = core.perceptualTag(otherSize);
  const r = await pipeline(sky, [{ fp: staleFp, obfuscate: true, manual: true }], cfg);
  assert.strictEqual(r.action, 'obfuscated', '手动要混 → 即使指纹失配也必须混淆');
  assert.strictEqual(r.why, 'manual-fallback', '走手动兜底分支');
  assert.strictEqual(calls.encode, 1, '编码恰好一次');
});

test('流程: 指纹失配且手动要求「不混淆」→ 不无脑直通, 回落审查', async () => {
  const { pipeline, calls } = makeSpyPipeline();
  const cfg = { nsfwOnly: true, nsfwThreshold: 0.7, reviewMode: 'local' };
  const nude = NUDE();                                // 高分图 (审查会说要混)
  const otherSize = { width: nude.width + 40, height: nude.height + 40, data: new Uint8ClampedArray((nude.width + 40) * (nude.height + 40) * 4).fill(200) };
  const staleFp = core.perceptualTag(otherSize);
  const r = await pipeline(nude, [{ fp: staleFp, obfuscate: false, manual: true }], cfg);
  assert.strictEqual(r.action, 'obfuscated', '手动不混淆不能跨图生效 → 按审查结果混淆');
  assert.ok(String(r.why).indexOf('/inline') >= 0, '走现场审查分支');
});

// ---- v3 「流光照影」 ----


test('v3: 无损往返 (多种尺寸, 默认算法)', () => {
  for (const [w, h] of [[1, 1], [17, 3], [64, 48], [65, 65], [333, 201], [512, 512], [664, 424], [640, 401]]) {
    const orig = makeData(w, h, 'v3-' + w);
    const enc = encodeImage(orig, {});                       // 默认 = v3
    assert.strictEqual(enc.algo, 'v3', w + 'x' + h + ': 默认 algo v3');
    assert.ok(enc.width > w && enc.height > h, w + 'x' + h + ': 有定位框和补边');
    const dec = decodeImage(enc, {});
    assert.strictEqual(dec.ok, true, w + 'x' + h + ': ok');
    assert.strictEqual(dec.layout, 'v3', w + 'x' + h + ': layout');
    assertPixelEqual(dec, orig, 'v3 ' + w + 'x' + h);
  }
});

test('v3: 半透明像素无损 (RGBA 整像素搬运)', () => {
  const orig = makeData(48, 48, 'v3-alpha');
  for (let i = 3; i < orig.data.length; i += 4) orig.data[i] = (i / 4) % 256;
  const enc = encodeImage(orig, {});
  assertPixelEqual(decodeImage(enc, {}), orig, 'v3 alpha');
});

test('v3: 盐值隔离 (不同盐解不出, 报 bad-salt)', () => {
  const orig = makeData(100, 80, 'v3-salt');
  const enc = encodeImage(orig, { salt: 'groupA' });
  assert.strictEqual(decodeImage(enc, { salt: 'groupA' }).ok, true, '同盐可解');
  const bad = decodeImage(enc, { salt: 'groupB' });
  assert.strictEqual(bad.ok, false, '异盐不可解');
  assert.strictEqual(bad.reason, 'bad-salt', '报 bad-salt 而非 not-moe');
});

test('v3: 定位框可识别 + 元数据自解释 (readMetaV3 报 ver=3)', () => {
  const orig = makeData(300, 200, 'v3-meta');
  const enc = encodeImage(orig, { salt: 'xyz' });
  assert.strictEqual(core.detectFrame(enc).ok, true, '混淆图命中定位框');
  const m = core.readMetaV3(enc.data, enc.width, enc.height, 'xyz');
  assert.ok(m, '元数据可读');
  assert.strictEqual(m.extra.ver, 3, 'extra.ver=3');
  assert.ok(m.extra.T > 0 && (m.extra.T & (m.extra.T - 1)) === 0, 'T 是 2 的幂');
  // probeMagic 认出 v3 (盐值不符时)
  assert.strictEqual(core.probeMagic(enc.data, enc.width, enc.height), true, 'probeMagic 命中');
});

test('v3: 遭平台重编码 (真实缩图) → resized 而不是 not-moe', () => {
  const orig = makeData(200, 150, 'v3-resize');
  const enc = encodeImage(orig, {});
  // 最近邻减半, 模拟平台缩略图 (定位框还在, 但尺寸对不上)
  const W = enc.width, H = enc.height, nw = W >> 1, nh = H >> 1;
  const sd = new Uint8ClampedArray(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const s = ((y * 2) * W + x * 2) * 4, t = (y * nw + x) * 4;
      for (let k = 0; k < 4; k++) sd[t + k] = enc.data[s + k];
    }
  }
  const shrunk = { width: nw, height: nh, data: sd };
  const fr = core.detectFrame(shrunk);
  assert.strictEqual(fr.ok, true, 'v3 中性框缩图后仍可识别 (style=' + fr.style + ')');
  const r = decodeImage(shrunk, {});
  assert.strictEqual(r.ok, false, 'ok=false');
  assert.strictEqual(r.reason, 'resized', '靠定位框认出是喵图 → 报 resized');
});

test('v3: 中性定位框不误报普通图 (含深色/灏灰图)', () => {
  // 纯黑图: 边缘全是深色低饱和 → 最容易误报的情况
  const black = { width: 120, height: 90, data: new Uint8ClampedArray(120 * 90 * 4) };
  for (let i = 0; i < black.data.length; i += 4) { black.data[i] = 8; black.data[i + 1] = 8; black.data[i + 2] = 10; black.data[i + 3] = 255; }
  assert.strictEqual(core.detectFrame(black).ok, true, '纯黑图确实会命中(已知局限) → 依靠元数据作权威判定');
  // 但解码仍必须报 resized 而非误当成可解 → 不会输出垃圾图
  const r = decodeImage(black, {});
  assert.strictEqual(r.ok, false, '纯黑图不可解');
  // 彩色渐变图(真正的普通图)不该命中
  assert.strictEqual(core.detectFrame(makeData(200, 150, 'plain-photo')).ok, false, '渐变普通图不误报');
});

test('元数据: ComfyUI 工作流等 tEXt chunks 经过 混淆→解码 完整保留', () => {
  const orig = makeData(64, 48, 'meta');
  const enc = encodeImage(orig, { salt: 's' });
  // 模拟原始 PNG 上的工作流 chunks (中文 + emoji + 1.2MB 大 JSON)
  const chunks = [
    { k: 'parameters', v: 'Steps: 30, Sampler: DPM++ 2M Karras, CFG: 7' },
    { k: 'prompt', v: 'masterpiece, 猫娘, best quality' },
    { k: 'workflow', v: '{"nodes":[{"type":"KSampler","seed":42}],"中文键":"标签"}' },
    { k: 'moe-big', v: 'X'.repeat(500000) },
  ];
  // 混淆产物 = enc PNG + moEg + moMt
  let u8 = new Uint8Array(writePng(enc));
  u8 = core.pngAddMarker(u8, enc.meta);
  u8 = core.pngPutTextChunks(u8, chunks);
  assert.ok(core.pngReadMarker(u8, 's'), 'moEg 标记还在');
  const back = core.pngReadMetaChunks(u8);
  assert.ok(back && back.length === chunks.length, 'moMt 读回数量一致');
  assert.strictEqual(JSON.stringify(back), JSON.stringify(chunks), '内容逐字节一致 (中文/大JSON)');
  // 解码 → 还原图 → 以标准 tEXt 回写元数据
  const dec = decodeImage(pngDecode(u8), { salt: 's' });
  assert.strictEqual(dec.ok, true, '解码成功');
  let out = new Uint8Array(writePng(dec));
  out = core.pngRestoreTextChunks(out, core.pngReadMetaChunks(u8) || []);
  const finalChunks = core.pngGetTextChunks(out);
  assert.strictEqual(JSON.stringify(finalChunks), JSON.stringify(chunks), '还原图 tEXt == 原 chunks');
});

test('元数据: 无工作流的普通 PNG 不产生 moMt (pngPutTextChunks 幂等)', () => {
  const orig = makeData(32, 32, 'plain');
  const enc = encodeImage(orig, {});
  const u8 = new Uint8Array(writePng(enc));
  const u8b = core.pngPutTextChunks(u8, []);
  assert.strictEqual(u8b.length, u8.length, '空 chunks → 原样返回');
  assert.strictEqual(core.pngReadMetaChunks(u8), null, '无 moMt');
  assert.strictEqual(core.pngGetTextChunks(u8).length, 0, '无 tEXt');
});

test('快速 PNG 编码器: 产物合法 + 往返无损 + 可叠加标记块', async () => {
  if (typeof CompressionStream === 'undefined') { console.log('       (无 CompressionStream, 跳过)'); return; }
  const orig = makeData(320, 240, 'fastpng');
  const enc = encodeImage(orig, { salt: 'fp' });
  const fast = await core.encodePngFast(enc);
  assert.ok(core.isPng(fast), '是合法 PNG');
  const parsed = pngDecode(Buffer.from(fast));
  assert.strictEqual(parsed.width, enc.width, '宽一致');
  assert.strictEqual(parsed.height, enc.height, '高一致');
  // 像素必须与编码结果逐字节相同 (无损铁律)
  let px = 0;
  for (let i = 0; i < enc.data.length; i++) if (enc.data[i] !== parsed.data[i]) px++;
  assert.strictEqual(px, 0, '编码器不改像素');
  assertPixelEqual(decodeImage(parsed, { salt: 'fp' }), orig, 'fastpng 往返');
  // 叠 moEg + moMt 后仍可解
  let u8 = core.pngAddMarker(fast, enc.meta);
  u8 = core.pngPutTextChunks(u8, [{ k: 'workflow', v: '{"n":1}' }]);
  assert.ok(core.pngReadMarker(u8, 'fp'), 'moEg 可读');
  assert.ok(core.pngReadMetaChunks(u8), 'moMt 可读');
  assertPixelEqual(decodeImage(pngDecode(Buffer.from(u8)), { salt: 'fp' }), orig, '带标记块往返');
});

test('v3 默认 tile 降到 256: 补边浪费显著变小, 旧图(T=1024) 仍可解', () => {
  assert.strictEqual(core.V3_MAX_TILE, 256, '默认上限 256');
  const orig = makeData(1536, 1152, 'tilecmp');
  const now = encodeImage(orig, { salt: 't' });
  const ratio = (now.width * now.height) / (1536 * 1152);
  assert.ok(ratio < 1.3, '补边倍数 < 1.3x (实际 ' + ratio.toFixed(2) + 'x)');
  assertPixelEqual(decodeImage(now, { salt: 't' }), orig, 'T=256 往返');
  // 旧图: 显式 T=1024 仍必须能解 (向后兼容铁律)
  const old = encodeImage(orig, { tile: 1024, salt: 't' });
  assert.strictEqual(old.meta.T, 1024, '可显式指定大 tile');
  assertPixelEqual(decodeImage(old, { salt: 't' }), orig, 'T=1024 旧图往返');
});

// ---- 性能 ----
test('性能: 1MP 图编码+解码 < 1500ms', () => {
  const orig = makeData(1024, 1024, 'perf');
  let t0 = Date.now();
  const enc = encodeImage(orig, {});
  let t1 = Date.now();
  const dec = decodeImage(enc, {});
  let t2 = Date.now();
  assert.strictEqual(dec.ok, true);
  assertPixelEqual(dec, orig, 'perf roundtrip');
  assert.ok(t1 - t0 < 1500, 'encode too slow: ' + (t1 - t0) + 'ms');
  assert.ok(t2 - t1 < 1500, 'decode too slow: ' + (t2 - t1) + 'ms');
  console.log(`       (1MP: 编码 ${t1 - t0}ms / 解码 ${t2 - t1}ms)`);
});

runAll().then(() => {
  console.log(`
结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
});

test('PNG: moEg 必须在前 128 字节内 (moMt 巨大也不能把它顶出去)', () => {
  // 重现 bug: pngPutTextChunks 与 pngAddMarker 都插在 IHDR 后 → 后插的在前。
  // 若 moEg 先插, 1.2MB 的 moMt 会把它顶出预筛窗口 → 对方读不到标记 → 不解码。
  const im = { width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4).fill(180) };
  const png = new Uint8Array(writePng(im));
  const bigWorkflow = [{ k: 'workflow', v: 'x'.repeat(300000) }];
  const meta = { w: 40, h: 40, B: 16, salt: '' };

  // 正确顺序 (format.js 现在的做法): 先 moMt, 后 moEg
  let good = core.pngPutTextChunks(png, bigWorkflow);
  good = core.pngAddMarker(good, meta);
  const gs = String.fromCharCode.apply(null, good.subarray(0, 128));
  assert.ok(gs.indexOf('moEg') >= 0 && gs.indexOf('moEg') < 128, 'moEg 应在前 128 字节内');
  assert.ok(core.pngReadMarker(good.subarray(0, 128), ''), '只给 128 字节也能读出标记');
  assert.deepStrictEqual(core.pngReadMetaChunks(good), bigWorkflow, '元数据仍完整');

  // 反面: 顺序颢倒就读不到 (证明这个测试真的有约束力)
  let bad = core.pngAddMarker(png, meta);
  bad = core.pngPutTextChunks(bad, bigWorkflow);
  assert.strictEqual(core.pngReadMarker(bad.subarray(0, 128), ''), null, '顺序颢倒时前 128 字节读不到标记');
});

test('内容键: 字节级精确身份 (多图同时上传不串位)', () => {
  const a = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const aCopy = new Uint8Array(a);
  const b = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 11]);   // 只差最后一字节
  assert.strictEqual(core.contentKey(a), core.contentKey(aCopy), '同字节 → 同键');
  assert.notStrictEqual(core.contentKey(a), core.contentKey(b), '差一字节 → 不同键');
  // 顺序敏感 (双向扫的意义: 单向 FNV 对某些置换不敏感)
  assert.notStrictEqual(core.contentKey(new Uint8Array([1, 2, 3])), core.contentKey(new Uint8Array([3, 2, 1])), '顺序不同 → 不同键');
  assert.strictEqual(core.contentKey(new Uint8Array(0)), '', '空输入 → 空键');
});

test('内容键: 解决感知指纹串位 (两张相似图各自的开关互不干扰)', () => {
  // 造两张相似图: 感知指纹会容差匹配上, 但字节不同
  const mk = (base) => {
    const w = 64, h = 64, d = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      d[i * 4] = base; d[i * 4 + 1] = base; d[i * 4 + 2] = base; d[i * 4 + 3] = 255;
    }
    return { width: w, height: h, data: d };
  };
  const imA = mk(180), imB = mk(181);
  const fpA = core.perceptualTag(imA), fpB = core.perceptualTag(imB);
  assert.ok(core.tagMatches(fpA, fpB), '前提: 这两张图的感知指纹会互相匹配 (串位风险)');

  const ckA = core.contentKey(new Uint8Array(imA.data.buffer));
  const ckB = core.contentKey(new Uint8Array(imB.data.buffer));
  assert.notStrictEqual(ckA, ckB, '内容键必须能区分它们');

  // 模拟 hook.js 的精确匹配: A 说不混淆, B 说混淆 → 各自拿对自己的
  const decisions = [
    { fp: fpA, ck: ckA, obfuscate: false, manual: true, at: 100 },
    { fp: fpB, ck: ckB, obfuscate: true, manual: true, at: 100 },
  ];
  const exactFor = (ck) => decisions.find((d) => d.ck && d.ck === ck) || null;
  assert.strictEqual(exactFor(ckA).obfuscate, false, 'A 图取到自己的「不混淆」');
  assert.strictEqual(exactFor(ckB).obfuscate, true, 'B 图取到自己的「混淆」');
});

test('回归: 即时置换不能与 MutationObserver 形成死循环 (3.4.1 冻页)', () => {
  /* 复现 3.4.1 把页面冻住的那个环:
   *   applyDecoded 写 img.src → 观察器收到 src 变更 → swapIfKnown(target)
   *   → 此刻 currentSrc 仍是旧的 CDN 地址 (浏览器的资源选择是异步的)
   *   → 又命中 decodedSync → 又写一次 src → 无限循环。
   * 这里用最小模型验证「已接管就跳过」这道闸门能截断它。 */
  const CDN = 'https://cdn.discordapp.com/attachments/1/2/a.png';
  const BLOB = 'blob:fake-object-url';
  const decodedSync = new Map([['/attachments/1/2/a.png', { url: BLOB, width: 10, height: 20 }]]);
  const attachKey = (u) => u.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '');

  let writes = 0, guardHits = 0;
  const img = { dataset: {}, attrs: { src: CDN }, currentSrc: CDN };

  function applyDecoded(el, raw, r) {
    el.dataset.moeScan = 'decoded';
    el.dataset.moeScanSrc = raw;
    if (el.attrs.src !== r.url) {              // 相等短路 (第二道闸)
      el.attrs.src = r.url;
      writes++;
      onSrcMutation(el);                       // 模拟观察器同步回调
    }
  }
  function swapIfKnown(el) {
    if (el.dataset.moeScan === 'decoded') { guardHits++; return true; }   // 第一道闸
    const raw = el.currentSrc || el.attrs.src || '';
    if (!raw || /^(blob:|data:)/.test(raw)) return false;
    const hit = decodedSync.get(attachKey(raw));
    if (!hit) return false;
    applyDecoded(el, raw, hit);
    return true;
  }
  function onSrcMutation(el) {
    if (writes > 50) throw new Error('死循环: src 被写了 ' + writes + ' 次');
    swapIfKnown(el);                           // currentSrc 故意保持旧值 (真实浏览器行为)
  }

  swapIfKnown(img);
  assert.strictEqual(writes, 1, 'src 只该被写一次');
  assert.strictEqual(guardHits, 1, '第二次进入必须被闸门截断');
  assert.strictEqual(img.attrs.src, BLOB, '最终指向解码结果');

  // 重复调用也必须幂等
  for (let i = 0; i < 5; i++) swapIfKnown(img);
  assert.strictEqual(writes, 1, '反复调用不再写 src');
});

test('长图清晰化: 只在带降采样参数时才升原图', () => {
  /* Discord 媒体代理会给图加 ?width=&height=&format=webp 把长图压小。
   * upgradeFullRes 的判定逻辑: 有这些参数才值得换成 cdn 原图。 */
  const hasDownscale = (u) => {
    const x = new URL(u);
    return ['width', 'height', 'format', 'quality', 'size'].some((k) => x.searchParams.has(k));
  };
  const toOriginal = (u) => {
    const x = new URL(u);
    if (/^media(-b\d)?\.discordapp\.net$/.test(x.hostname)) x.hostname = 'cdn.discordapp.com';
    if (x.hostname === 'cdn.discordapp.com') {
      for (const k of ['width', 'height', 'format', 'quality', 'animated', 'size']) x.searchParams.delete(k);
    }
    return x.href;
  };

  const downscaled = 'https://media.discordapp.net/attachments/1/2/long.png?ex=aa&is=bb&hm=cc&format=webp&quality=lossless&width=512&height=350';
  assert.ok(hasDownscale(downscaled), '带降采样参数 → 应该升级');
  const full = toOriginal(downscaled);
  assert.ok(full.indexOf('cdn.discordapp.com') > 0, '主机换成 cdn');
  assert.ok(full.indexOf('width=') < 0 && full.indexOf('format=') < 0, '降采样参数被剥掉');
  assert.ok(full.indexOf('ex=aa') > 0 && full.indexOf('hm=cc') > 0, '签名参数必须保留 (否则 403)');
  assert.ok(!hasDownscale(full), '升级后的 URL 不该再触发升级 (防循环)');

  const already = 'https://cdn.discordapp.com/attachments/1/2/long.png?ex=aa&is=bb&hm=cc';
  assert.ok(!hasDownscale(already), '本来就是原图 → 不折腾');
});

test('表情解锁: 被锁表情插 CDN 图片链接而不是 :name:', () => {
  /* 为何不能插 :name: —— 服务器外部表情写成 :name: 发出去服务端解不开,
   * 对方只看到字面文本。插 CDN URL 则 Discord 自动展开成图片。 */
  const cdnUrl = (id, animated) =>
    'https://cdn.discordapp.com/emojis/' + id + (animated ? '.gif' : '.webp') + '?size=96';
  assert.strictEqual(cdnUrl('1375519252181815557', false),
    'https://cdn.discordapp.com/emojis/1375519252181815557.webp?size=96');
  assert.strictEqual(cdnUrl('123', true),
    'https://cdn.discordapp.com/emojis/123.gif?size=96');
  // id 必须存在才插 (拿不到就不做, 免得插出坏链接)
  const shouldInsert = (id) => !!id;
  assert.strictEqual(shouldInsert(''), false);
  assert.strictEqual(shouldInsert('1375519252181815557'), true);
});

test('大图选取: 长图(窄)也必须被选中装缩放', () => {
  /* 3.5.0 的 bug: 用「宽度 ≥ 200」筛真正的大图。
   * 一张 1024×6000 的长条图按高度缩进 772px 高的弹窗后宽只剩 132px
   * → 被排掉 → 长图的滚轮缩放根本没装上 (主人反馈)。
   * 改成按位置(在 mediaArea 内)优先 + 小面积下限排图标。 */
  const pick = (imgs) => {
    let best = 0, hit = null;
    for (const i of imgs) {
      if (i.w < 60 && i.h < 60) continue;
      if (i.inAvatar || i.inBadge) continue;
      const score = (i.inMedia ? 1e9 : 0) + i.w * i.h;
      if (score > best) { best = score; hit = i; }
    }
    return hit;
  };

  const avatar = { name: 'avatar', w: 40, h: 40, inAvatar: true, inMedia: false };
  const badge = { name: 'badge', w: 14, h: 14, inBadge: true, inMedia: false };
  const longImg = { name: 'long', w: 132, h: 772, inMedia: true };
  assert.strictEqual(pick([avatar, badge, longImg]).name, 'long', '窄长图必须被选中');

  // 旧逻辑复现: 宽度门槛会漏掉它
  const oldPick = (imgs) => imgs.filter((i) => i.w >= 200).sort((a, b) => b.w * b.h - a.w * a.h)[0] || null;
  assert.strictEqual(oldPick([avatar, badge, longImg]), null, '旧逻辑确实漏掉长图 (证明这测试有意义)');

  // 正常图仍然选对
  const normal = { name: 'normal', w: 552, h: 828, inMedia: true };
  assert.strictEqual(pick([avatar, badge, normal]).name, 'normal');
  // 头像再大也不选 (弹窗里不会有, 但防御性)
  const bigAvatar = { name: 'bigAvatar', w: 900, h: 900, inAvatar: true, inMedia: false };
  assert.strictEqual(pick([bigAvatar, longImg]).name, 'long', '媒体区优先于任何头像');
});

test('Slate 输入: 必须用 paste 通道 (execCommand 只改 DOM 不改 model)', () => {
  /* 实测发现的真因: Discord 的 Slate 有两份状态, 发送时读的是内部 model。
   *   execCommand('insertText') → 只动 DOM, model 不变 → 框里有字但发出去是空的
   *   ClipboardEvent('paste')   → model 真的更新
   * 这里用最小模型验证 insertIntoComposer 的通道优先级。 */
  const calls = [];
  const fakeInput = {
    focus() { calls.push('focus'); },
    dispatchEvent(ev) { calls.push('dispatch:' + ev.type); return true; },
  };
  // 复刻 insertIntoComposer 的主通道逻辑
  function insert(input, text, hasClipboardEvent) {
    input.focus();
    if (hasClipboardEvent) {
      input.dispatchEvent({ type: 'paste', text });
      return 'paste';
    }
    return 'execCommand';
  }
  assert.strictEqual(insert(fakeInput, 'x', true), 'paste', '有 ClipboardEvent 时必须走 paste');
  assert.deepStrictEqual(calls, ['focus', 'dispatch:paste'], '顺序: 先聚焦再派发 paste');
  assert.strictEqual(insert(fakeInput, 'x', false), 'execCommand', '没有 ClipboardEvent 才退回 execCommand');
});

test('表情锁定判定: lockedEmoji 类名不可用作锁信号 (57/57 都带它)', () => {
  /* 实测踩坑: 面板里每一个表情的 img 都带 lockedEmoji 类名,
   * 拿它当锁信号会把本服可用表情也当成锁住的 → 原生能发的反被换成链接。
   * 真正的锁信号是按钮内的 emojiLockIcon 元素 / NitroLocked 分区 / aria-disabled。 */
  const mk = (o) => ({
    attrs: o.attrs || {},
    hasLockIcon: !!o.hasLockIcon,
    inNitroSection: !!o.inNitroSection,
    getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; },
    querySelector(sel) { return /emojiLockIcon/.test(sel) && this.hasLockIcon ? {} : null; },
    closest(sel) { return /NitroLocked/.test(sel) && this.inNitroSection ? {} : null; },
  });
  const locked = (h) => {
    if (!h) return false;
    if (h.getAttribute('aria-disabled') === 'true') return true;
    if (h.querySelector('[class*="emojiLockIcon"]')) return true;
    if (h.closest('[class*="NitroLocked"]')) return true;
    return false;
  };

  // 本服静态表情: 原生可用 → 不该拦 (即使 img 带 lockedEmoji 类名)
  assert.strictEqual(locked(mk({})), false, '本服静态表情不该被判为锁');
  // 本服动图: 带锁图标 → 该拦 (主人说的「本服动图没解锁」)
  assert.strictEqual(locked(mk({ hasLockIcon: true })), true, '本服动图带锁图标 → 拦');
  // 外部服务器表情: 在 NitroLocked 分区
  assert.strictEqual(locked(mk({ inNitroSection: true })), true, '外部表情 → 拦');
  assert.strictEqual(locked(mk({ attrs: { 'aria-disabled': 'true' } })), true, 'aria-disabled → 拦');
});

test('表情动图后缀: 必须读 data-animated 而非 img.src', () => {
  /* 面板预览图统一是 .webp 静态帧, 用 /\.gif/.test(img.src) 永远为 false
   * → 动图会被当静态图插出去, 发出来是不动的。
   * Discord 自己在按钮上写了 data-animated="true"。 */
  const cdn = (id, animated) =>
    'https://cdn.discordapp.com/emojis/' + id + (animated ? '.gif' : '.webp') + '?size=96';
  const previewSrc = 'https://cdn.discordapp.com/emojis/123.webp?size=48';   // 面板预览恒为 webp
  const wrongWay = /\.gif/.test(previewSrc);
  assert.strictEqual(wrongWay, false, '证明: 看 img.src 判断动图恒为 false');

  const btnAnimated = { getAttribute: (k) => (k === 'data-animated' ? 'true' : null) };
  const rightWay = btnAnimated.getAttribute('data-animated') === 'true';
  assert.strictEqual(rightWay, true, 'data-animated 才是可靠来源');
  assert.ok(cdn('123', rightWay).endsWith('.gif?size=96'), '动图必须用 .gif 后缀');
  assert.ok(cdn('123', wrongWay).endsWith('.webp?size=96'), '静态图用 .webp');
});

test('贴纸解锁: 按 format_type 选后缀, Lottie 不可链接化', () => {
  /* Discord 贴纸的 format_type: 1=PNG 2=APNG 3=Lottie 4=GIF
   * 贴纸 CDN 必须走 media.discordapp.net —— 实测 cdn.discordapp.com/stickers/
   * 会被 CORS 拦 (Failed to fetch), media 域返 206 OK。
   * Lottie 是 JSON 动画, 发链接对方看到的是 JSON 文本, 且实测取 .json 直接 400
   * → 返回 null 交回 Discord 原生处理, 不做无意义的插入。 */
  const EXT = { 1: 'png', 2: 'png', 4: 'gif' };
  const url = (id, fmt) => {
    const ext = EXT[+fmt];
    return ext ? 'https://media.discordapp.net/stickers/' + id + '.' + ext + '?size=160' : null;
  };
  assert.strictEqual(url('300000000000000003', 1),
    'https://media.discordapp.net/stickers/300000000000000003.png?size=160', 'PNG 贴纸');
  assert.strictEqual(url('400000000000000004', 4),
    'https://media.discordapp.net/stickers/400000000000000004.gif?size=160', 'GIF 贴纸用 .gif');
  assert.strictEqual(url('x', 2).indexOf('.png') > 0, true, 'APNG 也用 .png');
  assert.strictEqual(url('500000000000000005', 3), null, 'Lottie → null (不拦, 交回原生)');
  // 必须是 media 域, 不能是 cdn 域
  assert.ok(url('1', 1).indexOf('media.discordapp.net') > 0, '贴纸必须走 media 域');
  assert.ok(url('1', 1).indexOf('cdn.discordapp.com') < 0, '不能用 cdn 域 (CORS 拦)');
});

test('贴纸解锁: 只拦外服贴纸, 本服的交回原生', () => {
  const myGuild = '100000000000000001';   // 当前所在服务器 (示例值)
  const shouldHijack = (ent) => !(ent && ent.guild_id && ent.guild_id === myGuild);
  assert.strictEqual(shouldHijack({ guild_id: myGuild }), false, '本服贴纸 → 原生发送');
  assert.strictEqual(shouldHijack({ guild_id: '999' }), true, '外服贴纸 → 拦下换链接');
  assert.strictEqual(shouldHijack({ pack_id: '200000000000000002' }), true, '官方贴纸包 (无 guild_id) → 拦');
  assert.strictEqual(shouldHijack(null), true, '读不到实体时保守拦下 (宁可发链接也别静默失败)');
});

test('贴纸: 锁判定用 stickerUnsendable 而非 guild_id', () => {
  /* 实测: Discord 自己在 stickerNode 上标 stickerUnsendable (带 grayscale(1) 滤镜),
   * 这比我们拿 guild_id 自己推更准 —— 9 张里有 2 张 guild_id 不同但仍可发
   * (贴纸有 pack/官方来源等情况)。所以以 Discord 的标记为准。
   * 顺带: 这个 class 也是黑白滤镜的源头, 加在 stickerNode 上,
   *   只给 img / sticker_ 去 filter 是盖不到的。 */
  const mk = (cls) => ({ getAttribute: () => cls });
  const unsendable = (node) => !!(node && /stickerUnsendable/.test(node.getAttribute('class') || ''));
  assert.strictEqual(unsendable(mk('stickerNode_c6367b stickerUnsendable_c6367b')), true, '带标记 → 拦下');
  assert.strictEqual(unsendable(mk('stickerNode_c6367b')), false, '无标记 → 原生发送');
  assert.strictEqual(unsendable(null), false, '拿不到节点 → 不拦 (交回原生, 避免误伤)');
});

test('Firefox 预览取字节: 三条路的降级顺序与 ck 归属', () => {
  /* 【Firefox 丢 UI 的真因】Discord 预览卡是 <img src="blob:https://discord.com/…">,
   * 这个 blob 归页面的 principal。Chrome 的隔离世界能 fetch 它, Firefox 不能
   * (同族问题: Mozilla bug 1696174 —— downloads.download 也读不了页面 blob)。
   * fetch 抛异常 → preparePreview 整个挂掉 → 分数角标与 ✕/○ 开关全都不出现。
   *
   * 修法: fetch → canvas 重绘 → 主世界代取, 依次降级。
   * canvas 路不发请求, 所以不受 principal 限制。 */
  const pick = (fetchOk, canvasOk) => fetchOk ? 'fetch' : (canvasOk ? 'canvas' : 'main');
  assert.strictEqual(pick(true, true), 'fetch', 'Chromium: 直接 fetch 最快');
  assert.strictEqual(pick(false, true), 'canvas', 'Firefox: fetch 失败 → canvas 重绘');
  assert.strictEqual(pick(false, false), 'main', '都不行 → 主世界代取');

  /* canvas 重绘拿到的是重编码 PNG, 字节与原 File 不同 →
   * 算出来的内容键是假的, 会让 hook 端永远对不上。宁可不算, 回落感知指纹。 */
  const shouldComputeCk = (grab) => grab !== 'canvas';
  assert.strictEqual(shouldComputeCk('fetch'), true, 'fetch 拿到原字节 → 算 ck');
  assert.strictEqual(shouldComputeCk('main'), true, '主世界代取也是原字节 → 算 ck');
  assert.strictEqual(shouldComputeCk('canvas'), false, 'canvas 是重编码 → 不算 ck (否则假键)');
});

test('Firefox 预览取字节: 全失败也要挂上 UI, 不能静默死', () => {
  /* 上一版的 catch 只 stamp 日志就结束了 → 用户看到的就是「插件没反应」。
   * 现在即使拿不到字节也要 makeToggle: 没指纹也能翻开关, 默认混淆。 */
  const label = (degraded, decision, on) =>
    degraded && !decision ? (on ? '默认·混' : '默认·原')
      : !decision ? '审查中'
      : decision.manual ? (on ? '手动·混' : '手动·原') : '分数';
  assert.strictEqual(label(true, null, true), '默认·混', '降级模式说实话, 不假装「审查中」');
  assert.strictEqual(label(true, null, false), '默认·原', '降级模式也能翻到原图发送');
  assert.strictEqual(label(false, null, true), '审查中', '正常路径审查中');
  assert.strictEqual(label(true, { manual: true }, false), '手动·原', '用户手动推翻后按手动显示');
});

test('Firefox 解码: ImageData 必须与 canvas 同 realm', () => {
  /* 【Firefox 无法解码的真因】(诊断面板原话)
   *   dec:CanvasRenderingContext2D.putImageData:
   *   Failed to extract Uint8ClampedArray from ImageData (security check failed?)
   *
   * 隔离世界(content script)与页面是不同 realm。
   * document.createElement('canvas') 拿到的 canvas 属于【页面 realm】(带 Xray 包装),
   * 而 new ImageData(...) 造出来的是【隔离世界】的对象 →
   * putImageData 时 Firefox 无法跨 realm 取出里面的 Uint8ClampedArray, 直接抛。
   * Chrome 的隔离世界没有这层限制, 所以之前一直没暴露。
   *
   * 修法: 用 ctx.createImageData() 让 ImageData 与 ctx 同 realm, 再 .data.set() 灌像素。 */
  const mkCtx = (crossRealmOk) => ({
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4), _realm: 'ctx' }),
    putImageData: (id) => {
      if (id._realm !== 'ctx' && !crossRealmOk) throw new Error('Failed to extract Uint8ClampedArray from ImageData (security check failed?)');
      return 'ok';
    },
  });
  const src = { width: 2, height: 2, data: new Uint8ClampedArray(16).fill(7) };

  // 正确写法: 同 realm → Firefox 与 Chrome 都过
  const draw = (ctx) => {
    let id = null;
    try { id = ctx.createImageData(src.width, src.height); id.data.set(src.data); } catch (e) { id = null; }
    if (!id) id = { width: src.width, height: src.height, data: src.data, _realm: 'isolated' };
    return ctx.putImageData(id);
  };
  assert.strictEqual(draw(mkCtx(false)), 'ok', 'Firefox(严格跨realm): 用 ctx.createImageData 才过');
  assert.strictEqual(draw(mkCtx(true)), 'ok', 'Chrome(宽松): 同样过');

  // 旧写法(直接 new ImageData)在 Firefox 上必然抛 —— 反面断言, 防回归
  const drawOld = (ctx) => ctx.putImageData({ width: 2, height: 2, data: src.data, _realm: 'isolated' });
  assert.throws(() => drawOld(mkCtx(false)), /security check failed/, '旧写法在 Firefox 上会抛');
  assert.strictEqual(drawOld(mkCtx(true)), 'ok', '旧写法只在 Chrome 上侥幸能跑');

  // 像素必须真的搬过去, 不能只是不报错
  const ctx = mkCtx(false);
  const id = ctx.createImageData(2, 2);
  id.data.set(src.data);
  assert.deepStrictEqual(Array.from(id.data), Array.from(src.data), '灌进去的像素要一致');
});
