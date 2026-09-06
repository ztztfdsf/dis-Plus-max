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

test('审查: nsfwOnly 关掉/缺失时一律混淆 (保守兵库)', async () => {
  /* 注意这不是「默认值」的测试 —— v3.6.8 起 nsfwOnly 默认为 true。
   * 这里测的是 decide() 的兵库行为: 拿不到配置时宁可全混淆,
   * 而不是当成“只混淆高分图”把图直发出去。 */
  const sky = paint(200, 150, () => [80, 150, 230]);
  const r = await review.decide(sky, {});
  assert.strictEqual(r.obfuscate, true, '空 cfg → 全混淆');
  assert.strictEqual(r.source, 'always');
  // 显式关掉 → 也是全混淆
  const off = await review.decide(sky, { nsfwOnly: false });
  assert.strictEqual(off.obfuscate, true, '开关关掉 → 全混淆 (一张不漏)');
  assert.strictEqual(off.source, 'always');
  // 传了个非布尔的杂值 → 仍然保守 (不能被 'true' 字符串之类骷过去)
  const weird = await review.decide(sky, { nsfwOnly: 'true' });
  assert.strictEqual(weird.obfuscate, true, '字符串 "true" 不算开启 → 仍全混淆');
});

test('审查默认值: 新装就该是「只混淆色情图片」= 开 (v3.6.8 行为变更)', () => {
  /* 【主人要求】默认勾上。四处默认值必须一致, 否则会出现
   *   弹窗显示勾上、实际行为却是全混淆 这种“界面说谎”。
   * 这里直接读源文件比对 —— 因为它们分布在四个不同运行环境
   *   (content.js 隔离世界 / options.js 设置页 / popup.js 弹窗 / hook.js 主世界),
   *   单测里没法把四个都跑起来。 */
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');

  // 1) content.js 与 options.js 的 DEFAULTS 必须是 true
  for (const f of ['content.js', 'options.js']) {
    const s = read(f);
    assert.ok(/nsfwOnly:\s*true/.test(s), f + ' 的 DEFAULTS 里 nsfwOnly 必须为 true');
    assert.ok(!/nsfwOnly:\s*false/.test(s), f + ' 里不得再有 nsfwOnly: false');
  }

  // 2) popup.js 读取时必须用 !== false 而不是 === true
  //    === true 的语义是“没存过就算关” → 新装的人看到未勾选 (跟默认值矛盾)
  const popup = read('popup.js');
  assert.ok(/t-nsfwOnly'\)\.checked = v\.nsfwOnly !== false/.test(popup),
    'popup.js 读 nsfwOnly 要用 !== false (与其他默认开的开关一致)');
  assert.ok(!/v\.nsfwOnly === true/.test(popup),
    'popup.js 不得再用 === true (那会让新装的人看到未勾选)');

  // 3) hook.js 是主世界兵库, 故意保留 false —— 配置同步前宁可全混淆
  const hook = read('hook.js');
  assert.ok(/nsfwOnly:\s*false/.test(hook),
    'hook.js 的初值应保留 false: 配置还没送到时宁可全混淆, 不能漏发原图');

  // 4) review.js 的门禁仍用 !== true (拿不到配置时保守)
  const rev = read('review.js');
  assert.ok(/cfg\.nsfwOnly !== true/.test(rev),
    'review.js 内部判定仍用 !== true: 未传配置时要全混淆');
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

test('流程: 关掉审查 → 所有图都混淆, 但仍是先判定后编码', async () => {
  // (v3.6.8 起审查默认是开的; 这里测的是【关掉后】的流程)
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

/* ---------- 跳 realm 回归 (Firefox 隔离世界) ----------
 * Firefox 152 实测: 隔离世界把本 realm 的 TypedArray 交给页面 realm 的
 * CompressionStream writer 时, 参数转换直接拒收:
 *   TypeError: Value could not be converted to any of: ArrayBufferView, ArrayBuffer.
 * 这里把 WritableStreamDefaultWriter.prototype.write 换成同样拒收 TypedArray 的版本,
 * 在 Node 里复现那个环境 —— 编码器必须仍然能干活 (走 Blob 输入, 不碰公开 writer)。 */
test('跳 realm: writer.write 拒收 TypedArray 时 encodePngFast 仍需成功', async () => {
  if (typeof CompressionStream === 'undefined' || typeof WritableStreamDefaultWriter === 'undefined') {
    console.log('       (无 CompressionStream/WritableStreamDefaultWriter, 跳过)');
    return;
  }
  const proto = WritableStreamDefaultWriter.prototype;
  const origWrite = proto.write;
  let rejected = 0;
  proto.write = function (chunk) {
    if (chunk && chunk.buffer instanceof ArrayBuffer) {
      rejected++;
      return Promise.reject(new TypeError('Value could not be converted to any of: ArrayBufferView, ArrayBuffer.'));
    }
    return origWrite.call(this, chunk);
  };
  try {
    const orig = makeData(96, 72, 'xrealm');
    const enc = encodeImage(orig, { salt: 'xr' });
    const u8 = await core.encodePngFast(enc);
    assert.ok(core.isPng(u8), '仍产出合法 PNG');
    assertPixelEqual(decodeImage(pngDecode(Buffer.from(u8)), { salt: 'xr' }), orig, '跳 realm 下往返无损');
    // 反面断言: 旧写法 (writer.write(typedArray)) 在这个环境里必须真的挂
    let oldFailed = false;
    try {
      const cs = new CompressionStream('deflate');
      const wr = cs.writable.getWriter();
      await wr.write(new Uint8Array([1, 2, 3]));
    } catch (e) { oldFailed = /could not be converted/.test(e.message); }
    assert.ok(oldFailed, '旧写法必须在此环境报错 (否则回归测试本身失效)');
    assert.ok(rejected > 0, '补丁确实生效过');
  } finally {
    proto.write = origWrite;
  }
});

test('约 JS 傅底编码器 encodePngStore: 无任何浏览器 API 也能无损出 PNG', () => {
  const orig = makeData(128, 96, 'storepng');
  const enc = encodeImage(orig, { salt: 'st' });
  const u8 = core.encodePngStore(enc);
  assert.ok(core.isPng(u8), '是合法 PNG');
  const parsed = pngDecode(Buffer.from(u8));
  assert.strictEqual(parsed.width, enc.width, '宽一致');
  assert.strictEqual(parsed.height, enc.height, '高一致');
  let px = 0;
  for (let i = 0; i < enc.data.length; i++) if (enc.data[i] !== parsed.data[i]) px++;
  assert.strictEqual(px, 0, 'store 不改像素');
  assertPixelEqual(decodeImage(parsed, { salt: 'st' }), orig, 'store 往返无损');
  // 叠标记块后仍可识别 (回落产物也得能被对方预筛到)
  const marked = core.pngAddMarker(u8, enc.meta);
  assert.ok(core.pngReadMarker(marked, 'st'), 'moEg 可读');
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

test('Firefox 解码: 像素字节必须先过 realm 桥 (cloneInto)', () => {
  /* 【Firefox 无法解码的真因】诊断面板原话:
   *   dec:CanvasRenderingContext2D.putImageData:
   *   Failed to extract Uint8ClampedArray from ImageData (security check failed?)
   *
   * Firefox 152 用临时扩展逐步探针实测 (隔离世界):
   *   ctx.createImageData(w,h).data.set(沙箱数组)  → Permission denied to access object
   *   new ImageData(沙箱数组,w,h) → putImageData    → Failed to extract Uint8ClampedArray…
   *   cloneInto(沙箱数组, window.wrappedJSObject) 后两者都 ✓
   *
   * 拒收点不是「谁造的 ImageData」而是「字节属于哪个 realm」——
   * 所以 v3.6.3 只把 new ImageData 换成 ctx.createImageData 是无效的:
   * 报错只是从 putImageData 前移到 .data.set(), 而那句外面包了 try/catch,
   * 失败后又退回 new ImageData 路 → 报同一句话。
   * 下面用带 realm 标记的假 ctx 复现这一整套语义。 */
  const PAGE = 'page';
  // 页面 realm 的字节容器: set() 只接受同 realm 的源
  const mkPageBytes = (n) => {
    const buf = new Uint8ClampedArray(n);
    return {
      _realm: PAGE, length: n,
      set(src) {
        if (src._realm !== PAGE) throw new Error('Permission denied to access object');
        buf.set(src.bytes);
      },
      get bytes() { return buf; },
    };
  };
  const mkCtx = () => ({
    createImageData: (w, h) => ({ width: w, height: h, data: mkPageBytes(w * h * 4), _realm: PAGE }),
    putImageData: (id) => {
      if (id.data._realm !== PAGE) {
        throw new Error('Failed to extract Uint8ClampedArray from ImageData (security check failed?)');
      }
      return Array.from(id.data.bytes);
    },
  });
  // 沙箱 realm 的像素 (我们算出来的解码结果)
  const sandbox = { _realm: 'sandbox', bytes: new Uint8ClampedArray([9, 8, 7, 255]), length: 4 };
  const cloneIntoStub = (v) => ({ _realm: PAGE, bytes: v.bytes, length: v.length });

  // ✅ 正确写法: 先过桥, 再灌进同 realm 的 ImageData
  const draw = (ctx, bridge) => {
    const id = ctx.createImageData(1, 1);
    id.data.set(bridge(sandbox));
    return ctx.putImageData(id);
  };
  assert.deepStrictEqual(draw(mkCtx(), cloneIntoStub), [9, 8, 7, 255], 'cloneInto 后像素真的落到了 canvas');

  // ❌ 反面断言 1: 不过桥直接 set → Permission denied (v3.6.3 就死在这)
  assert.throws(() => draw(mkCtx(), (v) => v), /Permission denied/, '不过桥: .data.set 就被拒');

  // ❌ 反面断言 2: 拿沙箱数组自己造 ImageData → 报那句经典错误
  assert.throws(
    () => mkCtx().putImageData({ width: 1, height: 1, data: sandbox, _realm: 'sandbox' }),
    /Failed to extract Uint8ClampedArray/,
    '沙箱 ImageData 直接 put → 就是用户看到的报错');

  // 主世界/Chrome: 没有 wrappedJSObject → 桥退化为原样返回, 零开销
  const noBridge = (u8) => u8;
  assert.strictEqual(noBridge(sandbox), sandbox, '无 realm 边界时桥不拷贝');
});

test('Firefox 解码: PNG 编码三级回落且失败原因不得吞掉', () => {
  /* 旧版只有两级, 且 encodePngFast 失败时静默回落 canvas →
   * 真正的首发异常被吞, 只能看到下游 putImageData 报错
   * → 一路误判成「new Response(stream) 在隔离世界不行」。
   * 现在: fast → canvas → store, 每级原因都拼进 lastFastPngErr。 */
  function encodePng(avail) {
    const errs = [];
    for (const [name, ok] of [['fast', avail.fast], ['canvas', avail.canvas], ['store', avail.store]]) {
      if (ok) return { path: name, err: errs.join(' | ') };
      errs.push(name + ':boom');
    }
    return { path: 'none', err: errs.join(' | ') };
  }
  assert.strictEqual(encodePng({ fast: 1, canvas: 1, store: 1 }).path, 'fast', 'Chrome: 走最快的');
  const ff = encodePng({ fast: 0, canvas: 0, store: 1 });
  assert.strictEqual(ff.path, 'store', '两级都挂 → 纯 JS 兜底仍能出图');
  assert.strictEqual(ff.err, 'fast:boom | canvas:boom', '两级失败原因都得留下来');
  assert.strictEqual(encodePng({ fast: 0, canvas: 1, store: 1 }).err, 'fast:boom', '即使成功也要留首发异常');
  assert.strictEqual(encodePng({ fast: 0, canvas: 0, store: 0 }).path, 'none', '全挂时得明确报错');
});

/* ---------- 跨 realm: Blob 字节必须先拷成本 realm ----------
 * Firefox 152 实测 (隔离世界):
 *   const u8 = new Uint8Array(await blob.arrayBuffer());
 *   u8.length / u8[i] / for 循环求和   → 全部正常
 *   u8.subarray(a, b)                 → Error: Permission denied to access property "constructor"
 *   new TextDecoder().decode(u8.sub…) → 同上
 * (TypedArray 派生要读 @@species 构造器, 跨 realm 不给访问;
 *  Response / FileReader / ab.slice(0) 拿到的 buffer 同样如此,
 *  只有 u8.set(跨realm视图) / Uint8Array.from / structuredClone / blob.stream() 是干净的)
 *
 * 后果: core.js 的 PNG chunk 读写全靠 subarray + TextDecoder, 而调用点全是 try/catch →
 *   moEg / moMt 静默丢失。混淆图发出去对方预筛读不到标记 → 根本不触发解码。
 *   这就是「像素往返 PIXEL-PERFECT 但 metaChunks MISS」的真因。
 *
 * 这里用一个 subarray 会抛的 Uint8Array 子类模拟那种视图, 断言:
 *   1. 直接喂 → PNG chunk 相关能力真的会挂 (反面断言, 防回归)
 *   2. 过一次 .set() 拷贝 → 全部恢复正常
 */
test('跨 realm: Blob 字节直接用会让 moEg/moMt 静默丢失, 拷一次就好', async () => {
  class XrayView extends Uint8Array {
    subarray() { throw new Error('Permission denied to access property "constructor"'); }
    slice() { throw new Error('Permission denied to access property "constructor"'); }
  }
  const orig = makeData(48, 32, 'xrayblob');
  const enc = encodeImage(orig, { salt: 'xb' });
  const chunks = [{ k: 'workflow', v: '{"seed":42,"中文":"喵"}' }];

  // 正常字节: 插标记 + 元数据 → 都读得回来 (基线)
  let clean = new Uint8Array(writePng(enc));
  clean = core.pngPutTextChunks(clean, chunks);
  clean = core.pngAddMarker(clean, enc.meta);
  assert.ok(core.pngReadMarker(clean, 'xb'), '基线: moEg 可读');
  assert.deepStrictEqual(core.pngReadMetaChunks(clean), chunks, '基线: moMt 可读');

  // 模拟隔离世界从 blob 直接拿到的视图
  const hostile = new XrayView(clean.length);
  hostile.set(clean);
  assert.strictEqual(hostile.length, clean.length, '视图长度正常');
  assert.strictEqual(hostile[0], 0x89, '下标读取正常 (所以问题很隐蔽)');

  // ❌ 反面断言: moMt 读不出来 (subarray 被拒 → 外层 try/catch 吞掉 → 返回 null)
  assert.strictEqual(core.pngReadMetaChunks(hostile), null, '直接用: moMt 静默丢失');
  // ❌ 反面断言: 往里插块也会挂 (pngAddMarker 内部靠 subarray 搬字节)
  assert.throws(() => core.pngAddMarker(hostile, enc.meta), /Permission denied/, '直接用: 插 moEg 会抛');

  // ✅ 拷一次到本 realm → 一切恢复
  const copied = new Uint8Array(hostile.length);
  copied.set(hostile);                                  // set(跨realm视图) 是允许的
  assert.ok(core.pngReadMarker(copied, 'xb'), '拷贝后: moEg 可读');
  assert.deepStrictEqual(core.pngReadMetaChunks(copied), chunks, '拷贝后: moMt 可读');
  const marked = core.pngAddMarker(copied, enc.meta);
  assert.ok(core.isPng(marked), '拷贝后: 插块正常');
  // 内容键也得一致 (contentKey 只用下标循环, 两者本来就该相等)
  assert.strictEqual(core.contentKey(copied), core.contentKey(clean), '拷贝不改内容键');
});

/* ---------- 消息归属: 带回复的消息不能把被回复者当成作者 ----------
 * 【现象】切到另一个账号看别人发的混淆图, 徽标写「已混淆」而不是「已解析」。
 * 【真因】拓下来的真实 DOM 顺序 (2026-09):
 *     div.message__…hasReply_
 *       └ div.repliedMessage_ → img.replyAvatar_   ← 被回复者, 先出现!
 *       └ div.contents_       → img.avatar_        ← 真作者
 *   旧写法 anchor.querySelector('img[src*="/avatars/"]') 拿到第一个 = 被回复者。
 *   样本统计: 8 条带回复的消息, 8 条第一个头像都是 replyAvatar,
 *     其中 1 条被回复者正好是我 → 别人的图被标成「已混淆」。
 */
test('归属判定: 带回复的消息取 contents 内的作者头像, 不能取 replyAvatar', () => {
  const ME = '1443679787548803234';
  const OTHER = '740577126448627712';

  /* 极简 DOM 模型: 只实现 querySelector 需要的那点语义 */
  function el(cls, kids) {
    return { cls: cls, kids: kids || [], isImg: false };
  }
  function img(cls, userId) {
    return { cls: cls, kids: [], isImg: true, src: 'https://cdn.discordapp.com/avatars/' + userId + '/x.webp?size=80' };
  }
  function walk(node, hit, out) {
    for (const k of node.kids) {
      if (hit(k)) { out.push(k); }
      walk(k, hit, out);
    }
  }
  function q(node, hit) {
    const out = [];
    walk(node, hit, out);
    return out[0] || null;
  }
  const isAvatar = (n) => n.isImg && /\/avatars\//.test(n.src);
  const isReplyAvatar = (n) => isAvatar(n) && /replyAvatar/.test(n.cls);
  const isAuthorAvatar = (n) => isAvatar(n) && !/replyAvatar/.test(n.cls);
  const isContents = (n) => /contents/.test(n.cls);

  // 别人(OTHER)发的消息, 回复的是我(ME)
  const msg = el('message__5126c hasReply_c19a55', [
    el('repliedMessage_c19a55', [img('replyAvatar_c19a55 clickable_c19a55', ME)]),
    el('contents_c19a55', [img('avatar_c19a55 clickable_c19a55', OTHER)]),
  ]);

  const uid = (n) => (n ? n.src.match(/\/avatars\/(\d+)\//)[1] : null);

  // ❌ 旧写法: 命中 replyAvatar → 判成「我发的」
  assert.strictEqual(uid(q(msg, isAvatar)), ME, '旧写法确实先命中被回复者 (这就是 bug)');

  // ✅ 新写法: 先缩到 contents 容器, 再排 replyAvatar
  function authorAvatar(scope) {
    const box = q(scope, isContents) || scope;
    return q(box, isAuthorAvatar) || q(scope, isAuthorAvatar);
  }
  assert.strictEqual(uid(authorAvatar(msg)), OTHER, '新写法拿到真作者 → 标「已解析」');
  assert.strictEqual(uid(authorAvatar(msg)) === ME, false, '不会误判成我发的');

  // 我自己发的带回复消息: 仍要正确识别为「我的」
  const mineMsg = el('message__5126c hasReply_c19a55', [
    el('repliedMessage_c19a55', [img('replyAvatar_c19a55', OTHER)]),
    el('contents_c19a55', [img('avatar_c19a55', ME)]),
  ]);
  assert.strictEqual(uid(authorAvatar(mineMsg)), ME, '我发的仍判为我 → 标「已混淆」');

  // 无回复的普通消息: 两种写法都对 (不能因为修 bug 把简单情形弄坏)
  const plain = el('message__5126c', [el('contents_c19a55', [img('avatar_c19a55', OTHER)])]);
  assert.strictEqual(uid(q(plain, isAvatar)), OTHER, '普通消息旧写法本来也对');
  assert.strictEqual(uid(authorAvatar(plain)), OTHER, '普通消息新写法一致');

  // 合并组的后续消息: 没有任何头像 → 必须回退到往上找, 且往上也要排 replyAvatar
  const grouped = el('message__5126c', [el('contents_c19a55', [])]);
  assert.strictEqual(authorAvatar(grouped), null, '合并组消息本身没头像 → 交给上溯逻辑');
});

test('归属判定: fiber 优先于头像 (头像可能根本不存在)', () => {
  /* React fiber 里 message.author.id 是权威值。
   * ⚠️ Firefox 隔离世界【看不到】DOM 节点上的 React expando:
   *     Object.keys(node) 里没有 __reactFiber$… (探针实测 NONE)
   *   必须 node.wrappedJSObject 穿透才能读到 → 探针实测穿透后 author.id 正常。 */
  const ME = 'me-123';
  function fiberAuthorId(node) {
    // 模拟: 沙箱直接看不到 expando, 只有 wrappedJSObject 上有
    const view = node.wrappedJSObject || node;
    const key = Object.keys(view).find((k) => k.indexOf('__reactFiber$') === 0);
    if (!key) return '';
    let f = view[key];
    for (let i = 0; i < 14 && f; i++) {
      const m = f.memoizedProps && f.memoizedProps.message;
      if (m && m.author && m.author.id) return String(m.author.id);
      f = f.return;
    }
    return '';
  }
  // 沙箱视角: 节点自身没有 expando, 藏在 wrappedJSObject 后面
  const inner = { '__reactFiber$k': { memoizedProps: { message: { author: { id: ME } } }, return: null } };
  const node = { wrappedJSObject: inner };
  assert.strictEqual(fiberAuthorId(node), ME, '穿透 wrappedJSObject 能读到 author.id');

  // 没有 wrappedJSObject (Chrome / 主世界) → 直接读自身
  const chromeNode = { '__reactFiber$k': { memoizedProps: { message: { author: { id: ME } } }, return: null } };
  assert.strictEqual(fiberAuthorId(chromeNode), ME, 'Chrome 直接读自身 expando');

  // 沙箱看不到 (没穿透) → 返回空字符串, 让调用方回落 DOM 头像
  const blind = { '__reactFiber$k': undefined };
  assert.strictEqual(fiberAuthorId(blind), '', '读不到 fiber → 空串, 回落 DOM');

  // fiber 要能沿 return 链往上找 (图片本身的 fiber 上没有 message)
  const chained = {
    '__reactFiber$k': {
      memoizedProps: { src: 'x.png' },
      return: { memoizedProps: {}, return: { memoizedProps: { message: { author: { id: ME } } }, return: null } },
    },
  };
  assert.strictEqual(fiberAuthorId(chained), ME, '沿 fiber.return 上溯能找到 message');
});

/* ---------- 输入框插文本: Firefox 的 ClipboardEvent 带不动数据 ----------
 * 【现象】火狐里回复别人消息时, 表情/贴纸的图片链接发不出去。
 * 【真因】(Firefox 152 探针实测)
 *   new ClipboardEvent('paste', { clipboardData: dt })
 *     → 页面端 e.clipboardData.types === ""  (空!)
 *   连让【页面 realm 自己】造也是空的 → 不是跨 realm 问题,
 *   而是 Gecko 的 ClipboardEvent 构造器不实现 clipboardData 这个 init 成员
 *   (Chrome 实现了 → 所以旧写法只在 Chrome 能跑)。
 *   Slate 拿到空剪贴板 → model 不更新 → 发出去是空的。
 * 【修法】造完再 defineProperty 盖 clipboardData; 且 DataTransfer 必须是页面 realm 的。
 *   并且不能只看 dispatchEvent 有没抛 —— 那永远成功, 必须核对编辑器内容真的变了。
 */
test('插入输入框: 必须核对内容真变了, 而不是「事件发出去就算成功」', () => {
  /* 模拟 Gecko: 构造器忽略 clipboardData, 只有 defineProperty 盖上的才生效 */
  function geckoClipboardEvent(init) {
    const ev = { type: 'paste', clipboardData: null, _init: init };
    return ev;                                     // 构造器不认 init.clipboardData
  }
  function slateHandle(ev, model) {
    const dt = ev.clipboardData;
    const t = dt ? dt.data : '';
    return t ? model + t : model;                  // 空剪贴板 → model 不变
  }

  // ❌ 旧写法: 构造器传 clipboardData → Gecko 忽略 → model 不变
  let model = '';
  const oldEv = geckoClipboardEvent({ clipboardData: { data: 'URL' } });
  assert.strictEqual(slateHandle(oldEv, model), '', '旧写法在 Gecko 上 model 不变 (发不出去)');

  // ✅ 新写法: 造完盖上去
  const newEv = geckoClipboardEvent({});
  newEv.clipboardData = { data: 'URL' };           // 等价于 defineProperty
  assert.strictEqual(slateHandle(newEv, model), 'URL', '盖上 clipboardData 后 model 更新');

  /* 通道回落: 只有真的改动了内容才算这条通道可用 */
  function insert(channels) {
    let content = '';
    for (const ch of channels) {
      const before = content;
      if (!ch.dispatched) continue;                // 构造失败 → 下一条
      if (ch.writes) content += ch.writes;
      if (content !== before) return { used: ch.name, content: content };
    }
    return { used: 'none', content: content };
  }
  // Firefox: paste 通道事件发出去了但没写入 → 必须继续往下试
  assert.strictEqual(
    insert([
      { name: 'paste', dispatched: true, writes: '' },
      { name: 'beforeinput-text', dispatched: true, writes: 'URL' },
    ]).used,
    'beforeinput-text',
    'paste 无效时自动落到 beforeinput');
  // Chrome: paste 直接成功 → 不该继续
  assert.strictEqual(
    insert([
      { name: 'paste', dispatched: true, writes: 'URL' },
      { name: 'beforeinput-text', dispatched: true, writes: 'SHOULD-NOT-RUN' },
    ]).content,
    'URL',
    'paste 成功就停, 不会插两遍');
  // 全挂 → 明确 none (供诊断面板显示 insert=all-failed)
  assert.strictEqual(insert([{ name: 'paste', dispatched: false }]).used, 'none', '全挂时报 none');
});

/* ---------- toast 文案不能自相矛盾 ----------
 * 【现象】上传原图时弹「已混淆上传 · 原图 · 123KB」。
 * 【真因】旧代码无论换没换体都拼 '已混淆上传 · ' + info,
 *   而 info 里的 label 在直通时是「原图」→ 凑出矛盾话。
 * 【修法】hook 端把 obf 布尔一起发过来, 由它决定文案。
 */
test('toast 文案: 原图直通不能说「已混淆上传」', () => {
  function toastText(d) {
    const kb = d.kb || '';
    return d.obf === false ? ('原图直传' + (kb ? ' · ' + kb : ''))
                           : ('已混淆上传' + (kb ? ' · ' + kb : ''));
  }
  assert.strictEqual(toastText({ obf: false, kb: '123KB' }), '原图直传 · 123KB', '直通说原图直传');
  assert.strictEqual(toastText({ obf: true, kb: '85KB' }), '已混淆上传 · 85KB', '混淆说已混淆上传');
  assert.ok(!/已混淆/.test(toastText({ obf: false, kb: '1KB' })), '直通文案里绝不出现「已混淆」');
  // 旧写法留个反面断言, 防回归
  const oldText = (label) => '已混淆上传 · ' + label;
  assert.strictEqual(oldText('原图 · 123KB'), '已混淆上传 · 原图 · 123KB', '旧写法就是这句矛盾话');

  /* 后台统计也得分开记: 直通不能计入 uploadsReplaced */
  function tally(ev, dbg) {
    if (ev.obf === false) dbg.pass++;
    else dbg.replaced++;
    return dbg;
  }
  const dbg = tally({ obf: false }, tally({ obf: true }, { replaced: 0, pass: 0 }));
  assert.deepStrictEqual(dbg, { replaced: 1, pass: 1 }, '混淆记 replaced, 直通记 pass');
});

/* ---------- 徽标条: 必须在图外的头像槽里, 且不得重叠 ----------
 * 【现象】「已混淆」角标与「下载」按钮叠在一起。
 * 【真因】排上下靠的这行 —— const top = av ? (av.offsetTop + av.offsetHeight + 4) : 2;
 *   #15 归属重构把同作用域的 av 删了 → ReferenceError。
 *   而它在两个元素【已 append 进 DOM 之后】才执行, 又被外层 try/catch 吞掉
 *   → top 永远没写上, 两个 absolute 元素 top:auto 一起塌在同一处。
 *   实页诊断里这条 74 次: err="tag:av is not defined"。
 * 【位置要求】主人要的是【图片外面】的头像槽 (Chrome v3.6.4 的样子)。
 *   CDP 实测坐标: 消息 1126×419 / 角标 (16,48) / 下载 (16,68) / 图 (72,26) 522×348
 *   → 角标在 x=16, 图从 x=72 开始, 角标完全在图外。
 *   中间有一版改成“落在图内左上角”是改错了方向, 这里把“必须在图外”钉住。
 * 【修法】位置不变, 但两个 chip 装进同一个 flex 列, 行距交给 gap
 *   → 只需算一个 top, 结构上不可能再重叠。
 */
test('徽标条: 必须在图外的头像槽, 且角标与下载不得重叠', () => {
  const CHIP_H = 16, GAP = 4, LEFT = 16;
  const rect = (x, y, w, h) => ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h });
  const overlaps = (a, b) => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);

  /* Chrome 实测的真实尺寸 (CDP 量的, 不是拍脑袋) */
  const anchor = rect(0, 0, 1126, 419);
  const avatar = rect(16, 4, 40, 40);              // 头像: off4+40
  const img = rect(72, 26, 522, 348);              // 图片从 x=72 开始

  /* ❌ 旧写法: av 报 ReferenceError → top 没写上 → 两个元素同位置 */
  function oldPlace() {
    const tag = { left: LEFT, top: null }, dl = { left: LEFT, top: null };
    try {
      const av = (function () { throw new ReferenceError('av is not defined'); })();
      const top = av ? 48 : 2;
      tag.top = top; dl.top = top + 20;
    } catch (e) { return { tag: tag, dl: dl, err: e.message }; }
    return { tag: tag, dl: dl, err: null };
  }
  const old = oldPlace();
  assert.strictEqual(old.err, 'av is not defined', '旧代码确实就在这里报 ReferenceError');
  assert.strictEqual(old.tag.top, null, 'top 根本没被赋上 (这就是重叠的根)');
  assert.strictEqual(old.dl.top, null, '下载按钮的 top 也没赋上');
  // top 都是 auto → 塌到同一处 → 矩形重合
  assert.ok(overlaps(rect(LEFT, 0, 40, CHIP_H), rect(LEFT, 0, 30, CHIP_H)),
    '旧布局两个元素确实重叠 (主人看到的现象)');

  /* ✅ 新写法: 一个 flex 列, 子元素垂直排 + gap; 宽度卡在头像槽内 */
  function newPlace(labels, an, av, im) {
    const top = av && av.height > 0 ? Math.round(av.top - an.top + av.height + 4) : 2;
    const how = av && av.height > 0 ? 'avatar' : 'top';
    const avail = im && im.width >= 24 ? Math.round(im.left - an.left) - LEFT - 2 : null;
    const maxW = avail !== null && avail >= 36 ? Math.min(avail, 120) : 56;
    const kids = [];
    let y = an.top + top;
    for (const t of labels) {
      const w = Math.min(t.length * 10 + 10, maxW);   // chip 宽估值, 封顶到槽宽
      kids.push(rect(an.left + LEFT, y, w, CHIP_H));
      y += CHIP_H + GAP;                              // gap 交给浏览器, 这里只是模拟
    }
    const barH = kids.length * CHIP_H + GAP * (kids.length - 1);
    const barW = Math.max(...kids.map((k) => k.width));
    return { kids: kids, how: how, top: top, maxW: maxW,
             bar: rect(an.left + LEFT, an.top + top, barW, barH) };
  }
  const now = newPlace(['已解析', '下载'], anchor, avatar, img);

  assert.strictEqual(now.how, 'avatar', '有头像 → 排头像下方');
  assert.strictEqual(now.top, 48, '头像 4+40+4 = 48, 与 Chrome 实测的 top 一致');
  assert.strictEqual(now.kids[0].left, LEFT, '角标 x=16, 与 Chrome 实测一致');
  assert.strictEqual(now.kids[1].top - now.kids[0].bottom, GAP, '两行之间正好是 gap');
  assert.ok(!overlaps(now.kids[0], now.kids[1]), 'flex 列排后两个 chip 不重叠');

  /* 【最关键的断言】整条必须完全在图外 —— 主人要的就是这个 */
  assert.ok(now.bar.right <= img.left, '徽标条右边缘 ≤ 图左边缘 → 完全在图外');
  assert.ok(!overlaps(now.bar, img), '徽标条与图片无任何交集');
  assert.strictEqual(now.maxW, 54, '槽宽 = 72−16−2 = 54px');

  /* 多张图时文案变长 (「已解析 8」「下载 8」) → 仍不得盖到图 */
  const multi = newPlace(['已解析 8', '下载 8'], anchor, avatar, img);
  assert.ok(multi.bar.right <= img.left, '多张时文案变长, 被槽宽卡住, 仍在图外');
  assert.ok(!overlaps(multi.kids[0], multi.kids[1]), '多张时仍不重叠');
  // 反面对照: 不卡槽宽的话「已解析 8」会盖到图上
  const naiveW = '已解析 8'.length * 10 + 10;      // 60px > 槽宽 54px
  assert.ok(LEFT + naiveW > img.left, '不卡槽宽的话确实会越过图左边缘 (所以必须卡)');

  /* 合并组的后续消息没头像 → 贴顶, 但仍在图外、仍不重叠 */
  const grouped = newPlace(['已解析', '下载'], anchor, null, img);
  assert.strictEqual(grouped.how, 'top', '没头像 → 贴顶');
  assert.strictEqual(grouped.top, 2, '贴顶坐标 top=2');
  assert.ok(grouped.bar.right <= img.left, '合并组也在图外');
  assert.ok(!overlaps(grouped.kids[0], grouped.kids[1]), '合并组也不重叠');

  /* 图还没布局出来 (惰加载, rect 为 0) → 回落默认槽宽, 不报错 */
  const lazy = newPlace(['已解析', '下载'], anchor, avatar, rect(0, 0, 0, 0));
  assert.strictEqual(lazy.maxW, 56, '图未布局 → 用默认 56px 槽宽');
  assert.ok(!overlaps(lazy.kids[0], lazy.kids[1]), '回落时也不重叠');

  /* 下载按钮的取锚: 包进 bar 后 parentElement 是 bar 而不是消息
   * → 必须 closest('[data-moe-tagged="1"]'), 否则下载弹窗拿不到图 */
  const msgNode = { tagged: true, parent: null };
  const barNode = { tagged: false, parent: msgNode };
  const dlNode = { tagged: false, parent: barNode };
  const closestTagged = (n) => { for (let k = n; k; k = k.parent) if (k.tagged) return k; return null; };
  assert.strictEqual(dlNode.parent, barNode, '旧写法 parentElement 只能拿到 bar (不是消息)');
  assert.strictEqual(closestTagged(dlNode), msgNode, 'closest 能正确向上找到消息容器');
});

/* ---------- 表情锁定判定: 不能被自己的解锁动作擦掉 ----------
 * 【现象】所有「解锁了的」表情插不出链接, 对方只看到 :name: 字面文本。
 * 【真因】unlockEmoji() 每 1.2s + 每次 DOM 变动都 removeAttribute('aria-disabled'),
 *   而 aria-disabled 正是 emojiLocked() 最主要的锁信号 → 自己把证据擦了。
 *   实页诊断: 点本服动图表情 (需 Nitro, 必然是锁的) →
 *     ariaDisabled=null, hasLockIcon=false, insertStamp=null (我们根本没跑),
 *     输入框只多 12 字符 (CDN 链接 60+) → 那是 Discord 自己插的。
 * 【修法】固化在前、擦除在后: 先把锁信号连表情 id 写进 data-moe-lock 再摘。
 *   存 id 而不存布尔: 面板是虚拟滚动, React 会把 button 节点复用给别的表情。
 */
test('表情锁定判定: 解锁动作不得抹掉锁信号 (否则插不出链接)', () => {
  /* 极简元素模型: 只实现 get/set/removeAttribute + dataset.id */
  function btn(id, opts) {
    const attrs = Object.assign({}, opts || {});
    return {
      dataset: { id: id },
      getAttribute: function (k) { return k in attrs ? attrs[k] : null; },
      setAttribute: function (k, v) { attrs[k] = String(v); },
      removeAttribute: function (k) { delete attrs[k]; },
      querySelector: function () { return null; },      // 无 emojiLockIcon (实测就是没有)
      closest: function () { return null; },            // 不在 NitroLocked 分区
      _attrs: attrs,
    };
  }
  // Discord 自己的实时信号 (三条里只有 aria-disabled 在本例生效)
  const lockedLive = (h) => h.getAttribute('aria-disabled') === 'true' ||
                            !!h.querySelector('[class*="emojiLockIcon"]') ||
                            !!h.closest('[class*="NitroLocked"]');

  /* ❌ 旧流程: 只看实时信号, 且解锁先跑 */
  const a = btn('111', { 'aria-disabled': 'true' });
  assert.strictEqual(lockedLive(a), true, '面板刚渲染时确实是锁的');
  a.removeAttribute('aria-disabled');                  // ← unlockEmoji 干的
  assert.strictEqual(lockedLive(a), false, '旧流程: 解锁后锁信号消失 → 不接管 (这就是 bug)');

  /* ✅ 新流程: 先 mark 再摘; 判定优先读标记 */
  function mark(h) {
    const sig = (h.dataset && h.dataset.id) || '1';
    if (lockedLive(h)) { h.setAttribute('data-moe-lock', sig); return; }
    const had = h.getAttribute('data-moe-lock');
    if (had === null) return;
    if (had !== sig) h.removeAttribute('data-moe-lock');   // 节点被复用给别的表情
  }
  function locked(h) {
    const m = h.getAttribute('data-moe-lock');
    if (m !== null && m === ((h.dataset && h.dataset.id) || '1')) return true;
    return lockedLive(h);
  }
  const b = btn('222', { 'aria-disabled': 'true' });
  mark(b);                                             // 先固化
  b.removeAttribute('aria-disabled');                  // 再摘 (去灵用滤镜/恢复可点)
  assert.strictEqual(locked(b), true, '新流程: 摘了 aria-disabled 仍能判定为锁 → 接管插链接');
  assert.strictEqual(b.getAttribute('data-moe-lock'), '222', '标记存的是表情 id');

  // 本服静态表情 (本来就能发) → 不能被误判成锁, 否则本可原生发却换成了链接
  const c = btn('333', {});
  mark(c);
  assert.strictEqual(locked(c), false, '未锁表情不打标记 → 交回 Discord 原生');
  assert.strictEqual(c.getAttribute('data-moe-lock'), null, '未锁就不应该有标记');

  /* 虚拟滚动: 同一个 button 节点被 React 复用给另一个表情
   * → 旧标记必须失效, 否则没锁的表情也被换成链接 (反向的 bug) */
  const d = btn('444', { 'aria-disabled': 'true' });
  mark(d);
  d.removeAttribute('aria-disabled');
  assert.strictEqual(locked(d), true, '复用前: 锁的');
  d.dataset.id = '555';                                // ← 节点被复用给本服可用表情
  assert.strictEqual(locked(d), false, '复用后: id 变了 → 旧标记不算, 不误接管');
  mark(d);                                             // 下一轮清理
  assert.strictEqual(d.getAttribute('data-moe-lock'), null, '下一轮把陈旧标记清掉');

  /* 存布尔而不存 id 的反面对照: 滚一下就会把未锁表情误当成锁的 */
  const e = btn('666', { 'aria-disabled': 'true' });
  e.setAttribute('data-moe-lock', '1');                // 旧想法: 只存 '1'
  e.dataset.id = '777';                                // 节点复用给未锁表情
  const naive = (h) => h.getAttribute('data-moe-lock') !== null || lockedLive(h);
  assert.strictEqual(naive(e), true, '只存布尔 → 复用后误判为锁 (所以必须存 id)');
});

