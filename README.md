# 🌸 dis-Plus max（MoeGuard 喵图混淆）

Discord 图片上传自动混淆扩展 —— **只有装了本插件的人才能看到原图**。轻量 · 无损 · **无需密钥** · 自研算法（MOE v3「流光照影」）。

当前版本 **v3.6.8**（测试版）。许可证 GPL-3.0。

---

## ⚠️ 使用前必读（风险告知）

本扩展会 **修改 Discord 客户端行为**：hook XHR 上传、拦截点击事件、注入 DOM 与 CSS。

### 条款上确实违规

Discord Terms of Service（Effective: September 29, 2025）里有两处相关：

> **软件许可段：** You may not copy, modify, create derivative works based upon, distribute…
> any of our software or services. You also may not reverse engineer or decompile our software or services…
>
> **禁止行为段：** using any unauthorized software designed to modify the services

所以"违反 ToS"不是夸张，就是字面意思。

### 但实际执法情况要分开看

参照同类客户端 mod（BetterDiscord / Vencord，用户量比本项目大得多）的公开记录：
Discord **从未因为单纯使用 client mod 而封号**，被封的都是拿它干别的事——
API 滥用、自动化脚本、批量操作、self-bot 行为。Discord 官方在支持论坛的口径也是这个：
不主动扫、不主动封，但不提供支持，出问题不管，并且随时保留处理的权利。

本插件的风险面比 BetterDiscord 还小：

- 不改客户端本体文件，只是浏览器扩展改 DOM
- 不调任何未授权 API（表情 / 贴纸走的是公开 CDN 图链接，自动加反应这类功能明确没做）
- 不自动化、不批量、不发多余请求
- 不读 token、不发送凭据、不连接任何作者控制的服务器（源码全开可自行校验）

### 诚实的结论

条款上确实违规；被封的实际概率很低但不是零，且完全取决于 Discord 的自由裁量——
他们哪天改主意就改主意了。自己权衡后使用，作者不对封号后果负责。

---

## ✨ 功能

| 功能 | 说明 |
|---|---|
| 🛡 上传自动混淆 | 发图时自动打乱成分形纹样，Discord 服务器和没装插件的人看到的都是花纹 |
| 👁 自动解码 | 自己发的、别人发的喵图都自动还原成原图显示，交流无障碍 |
| 🔲 二维码式定位框 | 混淆图外围一圈中性灰阶定位框 + 3 个角眼 → 一眼认出喵图，缩略图也认得，且融入 Discord 默认主题 |
| 🔍 先审查后决定 | 所有图先过一遍检测再决定混不混；**默认只混淆色情图**，本地启发式零联网，也可选接远端 API（关掉开关 = 全部混淆）|
| ❌ 单图推翻结论 | 预览图**右上角按钮**：✕ = 会混淆，○ = 原图发送，点一下切换 |
| 🏷 预览角标 | 发送前的预览卡上显示真实结论（审查中… / 0.82·混 / 手动·原 / 默认·混）|
| 🔓 手动解码 | 右键任意图片 →「解码此图片」：预览 + 下载原图 |
| ⚡ 廉价预筛 | 只读图片前 128 字节判断是不是喵图 → 普通图片/表情/头像完全不受影响 |
| ⚙️ 可开关 | 上传混淆、自动解码、角标独立开关 |
| 🪪 群组盐值 | 留空=全员互通；填写后只有同盐值的人能互解 |
| 🧬 元数据保留 | 混淆图与解码图都完整携带 PNG 文本元数据（**ComfyUI 工作流**/提示词/参数），拖回 ComfyUI 可直接复现 |
| 🚫 移除举报 | 自动清掉 Discord 界面所有「举报/Report」入口（hover 菜单/用户弹窗/工具条） |
| 🏷 消息归属标签 | 徽标在**图片外**的头像槽里（头像下方）：自己发的图 → 「已混淆」；别人发的已解图 → 「已解析」+「下载」（带回复的消息也不会弄反）|
| 😀 emoji 全解锁 | 服务器 emoji/动画 emoji 去灰启用，点击可用（绕过 Nitro 限制） |
| 🎴 贴纸解锁 | 外服贴纸去黑白滤镜，点击自动插入 CDN 图链接（Lottie 类型除外） |
| 🌐 三浏览器 | Chrome / Edge (MV3) · Firefox (MV3 128+)，`build.js` 一键打三个包 |

## 🧠 算法：MOE v3「流光照影」（自研、无密钥、无损）

**为什么好看**：希尔伯特曲线把 2D 压成 1D 且保持局部性——曲线上相邻的像素在平面上也相邻。
沿曲线做一次黄金比 φ 大平移，曲线上连续的一长段整体搬走 → 平面上出现**大块柔和的分形形状**，而不是噪点雪花或细碎颗粒。

