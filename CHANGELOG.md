# 更新日志

本文件按浏览器分段记录每个版本的改动。
三个包同源同码，只有 manifest 与后台形态不同（Chrome/Edge 用 `service_worker`，
Firefox 用非持久 event page），所以修复往往三端共享，但**触发条件与可见症状不同**。

---

## v3.7.2 — 2026-09-06

### 🤖 新 emoji 不再显示「口」（安卓）

旧安卓的系统 emoji 字体缺 2021 年后的码点（🪪🫠🧬…），Discord 里一片豆腐块。
打包 **Twemoji Mozilla**（Firefox 自带的 emoji 兜底字体，1.4MB）进扩展，
重定义 Discord 的 `:root` 字体变量把 `MoeEmoji` prepend 进字体栈：

- `@font-face` 用 `unicode-range` 限定 emoji 区段 → 普通文本零影响
- 变量层面注入，不盖任何元素的 `font-family` → 代码块等宽不串
- 只在 GeckoView 注入（判定：后台 `platform-probe` 报没有 `contextMenus`），
  桌面端保持系统原生 emoji 观感

---

## v3.7.1 — 2026-09-06

### 🤖 GeckoView 适配（安卓端起步）

给 GeckoView 套壳 App 铺路，三处兼容修补（桌面端行为零变化）：

- **后台脚本判空 `chrome.contextMenus` / `chrome.downloads`**：GeckoView 里这两个
  API 是 undefined，不判空后台脚本加载即崩 → 消息全灭、解码审查全瘫。
- **下载走原生桥**：没有 `downloads` API 时改用 `sendNativeMessage('app', …)`，
  由安卓 App 的 `MessageDelegate` 把 dataURL 写进系统下载目录
  （manifest 新增 `nativeMessaging` 权限）。
- **触屏长按解码**：手机上没有右键菜单 —— 长按附件图 550ms 直接弹解码窗，
  并吞掉随后的 contextmenu 避免系统菜单抢戏。桌面无 touch 事件，天然不生效。

---

## v3.7.0 — 2026-09-06

### 🚀 视窗优先的解码队列（高楼层不解码的根因修复）

滚到楼上时一屏涌入几十张历史附件图，旧版对**所有**附件图同时发起
预筛+全图抓取，没有并发上限 → 代理/连接池瞬间被挤满，每笔都爬到
12s 超时 → 「高楼层之后就不解码了」。

- 离视窗超过两屏的图**不抓**（滚近了下一轮扫描自然轮到）
- 剩下的按**到视窗的距离**排序，视窗里的永远先解
- 全局并发上限 4，超出的留到下一轮（扫描每 1.2s 就跑）
- 诊断 `扫描` 行新增 `far=`（因太远未抓）与 `q=`（在途并发）

视窗判定用 `getBoundingClientRect` + `innerHeight`，扫描本来就在周期性跑，
不需要再养一个 IntersectionObserver。

### 🛠 编辑消息时表情插错框

点表情面板按钮会把焦点从输入框抢走 → `activeElement` 不再是任何 textbox
→ 旧写法按 DOM 顺序挑第一个可见输入框，永远挑中主输入栏。
现在跟踪**最近聚焦过的**输入框（进编辑模式 Discord 会自动聚焦编辑框），
焦点被抢走时插回它；没有聚焦记录时优先不在 channelTextArea 里的那个。

---

## v3.6.9 — 2026-09-06

### 🦊 Firefox（根因修复：解码「突然」完全不动）

实页症状：所有附件图永久 `pending`，扫描 `new=0`，`最近结果: fetch-fail:prefilter`，
弹窗还报喜「已扫描，可解码的喵图已还原 ✓」。

**根因 A：消息通道可能永远不回包。** Firefox 的 event page 在 fetch 途中被挂起/终止时，
`sendMessage` 的回调既不调也不报错。`fetchImg` 没有超时 → `decodeUrl` 的 Promise 永远挂着，
还进了 `cache` → 这张图永久 pending，之后每轮扫描都跳过它。一次卡死，终身不解。
修法：`fetchImg` 自带 12s 超时；后台侧 fetch 也加 20s `AbortController`，不让悬挂的请求
拖死 event page。

**根因 B：真实错误被吞成 `prefilter`。** 预筛把 HTTP 错误 / 网络错误 / 无回包全吞成
`'retry'`，面板上完全看不到根因。现在底层错误原样带进 `最近结果`
（如 `fetch-fail:prefilter:bg:HTTP 403 | direct:…`），并新增 `预筛错误` 诊断字段。

**兜底：后台代抓失败 → 内容脚本直接 fetch。** Firefox 的内容脚本带 host 权限可绕 CORS；
Chrome 上直接抓会被页面 CSP 拦，那时把两条路的错误都报出来。

