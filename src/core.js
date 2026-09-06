/* ══════════════════════════════════════════════════════════════════
 * MoeGuard 喵图混淆引擎 —— 自研轻量无损图片混淆 (MOE v3「流光照影」)
 * ══════════════════════════════════════════════════════════════════
 *
 * 设计 (自创, 无需密钥):
 *   1. 图片按 T×T tile 划分; 不足部分用【镜像反射】补边 (不产生死板纯色块)
 *   2. 每个 tile 内部沿【希尔伯特曲线】整体平移 φ (黄金比 0.618…)
 *      → 曲线保持局部性, 长连续段整体搬运 → 大块柔和分形, 不是噪点雪花
 *   3. tile 之间带盐洗牌 → 构图级打乱 + 可选盐值群组隔离
 *   4. 外围画中性灰阶【定位框】(仿二维码: 边框+节拍线+3 个角眼)
 *      → 人眼与 detectFrame 一眼认出喵图; 融入 Discord 默认主题
 *   5. 末行右侧 5 像素写元数据: 魔数 + 版本 + T + 原始宽高 + 校验和 + 盐值尾字节
 *      → 解码器可自检「这图是不是喵图」, 无需外部密钥
 *   6. 种子 = FNV-1a(魔串 + 宽x高 + T + 可选盐值) → SplitMix64 流
 *      → 所有装了本插件的人, 用相同的算法即可互相解图
 *   7. 全部变换都是【位置双射】(纯排列) → 像素值零丢失
 *      PNG 无失真编码 → 解码 = 逆变换 + 裁剪 → 像素级 100% 无损还原
 *
 * 安全模型:
 *   - 无插件者看到的是分形纹样的拼贴图, 认不出原内容
 *   - 插件内置算法相同 → 装插件即可互通 (无需密钥 = 插件即通行证)
 *   - 可选「盐值」: 设置后只有用同一盐值的人能解 (群组隔离)
 *   - 诚实声明: 无密钥方案下, 逆向插件源码者可还原; 同尺寸图片排列相同
 *
 * ⚠️ 本文件为纯逻辑, 不依赖 DOM —— 可在 Node / 页面 / 插件三处复用
 * ══════════════════════════════════════════════════════════════════ */
'use strict';

/* 【不是扩展版本号】这是【图片格式】的版本 (MOE v3 的 3.0.0),
 * 改它会让旧图解不开 —— 与 manifest 的扩展版本号无关。
 * build.js 会拦所有写死的版本号字面量, 这里显式豁免。 */
const VERSION = '3.0.0';   // not-ext-version
const MAGIC = [0x4D, 0x4F, 0x45];          // 'M','O','E' (写于末行标记像素 R/G/B, alpha 恒为 255)
/* ---------- 确定性哈希 / PRNG ---------- */