> 走过的弯路：像素级打乱 = 彩色雪花噪点且 PNG 膨胀；切太碎（小 tile）= 刺眼。
> 大 tile + 沿曲线整段平移才是柔和的。

**两级结构（只有「大 + 中」两档碎片）**：

1. **中级**：每个 `T×T` tile 内部沿希尔伯特曲线整体平移 φ（0.618…）
   → 块内渐变与大色区保持完整，曲线裁出分形边缘
2. **大级**：tile 之间带盐洗牌 → 构图级打乱 + 可选盐值群组隔离

配套机制：

- **Tile 自适应**：`T = min(256, 不超过 max(w,h) 的最大 2 幂)`。
  1536×1152 → `1560×1304`（补边仅 1.15x）。曾用 1024 会补到 `2072²`（2.43x），
  不只浪费体积，还把 PNG 编码这个真正瓶颈乘大 2.4 倍。`T` 写在元数据里，可在设置页手动指定。
- **补边用镜像反射**：边缘复制会在角上留一大片死板纯色区，镜像补边看不出接缝。
- **alpha 安全**：RGBA 整像素搬运，不拆通道
  （canvas 预乘 alpha 会毁掉 a≈0 处的 RGB）→ 半透明图同样无损。
- **定位框**：外围 12px 中性深墨实心边框 + 中性灰节拍虚线 + 3 个角眼（仿二维码）。
  低饱和灰阶 → 与 Discord 亮/暗主题都融合。`detectFrame()` 多尺度扫描，
  图被缩到 50% 也能识别；边框不承载数据，裁掉不影响无损。
- **元数据**：末行最右 5 像素 × RGB 存 `MOE` 魔数 / 版本 3 / T / 原始宽高 / 校验和 / 盐值尾字节。
  解码器可自检「这图是不是喵图」，无需外部密钥。
- **种子**：`FNV-1a(魔串 + 宽×高 + T + 盐值)` → SplitMix64。
- **`moEg` 标记块**：PNG 里插入 23 字节 ancillary 块（标准解码器忽略），
  让检测端**只需下载前 128 字节**就能判断是不是喵图。
- **`moMt` 元数据块**：把原图的 PNG 文本 chunk（ComfyUI workflow / 提示词 / 参数）
  打包存进混淆图；解码时以标准 `tEXt` 写回还原图 → 拖回 ComfyUI 可直接复现。

编码尺寸：`encW = ceil(w/T)*T + 2F`，`encH = ceil(h/T)*T + 2F`（F=12）

**性能**：变换本身 1MP 约 16ms（编码）/ 8ms（解码）。
真正的瓶颈曾是 `canvas.toBlob('image/png')`——1536×1152 要 ~1050ms 且压缩等级不可调。
现在改用自建快速 PNG 编码器（`CompressionStream('deflate')` + Sub 滤波器），
浏览器实测上传链路 **1201ms → 157ms（7.7x）**，体积 2.49MB → 0.85MB。
PNG 是无损格式，压缩等级只影响体积不影响像素。

> 🎨 风格血统：从 20+ 种数学变换样张中选中「希尔伯特平移」（04 号样张），
> 再经「大块不刺眼」「大+中两档碎片」两轮打磨成 v3。样张见 `G:\数学混淆样张-曲线家族\`。

**安全模型（诚实声明）**：

- 无插件者看到的是分形纹样的拼贴图，认不出原内容
- 「无需密钥」的代价：逆向插件源码者可还原；同尺寸图排列结构相同（可用盐值隔离）
- 盐值不符时报 `bad-salt`（而不是静默失败），能区分「不是喵图」与「不是同一群组」
- Discord 上传前会把图重压成 webp，但混淆发生在压缩之后，故 CDN 上的字节就是混淆图

> **单一算法说明**：发布前只保留 v3，历史的 v0/v1/v2 编解码路径已全部删除
> （不留兼容层、不留 fallback）。若日后要改算法，元数据第 2 字节是版本号，
> 按需新增 `readMetaV4` 分支即可。

## 🔍 内容审查：先审查 → 再决定混不混

**流程铁律（色情与非色情走同一条路，顺序不可颠倒）：**

```
图片进输入框
  → 算感知指纹
  → 审查打分（本地启发式 / 远端 API）
  → 得出结论：混淆 or 原图
  → 角标显示真实结论（「审查 0.82 · 混淆」/「审查 0.13 · 原图」）
  → 用户可点右上角按钮手动推翻 → 角标变「手动 · 混淆 / 手动 · 原图」
  → 上传时 hook 只是【执行】这个已定的结论