### 🌐 三端共通

弹窗「扫描全部」按钮不再说谎：以前是点了就报「已还原 ✓」（扫描只是触发，解码是异步的），
现在等一拍读真实状态再报「已解码 X · 排队 Y · 失败 Z」。

---

## v3.6.8 — 2026-09-06

### ⚠️ 行为变更（三端一致）

**「只混淆色情图片」现在默认开启。**

新装用户默认只混淆检测得分 ≥ 0.7 的图，景物与截图原图直通。
四处默认值（`content.js` / `options.js` 的 `DEFAULTS`、`popup.js` 的读取判断）
已统一，并加了单测防止再次跑偏 —— 之前 `popup.js` 用 `v.nsfwOnly === true`
读取，语义是"没存过就算关"，会和默认值互相矛盾。

诚实说清代价：本地检测是**肤色面积 + 集中度 + 平滑度的启发式，不是模型**，
对插画、泳装、特写会漏判，**漏判的那张会以原图发出去**。
想要一张不漏就把这个开关关掉（关 = 全部混淆）。

`hook.js` 主世界那份初值仍保留 `false`，这不是遗漏：真配置要等
`content.js` 通过 `postMessage` 送过来，在那之前万一有图上传，
`false`（全部混淆）才是安全的那一侧。

**老用户不受影响** —— 只要在弹窗里点过任意一个开关，`nsfwOnly` 就已经存进
`chrome.storage.sync`，存过的值优先于默认值。

---

### 🦊 Firefox

三个只在 Firefox 上出现的 bug，全部来自**隔离世界（ISOLATED world）与页面
realm 之间的边界**。Chrome 的 content script 没有这层隔离，所以同一份代码在
Chrome 上一直是好的。

**1. 图片链接发不出去（表情 / 贴纸解锁）**

伪造 `paste` 事件的老写法：

```js
input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt }));
```

Firefox 152 探针实测：页面端读到 `e.clipboardData.types === ""` —— 空的。
让**页面 realm 自己**造也一样空 → 不是跨 realm 问题，而是
**Gecko 的 `ClipboardEvent` 构造器不实现 `clipboardData` 这个 init 成员**
（Chrome 实现了，所以旧写法只在 Chrome 能跑）。
Slate 拿到空剪贴板 → 内部 model 不更新 → 发送时读 model → 发出去是空的。

修法是四条通道依次试，**每次都核对编辑器内容真的变了才算成功**
（`dispatchEvent` 永远不报错，不能拿它当成功信号）：

| 通道 | 说明 |
|---|---|
| `paste` | 造完事件再 `defineProperty` 盖 `clipboardData`；`DataTransfer` 必须用**页面 realm** 的构造器，init 字典要 `cloneInto` |
| `beforeinput` + `dataTransfer` | `insertFromPaste` |
| `beforeinput` + `data` | `insertText` |
| `execCommand` | 只改 DOM 不改 model，兵库 |

另外 `insertIntoComposer` 改成 `async` + 等一拍（40ms）再比对内容 ——
同步比对会看到"没变"，于是继续试下一条通道，结果插两遍。

**2. 无法解码：`putImageData: Failed to extract Uint8ClampedArray`**

沙箱里造的 TypedArray 永远写不进页面 realm 的 WebIDL API。
v3.6.3 只把 `new ImageData` 换成 `ctx.createImageData` 是无效的 ——
拒收点在 `.data.set()` 那一步。现在 `cloneInto` 到页面 realm 再 `set`。

`encodePngFast` 也改成走 `new Blob([...]).stream()`：
`BlobPart` 转换绕开了 realm 检查，比 `writer.write(u8)` 可靠。

**3. moEg / moMt 元数据块静默丢失**

`new Uint8Array(await blob.arrayBuffer())` 造出来的视图，
在 `.subarray()` / `TextDecoder.decode()` 上会抛
`Permission denied to access property "constructor"`。
异常被吞掉 → 标记块与工作流元数据无声消失。
现在统一走 `FMT.blobToBytes()`，一次 `out.set(src)` 拷进本 realm。

PNG 编码同时改成三级回落（fast → canvas → store），
所有失败原因累积到 `lastFastPngErr`，不再静默吞掉首发异常。

---

### 🌐 Chrome

**1. 角标与「下载」按钮叠在一起**

实页诊断抓到直接证据：`err="tag:av is not defined"`，**74 次**。

```js
const top = av ? (av.offsetTop + av.offsetHeight + 4) : 2;   // ← av 已经不存在
```

归属判定重构删掉了 `av` 这个局部变量，这行成了 `ReferenceError`。
它在两个元素**已经 append 进 DOM 之后**才执行，又被函数外层 `try/catch`
吞掉 —— 控制台一片安静，`top` 永远没写上，两个 absolute 元素
`top:auto` 一起塌到同一处。