function fnv1a(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

// 自研流: FNV-1a 双通道 → 64bit 种子 → SplitMix64 输出 32bit 流
function makePRNG(seedStr) {
  const h1 = fnv1a(seedStr, 0x811c9dc5);
  const h2 = fnv1a(seedStr + ':moe.v1', 0x01000193);
  let st = (BigInt(h2) << 32n) ^ BigInt(h1);
  if (st === 0n) st = 0x9e3779b97f4a7c15n;
  return function next32() {
    st = (st + 0x9e3779b97f4a7c15n) & 0xFFFFFFFFFFFFFFFFn;
    let z = st;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & 0xFFFFFFFFFFFFFFFFn;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & 0xFFFFFFFFFFFFFFFFn;
    z = z ^ (z >> 31n);
    return Number(z & 0xFFFFFFFFn) >>> 0;
  };
}


/* ---------- 排列生成 ---------- */

function shufflePerm(n, next) {
  const arr = new Int32Array(n);
  for (let i = 0; i < n; i++) arr[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = next() % (i + 1);
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

/* ---------- 像素工具 ---------- */

function setPx(d, x, y, w, r, g, b, a) {
  const i = (y * w + x) * 4; d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a;
}
function pxv(d, x, y, w, c) { return d[(y * w + x) * 4 + c]; }

// 盐值 → 尾部校验字节 (不同盐值无法解, 且能检测出来而不是解出乱码)
function saltTail(salt) {
  const h = fnv1a('salt:' + (salt || ''), 0x12345678);
  return [(h >>> 8) & 255, h & 255];
}


/* ---------- 定位框配色 (中性灰阶, 与 Discord 亮/暗主题都融合) ---------- */
const V3_FRAME = 12;                     // 定位框宽度(像素)
const INK = [35, 37, 43];                // 深墨 (≈Discord #232529)
const GRAY = [148, 155, 164];            // 中性灰 (≈Discord text-muted #949ba4)
/** 画定位框 (仿二维码): 实心边框 + 白色节拍虚线 + 3 个角眼
 *  全部 alpha=255; 不承载像素数据, 纯粹为了让人眼与 detectFrame 一眼认出喵图
 *  main = 主色 (默认深墨), accent = 节拍与角眼色 (默认中性灰) */
function v3DrawFrame(out, encW, encH, F, main, accent) {
  main = main || INK; accent = accent || GRAY;
  const put = (x, y, c) => setPx(out, x, y, encW, c[0], c[1], c[2], 255);
  const inBand = (x, y) => y < F || y >= encH - F || x < F || x >= encW - F;
  // 1) 整圈实心主色
  for (let y = 0; y < encH; y++) {
    for (let x = 0; x < encW; x++) if (inBand(x, y)) put(x, y, main);
  }
  // 2) 节拍虚线 (边框中线, 3 亮 3 主) → 二维码那种节律感
  const mid = (F >> 1);
  for (let x = F; x < encW - F; x++) {
    if (((x / 3) | 0) & 1) continue;
    put(x, mid, accent); put(x, encH - 1 - mid, accent);
  }
  for (let y = F; y < encH - F; y++) {
    if (((y / 3) | 0) & 1) continue;
    put(mid, y, accent); put(encW - 1 - mid, y, accent);
  }
  // 3) 内隔线: 贴着数据区的一圈 → 边界干净, 也便于未来做仿射定位
  for (let x = F - 1; x < encW - F + 1; x++) { put(x, F - 1, accent); put(x, encH - F, accent); }
  for (let y = F - 1; y < encH - F + 1; y++) { put(F - 1, y, accent); put(encW - F, y, accent); }
  // 4) 三个角眼 (左上/右上/左下): 主色实心 → 亮环 → 主色核, 与二维码同构
  const eye = (ox, oy) => {
    for (let j = 0; j < F; j++) {
      for (let i = 0; i < F; i++) {
        const inset = Math.min(i, j, F - 1 - i, F - 1 - j);
        put(ox + i, oy + j, (inset === 2 || inset === 3) ? accent : main);
      }
    }
  };
  eye(0, 0); eye(encW - F, 0); eye(0, encH - F);
}

/* ══════════════════════════════════════════════════════════════════
 * MOE v3「流光照影」—— 大块希尔伯特曲线平移 + 带盐 tile 洗牌
 * ══════════════════════════════════════════════════════════════════
 * 血统: 主人从数学样品选型 —— 04-希尔伯特平移 (柔和分形) + C1024 (大块不刺眼)
 *
 * 为什么好看 (设计依据):
 *   希尔伯特曲线把 2D 压成 1D 且保持局部性 —— 曲线上相邻的像素在平面上也相邻
 *   → 沿曲线做一次大平移 φ, 曲线上连续的一长段整体搬走
 *   → 平面上出现【大块柔和的分形形状】, 而不是高频噪点/碎屑
 *   流行的教训: 像素级打乱=噪点雪花; 切太碎(小 tile)=刺眼; 大 tile + 整段平移=柔和
 *
 * 两级结构 (只有「大 + 中」两档碎片, 主人亲定):
 *   1. 中级: 每个 T×T tile 内部, 沿希尔伯特曲线整体平移 φ (0.618…黄金比)
 *      → 块内渐变/大色区保持完整, 曲线裁出分形边缘; 最小碎片 = 曲线折返粒度
 *   2. 大级: tile 之间带盐洗牌 (可选盐值 → 群组隔离), 构图级打乱
 *
 * Tile 自适应: T = min(V3_MAX_TILE, 不超过 max(w,h) 的最大 2 幂)
 *   T 默认 256: 补边浪费小 (1536×1152 → 1560×1304, 1.15x), 而 1024 会补到 2072² (2.43x)
 *   —— 补边不仅浪费体积, 还把【canvas PNG 编码】这个真正瓶颈乘大 2.4 倍
 *   256px 块仍然是大块分形观感 (实测碎片率比 1024 还低), 不是噪点
 *   T 存在元数据里 → 旧图 (T=1024) 永远能解开, 改默认值不破向后兼容
 *
 * 数学性质: 全位置双射 (曲线平移∘tile洗牌), 像素值零丢失;
 *   补边用镜像反射 (不产生死板纯色块); 解码只取 w×h → 100% 无损
 * ══════════════════════════════════════════════════════════════════ */
const V3_MAX_TILE = 256;               // 默认上限 (补边浪费与大块观感的平衡点)
const V3_CAP_TILE = 1024;              // 允许的最大 tile (opts.tile 可上到这里; 旧图靠元数据解)
const V3_SHIFT = 0.6180339887498949;   // 黄金比 φ 曲线平移

/* 希尔伯特表缓存: 同一 T 只建一次 (T=1024 建表 ~18ms, 编+解码各一次就是 36ms) */
const _hilbertCache = new Map();

function v3TileSize(w, h) {
  const m = Math.max(w, h);
  let T = 1;
  while (T * 2 <= V3_MAX_TILE && T * 2 <= m) T *= 2;
  return T;
}
function v3Seed(w, h, T, salt) { return 'MoeGuard.v3:' + w + 'x' + h + '@' + T + ':' + (salt || ''); }

/** 希尔伯特曲线: 返回 order[d] = 该曲线位置对应的 (y*T+x) 像素索引 (N=T, 需 2 幂)
 *  带缓存: 表只读不写 (调用方仅查询), 所以可以安全共用 */
function hilbertOrder(T) {
  const hit = _hilbertCache.get(T);
  if (hit) return hit;
  const N = T;
  const order = new Int32Array(N * N);
  const d2xy = (d) => {
    let x = 0, y = 0, t = d, s = 1;
    while (s < N) {
      const rx = 1 & (t >> 1), ry = 1 & (t ^ rx);
      if (ry === 0) {
        if (rx === 1) { x = s - 1 - x; y = s - 1 - y; }
        const tmp = x; x = y; y = tmp;
      }
      x += s * rx; y += s * ry;
      t >>= 2; s <<= 1;
    }
    return y * N + x;
  };
  for (let d = 0; d < N * N; d++) order[d] = d2xy(d);
  if (_hilbertCache.size > 6) _hilbertCache.clear();
  _hilbertCache.set(T, order);
  return order;
}

/** tile 洗牌: tilePerm[destTile] = srcTile (带盐) */
function v3TilePerm(cols, rows, seedStr) {
  const n = cols * rows;
  const perm = shufflePerm(n, makePRNG(seedStr + ':tp'));
  return perm;
}

/* v3 元数据: 末行最右 5 像素 × RGB (alpha 恒 255)
 *   px0 = 'M','O','E'       px1 = 3(版本), shiftId, T_hi
 *   px2 = T_lo, hiW, loW    px3 = hiH, loH, chkAll
 *   px4 = tail0, 0x37, 0x31 */
function v3ChkAll(T, shiftId, w, h, salt) {
  const tail = saltTail(salt);
  return (MAGIC[0] ^ MAGIC[1] ^ MAGIC[2] ^ 3 ^ shiftId ^
    ((T >> 8) & 255) ^ (T & 255) ^
    ((w >> 8) & 255) ^ (w & 255) ^ ((h >> 8) & 255) ^ (h & 255) ^ tail[1]) & 255;
}
function writeMetaV3(out, encW, encH, w, h, T, shiftId, salt) {
  const my = encH - 1, x0 = encW - 5;
  const tail = saltTail(salt);
  setPx(out, x0, my, encW, MAGIC[0], MAGIC[1], MAGIC[2], 255);
  setPx(out, x0 + 1, my, encW, 3, shiftId, (T >> 8) & 255, 255);
  setPx(out, x0 + 2, my, encW, T & 255, (w >> 8) & 255, w & 255, 255);
  setPx(out, x0 + 3, my, encW, (h >> 8) & 255, h & 255, v3ChkAll(T, shiftId, w, h, salt), 255);
  setPx(out, x0 + 4, my, encW, tail[0], 0x37, 0x31, 255);
}
function readMetaV3(data, ew, eh, salt) {
  if (!data || !data.length || ew < 5 || eh < 1) return null;
  const my = eh - 1, x0 = ew - 5;
  if (pxv(data, x0, my, ew, 0) !== MAGIC[0] ||
      pxv(data, x0, my, ew, 1) !== MAGIC[1] ||
      pxv(data, x0, my, ew, 2) !== MAGIC[2]) return null;
  if (pxv(data, x0 + 1, my, ew, 0) !== 3) return null;
  const shiftId = pxv(data, x0 + 1, my, ew, 1);
  const T = (pxv(data, x0 + 1, my, ew, 2) << 8) | pxv(data, x0 + 2, my, ew, 0);
  const w = (pxv(data, x0 + 2, my, ew, 1) << 8) | pxv(data, x0 + 2, my, ew, 2);
  const h = (pxv(data, x0 + 3, my, ew, 0) << 8) | pxv(data, x0 + 3, my, ew, 1);
  if (w < 1 || h < 1 || T < 1 || T > V3_CAP_TILE || (T & (T - 1)) !== 0 || shiftId !== 0) return null;
  if (pxv(data, x0 + 3, my, ew, 2) !== v3ChkAll(T, shiftId, w, h, salt)) return null;
  if (pxv(data, x0 + 4, my, ew, 0) !== saltTail(salt)[0]) return null;
  if (pxv(data, x0 + 4, my, ew, 1) !== 0x37 || pxv(data, x0 + 4, my, ew, 2) !== 0x31) return null;
  const gw = Math.ceil(w / T) * T, gh = Math.ceil(h / T) * T;
  if (gw + 2 * V3_FRAME !== ew || gh + 2 * V3_FRAME !== eh) return null;
  return { w, h, extra: { ver: 3, T, shiftId, gridW: gw, gridH: gh } };
}
function shapeFrameV3(w, h, B, extra) {
  const T = extra && extra.T != null ? extra.T : v3TileSize(w, h);
  const F = V3_FRAME;
  const gw = Math.ceil(w / T) * T, gh = Math.ceil(h / T) * T;
  return { encW: gw + 2 * F, encH: gh + 2 * F, F, T, gridW: gw, gridH: gh };
}

/** 编码: 镜像补边 → 曲线平移 → tile 洗牌 → 画框 → 写元数据 */
function encodeImageV3(img, opts) {
  opts = opts || {};
  const salt = opts.salt || '';
  const w = img.width | 0, h = img.height | 0;
  if (!(w > 0 && h > 0)) throw new Error('bad image dims');
  const T = opts.tile ? Math.min(opts.tile, V3_CAP_TILE) : v3TileSize(w, h);
  const cols = Math.ceil(w / T), rows = Math.ceil(h / T);
  const gridW = cols * T, gridH = rows * T;
  const F = V3_FRAME;
  const encW = gridW + 2 * F, encH = gridH + 2 * F;
  const src = img.data;

  // 1) 镜像补边到 gridW×gridH
  const padded = new Uint8ClampedArray(gridW * gridH * 4);
  const mx = new Int32Array(gridW), my = new Int32Array(gridH);
  const mirror = (v, n) => { if (n === 1) return 0; const p = 2 * n - 2; let m = ((v % p) + p) % p; return m < n ? m : p - m; };
  for (let x = 0; x < gridW; x++) mx[x] = mirror(x, w);
  for (let y = 0; y < gridH; y++) my[y] = mirror(y, h);
  for (let y = 0; y < gridH; y++) {
    const sr = my[y] * w;
    for (let x = 0; x < gridW; x++) {
      const s = (sr + mx[x]) * 4, t = (y * gridW + x) * 4;
      padded[t] = src[s]; padded[t + 1] = src[s + 1];
      padded[t + 2] = src[s + 2]; padded[t + 3] = src[s + 3];
    }
  }

  // 2) 曲线平移表 (tile 内): sub[dstIdx] = srcIdx, 一次建表所有 tile 复用
  const T2 = T * T;
  const order = hilbertOrder(T);
  const sOff = Math.round(T2 * V3_SHIFT) % T2;
  const inv = new Int32Array(T2);
  for (let i = 0; i < T2; i++) inv[order[i]] = i;          // 像素索引 → 曲线位置
  const sub = new Int32Array(T2);                          // sub[曲线位置+平移后的目标像素] = 源像素
  for (let i = 0; i < T2; i++) {
    const curvePos = i;                                    // 目标曲线位置
    const srcPixel = order[(curvePos + sOff) % T2];        // 平移后的源像素
    sub[order[curvePos]] = srcPixel;                        // 按像素索引排布
  }

  // 3) tile 洗牌: tilePerm[destTile] = srcTile
  const seed = v3Seed(w, h, T, salt);
  const tilePerm = v3TilePerm(cols, rows, seed);

  // 4) 搬运: 平移 + 洗牌合写 (dest block → src block + sub)
  const out = new Uint8ClampedArray(encW * encH * 4);
  for (let d = 0; d < cols * rows; d++) {
    const s = tilePerm[d];
    const sbx = (s % cols) * T, sby = ((s / cols) | 0) * T;
    const dbx = (d % cols) * T, dby = ((d / cols) | 0) * T;
    for (let j = 0; j < T; j++) {
      const dRow = ((dby + j + F) * encW + dbx + F) * 4;
      for (let i = 0; i < T; i++) {
        const srcPix = sub[j * T + i];
        const sy = (srcPix / T) | 0, sx = srcPix % T;
        const so = ((sby + sy) * gridW + sbx + sx) * 4, dof = dRow + i * 4;
        out[dof] = padded[so]; out[dof + 1] = padded[so + 1];
        out[dof + 2] = padded[so + 2]; out[dof + 3] = padded[so + 3];
      }
    }
  }

  if (F > 0) v3DrawFrame(out, encW, encH, F, INK, GRAY);   // v3: 中性黑白灰框 (融入默认主题)
  writeMetaV3(out, encW, encH, w, h, T, 0, salt);
  return {
    width: encW, height: encH, data: out, algo: 'v3',
    meta: { algo: 'v3', T, w, h, F, encW, encH, salt, shiftId: 0 },
  };
}

/** 解码: 逆 tile 洗牌 → 逆曲线平移 → 裁回 w×h */
function decodeImageV3(img, m, salt) {
  const w = m.w, h = m.h;
  const T = m.extra.T, shiftId = m.extra.shiftId;
  const F = V3_FRAME;
  const ew = img.width | 0;
  const cols = Math.ceil(w / T), rows = Math.ceil(h / T);
  const gridW = cols * T, gridH = rows * T;
  if (ew !== gridW + 2 * F || img.height !== gridH + 2 * F) {
    return { ok: false, reason: 'resized', meta: m };
  }

  const T2 = T * T;
  const order = hilbertOrder(T);
  const sOff = Math.round(T2 * V3_SHIFT) % T2;
  const pos = new Int32Array(T2);
  for (let i = 0; i < T2; i++) pos[order[i]] = i;          // 像素索引 → 曲线位置
  const subInv = new Int32Array(T2);                        // 逆平移: 目标曲线位置 → 源曲线位置(-sOff)
  for (let curvePos = 0; curvePos < T2; curvePos++) {
    subInv[curvePos] = (curvePos - sOff + T2) % T2;
  }

  const seed = v3Seed(w, h, T, salt);
  const tilePerm = v3TilePerm(cols, rows, seed);
  const invPerm = new Int32Array(cols * rows);
  for (let d = 0; d < cols * rows; d++) invPerm[tilePerm[d]] = d;  // 源 tile → 目标 tile

  const src = img.data;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let s = 0; s < cols * rows; s++) {                    // s = 源(原图) tile
    const d = invPerm[s];                                    // 它现在在哪个目标 tile
    const sbx = (s % cols) * T, sby = ((s / cols) | 0) * T;
    const dbx = (d % cols) * T, dby = ((d / cols) | 0) * T;
    for (let j = 0; j < T; j++) {
      const sy = sby + j;
      if (sy >= h) break;
      const sRow = sy * w;
      const dRow = ((dby + j + F) * ew + dbx + F) * 4;
      for (let i = 0; i < T; i++) {
        const sx = sbx + i;
        if (sx >= w) break;
        const curvePos = pos[j * T + i];                    // 源像素的曲线位置
        const srcCurve = subInv[curvePos];                  // 它被平移前的位置
        const srcPix = order[srcCurve];                     // 平移前曲线位置对应的像素
        const syy = (srcPix / T) | 0, sxx = srcPix % T;
        const si = (sy * w + sx) * 4;
        const df = ((dby + syy + F) * ew + dbx + sxx + F) * 4;
        out[si] = src[df]; out[si + 1] = src[df + 1];
        out[si + 2] = src[df + 2]; out[si + 3] = src[df + 3];
      }
    }
  }
  return { ok: true, width: w, height: h, data: out, meta: m, layout: 'v3', algo: 'v3' };
}

/** 定位框宽容识别: 即使图被缩放/重编码也能认出「这是喵图」
 *  看四条边的窄带: 中性深墨占主 + 灰节拍线点缀
 *
 *  【为何多尺度扫】边框是固定 12px, 但图可能被平台缩放过 (框也跟着缩)。
 *    若用固定比例(如 2%)开窗: 大图上窗口 26px > 框宽 12px → 推入一半图像内容
 *    → 深色占比被稀释到阈值之下 → 自己的图反而识别不了。
 *    所以改成多个窗口宽度各扫一次, 取最好的得分 —— 总有一个窗口对得上框宽。
 *  元数据才是权威判定; 本函数只用于区分「被重编码的喵图」与「普通图」 */
function detectFrame(img) {
  const w = img.width | 0, h = img.height | 0, d = img.data;
  if (w < 24 || h < 24) return { ok: false, score: 0 };
  const lim = Math.max(2, Math.floor(Math.min(w, h) / 6));
  let best = { ok: false, score: 0, darkRatio: 0, grayRatio: 0, band: 0 };
  for (const cand of [2, 4, 6, 8, 12, 16]) {
    const t = Math.min(cand, lim);
    if (t < 2) continue;
    let dark = 0, midGray = 0, total = 0;
    const scan = (x0, y0, x1, y1) => {
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * w + x) * 4, r = d[i], g = d[i + 1], b = d[i + 2];
          total++;
          // 中性灰阶判定: 三通道接近 (低饱和)
          const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
          if (mx - mn <= 26) {
            if (mx < 78) dark++;
            else if (mx < 205) midGray++;
          }
        }
      }
    };
    scan(0, 0, w, t);
    scan(0, h - t, w, h);
    scan(0, t, t, h - t);
    scan(w - t, t, w, h - t);
    if (!total) continue;
    const dr = dark / total, gr = midGray / total;
    const score = +Math.min(1, dr + gr * 0.5).toFixed(3);
    // 深墨占主 + 灰节拍线 (普通图很少整圈边缘都是低饱和深色)
    const ok = dr > 0.55 && dr + gr > 0.72;
    if (score > best.score) {
      best = { ok, score, darkRatio: +dr.toFixed(3), grayRatio: +gr.toFixed(3), band: t };
    }
    if (ok && t >= 8) break;                 // 已经确认且窗口足够大 → 不必再扫
  }
  return best;
}