```

**绝不允许「先混淆 → 再审查 → 再取消」**：那样白跑一遍编码，而且角标会说谎。
判定统一在 `review.js` 的 `resolveAction()` 里做，预览端与上传端共用同一个函数。
只有结论为「混淆」时才会调 `encodeImage`——这条有专门的单测断言（见下）。

粘贴/拖拽后秒发、预览来不及审查的情况，`obfuscateBytes` 会**现场补审**（`source` 带 `/inline`），
顺序仍然是先审查后编码。

**默认开启**「只混淆色情图片」（`nsfwOnly: true`，v3.6.8 起）：
所有图过一遍本地检测，只有得分 ≥ 阈值的才混淆，景物与截图原图直通、不影响正常交流。

关掉开关则回到「全部混淆」（此时 `source: always`）。
⚠️ 本地检测是肤色启发式而不是模型，对插画 / 泳装 / 特写会漏判 ——
**漏判的那张会以原图发出去**。要一张不漏就把开关关掉。

三种审查模式（设置页可选）：

| 模式 | 说明 | 隐私 |
|---|---|---|
| `local`（默认） | 本地启发式：肤色面积 + 集中度 + 平滑度加权 | ✅ 零联网、零字节外传 |
| `remote` | 只用远端审查 API | ⚠️ 图片（缩到 512px）会发给第三方 |
| `both` | 两者取高分 | ⚠️ 同上 |

**本地启发式怎么算的**（`src/review.js`）：

1. 单像素肤色判定：Kovac RGB 规则 + YCbCr 区间双重确认
2. 采样到长边约 160px，统计肤色占比 `skinRatio`
3. 8×8 粗网格，找肤色占比 > 45% 格子的最大四连通块 → `concentration`（成片程度）
4. 肤色区局部梯度 → `smoothness`（裸露皮肤大而平滑；花衣服/文字梯度高）
5. 加权：`面积×0.62 + 集中度×0.26 + 面积×平滑×0.12`

⚠️ **诚实声明**：这是启发式，不是分类模型。它能拦住大面积裸露，
但**暖色渐变插画、泳装、大特写会误判为高分**。要认真做只能上模型。
设置页有「本地审查自测」按钮可以直接看 5 类典型图的打分。

**远端 API 适配层**（`src/background.js` 的 `NSFW_ADAPTERS`）：

- `sightengine` — 表单 POST，读 `nudity.{sexual_activity, sexual_display, erotica}`
- `generic` — POST JSON `{image: "<base64>"}`，从 `nsfw_score/score/porn/labels[]` 里找分数

远端请求走**后台 Service Worker**（页面主世界发跨域请求会被 Discord 的 CSP 拦死），
域名权限走 `optional_host_permissions`，保存设置时才按需申请。

**失败策略**：审查超时、报错、拿不到分数 → **保守处理，仍然混淆**。

## ❌ 单图取消混淆是怎么匹配的

难点：hook 拦的是最终 PUT 的字节，此时 Discord 已经把图重压成 webp，
**拿不到 File 名字，字节哈希也必然对不上**。

方案：`perceptualTag()` —— 尺寸 + 4×4 网格平均亮度量化到 4 bit。
比较时用 `tagMatches()` 做容差匹配（16 个桶累计差 ≤ 6），因为有损重压会让个别桶 ±1。
尺寸不同直接判定为不同图，撞车率极低。

## 📦 安装

### 方式一：下载打包好的版本（推荐）

从 [Releases](https://github.com/ztztfdsf/dis-Plus-max/releases) 下载对应浏览器的 zip，解压后按下面「加载到浏览器」操作：

| 文件 | 用于 |
|---|---|
| `moeguard-chrome-<版本>.zip` | Chrome |
| `moeguard-edge-<版本>.zip` | Edge |
| `moeguard-firefox-<版本>.zip` | Firefox |

### 方式二：自己构建

需要 Node.js（任意近期版本均可，零依赖，不用 npm install）：

```bash
git clone https://github.com/ztztfdsf/dis-Plus-max.git
cd dis-Plus-max
node build.js              # 产出全部三个包到 dist/
node build.js firefox      # 只构建一个
```

**构建是可复现的** —— zip 内时间戳固定，同一份源码永远产出相同字节。
你可以自己 build 一遍比对 sha256，确认下载到的包没被人塞过东西。

### 加载到浏览器

**Chrome**
1. 打开 `chrome://extensions`
2. 开启右上角「开发者模式」
3. 「加载已解压的扩展程序」→ 选 `dist/chrome/`（或解压后的 zip 目录）
4. **刷新 Discord 页面**（必须刷新）

**Edge**
1. 打开 `edge://extensions`
2. 开启左下角「开发人员模式」
3. 「加载解压缩的扩展」→ 选 `dist/edge/`
4. 刷新 Discord 页面

