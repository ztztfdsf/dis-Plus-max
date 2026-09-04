# 🌸 dis-Plus max（MoeGuard 喵图混淆）

Discord 图片上传自动混淆扩展 —— **只有装了本插件的人才能看到原图**。轻量 · 无损 · **无需密钥** · 自研算法（MOE v3「流光照影」）。

当前版本 **v3.6.1**（测试版）。许可证 GPL-3.0。

---

## ⚠️ 使用前必读（风险告知）

本扩展会 **修改 Discord 客户端行为**：hook XHR 上传、拦截点击事件、注入 DOM 与 CSS。

- **这违反 Discord 服务条款**（其 TOS 禁止使用第三方修改客户端）。理论上存在账号被警告或封禁的风险。
- 它**不会**盗取你的账号：不读 token、不发送凭据、不连接任何作者控制的服务器。源码全开可自行校验。
- 表情 / 贴纸解锁的实现方式是**插入公开 CDN 图片链接**，不伪造身份、不伪造权限、不调用未授权接口。
- 自己权衷后使用。作者不对封号后果负责。

---

## ✨ 功能

| 功能 | 说明 |
|---|---|
| 🛡 上传自动混淆 | 发图时自动打乱成分形纹样，Discord 服务器和没装插件的人看到的都是花纹 |
| 👁 自动解码 | 自己发的、别人发的喵图都自动还原成原图显示，交流无障碍 |
| 🔲 二维码式定位框 | 混淆图外围一圈中性灰阶定位框 + 3 个角眼 → 一眼认出喵图，缩略图也认得，且融入 Discord 默认主题 |
| 🔍 先审查后决定 | 所有图先过一遍检测再决定混不混；本地启发式零联网，也可选接远端 API |
| ❌ 单图推翻结论 | 预览图**右上角按钮**：✕ = 会混淆，○ = 原图发送，点一下切换 |
| 🏷 角标 | 图片**左上角**显示真实结论（审查中… / 审查 0.82 · 混淆 / 手动 · 原图）；消息里「已解码 ✓」|
| 🔓 手动解码 | 右键任意图片 →「解码此图片」：预览 + 下载原图 |
| ⚡ 廉价预筛 | 只读图片前 128 字节判断是不是喵图 → 普通图片/表情/头像完全不受影响 |
| ⚙️ 可开关 | 上传混淆、自动解码、角标独立开关 |
| 🪪 群组盐值 | 留空=全员互通；填写后只有同盐值的人能互解 |
| 🧬 元数据保留 | 混淆图与解码图都完整携带 PNG 文本元数据（**ComfyUI 工作流**/提示词/参数），拖回 ComfyUI 可直接复现 |
| 🚫 移除举报 | 自动清掉 Discord 界面所有「举报/Report」入口（hover 菜单/用户弹窗/工具条） |
| 🏷 头像下标签 | 自己发的图 → 头像下「已混淆」；别人发的已解图 → 「已解析」+ ↓ 下载原图按钮 |
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

默认策略是「全部混淆」（`nsfwOnly: false`，此时 `source: always`），
打开开关后只有得分 ≥ 阈值的图才混淆，普通图原图直通、不影响正常交流。

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

建议转发给别人时把本页顶部的**风险告知**一起发过去。

三浏览器的差异全部由 `build.js` 处理，源码不分叉（依据 MDN browser-compat-data 实测确认）：

| 特性 | Chrome | Firefox | 处理方式 |
|---|---|---|---|
| `background.service_worker` | 88+ | ❌ 不支持 | Firefox 包换成 `background.scripts`（非持久 event page） |
| `content_scripts.world: "MAIN"` | 111+ | 128+ | 都支持，无需改动 |
| `optional_host_permissions` | 102+ | 128+ | 都支持，无需改动 |
| `CompressionStream` | 80+ | 113+ | 都支持，无需改动 |
| `storage.session` | 102+ | 115+ | 都支持，无需改动 |
| `minimum_chrome_version` | ✅ | 无此键 | Firefox 包移除，换 `browser_specific_settings.gecko` |

`background.js` 本身没用到 `importScripts` / `clients` / `caches` 等 Service Worker 专属 API，
所以换成 event page 声明后代码零改动即可运行。

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
node tests/core.test.js        # 50 项单测 (v3 无损往返/定位框/审查/指纹/流程顺序/元数据/表情贴纸)
node tests/make-icons.js       # 生成扩展图标
node tests/make-test-image.js  # 生成测试图
node tests/verify-cdn.js <channelId>   # 拉真实 Discord CDN 验证像素一致性
node build.js                  # 打三个浏览器的包
```

**实测结果**：
| 项目 | 结果 |
|---|---|
| 单测 (50 项) | ✅ 全通过，1MP 变换 16ms / 8ms；含元数据往返与流程顺序硬验证 |
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
├── src/
│   ├── core.js            v3 混淆引擎 + 快速 PNG 编码器 + moEg/moMt 块 + 感知指纹 (纯逻辑)
│   ├── review.js          审查层: 启发式打分 + resolveAction 统一判定 (纯逻辑)
│   ├── format.js          Blob↔ImageData↔PNG 工具
│   ├── hook.js            主世界: XHR/fetch 上传拦截 (先审查后编码)
│   ├── content.js         隔离世界: 预览审查定结论/预筛/自动解码/角标/右键弹窗/表情贴纸解锁
│   ├── background.js      后台: 右键菜单/跨域抓图/下载/遥测/NSFW API 代发
│   ├── options.html/js    设置页 (算法自测 + 本地审查自测)
│   └── popup.html/js      弹窗 (开关 + 调试面板)
├── tests/                 单测 + PNG 编解码器 + CDN 验证脚本
├── testdata/              测试图 / 混淆图 / 解码输出
└── dist/                  构建产物 (git 忽略)
```

零运行时依赖 —— 不装 npm 包，`build.js` 的 zip 写入器也是手写的。

## 📌 使用提示

- 对方**装了插件**才能看到原图；没装的看到分形花纹
- 右键任意图片 →「🔓 解码此图片」可手动还原（跳过预筛，强制尝试）
- 默认**所有图都混淆**；想只混淆色情图 → 弹窗或设置页开「🔍 只混淆色情图片」
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