/* ══════════════════════════════════════════════════════════════════
 * 快速 PNG 编码器 —— 绕开 canvas.toBlob 的单线程高压 zlib
 * ══════════════════════════════════════════════════════════════════
 * 为什么需要: 实测 1536×1152 图 canvas.toBlob('image/png') 要 ~1050ms,
 *   而混淆变换本身只用 30ms —— 瓶颈 97% 在浏览器的 PNG 压缩上。
 *   canvas 用最高压缩等级且不可调, 而我们不在乎多几百 KB。
 *
 * 做法: 手写 PNG 容器 (IHDR/IDAT/IEND) + CompressionStream('deflate')
 *   浏览器原生、流式、底层是优化过的 zlib, 但用默认(低)压缩等级 → 快很多。
 *   滤波器统一用 Sub(1): 对混淆图这种局部相关内容比 None 小很多, 计算又极廉价。
 *
 * 无损保证: PNG 本身就是无损格式, 压缩等级只影响体积不影响像素。
 *   且本编码器直接写 8bit RGBA (无调色板/无预乘), 不经过 canvas 二次采样。
 * ══════════════════════════════════════════════════════════════════ */

function pngChunk(type, body) {
  const len = body.length;
  const out = new Uint8Array(12 + len);
  out[0] = (len >>> 24) & 255; out[1] = (len >>> 16) & 255;
  out[2] = (len >>> 8) & 255; out[3] = len & 255;
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  const crc = crc32(out.subarray(4, 8 + len));
  const o = 8 + len;
  out[o] = (crc >>> 24) & 255; out[o + 1] = (crc >>> 16) & 255;
  out[o + 2] = (crc >>> 8) & 255; out[o + 3] = crc & 255;
  return out;
}