**Firefox**
1. 打开 `about:debugging#/runtime/this-firefox`
2. 「临时载入附加组件」→ 选 `dist/firefox/manifest.json`
3. 刷新 Discord 页面

> ⚠️ Firefox 的「临时载入」重启浏览器后会失效。要长期使用需签名后安装
> （`about:config` 里把 `xpinstall.signatures.required` 设为 `false` 只在
> Developer Edition / Nightly 有效，正式版无法关闭签名校验）。

**最低版本**：Chrome / Edge 111+ · Firefox 128+

### 🤝 跟朋友一起用

开箱即用，**不需要任何配置**——无密钥、无账号、无服务器。装了就能互相看到原图。

- 你发的混淆图，对方**装了插件才能看到原图**；没装的只看到分形花纹
- 两边的**盐值必须一致**（默认都留空 = 全员互通）。想做小圈子隔离就约定一个盐值一起填
- 表情 / 贴纸解锁是**各自生效**的，与对方装不装无关（发出去的就是普通图片链接，任何人都能看到）

顶层那段风险告知已经把 ToS 原文引用与实际执法情况都写清楚了，转发给别人时一并发过去。

三浏览器的差异全部由 `build.js` 处理，源码不分叉（依据 MDN browser-compat-data 实测确认）：

| 特性 | Chrome | Firefox | 处理方式 |
|---|---|---|---|
| `background.service_worker` | 88+ | ❌ 不支持 | Firefox 包换成 `background.scripts`（非持久 event page） |
| `content_scripts.world: "MAIN"` | 111+ | 128+ | 都支持，无需改动 |
| `optional_host_permissions` | 102+ | 128+ | 都支持，无需改动 |
| `CompressionStream` | 80+ | 113+ | 都支持，无需改动 |
| `storage.session` | 102+ | 115+ | 都支持，无需改动 |
| `minimum_chrome_version` | ✅ | 无此键 | Firefox 包移除，换 `browser_specific_settings.gecko` |
| 读页面创建的 `blob:` URL | ✅ 隔离世界可直接 fetch | ❌ principal 不同，读不了 | 代码内三级降级（见下） |

### 🦊 Firefox 上预览卡 UI 丢失的真因

