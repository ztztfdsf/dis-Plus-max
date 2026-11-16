/* mcp-chrome-bridge 的极简 MCP-over-HTTP 客户端：initialize → tools/list → tools/call */
'use strict';
const BASE = process.env.MCP_URL || 'http://127.0.0.1:12306/mcp';
let sid = null;

function parseSseOrJson(text) {
  const t = text.trim();
  if (!t) return null;
  if (t.startsWith('{')) { try { return JSON.parse(t); } catch (e) {} }
  // SSE: 取最后一条 data:
  let out = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('data:')) { try { out = JSON.parse(line.slice(5).trim()); } catch (e) {} }
  }
  return out;
}

async function rpc(method, params, isNotif) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (sid) headers['mcp-session-id'] = sid;
  const body = isNotif ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++rpc._id, method, params };
  const r = await fetch(BASE, { method: 'POST', headers, body: JSON.stringify(body) });
  const s = r.headers.get('mcp-session-id');
  if (s) sid = s;
  const txt = await r.text();
  if (isNotif) return { status: r.status };
  const j = parseSseOrJson(txt);
  if (!j) throw new Error('no json (HTTP ' + r.status + '): ' + txt.slice(0, 300));
  if (j.error) throw new Error(method + ' → ' + JSON.stringify(j.error).slice(0, 400));
  return j.result;
}
rpc._id = 0;

async function ensureInit() {
  if (sid) return;
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'pi-ship-check', version: '1.0' },
  });
  await rpc('notifications/initialized', {}, true);
}

async function tools() { await ensureInit(); return (await rpc('tools/list', {})).tools; }
async function call(name, args) {
  await ensureInit();
  const r = await rpc('tools/call', { name, arguments: args || {} });
  const txt = (r.content || []).map((c) => (c.type === 'text' ? c.text : '[' + c.type + ']')).join('\n');
  return { text: txt, isError: !!r.isError, structured: r.structuredContent || null };
}

module.exports = { tools, call, ensureInit, rpc, get sid() { return sid; } };

if (require.main === module) {
  (async () => {
    const cmd = process.argv[2];
    if (cmd === 'list') {
      const ts = await tools();
      console.log('工具数:', ts.length);
      for (const t of ts) console.log(' -', t.name.padEnd(28), (t.description || '').split('\n')[0].slice(0, 90));
    } else if (cmd === 'call') {
      const name = process.argv[3];
      let args = {};
      try { args = JSON.parse(process.argv[4] || '{}'); } catch (e) {}
      const r = await call(name, args);
      console.log(r.isError ? 'ERR' : 'OK', r.text.slice(0, 4000));
    } else console.log('用法: node mcp.js list | node mcp.js call <tool> \'<json>\'');
  })().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
}