/** 扫描线加 Sub 滤波器 (每行前缀 1, 字节减左侧4字节) → 待压缩原流 */
function pngFilterSub(im) {
  const w = im.width, h = im.height, src = im.data;
  const stride = w * 4;
  const raw = new Uint8Array(h * (stride + 1));
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 1;                       // filter type: Sub
    const s = y * stride;
    for (let i = 0; i < 4; i++) raw[p + i] = src[s + i];
    for (let i = 4; i < stride; i++) raw[p + i] = (src[s + i] - src[s + i - 4]) & 255;
    p += stride;
  }
  return raw;
}

/** 扫描线不加滤波器 (每行前缀 0) —— 不压缩时滤波没意义, 省掉这道 CPU */
function pngFilterNone(im) {
  const w = im.width, h = im.height, src = im.data;
  const stride = w * 4;
  const raw = new Uint8Array(h * (stride + 1));
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0;
    const s = y * stride;
    for (let i = 0; i < stride; i++) raw[p + i] = src[s + i];
    p += stride;
  }
  return raw;
}

/** PNG 容器组装: IHDR + IDAT + IEND (纯字节运算, 无浏览器 API) */
function assemblePng(w, h, idat) {
  const ihdr = new Uint8Array(13);
  ihdr[0] = (w >>> 24) & 255; ihdr[1] = (w >>> 16) & 255; ihdr[2] = (w >>> 8) & 255; ihdr[3] = w & 255;
  ihdr[4] = (h >>> 24) & 255; ihdr[5] = (h >>> 16) & 255; ihdr[6] = (h >>> 8) & 255; ihdr[7] = h & 255;
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // color type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;         // deflate / adaptive filter / no interlace
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const cIhdr = pngChunk('IHDR', ihdr);
  const cIdat = pngChunk('IDAT', idat);
  const cIend = pngChunk('IEND', new Uint8Array(0));
  const out = new Uint8Array(sig.length + cIhdr.length + cIdat.length + cIend.length);
  let o = 0;
  out.set(sig, o); o += sig.length;
  out.set(cIhdr, o); o += cIhdr.length;
  out.set(cIdat, o); o += cIdat.length;
  out.set(cIend, o);
  return out;
}

