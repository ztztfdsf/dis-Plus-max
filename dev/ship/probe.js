'use strict';
/* chrome_javascript 的 result 恒 undefined → 用 console 通道取数:
 * 先 evaluate 写 console.log, 再 chrome_console snapshot 里捞 PROBE_TAG 行 */
const { call } = require('./mcp');
const TAG = 'PROBE#';

async function probeJs(code) {
  const payload = 'console.log("' + TAG + '" + String(JSON.stringify((function(){try{var __r=(function(){' + code + '})();return __r}catch(e){return {__err:String(e)}}})())))';
  const r = await call('chrome_javascript', { code: payload });
  if (r.isError) return { __tool: r.text.slice(0, 200) };
  await new Promise((res) => setTimeout(res, 1200));
  const snap = await call('chrome_console', { action: 'snapshot' });
  const txt = snap.text || '';
  const lines = txt.split('\n').filter((l) => l.indexOf(TAG) >= 0);
  const last = lines[lines.length - 1];
  if (!last) return { __noOutput: txt.slice(0, 200) };
  const raw = last.slice(last.indexOf(TAG) + TAG.length).replace(/^\s*PROBE#/, '').trim();
  let body = raw;
  for (let i = 0; i < 3 && /^"[\s\S]*"$/.test(body) ; i++) {
    try { body = JSON.parse(body); } catch (e) { break; }   // 剥外层转义引号
  }
  const m = /\{[\s\S]*\}\s*$/.exec(String(body));
  return m ? JSON.parse(m[0]) : { __raw: String(body).slice(0, 400) };
}

module.exports = { probeJs };
if (require.main === module) {
  probeJs(process.argv[2] || 'return {href: location.href}').then((j) => console.log(JSON.stringify(j, null, 1))).catch((e) => console.error('FAIL', e.message));
}