**位置本身是对的**：徽标就该在**图片外面**的头像槽里。
用 CDP 量的真实坐标：消息 1126×419 / 角标 (16,48) / 下载 (16,68) / 图 (72,26)。
所以修法是位置不动，只把"排上下"从手算换成浏览器排 —— 两个 chip 装进同一个
flex 列，行距交给 `gap`，只需算一个 `top`，结构上不可能再重叠。

宽度另外卡在头像槽内（`图左边缘 − 16 − 2`）：不卡的话多张图时
「已解析 8」算出来 60px，超过槽宽 54px 就会盖到图上。

**2. 「解锁了的表情」插不出链接，对方只看到 `:name:` 文本**

`unlockEmoji()` 每 1.2s 都在 `removeAttribute('aria-disabled')`（为了去灰、
恢复可点），而 `aria-disabled` 正是锁判定的主信号 —— **自己把证据擦了**。
面板一渲染标记就没了，等点下去时三条检查全落空 → 不接管 →
Discord 原生插 `:name:` 文本 → 外部/动图表情服务端不解析。

实页证据：点本服动图表情（需 Nitro，必然是锁的）时
`ariaDisabled=null`、`hasLockIcon=false`、`insertStamp=null`（我们的插入根本
没跑）、输入框只多了 12 个字符（CDN 链接是 60+ 字符）。

改成**固化在前、擦除在后**：先把锁信号连同表情 id 写进 `data-moe-lock`
再摘 `aria-disabled`。存 id 而不是布尔，因为表情面板是虚拟滚动，
React 会把同一个 `button` 节点复用给别的表情 —— 只存 `'1'` 滚一下就会把
没锁的表情也当成锁的，本可原生发的反而被换成链接（反向 bug，已加断言）。

**3. 别人发的图标成「已混淆」**

带回复的消息 DOM 顺序：

```
div.message__…hasReply_
  └ div.repliedMessage_ → img.replyAvatar_   ← 被回复者, 先出现!
  └ div.contents_       → img.avatar_        ← 真作者
```

旧写法 `querySelector('img[src*="/avatars/"]')` 命中第一个 = 被回复者。
样本统计：8 条带回复的消息，8 条第一个头像都是 `replyAvatar`。

现在两道保险：React fiber 直读 `message.author.id`（合并组没头像也能判），
DOM 回落时限定在 `contents_` 容器内且 `:not([class*="replyAvatar"])`。

**4. toast 说「已混淆上传 · 原图」**

无论换没换体都拼 `'已混淆上传 · ' + info`，而 `info` 里的 label
在直通时是"原图"。现在 hook 端把 `obf` 布尔一起发过来，
直通显示「原图直传」，后台统计也分开记（`uploadsPass` / `uploadsReplaced`）。

---

### 🔷 Edge

Edge 是 Chromium，与 Chrome **完全同一份产物**（v3.6.7 实测两个 zip 的
sha256 逐字节相同），所以上面 Chrome 段的四个修复在 Edge 上一字不差地适用。

独立出一个包只是因为 Edge Add-ons 要单独提交。
本版在临时独立 profile 的 Edge 141 上实测通过。

---

### 🧰 三端共通：工程改进

**版本号不再手写。** `popup.html`、`background.js`、`content.js` 三处各自
硬编码过版本号，结果全停在 3.6.3 而 manifest 已到 3.6.7 —— 而这恰好是实页
排障时最需要可信的一个数。现在三处都读 `chrome.runtime.getManifest().version`，
并且 `build.js` 会扫描打包内容，**发现与 manifest 不一致的版本号字面量就中断构建**
（`core.js` 的 `VERSION = '3.0.0'` 是图片格式版本，标 `// not-ext-version` 豁免）。

**新增 `tests/lint-scope.mjs`（eslint `no-undef`）。**
角标那个 bug 文本搜索发现不了 —— 同名变量 `av` 在别的函数里仍有声明，
必须真做作用域分析。这类错在 `try/catch` 里会被静默吞掉，
是最难靠肉眼发现的一类。

**单测 53 → 64 项。** 新增用例都带反面断言，先证明旧代码真的会坏，
再证明新代码修对了。

**诊断面板加了两个字段**：`data-badge`（角标定位走的哪条路）、
`data-hijack`（表情点击到底有没有被接管：`take` / `free` / `no-id` / `lottie`）。

---

## v3.6.3 — 2026-09-05

修 Firefox 无法解码（跨 realm ImageData）。
**这个修复是错的** —— 只把 `new ImageData` 换成 `ctx.createImageData`，
而真正的拒收点在 `.data.set()`。v3.6.8 才真正修好。

## v3.6.2

修 Firefox 预览卡 UI 丢失。

## v3.6.1

首个公开版本。