/** 快速编码为 PNG 字节 (需 CompressionStream); 不可用则 reject → 调用方逐级回落
 *
 * ⚠️ 【不能用 writer.write(typedArray)】—— Firefox 隔离世界实测 (152, 2026-09):
 *     writer.write(本 realm 的 Uint8Array)
 *       → TypeError: Value could not be converted to any of: ArrayBufferView, ArrayBuffer.
 *   CompressionStream 是页面 realm 的 DOM 对象, 它的参数转换拒收沙箱 realm 的
 *   TypedArray (Xray 安全检查)。写失败后流被 abort, 收流端跟着报
 *   AbortError / 空流 → 回落 canvas → 又撞上同样拒收沙箱数组的 putImageData →
 *   用户看到的就是 "Failed to extract Uint8ClampedArray from ImageData"。
 *
 *   正解: 先塞进 Blob。Blob 构造器在建对象时就把字节【拷】进自己的存储,
 *   BlobPart 转换不走 ArrayBufferView 联合类型 → 沙箱数组照收;
 *   之后 blob.stream() 出来的流已经是页面 realm 的合法输入,
 *   pipeThrough 全程不再碰 realm 边界。Chrome/Node 上行为完全一致。
 *   (实测 1536×1152: 滤波 ~9ms + deflate ~9ms, 比 canvas.toBlob 的 ~1050ms 快两个数量级)
 */
function encodePngFast(im) {
  if (typeof CompressionStream === 'undefined') {
    return Promise.reject(new Error('no-CompressionStream'));
  }
  if (typeof Blob === 'undefined') {
    return Promise.reject(new Error('no-Blob'));
  }
  const w = im.width | 0, h = im.height | 0;
  let stream;
  try {
    // zlib 包装 (PNG 要的就是 zlib 流)
    stream = new Blob([pngFilterSub(im)]).stream().pipeThrough(new CompressionStream('deflate'));
  } catch (e) {
    return Promise.reject(e);
  }
  const reader = stream.getReader();
  const parts = [];
  let total = 0;
  function pump() {
    return reader.read().then((r) => {
      if (r.done) {
        const idat = new Uint8Array(total);
        let o = 0;
        for (const p of parts) { idat.set(p, o); o += p.length; }
        return assemblePng(w, h, idat);
      }
      parts.push(r.value);
      total += r.value.length;
      return pump();
    });
  }
  return pump();
}

/** adler32 (zlib 流尾部校验和); 按 NMAX 分段取模 → 不溢出且快 */
function adler32(b) {
  let a = 1, s = 0, i = 0;
  const n = b.length, NMAX = 5552;
  while (i < n) {
    const end = Math.min(i + NMAX, n);
    for (; i < end; i++) { a += b[i]; s += a; }
    a %= 65521; s %= 65521;
  }
  return ((s << 16) | a) >>> 0;
}

/** 把字节包成合法 zlib 流, 全用 stored(未压缩)块 —— 零浏览器 API
 *
 * deflate 的 stored 块: 5 字节头 [BFINAL|BTYPE=00, LEN, ~LEN] + 原文, 每块最大 65535。
 * 体积等于原文 + 约 0.008%, 但无需任何浏览器能力。
 */
function zlibStore(raw) {
  const MAX = 65535;
  const nb = Math.max(1, Math.ceil(raw.length / MAX));
  const out = new Uint8Array(2 + nb * 5 + raw.length + 4);
  let o = 0;
  out[o++] = 0x78; out[o++] = 0x01;        // CMF/FLG: deflate, 32K 窗, 无字典
  for (let i = 0; i < nb; i++) {
    const s = i * MAX, len = Math.min(MAX, raw.length - s);
    out[o++] = (i === nb - 1) ? 1 : 0;     // 最后一块置 BFINAL
    out[o++] = len & 255; out[o++] = (len >>> 8) & 255;
    out[o++] = (~len) & 255; out[o++] = ((~len) >>> 8) & 255;
    out.set(raw.subarray(s, s + len), o); o += len;
  }
  const ad = adler32(raw);
  out[o++] = (ad >>> 24) & 255; out[o++] = (ad >>> 16) & 255;
  out[o++] = (ad >>> 8) & 255; out[o++] = ad & 255;
  return out.subarray(0, o);
}

/** 无依赖 PNG 编码器 (同步, 不需 CompressionStream 也不需 canvas)
 *
 * 存在的意义: 当快速编码器在某个 realm 里不可用时, 这里能保证解码仍然完成。
 * 代价是体积大 (不压缩), 但解码产物只是本地 blob URL, 体积无关紧要。
 * PNG 本身无损, stored 块不影响像素。
 */
function encodePngStore(im) {
  return assemblePng(im.width | 0, im.height | 0, zlibStore(pngFilterNone(im)));
}

const CHUNK_TYPE = 'moEg';
const META_CHUNK = 'moMt';   // 元数据(ComfyUI 工作流等 tEXt) 打包 chunk: 负载 = JSON{texts:[{k,v}...]}