Discord 的上传预览卡是 `<img src="blob:https://discord.com/…">`，这个 blob 归**页面**的 principal。
Chrome 的隔离世界能直接 `fetch` 它，Firefox 不行 —— 内容脚本与页面是不同 principal，
读页面的 blob URL 直接失败（同族问题见 [Mozilla bug 1696174](https://bugzilla.mozilla.org/show_bug.cgi?id=1696174)）。
结果是 `preparePreview()` 抛异常 → 分数角标与 ✕/○ 开关**全部不出现**，看起来就像插件没装上。

修法是三级降级取字节：

1. **直接 fetch** —— Chromium 走这条，最快，拿到的是原 File 字节
2. **canvas 重绘** —— 图已经渲染在页面里了，直接从 `<img>` 画到 canvas 取像素。
   不发请求，所以不受 principal 限制 → **Firefox 的主力路径**
3. **主世界代取** —— 让 `hook.js`（MAIN world，与页面同 principal）fetch 后回传 base64

⚠️ 走 canvas 路径时**不算内容键**：canvas 重绘得到的是重编码 PNG，字节与原 File 不同，
算出来的键是假的，会让 hook 端永远对不上。宁可不算，回落感知指纹
（指纹从像素算，canvas 重绘不改像素，照样准）。

三条路全失败时也要**把 UI 挂上去**（降级模式，角标显示「默认·混」）——
旧版的 catch 只记了日志就结束，用户看到的就是「插件没反应」。

### 🦊 Firefox 上无法解码的真因（跟上面是两回事）

诊断面板原话：

```
dec:CanvasRenderingContext2D.putImageData:
Failed to extract Uint8ClampedArray from ImageData (security check failed?)
```

隔离世界跑在自己的沙箱 **realm**，页面的 DOM 对象透过 Xray 包装可见。
结论是用临时扩展在 **Firefox 152 真机逐步探针** 跑出来的，不是推测：

**坑一：沙箱字节 → 页面 realm API（写方向）全部被拒**

| 写法 | 结果 |
|------|------|
| `ctx.createImageData(w,h).data.set(沙箱数组)` | ❌ `Permission denied to access object` |
| `new ImageData(沙箱数组,w,h)` → `putImageData` | ❌ `Failed to extract Uint8ClampedArray…` |
| `compressionWriter.write(沙箱数组)` | ❌ `TypeError: Value could not be converted to any of: ArrayBufferView, ArrayBuffer.` |
| `沙箱数组.set(xray 的 imageData.data)`（读方向） | ✅ 可以 |

拒收点不是“谁造的 ImageData”，而是“**字节属于哪个 realm**”。
所以 v3.6.3 只把 `new ImageData` 换成 `ctx.createImageData` 是无效的 ——
报错只是从 `putImageData` 前移到 `.data.set()`，而那句包了 try/catch，
失败后又退回 `new ImageData` 路 → 报同一句话。

修法：

- **PNG 编码器**（`encodePngFast`）不再用 `writer.write(u8)`，改成
  `new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))`。
  Blob 构造器在建对象时就把字节**拷**进自己的存储（BlobPart 转换不走
  ArrayBufferView 联合类型，所以沙箱数组照收），之后的流已经是页面 realm 的
  合法输入，全程不再碰边界。
- **canvas 输出路**（`imageDataToCanvas`）先 `cloneInto(u8, window.wrappedJSObject)`
  把字节结构化克隆到页面 realm，再 `ctx.createImageData().data.set()`。
  主世界 / Chrome 没有 `wrappedJSObject`，这一步自动退化为原样返回，零开销。

**坑二（更阴）：Blob 拿出来的字节看着正常，但 `subarray` 一碰就炸**

```js
const u8 = new Uint8Array(await blob.arrayBuffer());
u8.length / u8[i] / for 循环求和    → 全部正常
u8.subarray(a, b)                  → ❌ Permission denied to access property "constructor"
new TextDecoder().decode(u8.sub…)  → ❌ 同上
```

TypedArray 派生要读 `@@species` 构造器，跨 realm 不给访问。
`Response` / `FileReader` / `ab.slice(0)` 拿到的 buffer 同样中招；
干净的只有 `u8.set(跨realm视图)`、`Uint8Array.from`、`structuredClone`、`blob.stream()`。

后果：core.js 的 PNG chunk 读写全靠 `subarray` + `TextDecoder`，而调用点全是 try/catch
→ **moEg / moMt 静默丢失**。像素往返 PIXEL-PERFECT，但混淆图发出去对方
预筛读不到标记 → 根本不触发解码，表现就是“插件没反应”。

修法：新增 `FMT.blobToBytes(blob)`，所有从 Blob / fetch 取 PNG 字节的地方全走它，
里面就一句 `out.set(src)` 把字节拷成本 realm 自有。

**编码器现在是三级回落**，每级失败原因拼进 `FMT.lastFastPngErr`，
实际走的路记进 `FMT.lastPngPath`，弹窗诊断面板直接显示：

1. `encodePngFast` —— CompressionStream，走 Blob 输入
2. `canvas.toBlob` —— 压缩率高但极慢（1.8MP 约 1s），需 cloneInto 过桥
3. `encodePngStore` —— 纯 JS 不压缩，零浏览器 API，**一定能出结果**

旧版只有前两级且 `encodePngFast` 失败时**静默**回落，真正的首发异常被吞掉，
只能看到下游 `putImageData` 报错 —— 这就是之前误判成“`new Response(stream)`
在隔离世界不行”的原因（探针实测：`new Response(blob.stream().pipeThrough(cs))`
在隔离世界完全正常，之前报 AbortError 是因为上游 `writer.write` 已经把流 abort 了）。

**Firefox 152 真机端到端实测**（临时扩展加载 `dist/firefox/` 里的 core.js + format.js）：

```
crossRealm : true                      ← 确认跑在需要过桥的沙箱里
 encode    : ok 536x536 9ms
 encodedToBlob : ok size=211680 14ms path=fast
 prefilter : moEg ok saltOk=true 340x260
 metaChunks: ok n=1 same=true
 metaChunksRawView : MISS  ← 不拷贝的视图确实读不出 (对照组)
 roundtrip : PIXEL-PERFECT
 decodedToBlob : ok path=fast
 decodedMeta   : tEXt n=1 same=true
 imgTag    : loaded 340x260
 perf1536  : encode=29ms png=42ms decode=30ms 0.45MB → PIXEL-PERFECT
```

`background.js` 本身没用到 `importScripts` / `clients` / `caches` 等 Service Worker 专属 API，
所以换成 event page 声明后代码零改动即可运行。

### 🦊 Firefox 上图片链接发不出去的真因（表情 / 贴纸解锁）

表情与贴纸解锁靠往输入框插一段 CDN 图链接。旧版靠伪造 `paste`：

```js
const dt = new DataTransfer();
dt.setData('text/plain', url);
input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, … }));
```

探针实测（Firefox 152）：页面端读到 `e.clipboardData.types === ""`——**空的**。
关键在于让【页面 realm 自己】造也一样是空：
**Gecko 的 `ClipboardEvent` 构造器不实现 `clipboardData` 这个 init 成员**
（Chrome 实现了，所以旧写法只在 Chrome 能跑）。
Slate 拿到空剪贴板 → 内部 model 不更新 → 发送时读 model → 空。
所以这不是跟“回复模式”有关，而是 Firefox 上一直都插不进去。

修法是四条通道依次试，**每次都核对编辑器内容真的变了才算成功**
（`dispatchEvent` 永远不报错，不能拿它当成功信号）：

1. `paste` —— 造完事件再 `Object.defineProperty` 盖 `clipboardData`；
   `DataTransfer` 必须用**页面 realm** 的构造器（沙箱造的盖上去依旧 `types=""`），
   且 init 字典要 `cloneInto`（直接传沙箱对象 → `Permission denied to access property "bubbles"`）
2. `beforeinput` + `dataTransfer`（insertFromPaste）
3. `beforeinput` + `data`（insertText）
4. `execCommand('insertText')` —— 只改 DOM 不改 model，兵库

另外 `composerEl()` 改成**只挑可见的那个**：回复 / 子区场景下页面里同时存在
多个 `[contenteditable][role=textbox]`（含已隐藏的残留节点），拿错了就插到看不见的那个里。

真机仿真页实测（带隐藏 textbox + combobox 搜索框的 Slate 仿真）：

```
picked      : realComposer   ← 没挑错
 insert1    : ret=true used=paste
 insertedOnce: EXACTLY-ONCE  ← 没插两遍
 bothPresent : BOTH-OK       ← 连插表情+贴纸不丢
 withComboboxFocused: still-real-composer
```

### 🏷 带回复的消息归属判反

切另一个账号看别人发的混淆图，徒标写「已混淆」而不是「已解析」。
拓下来的真实 DOM 顺序：

```
div.message__…hasReply_
  └ div.repliedMessage_ → img.replyAvatar_   ← 被回复者, 先出现!
  └ div.contents_       → img.avatar_        ← 真作者
```

旧写法 `anchor.querySelector('img[src*="/avatars/"]')` 命中第一个 = 被回复者。
样本统计：8 条带回复的消息，8 条第一个头像都是 `replyAvatar`，
其中 1 条被回复者正好是自己 → 就是看到的那条。

现在两道保险：

- **React fiber 优先**：直读 `message.author.id`（合并组没头像也能判）。
  ⚠️ Firefox 隔离世界**看不到** DOM 节点上的 React expando——
  `Object.keys(node)` 里没有 `__reactFiber$…`（探针实测 NONE），
  必须走 `node.wrappedJSObject` 穿透才读得到
- **DOM 回落**：只在 `contents_` 容器内找，且 `:not([class*="replyAvatar"])`

### 💡 toast 文案不再自相矛盾

上传原图时旧版会弹「已混淆上传 · 原图 · 123KB」——因为无论换没换体都拼
`'已混淆上传 · ' + info`，而 `info` 里的 label 在直通时是“原图”。
现在 hook 端把 `obf` 布尔一起发过来，直通显示「原图直传」；
后台统计也分开记（直通计入 `uploadsPass` 而不是 `uploadsReplaced`）。

### 🏷 角标与下载按钮叠在一起

实页诊断抓到的直接证据：`err="tag:av is not defined"`，**74 次**。

两个元素各自 `position:absolute` 到消息左侧的头像槽，靠头像排上下：

```js
const top = av ? (av.offsetTop + av.offsetHeight + 4) : 2;   // ← av 已经不存在了
tag.style.top = top;  dl.style.top = top + 20;
```

归属判定重构（上一节）删掉了 `av` 这个局部变量，这行就成了 `ReferenceError`。
偏偏它在两个元素**已经 append 进 DOM 之后**才执行，又被函数外层的 `try/catch`
吞掉 —— 控制台一片安静，`top` 永远没写上：两个 absolute 元素只剩 `left:16px`
和 `top:auto`，一起塌到同一个静态位置。

**位置本身是对的**：徽标就该在**图片外面**的头像槽里。
用 CDP 在 Chrome 上量的真实坐标（v3.6.4，`av` 当时还在）：

```
消息容器  1126×419
角标      (16, 48)  40×16     ← 头像下方
下载      (16, 68)  30×16     ← 再下一行
图片      (72, 26)  522×348   ← 从 x=72 开始, 角标完全在图外
头像      offsetTop=4  h=40   → 4+40+4 = 48 ✓
```

所以修法是**位置不动**，只把“排上下”从手算改成浏览器排：

- 两个 chip 装进**同一个** flex 列（`.moe-msg-bar`，`flex-direction:column`），
  行距交给 `gap` —— 只需算一个 `top`，结构上不可能再重叠
- `top` 仍取头像下方，但头像用现成的 `authorAvatar()` 拿（已排掉 `replyAvatar`），
  且用 `getBoundingClientRect()` 差而不是 `offsetTop` —— `offsetParent` 不一定是 anchor
- 宽度卡在头像槽内（`图左边缘 − 16 − 2`）：不卡的话多张图时「已解析 8」算出来
  60px，超过槽宽 54px 就会盖到图上（已加断言）
- 合并组的后续消息没头像 → 贴顶 `top:2`，仍在图外
- 条本身 `pointer-events:none` 不挡消息，只有下载按钮 `pointer-events:auto`

下载按钮取锚也跟着改了：包进 `bar` 后 `parentElement` 是那个条而不是消息，
必须 `closest('[data-moe-tagged="1"]')` 才拿得到消息容器。

为防同类回归，加了 `tests/lint-scope.mjs`（eslint `no-undef`）。
这种错文本搜索发现不了 —— 同名变量在别的函数里仍有声明。

### 🔓 「解锁了的表情」插不出链接：自己把锁信号擦了

实页诊断（点本服动图表情，需 Nitro，必然是锁的）：

```
ariaDisabled : null     ← 锁信号不在了
hasLockIcon  : false
insertStamp  : null     ← 我们的插入通道根本没跑
输入框只多了 12 个字符   ← CDN 链接 60+ 字符, 那是 Discord 自己插的 :name:
```

`emojiLocked()` 最主要的锁信号就是 `aria-disabled`，而 `unlockEmoji()`
每 1.2s + 每次 DOM 变动都会 `removeAttribute('aria-disabled')`（为了去灰、恢复可点）。
面板一渲染标记就被自己擦掉，等点下去时三条检查全落空 → 我们不接管 →
Discord 原生插入 `:name:` 文本形式 → 外部/动图表情服务端不解析 → 对方只看到字面文本。

**这跟 Firefox 无关**（上一节的 realm 修复是对的，只是这条路根本没走到）。

修法是把顺序倒过来：**固化在前、擦除在后**。先把锁信号连同表情 id 写进
`data-moe-lock`，再摘 `aria-disabled`；判定时优先读这个标记。
存 id 而不是布尔，是因为表情面板是虚拟滚动，React 会把同一个 `button` 节点
复用给别的表情 —— 只存 `'1'` 的话滚一下就会把没锁的表情也当成锁的，
本可原生发的反而被换成链接（反向 bug）。

诊断面板同时加了 `data-hijack`（`take` / `free` / `no-id` / `lottie`），
下次一眼就能看出到底有没有接管，不用再从 `insertStamp` 是空倒推。

## 🔬 技术实现（踩坑记录）

**Discord 2026 的上传管线**（抓包实证）：
```
用户选图 → wasm Worker 重压缩成 webp (152KB PNG → 10.5KB webp)
        → XMLHttpRequest PUT 到 discord-attachments-uploads-prd.storage.googleapis.com
```
所以在 `File` / `Blob` / `FileReader` / `createImageBitmap` / `Worker.postMessage`
上装钩子**全部命中 0 次** —— 管线根本不经过它们。

**最终方案**：拦 `XMLHttpRequest.prototype.send`，URL 命中上传地址 + 字节头嗅探出图片
→ 解码像素 → 分块混淆 → 换成 PNG 发出。

**曾经踩过的坑**：
- ❌ `chrome.debugger` + CDP Fetch 域拦截：MV3 的 Service Worker 空闲 ~30s 被杀，
  被暂停的请求永远收不到 `continueRequest` → **上传永久卡在 0%**
- ❌ 改写声明的 `file_size` 并等待编码完成：实测 Discord **不校验**声明与实传大小
  （声明 123B / 实传 77B → 200 OK），纯属自找死锁
- ❌ 解码端用 `article` 选择器：2026 Discord 消息列表是 `[data-list-id="chat-messages"] > li`
- ❌ 直接解 `media.discordapp.net` 的图：那是 webp 重编码版，必须换成 `cdn.discordapp.com` 原始 URL

## 🧪 测试

```bash
node tests/core.test.js        # 64 项单测 (v3 无损往返/定位框/审查/指纹/流程顺序/元数据/跳 realm/表情贴纸/徽标布局)
node tests/lint-scope.mjs      # 作用域检查 (拓 try/catch 里被吞掉的 ReferenceError)
node tests/make-icons.js       # 生成扩展图标
node tests/make-test-image.js  # 生成测试图
node tests/verify-cdn.js <channelId>   # 拉真实 Discord CDN 验证像素一致性
node build.js                  # 打三个浏览器的包
```

> `lint-scope.mjs` 存在的理由：v3.6.5 的角标重叠 bug 是重构删了变量声明、
> 引用还留着造成的 `ReferenceError`。它在元素已插入 DOM 之后才抛，又被外层
> `try/catch` 吞掉 → 控制台干干净净，页面上只是“位置不对”。而同名变量在别的
> 函数里仍有声明，文本搜索也发现不了，必须真做作用域分析。

**实测结果**：
| 项目 | 结果 |
|---|---|
| 单测 (64 项) | ✅ 全通过，1MP 变换 16ms / 8ms；含元数据往返、流程顺序与跳 realm 硬验证 |
| 上传链路提速 | ✅ 1201ms → 157ms（7.7x），体积 2.49MB → 0.85MB（浏览器实测） |
| 定位框识别 | ✅ 混淆图命中、普通图不误报、缩到 50% 仍能识别 |
| 审查判定 | ✅ 裸露高分 / 风景·UI·花衣服低分 / 远端失败回落本地 / 异常保守混淆 |
| ✕ 指纹 | ✅ 抗 ±8 像素抖动，不同图与不同尺寸不误匹配 |
| 流程顺序 | ✅ 直通的图 encodeImage 调用次数 = 0（突变测试验证过会真的报错）|
| XHR 拦截仿真 | ✅ 5440B(webp) → 93412B(png)，服务器实收混淆图 |
| 自动解码仿真 | ✅ 喵图自动还原 + 角标；普通图不受影响 |
| **真实 Discord 全链路** | ✅ CDN 字节 = 混淆图（640×416，标记✓），解码后与原图 **diff=0** |

## 🗂 文件结构

```
moe-image-guard/
├── manifest.json          MV3 清单 (Chrome 基准, build.js 按目标改写)
├── build.js               打包脚本: 一份源码 → chrome / edge / firefox 三个包
├── CHANGELOG.md           更新日志 (按浏览器分段)
├── src/
│   ├── core.js            v3 混淆引擎 + 快速 PNG 编码器 + moEg/moMt 块 + 感知指纹 (纯逻辑)
│   ├── review.js          审查层: 启发式打分 + resolveAction 统一判定 (纯逻辑)
│   ├── format.js          Blob↔ImageData↔PNG 工具 + 跳 realm 桥
│   ├── hook.js            主世界: XHR/fetch 上传拦截 (先审查后编码)
│   ├── content.js         隔离世界: 预览审查定结论/预筛/自动解码/角标/右键弹窗/表情贴纸解锁
│   ├── background.js      后台: 右键菜单/跨域抓图/下载/遥测/NSFW API 代发
│   ├── options.html/js    设置页 (算法自测 + 本地审查自测)
│   └── popup.html/js      弹窗 (开关 + 调试面板)
├── tests/
│   ├── core.test.js       64 项单测 (带反面断言: 先证明旧代码真的会坏)
│   ├── lint-scope.mjs     作用域检查 (抓 try/catch 里被吞掉的 ReferenceError)
│   └── …                  PNG 编解码器 + CDN 验证脚本
├── testdata/              测试图 / 混淆图 / 解码输出
└── dist/                  构建产物 (git 忽略)
```

零运行时依赖 —— 不装 npm 包，`build.js` 的 zip 写入器也是手写的。

## 📌 使用提示

- 对方**装了插件**才能看到原图；没装的看到分形花纹
- 右键任意图片 →「🔓 解码此图片」可手动还原（跳过预筛，强制尝试）
- 默认**只混淆色情图片**（启发式检测会漏判）；想要一张不漏 → 弹窗或设置页**关掉**「🔍 只混淆色情图片」= 全部混淆
- 单张不想混淆 → 预览图**右上角 ✕**（变成 ○ 就是原图发送，再点可恢复）
- 改了盐值/块大小后，弹窗点开关或刷新页面即生效
- 动画 GIF/WebP 默认原样发送（动画无法无损混淆）
- 弹窗底部有两个调试面板：
  - 绿色 = 后台遥测（跟踪文件 / 已编码 / 上传拦获 / 已替换 / 审查结果 / 最近异常）
  - 粉色 = 页面脚本诊断（版本 / 扫描到几张图 / 各图状态 / 配置 / 最近解码结果）

## 🐞 诊断踩坑（v1.8 → v2.0）

排查「自己看不到原图」时踩到的两个坑，**以后不要再犯**：

- ❌ 把诊断标记写到 `<html>` 的 `data-*` 属性上 → Discord 用 react-helmet 接管
  `<html>`/`<head>` 属性，会把外来 `data-*` 全部抹掉，看起来像「脚本没跑」
- ❌ 改成写 `localStorage` → Discord **删除了 `window.localStorage`**（防盗 token），
  主世界 `localStorage is not defined`

✅ 正确做法：写到自己新建的隐藏 `<div id="__moe_diag">` 的 `data-*` 上（React 根之外，
不会被调和掉），并通过 `chrome.tabs.sendMessage({action:'moe-diag'})` 读回弹窗展示。

实际上 v1.7/v1.8 的自动解码**一直是正常工作的**（`scanStates` 显示 `decoded:1`），
只是诊断手段本身失效导致误判。