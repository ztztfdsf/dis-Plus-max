/* MoeGuard 选项页逻辑 */
'use strict';
const DEFAULTS = {
  enabled: true, autoDecode: true, badge: true, tile: 0, salt: '', maxDim: 0, skipAnimated: true,
  nsfwOnly: false, nsfwThreshold: 0.7, reviewMode: 'local', apiProvider: 'generic', apiUrl: '', apiUser: '', apiKey: '',
};

const $ = (id) => document.getElementById(id);

function load() {
  chrome.storage.sync.get(DEFAULTS, (v) => {
    $('cfg-enabled').checked = !!v.enabled;
    $('cfg-autoDecode').checked = !!v.autoDecode;
    $('cfg-badge').checked = !!v.badge;
    $('cfg-tile').value = String(v.tile || 0);
    $('cfg-salt').value = v.salt || '';
    $('cfg-maxDim').value = String(v.maxDim || 0);
    $('cfg-skipAnimated').checked = !!v.skipAnimated;
    $('cfg-nsfwOnly').checked = !!v.nsfwOnly;
    $('cfg-nsfwThreshold').value = String(v.nsfwThreshold || 0.7);
    $('cfg-reviewMode').value = v.reviewMode || 'local';
    $('cfg-apiProvider').value = v.apiProvider || 'generic';
    $('cfg-apiUrl').value = v.apiUrl || '';
    $('cfg-apiUser').value = v.apiUser || '';
    $('cfg-apiKey').value = v.apiKey || '';
  });
}

function readForm() {
  return {
    enabled: $('cfg-enabled').checked,
    autoDecode: $('cfg-autoDecode').checked,
    badge: $('cfg-badge').checked,
    tile: parseInt($('cfg-tile').value, 10) || 0,   // 0 = 自适应
    salt: ($('cfg-salt').value || '').trim().slice(0, 48),
    maxDim: parseInt($('cfg-maxDim').value, 10) || 0,
    skipAnimated: $('cfg-skipAnimated').checked,
    nsfwOnly: $('cfg-nsfwOnly').checked,
    nsfwThreshold: parseFloat($('cfg-nsfwThreshold').value) || 0.7,
    reviewMode: $('cfg-reviewMode').value || 'local',
    apiProvider: $('cfg-apiProvider').value || 'generic',
    apiUrl: ($('cfg-apiUrl').value || '').trim(),
    apiUser: ($('cfg-apiUser').value || '').trim(),
    apiKey: ($('cfg-apiKey').value || '').trim(),
  };
}

$('save').addEventListener('click', () => {
  const v = readForm();
  const s = $('status');

  function persist(note) {
    chrome.storage.sync.set(v, () => {
      s.textContent = '已保存 ✓ 新配置将在 Discord 页面立即生效' + (note || '');
      setTimeout(() => (s.textContent = ''), 3500);
    });
  }

  // 远端审查需要该域的 host 权限, 否则后台 fetch 会被 CORS 拦
  const needsHost = (v.reviewMode === 'remote' || v.reviewMode === 'both') && v.nsfwOnly;
  if (!needsHost) { persist(); return; }
  let origin = '';
  try {
    const url = v.apiProvider === 'sightengine' ? 'https://api.sightengine.com/' : v.apiUrl;
    origin = new URL(url).origin + '/*';
  } catch (e) {
    persist('（API 地址无法解析，远端审查会失败回落本地）');
    return;
  }
  chrome.permissions.request({ origins: [origin] }, (granted) => {
    persist(granted ? '（已授权 ' + origin + '）' : '（未授权 ' + origin + '，远端审查会失败回落本地）');
  });
});