/** 读 PNG 所有文本 chunk (tEXt/iTXt; zTXt 是压缩流, 同步无法解 → 跳过) → [{k, v}] */
function pngGetTextChunks(u8) {
  if (!isPng(u8) || u8.length < 33) return [];
  const out = [];
  let p = 8;
  while (p + 8 <= u8.length) {
    const len = ((u8[p] << 24 | u8[p + 1] << 16 | u8[p + 2] << 8 | u8[p + 3]) >>> 0);
    const type = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
    const start = p + 8, end = start + len;
    if (end > u8.length) break;
    if (type === 'tEXt' || type === 'iTXt') {
      try {
        const isITxt = type === 'iTXt';
        let kEnd = -1;
        for (let i = start; i < end; i++) if (u8[i] === 0) { kEnd = i; break; }
        if (kEnd < 0) { p = end + 4; continue; }
        const key = bytesToUtf8(u8.subarray(start, kEnd)).replace(/[^\x20-\x7E]/g, '');
        if (!key) { p = end + 4; continue; }
        let val = '';
        if (isITxt) {
          if (kEnd + 3 < end && u8[kEnd + 1] === 0 && u8[kEnd + 2] === 0) {
            // 压缩标志=0: 语言(≤4B) → 翻译 → 文本
            let langEnd = kEnd + 3;
            while (langEnd < end && u8[langEnd] !== 0) langEnd++;
            let trEnd = langEnd + 1;
            while (trEnd < end && u8[trEnd] !== 0) trEnd++;
            val = bytesToUtf8(u8.subarray(trEnd + 1, end));
          }
          // iTXt 压缩标志=1 → 跳过 (同步解不了)
        } else {
          val = bytesToUtf8(u8.subarray(kEnd + 1, end));
        }
        if (val) out.push({ k: key, v: val });
      } catch (e) {}
    }
    p = end + 4;
  }
  return out;
}

/** 在 IHDR 后插入 moMt chunk (含 ComfyUI workflow 等文本元数据); 返回 Uint8Array */
function pngPutTextChunks(u8, chunks) {
  if (!isPng(u8) || !chunks || !chunks.length) return u8;
  const payload = JSON.stringify(chunks);
  let body;
  try { body = new TextEncoder().encode(payload); } catch (e) {
    body = new Uint8Array(payload.length);
    for (let i = 0; i < payload.length; i++) body[i] = payload.charCodeAt(i) & 0xff;
  }
  const typeBytes = new Uint8Array([0x6d, 0x6f, 0x4d, 0x74]); // 'moMt'
  const len = body.length;
  const chunk = new Uint8Array(12 + len);
  chunk[0] = (len >> 24) & 255; chunk[1] = (len >> 16) & 255; chunk[2] = (len >> 8) & 255; chunk[3] = len & 255;
  chunk.set(typeBytes, 4);
  chunk.set(body, 8);
  const crc = crc32(chunk.subarray(4, 8 + len));
  chunk[8 + len] = (crc >> 24) & 255; chunk[8 + len + 1] = (crc >> 16) & 255;
  chunk[8 + len + 2] = (crc >> 8) & 255; chunk[8 + len + 3] = crc & 255;
  const ihdrLen = (u8[8] << 24 | u8[9] << 16 | u8[10] << 8 | u8[11]) >>> 0;
  const insertAt = 8 + 12 + ihdrLen;
  if (insertAt > u8.length) return u8;
  const out = new Uint8Array(u8.length + chunk.length);
  out.set(u8.subarray(0, insertAt), 0);
  out.set(chunk, insertAt);
  out.set(u8.subarray(insertAt), insertAt + chunk.length);
  return out;
}

/** 从混淆图提取元数据 (moMt → chunks) */
function pngReadMetaChunks(u8) {
  if (!isPng(u8)) return null;
  let p = 8;
  while (p + 8 <= u8.length) {
    const len = ((u8[p] << 24 | u8[p + 1] << 16 | u8[p + 2] << 8 | u8[p + 3]) >>> 0);
    const type = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
    const start = p + 8, end = start + len;
    if (end > u8.length) break;
    if (type === 'moMt') {
      try {
        const s = bytesToUtf8(u8.subarray(start, end));
        const arr = JSON.parse(s);
        if (Array.isArray(arr) && arr.every((x) => x && typeof x.k === 'string')) return arr;
      } catch (e) { return null; }
    }
    p = end + 4;
  }
  return null;
}

/** 解码产物専用: 把元数据以标准 tEXt chunks 写回还原图 (ComfyUI 等工具可直接读) */
function pngRestoreTextChunks(u8, chunks) {
  if (!isPng(u8) || !chunks || !chunks.length) return u8;
  let out = u8;
  for (const c of chunks) {
    if (!c || typeof c.k !== 'string' || !c.k || typeof c.v !== 'string') continue;
    const key = c.k.slice(0, 79);
    let keyB, valB;
    try { keyB = new TextEncoder().encode(key); } catch (e) { keyB = new Uint8Array(key.length); for (let i = 0; i < key.length; i++) keyB[i] = key.charCodeAt(i) & 0xff; }
    try { valB = new TextEncoder().encode(c.v); } catch (e) { valB = new Uint8Array(c.v.length); for (let i = 0; i < c.v.length; i++) valB[i] = c.v.charCodeAt(i) & 0xff; }
    const body = new Uint8Array(keyB.length + 1 + valB.length);
    body.set(keyB, 0);
    body.set(valB, keyB.length + 1);
    const typeB = new Uint8Array([0x74, 0x45, 0x58, 0x74]); // 'tEXt'
    const chunk = new Uint8Array(12 + body.length);
    chunk[0] = (body.length >>> 24) & 255; chunk[1] = (body.length >>> 16) & 255;
    chunk[2] = (body.length >>> 8) & 255; chunk[3] = body.length & 255;
    chunk.set(typeB, 4);
    chunk.set(body, 8);
    const crcIn = new Uint8Array(4 + body.length);
    crcIn.set(typeB, 0); crcIn.set(body, 4);
    const crc = crc32(crcIn);
    const o = 8 + body.length;
    chunk[o] = (crc >>> 24) & 255; chunk[o + 1] = (crc >>> 16) & 255;
    chunk[o + 2] = (crc >>> 8) & 255; chunk[o + 3] = crc & 255;
    // 插到 IEND 之前 (大多数工具在 IEND 前读全部 chunk)
    let iend = -1, p = 8;
    while (p + 8 <= out.length) {
      const len = (out[p] << 24 | out[p + 1] << 16 | out[p + 2] << 8 | out[p + 3]) >>> 0;
      if (out[p + 4] === 0x49 && out[p + 5] === 0x45 && out[p + 6] === 0x4e && out[p + 7] === 0x44) { iend = p; break; }
      p += 12 + len;
    }
    if (iend < 0) { p = out.length; iend = out.length; }
    const nxt = new Uint8Array(out.length + chunk.length);
    nxt.set(out.subarray(0, iend), 0);
    nxt.set(chunk, iend);
    nxt.set(out.subarray(iend), iend + chunk.length);
    out = nxt;
  }
  return out;
}

