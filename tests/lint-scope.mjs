/* 作用域检查: 抓「重构删了变量声明、引用还留着」这类静默 bug
 *
 * 【为什么单测抓不到】v3.6.5 的角标重叠 bug 就是这么来的:
 *   tagAvatar() 里 `const top = av ? … : 2;` —— av 在 #15 归属重构时被删了,
 *   这行成了 ReferenceError。但它在两个元素【已经 append 进 DOM 之后】才执行,
 *   又被函数外层的 try/catch 吞掉 → 页面上只是"位置不对", 控制台一片安静。
 *   而且 av 在同文件【别的函数里】仍有声明 → 文本搜索也发现不了,
 *   必须真正做作用域分析才行 → 用 eslint 的 no-undef。
 *
 * 【为什么 eslint 不进 package.json】扩展本体要求零运行时依赖, 仓库里也没有
 *   node_modules。eslint 只是发布前的检查工具, 装在工具目录下即可,
 *   这里按顺序去几个已知位置找它; 一个都找不到就【报错退出】而不是静默跳过
 *   —— 静默跳过正是我们要杜绝的失败方式。
 *
 * 用法: node tests/lint-scope.mjs
 */
import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');

/* eslint 的候选位置 (从近到远) */
const CANDIDATES = [
  path.join(HERE, '..', 'node_modules', 'eslint'),
  'G:\\工具等其他文件存放处\\moe-ff-probe\\node_modules\\eslint',
];

async function loadESLint() {
  const require = createRequire(import.meta.url);
  for (const p of CANDIDATES) {
    try {
      const mod = await import('file://' + require.resolve(p).replace(/\\/g, '/'));
      return mod.ESLint || (mod.default && mod.default.ESLint);
    } catch (e) { /* 换下一个 */ }
  }
  try { return (await import('eslint')).ESLint; } catch (e) { /* 没有 */ }
  return null;
}

/* 浏览器 + 扩展 + Firefox 沙箱里真实存在的全局
 * 少写一个只会误报, 不会漏报 → 宁可列全 */
const GLOBALS = `
  window document navigator location fetch console localStorage sessionStorage
  setTimeout clearTimeout setInterval clearInterval requestAnimationFrame requestIdleCallback
  queueMicrotask structuredClone alert getComputedStyle matchMedia
  Blob File FileReader FormData Headers Request Response URL URLSearchParams
  AbortController AbortSignal Image ImageData ImageBitmap createImageBitmap
  OffscreenCanvas HTMLCanvasElement HTMLImageElement HTMLElement Element Node NodeList
  Event CustomEvent MouseEvent KeyboardEvent InputEvent ClipboardEvent DragEvent
  PointerEvent WheelEvent DataTransfer MutationObserver IntersectionObserver ResizeObserver
  TextEncoder TextDecoder CompressionStream DecompressionStream
  ReadableStream WritableStream TransformStream crypto btoa atob
  DOMParser XMLHttpRequest WebSocket Worker performance
  module exports require globalThis self chrome browser
  cloneInto exportFunction XPCNativeWrapper
  Uint8Array Uint8ClampedArray Uint16Array Uint32Array Int8Array Int16Array Int32Array
  Float32Array Float64Array BigInt64Array BigUint64Array ArrayBuffer SharedArrayBuffer
  DataView Atomics Promise Map Set WeakMap WeakSet WeakRef Proxy Reflect Symbol BigInt
  JSON Math Date RegExp Intl Object Array String Number Boolean Function
  Error TypeError RangeError SyntaxError ReferenceError EvalError URIError AggregateError
  parseInt parseFloat isNaN isFinite escape unescape
  encodeURIComponent decodeURIComponent encodeURI decodeURI
  undefined NaN Infinity
`.split(/\s+/).filter(Boolean);

/* 各文件靠别的文件在 window 上挂的东西 (跨文件全局, 不是笔误) */
const CROSS_FILE = ['__MoeGuardCore', '_moeFormat', '__MoeReview', '__MoeUI'];

const ESLint = await loadESLint();
if (!ESLint) {
  console.error('✗ 找不到 eslint。作用域检查【没有跑】—— 这是必须修的, 不是可以跳过的。');
  console.error('  装一个即可 (任选其一):');
  for (const p of CANDIDATES) console.error('    ' + p);
  process.exit(2);
}

const files = readdirSync(SRC).filter((f) => f.endsWith('.js')).map((f) => path.join(SRC, f));
const eslint = new ESLint({
  useEslintrc: false,
  overrideConfig: {
    parserOptions: { ecmaVersion: 2023, sourceType: 'script' },
    globals: Object.fromEntries([...GLOBALS, ...CROSS_FILE].map((k) => [k, 'readonly'])),
    rules: {
      'no-undef': 'error',            // ← 本文件存在的理由
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-dupe-else-if': 'error',
      'no-duplicate-case': 'error',
      'no-unreachable': 'error',
      'no-func-assign': 'error',
      'no-const-assign': 'error',
      'no-self-assign': 'error',
      'no-obj-calls': 'error',
      'no-setter-return': 'error',
      'no-unsafe-negation': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
    },
  },
});

const results = await eslint.lintFiles(files);
let bad = 0;
for (const r of results) {
  for (const m of r.messages) {
    if (m.severity === 2) bad++;
    console.log(`${m.severity === 2 ? '✗' : '·'} src/${path.basename(r.filePath)}:${m.line}:${m.column}` +
                `  ${m.ruleId || 'parse'}  ${m.message}`);
  }
}
console.log(bad
  ? `\n✗ ${bad} 处作用域/静态错误 —— 这类错在 try/catch 里会被静默吞掉, 必须修`
  : `\n✓ 作用域检查通过 (${files.length} 个文件, 无未定义变量)`);
process.exit(bad ? 1 : 0);
