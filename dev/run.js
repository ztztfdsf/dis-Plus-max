#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════
 * MoeGuard 油猴版 —— 本地仿真台跑分
 *
 *   node dev/run.js            # 真实 Chrome headless 跑一遍 harness
 *   node dev/run.js --headful  # 想自己看的时候
 *
 * 干的事: 起一个本地静态服务器 → 用真 Chrome 打开 dev/harness.html
 *   → 页面里的用例把结果 POST 回来 → 打印 → 关浏览器。
 * 打桩只打在 GM_* 与 XHR 出口上, canvas / PNG / DOM / 模糊解码全是真跑。
 * ══════════════════════════════════════════════════════════════════ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP, { recursive: true });

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('找不到 Chrome'); process.exit(2); }

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json',
};

function collectBody(req) {
  return new Promise((res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => res(Buffer.concat(chunks)));
  });
}

let finish;
const done = new Promise((r) => { finish = r; });
const logs = [];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  if (req.method === 'POST' && p === '/report') {
    const body = await collectBody(req);
    res.writeHead(200); res.end('ok');
    finish(JSON.parse(body.toString('utf8')));
    return;
  }
  if (req.method === 'POST' && p === '/log') {
    const body = await collectBody(req);
    logs.push(body.toString('utf8').slice(0, 400));
    res.writeHead(200); res.end('ok');
    return;
  }
  if (req.method === 'POST' && p === '/upload') {
    const body = await collectBody(req);
    const name = path.basename(url.searchParams.get('name') || 'img.png');
    fs.writeFileSync(path.join(TMP, name), body);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
    return;
  }

  let file = null;
  if (p === '/' || p === '/dev/harness.html') file = path.join(__dirname, 'harness.html');
  else if (p.startsWith('/attachments/')) file = path.join(TMP, path.basename(p));
  else if (p.startsWith('/fake/')) file = path.join(TMP, path.basename(p));
  else file = path.join(ROOT, p.replace(/^\/+/, ''));

  if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('404'); return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const url = 'http://127.0.0.1:' + port + '/dev/harness.html';
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-prof-'));
  const headful = process.argv.includes('--headful');
  const args = [
    headful ? '--new-window' : '--headless=new',
    '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--window-size=1280,900',
    '--user-data-dir=' + profile,
    url,
  ];
  console.log('▶ Chrome ' + (headful ? '(可见)' : '(headless)') + ' → ' + url);
  const child = spawn(CHROME, args, { stdio: 'ignore', detached: false });

  const timer = setTimeout(() => finish(null), 90000);

  done.then((results) => {
    clearTimeout(timer);
    try { child.kill(); } catch (e) {}
    server.close();

    if (!results) { console.error('✗ 90s 内没收到结果 (页面脚本可能早退)'); process.exit(1); }
    let pass = 0, fail = 0;
    for (const r of results) {
      if (r.pass) { pass++; console.log('  ✓ ' + r.name + (r.extra && !/^\(信息\)/.test(r.name) ? '   [' + r.extra + ']' : '')); }
      else { fail++; console.log('  ✗ ' + r.name + '   [' + r.extra + ']'); }
    }
    if (logs.length) { console.log('\n── 页面日志 ──'); logs.forEach((l) => console.log('  ' + l)); }
    console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
    process.exit(fail ? 1 : 0);
  });
});