function bytesToUtf8(u8) {
  try {
    return new TextDecoder('utf-8').decode(u8);
  } catch (e) {
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return s;
  }
}

let _crcTable = null;
function crc32(bytes) {
  if (!_crcTable) {
    _crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      _crcTable[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ _crcTable[(crc ^ bytes[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}
function isPng(u8) {
  return !!u8 && u8.length > 8 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47;
}

/** 在 IHDR 之后插入 moEg 标记块; 入参/返回 Uint8Array */
function pngAddMarker(u8, meta) {
  if (!isPng(u8)) return u8;
  const ihdrLen = (u8[8] << 24 | u8[9] << 16 | u8[10] << 8 | u8[11]) >>> 0;
  const insertAt = 8 + 12 + ihdrLen; // 签名 + (len+type+crc) + data
  if (insertAt > u8.length) return u8;
  const tail = saltTail(meta && meta.salt);
  const w = (meta && meta.w) | 0, h = (meta && meta.h) | 0, B = (meta && meta.B) || 16;
  const payload = new Uint8Array([
    0x4d, 0x4f, 0x45, 0x31,                 // 'MOE1'
    B & 255,
    (w >> 8) & 255, w & 255,
    (h >> 8) & 255, h & 255,
    tail[0], tail[1],
  ]);
  const typeBytes = new Uint8Array([0x6d, 0x6f, 0x45, 0x67]); // 'moEg'
  const crcInput = new Uint8Array(typeBytes.length + payload.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(payload, typeBytes.length);
  const crc = crc32(crcInput);
  const chunk = new Uint8Array(12 + payload.length);
  chunk[0] = (payload.length >>> 24) & 255; chunk[1] = (payload.length >>> 16) & 255;
  chunk[2] = (payload.length >>> 8) & 255; chunk[3] = payload.length & 255;
  chunk.set(typeBytes, 4);
  chunk.set(payload, 8);
  const o = 8 + payload.length;
  chunk[o] = (crc >>> 24) & 255; chunk[o + 1] = (crc >>> 16) & 255;
  chunk[o + 2] = (crc >>> 8) & 255; chunk[o + 3] = crc & 255;
  const out = new Uint8Array(u8.length + chunk.length);
  out.set(u8.subarray(0, insertAt), 0);
  out.set(chunk, insertAt);
  out.set(u8.subarray(insertAt), insertAt + chunk.length);
  return out;
}

/** 从开头几十字节读标记块 → {B,w,h,saltOk} | null (不需完整文件) */
function pngReadMarker(u8, salt) {
  if (!isPng(u8) || u8.length < 33) return null;
  let p = 8;
  for (let guard = 0; guard < 4 && p + 8 <= u8.length; guard++) {
    const len = (u8[p] << 24 | u8[p + 1] << 16 | u8[p + 2] << 8 | u8[p + 3]) >>> 0;
    const type = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
    if (type === CHUNK_TYPE) {
      const d = p + 8;
      if (d + 11 > u8.length) return null;
      if (!(u8[d] === 0x4d && u8[d + 1] === 0x4f && u8[d + 2] === 0x45 && u8[d + 3] === 0x31)) return null;
      const tail = saltTail(salt);
      return {
        B: u8[d + 4] || 16,
        w: (u8[d + 5] << 8) | u8[d + 6],
        h: (u8[d + 7] << 8) | u8[d + 8],
        saltOk: u8[d + 9] === tail[0] && u8[d + 10] === tail[1],
      };
    }
    if (type === 'IDAT' || type === 'IEND') return null; // 标记应在像素数据之前
    p += 12 + len;
  }
  return null;
}

/** 感知指纹 (用于把预览阶段的结论匹配到上传字节)
 *  Discord 会先把图重压成 webp 再上传 → 字节级哈希必然对不上。
 *
 *  【为何是 8×8 + 色彩】旧版只取 4×4 网格的 4bit 亮度 = 64 bit 信息量,
 *    两张色调相近的图 (例如都是暖调人像) 指纹会完全相同 → 结论串图,
 *    用户对 B 图点的「改成混淆」会被 A 图的「不混淆」遮蔽 → 漏发原图。
 *    现在: 8×8 亮度 (64 桶) + 4×4 色差 (16 桶) ≈ 320 bit, 碰撞率降到微乎其微。
 *  桶内取平均值 → 对有损重编码仍然稳定 (实测 webp60 指纹不变)。
 *  ⚠️ 硬量化会在桶边界翻位 (127.9 → 7, 128.1 → 8), 所以匹配必须用
 *     tagMatches() 做容差比较, 不要直接字符串相等。
 *  格式: "WxH:<64 位亮度 hex>:<16 位色差 hex>" */
function perceptualTag(img) {
  const w = img.width | 0, h = img.height | 0, d = img.data;
  if (!(w > 0 && h > 0)) return '0x0::';
  let lum = '', chroma = '';
  // 8×8 亮度
  for (let gy = 0; gy < 8; gy++) {
    for (let gx = 0; gx < 8; gx++) {
      const x0 = ((gx * w) / 8) | 0, x1 = (((gx + 1) * w) / 8) | 0;
      const y0 = ((gy * h) / 8) | 0, y1 = (((gy + 1) * h) / 8) | 0;
      let sum = 0, n = 0;
      const sx = Math.max(1, ((x1 - x0) / 6) | 0), sy = Math.max(1, ((y1 - y0) / 6) | 0);
      for (let y = y0; y < y1; y += sy) {
        for (let x = x0; x < x1; x += sx) {
          const i = (y * w + x) * 4;
          sum += (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
          n++;
        }
      }
      lum += (n ? Math.min(15, (sum / n / 16) | 0) : 0).toString(16);
    }
  }
  // 4×4 色差 (R-B 映射到 0..15): 同亮度不同色调也能区分
  for (let gy = 0; gy < 4; gy++) {
    for (let gx = 0; gx < 4; gx++) {
      const x0 = ((gx * w) / 4) | 0, x1 = (((gx + 1) * w) / 4) | 0;
      const y0 = ((gy * h) / 4) | 0, y1 = (((gy + 1) * h) / 4) | 0;
      let rb = 0, n = 0;
      const sx = Math.max(1, ((x1 - x0) / 8) | 0), sy = Math.max(1, ((y1 - y0) / 8) | 0);
      for (let y = y0; y < y1; y += sy) {
        for (let x = x0; x < x1; x += sx) {
          const i = (y * w + x) * 4;
          rb += d[i] - d[i + 2];              // -255..255
          n++;
        }
      }
      const v = n ? (rb / n) : 0;
      chroma += Math.max(0, Math.min(15, Math.round((v + 256) / 32))).toString(16);
    }
  }
  return w + 'x' + h + ':' + lum + ':' + chroma;
}

/** 字节级 FNV-1a (对 Uint8Array, 不过字符串) */
function fnv1aBytes(u8, seed) {
  let h = (seed == null ? 0x811c9dc5 : seed) >>> 0;
  for (let i = 0; i < u8.length; i++) {
    h ^= u8[i];
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/** 内容键: 【字节级精确】身份, 给多图批量上传配对结论用
 *  为何不能只靠感知指纹: 指纹是模糊匹配, 一次发 4 张相似的图时
 *  A 图的「不混淆」可能匹到 B 图头上 → 该混的没混。
 *  预览图与上传 PUT 同源于同一个 File → 字节完全一致 → 可作主键。
 *  双种子双向扫: 长度相同且单 hash 撞车的概率降到可忽略。 */
function contentKey(u8) {
  if (!u8 || !u8.length) return '';
  const h1 = fnv1aBytes(u8, 0x811c9dc5);
  let h2 = 0x9e3779b9 >>> 0;
  for (let i = u8.length - 1; i >= 0; i--) {          // 反向一遍, 不同种子
    h2 ^= u8[i];
    h2 = (h2 + ((h2 << 1) + (h2 << 5) + (h2 << 13))) >>> 0;
  }
  return u8.length.toString(36) + '-' + h1.toString(36) + h2.toString(36);
}

/** 指纹容差匹配: 尺寸必须一致, 亮度与色差的累计差异各自在阈值内
 *  为什么不用字符串相等: webp 有损重压会让个别桶 ±1, 硬比会漏匹配。
 *  阈值: 亮度 64 桶允许累计差 10 (平均每桶 0.16 阶),
 *          色差 16 桶允许累计差 6。实测 webp 重压后差异基本为 0。 */
function tagMatches(a, b, tolLum, tolChroma) {
  if (!a || !b) return false;
  if (a === b) return true;
  const pa = a.split(':'), pb = b.split(':');
  if (pa.length < 2 || pb.length < 2) return false;
  if (pa[0] !== pb[0]) return false;                        // 尺寸不同 → 不是同一张
  const sumDiff = (x, y, cap) => {
    if (!x || !y || x.length !== y.length) return Infinity;
    let s = 0;
    for (let i = 0; i < x.length; i++) {
      s += Math.abs(parseInt(x[i], 16) - parseInt(y[i], 16));
      if (s > cap) return Infinity;
    }
    return s;
  };
  const cl = tolLum == null ? 10 : tolLum;
  const cc = tolChroma == null ? 6 : tolChroma;
  if (sumDiff(pa[1], pb[1], cl) === Infinity) return false;
  // 旧格式 (无色差段) 仍可比: 只要亮度对得上
  if (pa.length < 3 || pb.length < 3) return true;
  return sumDiff(pa[2], pb[2], cc) !== Infinity;
}

/* ---------- Node / 浏览器 / ServiceWorker 三端导出 ---------- */
/* ---------- 对外接口 ---------- */

/**
 * 混淆一张图
 * @param img  {width, height, data:Uint8ClampedArray}  原始像素
 * @param opts {salt?, tile?}   tile 不传则自适应 (上限 V3_MAX_TILE)
 * @returns {width, height, data, meta}
 */
function encodeImage(img, opts) {
  return encodeImageV3(img, opts || {});
}

/**
 * 解开一张图
 * @returns {ok:true, width, height, data, meta} | {ok:false, reason}
 *   reason: 'not-moe' 无标记 / 'bad-salt' 盐值不符 / 'resized' 尺寸被改动
 */
function decodeImage(img, opts) {
  opts = opts || {};
  const salt = opts.salt || '';
  const ew = img.width | 0, eh = img.height | 0;
  const m = readMetaV3(img.data, ew, eh, salt);
  if (!m) {
    // 魔数在但校验不过 → 确定是喵图, 只是盐值不同 (群组隔离)
    if (probeMagic(img.data, ew, eh)) return { ok: false, reason: 'bad-salt' };
    // 靠定位框认出「本来是喵图, 但被平台重编码了」
    const fr = detectFrame(img);
    if (fr.ok) return { ok: false, reason: 'resized', frame: fr };
    return { ok: false, reason: 'not-moe' };
  }
  return decodeImageV3(img, m, salt);
}

/** 读元数据 → {w,h} | null (判定「是不是喵图」) */
function readMeta(data, ew, eh, salt) {
  const m = readMetaV3(data, ew, eh, salt);
  return m ? { w: m.w, h: m.h } : null;
}
function detectMeta(img, salt) {
  return readMeta(img.data, img.width | 0, img.height | 0, salt);
}

/** 元数据魔数探测 (不校验校验和/盐值): 区分「不是喵图」与「盐值不同」 */
function probeMagic(data, ew, eh) {
  if (!data || !data.length || eh < 1 || ew < 5) return false;
  const my = eh - 1, x0 = ew - 5;
  return pxv(data, x0, my, ew, 0) === MAGIC[0] &&
         pxv(data, x0, my, ew, 1) === MAGIC[1] &&
         pxv(data, x0, my, ew, 2) === MAGIC[2] &&
         pxv(data, x0 + 1, my, ew, 0) === 3;
}

/* ---------- Node / 浏览器 / ServiceWorker 三端导出 ---------- */
const API = {
  VERSION, MAGIC,
  encodeImage, decodeImage, detectMeta, readMeta,
  encodeImageV3, decodeImageV3, readMetaV3, writeMetaV3,
  probeMagic, detectFrame,
  makePRNG, saltTail, fnv1a, shufflePerm, hilbertOrder, v3TileSize,
  encodePngFast, encodePngStore, isPng, crc32,
  pngAddMarker, pngReadMarker,
  pngGetTextChunks, pngPutTextChunks, pngReadMetaChunks, pngRestoreTextChunks,
  perceptualTag, tagMatches, contentKey, fnv1aBytes,
  V3_FRAME, V3_MAX_TILE, V3_CAP_TILE,
};
if (typeof window !== 'undefined') { window.__MoeGuardCore = API; }
if (typeof module !== 'undefined' && module.exports) { module.exports = API; }
