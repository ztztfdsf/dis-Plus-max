/* MoeGuard 弹窗逻辑 */
'use strict';
const $ = (id) => document.getElementById(id);

function load() {
  chrome.storage.sync.get(null, (v) => {
    $('t-enabled').checked = v.enabled !== false;
    $('t-autoDecode').checked = v.autoDecode !== false;
    $('t-badge').checked = v.badge !== false;
    $('t-nsfwOnly').checked = v.nsfwOnly === true;
  });
}

function save() {
  chrome.storage.sync.set({
    enabled: $('t-enabled').checked,
    autoDecode: $('t-autoDecode').checked,
    badge: $('t-badge').checked,
    nsfwOnly: $('t-nsfwOnly').checked,
  });
  // 通知当前 Discord 页
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (tab && tab.id != null) {
      try { chrome.tabs.sendMessage(tab.id, { action: 'cfg-updated' }); } catch (e) {}
    }
  });
}

$('t-enabled').addEventListener('change', save);
$('t-autoDecode').addEventListener('change', save);
$('t-badge').addEventListener('change', save);
$('t-nsfwOnly').addEventListener('change', save);

$('scan').addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab || tab.id == null) return;
    try {
      chrome.tabs.sendMessage(tab.id, { action: 'scan-all' }, (r) => {
        if (chrome.runtime.lastError) {
          $('st').textContent = '当前页面不是 Discord 或扩展尚未加载';
        } else {
          $('st').textContent = '已扫描，可解码的喵图已还原 ✓';
        }
      });
    } catch (e) {
      $('st').textContent = '当前页面不是 Discord 或扩展尚未加载';
    }
  });
});

$('opts').addEventListener('click', () => chrome.runtime.openOptionsPage());

/* 调试面板 */
$('reattach').addEventListener('click', () => { loadDbg(); loadDiag(); $('st').textContent = '已刷新遥测'; });
function loadDbg() {
  chrome.runtime.sendMessage({ action: 'moe-dbg' }, (d) => {
    const el = $('dbg');
    if (!d) { el.textContent = '暂无遥测数据'; el.style.display = 'block'; return; }
    $('attachSt').textContent = d.uploadsReplaced > 0 ? '🟢已生效' : (d.tracked > 0 ? '🟡待上传' : '⚪待命');
    el.textContent = [
      'v' + d.version + ' · ' + (d.mode || ''),
      '跟踪文件: ' + d.tracked + ' | 已编码: ' + d.encoded,
      '上传拦获: ' + d.uploadsSeen + ' | 已替换: ' + d.uploadsReplaced + ' | 直通: ' + d.uploadsPass,
      '最近文件: ' + (d.lastFile || '-') + ' ' + (d.lastSize || 0) + 'B',
      '最近替换: ' + (d.lastReplace || '-'),
      '审查结果: ' + (d.lastReview || '未启用'),
      '最后异常: ' + (d.lastError || '无') + ' @' + (d.lastTime || ''),
    ].join('\n');
    el.style.display = 'block';
  });
}
setTimeout(loadDbg, 250);
setInterval(loadDbg, 1500);

/* 页面侧诊断 (隔离世界 content.js 的真实执行轨迹) */
function loadDiag() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    const el = $('diag');
    if (!tab || tab.id == null) return;
    try {
      chrome.tabs.sendMessage(tab.id, { action: 'moe-diag' }, (d) => {
        if (chrome.runtime.lastError || !d) {
          el.textContent = '页面脚本未响应 (不是 Discord 页 / 未刷新)';
          el.style.display = 'block';
          return;
        }
        const states = Object.entries(d.scanStates || {}).map(([k, v]) => k + '=' + v).join(' ') || '无';
        el.textContent = [
          '页面脚本 v' + (d.ver || '?') + ' · 角标 ' + d.badges,
          '扫描: ' + (d.scan || '-'),
          '图片状态: ' + states,
          '配置: ' + (d.cfg || '-'),
          '最近结果: ' + (d.last || '-'),
          d.err ? '异常: ' + d.err : '',
        ].filter(Boolean).join('\n');
        el.style.display = 'block';
      });
    } catch (e) {}
  });
}
setTimeout(loadDiag, 350);
setInterval(loadDiag, 2000);

load();