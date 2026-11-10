# 🌸 MoeGuard 油猴版（dis-Plus-max 移植）

把 [`ztztfdsf/dis-Plus-max`](https://github.com/ztztfdsf/dis-Plus-max) 这个 **Discord 浏览器扩展** 原样移植成**单文件油猴脚本**。
算法（MOE v3 流光照影）、审查层、解码管线、UI 全部沿用上游源码，**内核零改写**。

- 产物：`dist/moeguard.user.js`（约 259 KB，单文件，无外部依赖）
- 上游基线：v3.7.11

---

## 安装

1. 装 Tampermonkey（Chrome / Edge / Firefox）
2. 新建脚本 → 全选删掉 → 粘贴 `dist/moeguard.user.js` 全文 → 保存
   （或把 `.user.js` 直接拖进浏览器窗口）
3. **刷新 Discord 页面**（必须）
4. 入口：
   - `Alt + M` 打开面板（弹窗 / 设置两个页签）
   - 或点 Tampermonkey 图标 →「🌸 MoeGuard 面板」
5. 第一次连远端审查 API / 下载图片时，Tampermonkey 会弹跨域授权（`@connect`），允许即可

> ⚠️ 必须跑在**主世界**（metadata 里钉了 `@sandbox raw` + `@inject-into page`）。
> 万一被浏览器强制丢进沙箱：自动解码照常工作，但**上传不会混淆**（图片原样发出去）。
> 诊断：控制台会打印 `[MoeGuard] 脚本没跑在主世界…`；`window.__moeWorld` 应为 `'page'`。

---

## 和扩展版的差异

| 能力 | 扩展版 | 油猴版 |
|---|---|---|
| 上传自动混淆（XHR 挂起 + 按发送换体） | ✅ | ✅ 一致 |
| 自动解码消息里的喵图 | ✅ | ✅ 一致 |
| 预览角标 / ✕○ 单图推翻 | ✅ | ✅ 一致 |
| 本地启发式审查 / 远端 API 审查 | ✅ | ✅ 一致（远端改走 `GM_xmlhttpRequest`） |
| 表情 / 贴纸解锁、移除举报入口 | ✅ | ✅ 一致 |
| 群组盐值、块大小、ComfyUI 元数据保留 | ✅ | ✅ 一致 |
| 设置页 / 弹窗 | 扩展弹窗 + 独立设置页 | **页内浮层**（`Alt+M`），原 HTML/JS 原样搬进去 |
| 右键「解码此图片」 | 原生 contextMenus | **页内菜单**：附件图上右键；`Shift+右键` = Discord 原生菜单 |
| 多文件构建 → 三浏览器 zip | `build.js` | `build-user.js` → 单个 `.user.js` |
| 自动更新 | 扩展商店 / 手动 | 需自行加 `@updateURL` / `@downloadURL` |
| 安卓 GeckoView（`sendNativeMessage` 下载、emoji 字体兜底） | ✅ | ❌ 无（桌面用不到） |
| 动态域名授权 `optional_host_permissions` | ✅ | 改成静态 `@connect`（含 `*`，安装时一次性授权） |

---

## 重新打（上游更新后）

```bash
node build-user.js        # → dist/moeguard.user.js
node dev/run.js           # → 真 Chrome 跑 29 条验收用例
node tests/core.test.js   # → 上游 64 条算法单测（源码没动，必然全绿）
```

版本号只认 `manifest.json`，`build-user.js` 会写进脚本头与诊断面板。

---

## 五模型独立审查结论（2026-11-10）

5 个不同模型的子代理各查一个角度（加载时序 / 上传链路 / 面板 UI / 油猴环境 / 打包器），共 20 条发现，**17 条已修并写了用例钉住**，3 条是上游设计取舍（见文末）。

| # | 来源 | 问题 | 处置 |
|---|---|---|---|
| 1 | 上传 | 预处理期按 Enter，意图被丢弃 → 只能等 45s TTL 才上传 | 补丁① `lastIntentAt` |
| 2 | 上传 | 预处理期删预览/切频道，abort 看不见 item → 幽灵上传 | 补丁② `__moeAbort` |
| 3 | 上传 | 放行期 abort 仍会 `origSend` | 补丁③ 置 sent 前再查 |
| 4 | 上传 | 有 ck 却没精确命中时回退模糊指纹 → 相似 A/B 图串位，A 的「原图直通」套给 B | 补丁④ `pool = item.ck ? [] : decisions` |
| 5 | UI | 两 pane 共享 4 个开关但只读一次 → 在 A 页改完去 B 页保存会把旧值写回 | 切页重读 `__moeReload*` |
| 6 | UI | 两份 HTML 的 `body{}` / `button{}` 混在同一作用域 → 设置页被压成 250px、外壳按钮被 `width:100%` 洗掉 | 按 pane 分别作用域 + `width:auto` |
| 7 | UI | 解成 blob: 的附件图右不出菜单（`data-moe-orig` 没回查） | `attachmentUrlFor` 补回落链 |
| 8 | UI | 面板被 Discord 重渲染移走后重建，新节点没有业务监听器 | 重挂**原节点**（保监听器，不重跑 boot） |
| 9 | UI | `openPanel('settings')` 在 DOM 未就绪时退化成弹窗 | 先记意图再 build |
| 10 | 时序 | 面板在 `documentElement` 不存在时 `appendChild` 抛错 | 延迟到 DOMContentLoaded |
| 11 | 油猴 | 多图下载在 `await` 后合成点击，瞬态激活已失效 → 从第 2 张起被丢 | `data:` → `blob:` → `GM_download` |
| 12 | 油猴 | `GM_setValue` 整包覆盖 ≠ `storage.sync` 按键 merge，双窗口交叉写互相抹掉 | 改按键存储 + 键名索引 |
| 13 | 油猴 | `responseHeaders` 为 null 时 `.split` 抛，Promise 永不结算 | 类型归一 + try/catch |
| 14 | 油猴 | `toU8` 不收二进制字符串 / 跨 realm 裸 ArrayBuffer | 两条兜底 |
| 15 | 油猴 | `Object.defineProperty(window, ...)` 两处没跟着换 PAGE（守卫读 PAGE 写 window） | build 增加替换 + 断言 |
| 16 | 油猴 | Firefox Xray 上 `defineProperty` 抛错会打断整个 IIFE（连解码都不跑） | try/catch 包住 |
| 17 | 油猴 | 面板关着仍每 2s 要一次 `moe-diag`，在 Discord 里白扫 DOM | 不可见时短路 |

**未修（上游设计取舍，不是移植引入）**

1. **编码失败 fail-open**：`encodeImage`/`encodedToBlob` 抛错时仍发原图。改成取消上传会让 Discord 卡在 0% —— 现在的折中是抛错会走 `ev:'error'` → 页面弹 4s 红色 toast「混淆失败」。要彻底关掉这条路只能自己改上游。
2. **fetch 分支不等发送**：`window.fetch` 那条路没有挂起队列（XHR 才是 Discord 2026 的主路径）。若哪天 Discord 改走 fetch，会变成「拖进来就传」。
3. **45s TTL 自动放行**：兜底保险，代价是「图留在草稿里不动，45 秒后仍会上传」。补丁①让正常路径不再需要它，但没拆。

---

## 对上游源码只做了两处补丁（都集中在 `build-user.js` 里，带断言）

1. **`hook.js` 的 4 处 `window` → `PAGE`**
   油猴有可能把脚本放进沙箱，那时 `window` 是沙箱窗口，改它的 `XMLHttpRequest` 不影响页面 →
   上传混淆静默失效。改用 `unsafeWindow`（有就用）保证 patch 打在页面自己的对象上。
2. **`content.js` 取 `raw` 的两处补一条回落 `img.dataset.moeOrig`**
   上游 bug：点「解码本页所有图片」会把 `data-moe-scan*` 一键删掉，而图此时 `src` 已是 `blob:`，
   原始 CDN 地址只剩 `data-moe-orig` 里还有 → 之后每轮扫描算不出 `raw`，直接 `continue` 跳过，
   角标再也回不来。补一条回落即可，重扫后立即恢复。
   （验收用例 `面板「解码本页所有图片」重扫后仍然是 decoded` 就是钉这条的。）

锚点找不到时 `build-user.js` 直接报错退出，**不会静默出一个半残的包**。

---

## 移植时踩到 / 确认过的坑

- **`chrome` 是局部变量**：整包塞进一个 IIFE，里面 `const chrome = 兼容层`，把页面自带的 `window.chrome` 挡在外面。
  core / content / hook / popup / options 因此**一行都不用改**。
- **跨域抓图**：页面世界 `fetch` 跨域受 Discord CSP 约束 → 走 `GM_xmlhttpRequest`（`responseType: 'arraybuffer'`），
  失败才回落 `content.js` 原本的 `fetchDirect`。
- **面板 CSS 必须做作用域**：上游样式里有裸 `button{}` / `input[type=checkbox]{}`，直接注入会把 Discord 自己的按钮洗掉。
  `build-user.js` 给每条规则加 `#moe-panel ` 前缀（`:root`/`html` → `#moe-panel`，`body` → `#moe-panel .moe-pane`），
  验收用例 `面板 CSS 没有污染页面自己的按钮` 钉这条。
- **`<style>` 被 CSP 拦的兜底**：插入后检查 `styleEl.sheet`，为 `null` 就改用 `CSSStyleSheet` + `adoptedStyleSheets`。
- **右键菜单只接管附件图**（`cdn/media.discordapp.*` 的 `/attachments/` 路径）：头像 / 表情 / 贴纸 / 外链图
  一律放行，不干扰 Discord 原生菜单；`Shift+右键` 永远放行。
- **`data-moe-scan` 与面板消息的时序**：页面脚本还没 boot 时发往 `content.js` 的消息会先排队（最多 20 条），
  boot 后自动补投，避免「点了按钮没反应」。

---

## 本地仿真台

`dev/harness.html` + `dev/run.js`：真 Chrome（headless）打开一个仿真 Discord 页面，
GM_* 与 XHR 出口打桩，canvas / PNG / DOM / 解码全是真跑。当前 **29 / 29 通过**：

```
✓ 脚本装载 / 注入世界 = page
✓ Alt+M 面板 / 页签切换 / 表单渲染 / 算法往返测试（✓ 无损往返，像素完全一致）
✓ 面板样式生效且不污染页面；设置页宽度 650px（没被弹窗 body 规则压成 250px）
✓ 外壳按钮没被 pane 的 button{width:100%} 洗掉
✓ 上传挂住（未按发送前零流量）→ Enter → 换体（52.8KB → 64.1KB）
✓ 上传体带 moEg/moMt 标记、解码回 240×180 原尺寸
✓ 消息流自动解码、换成 blob:、重扫后仍收敛
✓ 遥测面板计数、页内右键菜单、Shift 放行、下载走 GM_download
✓ 切页重读（不拿旧值覆盖）、已解码 blob 图仍能右出菜单、开关落盘
✓ 补丁②：预处理期 abort → 零流量
✓ 补丁①：意图早于入队 → 3s 内放行
```

---

## 风险（跟扩展版同源）

Discord ToS 明文禁止修改客户端行为；实际执法上从没因单纯 client mod 封号，
但风险不为零，自己权衡。安全问题、封号后果与被混淆的图能否被逆向，README 上游那份声明的口径在这里同样成立：
「无密钥」意味着读懂本脚本的人一定能还原原图。