/* ---------- 算法往返测试 ---------- */
$('test').addEventListener('click', async () => {
  const wrap = $('testWrap');
  const verdict = $('testVerdict');
  wrap.style.display = 'flex';
  wrap.innerHTML = '<figcaption>生成中…</figcaption>';
  verdict.innerHTML = '';
  try {
    const v = readForm();
    // 画一张带文字渐变的测试图
    const c = document.createElement('canvas');
    c.width = 340; c.height = 220;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 340, 220);
    g.addColorStop(0, '#ff9bd2'); g.addColorStop(1, '#7c6bf0');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 340, 220);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 26px Segoe UI, Microsoft YaHei';
    ctx.fillText('MoeGuard 喵图', 34, 90);
    ctx.font = '14px Segoe UI';
    ctx.fillText('这是一个无损往返测试: 混→解 应完全一致', 34, 130);
    ctx.fillStyle = '#2b2440';
    for (let i = 0; i < 14; i++) { ctx.fillRect(18 + i * 23, 180, 8, 8); }
    const im = { width: c.width, height: c.height, data: ctx.getImageData(0, 0, c.width, c.height).data };

    const t0 = performance.now();
    const enc = __MoeGuardCore.encodeImage(im, { tile: v.tile || undefined, salt: v.salt });
    const t1 = performance.now();
    const dec = __MoeGuardCore.decodeImage(enc, { salt: v.salt });
    const t2 = performance.now();

    let verdictHtml;
    if (dec.ok) {
      let same = true;
      const a = im.data, b = dec.data;
      if (a.length !== b.length) same = false;
      else for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { same = false; break; }
      verdictHtml = same
        ? `<span class="ok">✓ 无损往返通过！</span> 像素完全一致 · 编码 ${(t1 - t0).toFixed(0)}ms / 解码 ${(t2 - t1).toFixed(0)}ms`
        : '<span class="bad">✗ 往返不一致！</span>';
    } else {
      verdictHtml = '<span class="bad">✗ 解码失败: ' + (dec.reason === 'resized' ? '尺寸异常' : '无法识别') + '</span>';
    }
    verdict.innerHTML = verdictHtml;

    const encURL = _moeFormat.imageDataToDataURL(enc);
    const decURL = _moeFormat.imageDataToDataURL(dec.ok ? { width: dec.width, height: dec.height, data: dec.data } : im);

    wrap.innerHTML = '';
    const f1 = document.createElement('figure');
    const i1 = document.createElement('img'); i1.src = c.toDataURL();
    const cap1 = document.createElement('figcaption'); cap1.textContent = 'RAW 原图';
    f1.append(i1, cap1);
    const f2 = document.createElement('figure');
    const i2 = document.createElement('img'); i2.src = encURL;
    const cap2 = document.createElement('figcaption');
    cap2.textContent = `混淆版 ${enc.width}×${enc.height} (含定位框)`;
    const dl = document.createElement('button'); dl.className = 'ghost'; dl.textContent = '💾 保存混淆版';
    dl.style.cssText = 'margin-top:6px;width:100%;font-size:11px;padding:5px;';
    dl.onclick = () => {
      const a = document.createElement('a');
      a.href = encURL; a.download = 'moeguard-encoded.png'; a.click();
    };
    f2.append(i2, cap2, dl);
    const f3 = document.createElement('figure');
    const i3 = document.createElement('img'); i3.src = decURL;
    const cap3 = document.createElement('figcaption'); cap3.textContent = '解码还原版';
    f3.append(i3, cap3);
    wrap.append(f1, f2, f3);
  } catch (e) {
    verdict.innerHTML = '<span class="bad">测试出错: ' + e.message + '</span>';
  }
});

/* ---------- 本地审查自测 (不联网) ---------- */
$('reviewTest').addEventListener('click', () => {
  const out = $('reviewOut');
  const st = $('reviewStatus');
  out.style.display = 'block';
  const R = window.__MoeGuardReview;
  if (!R) { out.textContent = 'review.js 未加载'; return; }
  const th = parseFloat($('cfg-nsfwThreshold').value) || 0.7;

  function paint(w, h, fn) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    fn(ctx, w, h);
    return { width: w, height: h, data: ctx.getImageData(0, 0, w, h).data };
  }
  const cases = [
    ['大面积平滑肤色', paint(320, 240, (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#e8c0a8'); g.addColorStop(1, '#c99e86');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    })],
    ['风景(蓝绿)', paint(320, 240, (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#5aa0e0'); g.addColorStop(1, '#3c8a4a');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    })],
    ['小脸人像', paint(320, 240, (ctx, w, h) => {
      ctx.fillStyle = '#242a3c'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#e8bfa0';
      ctx.beginPath(); ctx.ellipse(w / 2, h * 0.35, w * 0.1, h * 0.13, 0, 0, 7); ctx.fill();
    })],
    ['UI 截图', paint(320, 240, (ctx, w, h) => {
      ctx.fillStyle = '#f2f2f6'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#333';
      for (let y = 20; y < h; y += 16) ctx.fillRect(20, y, w - 60, 4);
    })],
    ['花衣服(高频)', paint(320, 240, (ctx, w, h) => {
      const cols = ['#e03c5a', '#3c5ac8', '#f0e050'];
      for (let y = 0; y < h; y += 8) for (let x = 0; x < w; x += 8) {
        ctx.fillStyle = cols[((x >> 3) + (y >> 3)) % 3];
        ctx.fillRect(x, y, 8, 8);
      }
    })],
  ];
  const lines = ['阈值 ' + th + ' · 得分 ≥ 阈值 → 混淆', ''];
  for (const [name, im] of cases) {
    const s = R.localScore(im);
    lines.push(
      name.padEnd(9, '　') + ' score=' + s.score.toFixed(3) +
      '  肤色=' + s.skinRatio.toFixed(2) +
      ' 集中=' + s.concentration.toFixed(2) +
      ' 平滑=' + s.smoothness.toFixed(2) +
      '  → ' + (s.score >= th ? '混淆' : '直通'));
  }
  lines.push('', '⚠️ 启发式不是分类模型: 暖色渐变插画/泳装/特写会误判。认真用请接远端 API 或本地模型。');
  out.textContent = lines.join('\n');
  st.textContent = '自测完成';
  setTimeout(() => { st.textContent = ''; }, 2500);
});

load();