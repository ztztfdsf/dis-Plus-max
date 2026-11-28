# 更新日志

本文件按浏览器分段记录每个版本的改动。
四个包同源同码：三个扩展包只有 manifest 与后台形态不同（Chrome/Edge 用 `service_worker`，
Firefox 用非持久 event page），油猴版则是同一份内核换成 `GM_*` 的单文件形态。
所以修复往往四端共享，但**触发条件与可见症状不同**。

---

## v3.8.2 — 修「有时候要按两下回车才发出去」

> 主人报：「有时候双击才能发送」。

- **根因**：插件把上传按住不发，等到你按发送的那一刻才放行。Discord 收到这次发送时
  附件还是 0%，某些版本的 Discord 会直接把这次发送意图丢掉，于是第一次回车白按。
  会排队记住意图的版本就一次够用 —— 这就是「有时候」的来源。
- **修法**：附件还没传完时，把这次回车/点击先扣下来不交给 Discord，
  放行上传并等它真正结束，再补发一次同样的动作。
  - 补发前如果发现 Discord 已经自己把消息发了（POST /messages 已出现），就不补，避免发两条；
  - 没有挂起附件时完全不碰键盘事件，纯文本发消息行为不变；
  - Shift+Enter、输入法确认（含只报 keyCode 229 的旧输入法）都不算发送。
- **同时删掉了 3.8.1 里那个发图前的确认弹窗**（「准备附件 / 加入草稿」），它把每次发图变成两步。
  3.8.1 整版已撤回，GitHub 上不存在这个版本。
- **Equicord 插件按官方接口重写**：`@api/ChatButtons` 的 `ChatBarButtonFactory`、
  `UploadHandler.promptToUpload(files, channel, DraftType.ChannelMessage)`、
  `renderMessageAccessory` 三处都与官方插件示例一致；`engine.mjs` 由 `src/core.js` 直接生成，不维护第二份编解码代码。
- **回归**：核心算法 64/64、发送意图 8/8、上传生命周期 12/12、Equicord 真实 Chrome 绘制 21/21、六产物一致性审查 36/36。
- **跨版本互通（实测，不是推测）**：拿 3.6.3 / 3.7.11 / 3.7.17 / 3.8.2 四个已发布版本的 `src/core.js`
  两两互转，**16/16 逐像素一致**，格式版本一直是 MOE v3（`VERSION = '3.0.0'`）。
  唯一的互通条件是设置里的「盐值」：默认留空则全员互解；填了自定义盐就必须两边一致。
  工具：`node dev/xver-matrix.js <core.js> <core.js>`。
- **安卓**：设置页的「盐值随机」开关删除（它从来没接进编码路径，勾了也不生效），
  换成与 PC 一致的「盐值」输入框，默认留空即全员互通；发图编码与收图还原都按这个值走
  （`MoeHook.activeSalt()` / `LocalImage`），删掉 `MoeStore.randomSalt`。设置页版本号同步 3.8.2。
- **已知限制**：评分默认只混淆高敏感图（可在设置里改成全混或全不混）；
  网页端的进度条在按发送前会停在 0%，这是「按住上传」的必然表现。

---

## v3.8.0 — 快发竞态修复（拖入太快+发送太快 → 未评分就发送）

> 主人报：「拖入图片太快和发送太快，会导致未进行评分就发送，错误的混淆或者不混淆」。

- **根因**（`dev/tmp/race.test.js` 可复现）：上传 PUT 在 `xhr.send()` 被挂住的那一刻，
  字节登记进队列是异步的（body→字节→图片嗅探→指纹都是 await）。这个窗口里用户按了发送，
  `releaseAll` 看到队列为空 → 消息先走；图稍后才登记 → 没人再触发放行 →
  **等 45 秒 TTL 超时后原图直通**，正好表现为「未评分就发送」。
- **修法（三层）**：
  1. `send` 拦截命中上传 URL 的同一 tick 同步推占位项（`registering` 态）进队列，
     字节就绪后原地升级为 `held`（引用不变）；
  2. `onSendIntent` 的 early-return 同时计入 `registering` 态 → 按发送时即使字节还在登记也不会漏；
  3. `releaseAll` 先 `awaitRegistrations(3000)` 等登记落地（超时标 `held`，
     由 `releaseOne` 的空字节守卫按原图放行且日志外显 `register-timeout`，绝不静默）。
- **验证**：仿真台新增「快发竞态」回归用例（`send` 后零 sleep 立刻按 Enter：
  PUT 正常放行且带 moEg 标记）；算法单测 64/64、仿真台 61/61 全绿。

---

## 【已撤回】v3.7.18 — guildId 判归属（实页判不出 → 能用的表情也被转链，主人当场打回；release 与 tag 已删，包备份 G:\回收站61116-moeguard-3718-recalled）

> 主人：「表情栏给我重新对齐 3.7.11，点击表情后自动关表情栏对齐原生，那些没权限使用的以链接格式形式发送。」
> 上一版「一律接手」把本服表情也降成链接 —— 过度。判据回归事实数据：
> **格子实体里的 emoji.guildId（fiber props，内核直读）vs URL 里的当前服务器 id**，
> 相同 → 交回 Discord 原生（原生插芯片、原生收面板 = 3.7.11 手感）；不同/DM/判不出 → 拦死原生 + 插 `[. ](图链)` + 收面板。
> isLocked / 网关集合 / 面板搜索神谕全部不用（各自被实页打死过）。

 — 表情栏一律接手：原生那条路一走就弹会员框

> **同版本内追加（主人要求原地替换 3.7.17 的包，不另起版本号）**：
> 贴纸照表情办 —— 点贴纸格 = 原生整段拦死 + 插 `[. ](贴纸图链)` + 收面板，
> 并去掉贴纸格上的复制链接钮（主人：「像表情一样，去除那个复制链接的按钮，点击就直接发送到输入框里」）。
> 上一版把贴纸留在原生路上，结果外服贴纸一点就弹「仅限 Nitro」会员框 —— 与表情同一事故，同一个修法。

- **`hijackEmojiClicks` 加贴纸分支**：`[data-type="sticker"]` 带 `data-id` 的格子 →
  `preventDefault` + `stopPropagation` + 插 `[. ](media.discordapp.net/stickers/<id>.png?size=160)` +
  `closeExpressionPicker()`（Shift 留着连续挑）；`data-format-type` 1/2/4 出链，**3=Lottie 交回原生**
  （发链对方只拿到 JSON，实测 `.json` 还 400）。
- **`inExpressionPanel()` 这一刀不能省**：聊天里已发出的贴纸也带 `data-type="sticker"` + `data-id`，
  点它是看大图；不判面板就会把「看大图」变成「插链接」。
- **`addCopyButtons` 删掉贴纸格那一整块**（原 ②），聊天里已发出的贴纸（⑤）与聊天表情（③④）的复制钮保留 —— 
  那是「复制别人的贴纸/表情」那条路，主人早先点名要的。
- 仿真台 57 → **62 条**：贴纸格无钮、点贴纸格出正确 URL、贴纸格原生监听调用次数 = 0、
  点完面板自动收起、APNG(format_type=2) 同样接手、聊天贴纸仍有钮且点它不接手。

> **v3.7.13 / 14 / 15 / 16 已撤回**：这四个版本的 release 与 tag 已从 GitHub 删除
> （行为均被本版推翻，当时发得太快——本地用例绿就发了，没先做实页验证）。
> 包文件备份在本地，CHANGELOG 里的记录保留不抹。现行可用版本：**v3.7.17**。

> **同版本内追加 ②**：修「复制动图拿到静态图」—— 主人实测复制动图表情拿到
> `…emojis/1571135552114401290.webp` 而不是 `…1571135100962349096.gif`。根因：聊天里 🔗 的动图判定看的是
> **渲染出来的 img.src**，主人关了动画播放时 Discord 把动图渲染成 .webp 静帧，我们跟着错。
> 修法：新增 `rawContentOf()`（从 fiber 往上挖 `baseMessage.content`），图形态的 🔗 改按原始 content 里的
> `<a:名字:id>` 判动图（`a:` = 铁证），fiber 里找不到 content 才退回 src 判定；字面形态的 `rawEmojiToken()`
> 改为共用同一个助手（行为不变，少一份重复挖掘逻辑）。仿真台夹具改成真页形态（每张表情各自在
> `span.emojiContainer` 里、img 的 fiber 挂 return 链），63/63。
> **同版本内追加 ③（最终版，主人拍板）**：表情栏与贴纸判定**原样回退 3.7.11** ——
> emojiLockedLive/markEmojiLock/emojiLocked 固化机制 + stickerUnsendable 判锁，能用的交回原生，锁住的转链；
> 3.7.18 自创的 guildId 套路全部删除。版本号归位 3.7.17，远端资产整体替换。

主人把要求重述成一句，而这句话就是全部需求：
**「我只是让你点击表情后，自动关闭表情栏，还要把表情换成格式链接。」**

### 实页一手证据（上一版为什么错）

```
data-ver = 3.7.16
data-hijack = "emoji:free"      ← 我们的代码看了这颗，判「没锁」→ 放行走原生
弹窗文本 = "使用Nitro解锁所有表情符号 … 获得 Nitro :bz3015: 来自逍遥仙境 … 仅限 Nitro"
```

**结论：要 Nitro 的外服表情在表情栏里 `isLocked` 就是 `false`。**
所以 3.7.15 按「只有上锁的才转」分流，**漏掉的恰好就是主人要解决的那一类**，
而且漏掉的后果不是「不转」而是【弹会员框】。

### 现在的规则（没有分支就没有漏）

表情栏里点**任何**自定义表情（带 `data-id`）→ 一律：

1. `preventDefault()` + `stopPropagation()`（捕获阶段）→ **Discord 原生处理整段不跑**，
   会员弹窗从结构上不可能出现 —— 不需要判得对；
2. 输入框插 `[. ](CDN 图链)`（动图 `.gif`、静态 `.webp`，看 `data-animated`）；
3. 自动收起面板（Shift 连着挑不关）。

标准 unicode 表情没有 `data-id` → 不接手（它们本来就能直接发）。被锁格子依旧去灰可点。

### 删掉

`emojiLocked` / `fiberLockBag` / `isLocked` 读取与分流（无消费者，不留死代码）。
上一版那三条「按锁分流」的用例相应换成【一律接手】+【原生路拦得死】。

### 钉住的机制用例（比「判得准不准」重要）

仿真台里给格子挂一个**假的原生 click 监听**（模拟 Discord 弹会员框的那个），
点下去后断言：

| 断言 | 意义 |
|---|---|
| 假原生监听调用次数 = `0` | 原生路真的被捕获阶段拦死 → 会员弹窗不可能弹 |
| `isLocked=false` 的格子也插链 | 不再按锁分流（旧版就是在这颗上放行走原生而弹框） |
| `isLocked=true` 的格子同样插链 | 两条路合一条 |
| 接手后面板 `display:none` | 主人点名要的那个动作 |
| `emojiLocked`/`fiberLockBag` 不存在 | 分流代码真的拆干净 |

验证：仿真台 **57 条全绿**；算法单测 64/64。

## v3.7.16 — 修一个「做了但看不见」：消息里的复制钮永远不浮现

主人发了张截图：**「这两个外服表情你还没做？通杀方式」**

实页只读一枪就把真相拉出来了：

```
ver=3.7.15  boxes=38  imgs=9  pills=9      ← 钮其实全挂上了
rows[0]: :pigpig:  host=SPAN.emojiContainer_lTEMT6
         pillOpacity=0  pillPE=none         ← 但算出来就是不可见、不可点
```

### 根因

浮现规则只写了两种宿主：

```css
button[data-type="emoji"]:hover > .moe-copy,   /* 表情栏格子 ✓ */
[data-type="sticker"]:hover > .moe-copy,       /* 贴纸格 ✓ */
[class*="sticker"]:hover .moe-copy { ... }     /* 贴纸内部 ✓ */
```

而**消息里表情的宿主是 `span.emojiContainer_*`**、**消息里贴纸的宿主是 `messageContent_*`**
—— 一条都不匹配 → 钮挂上了却**从不浮现**，看起来就是「根本没做」。
（本质：我又去猜了 Discord 的类名，而不是自己打标记 —— 同一个错反复出现。）

### 修法

由 `ensureCopyButton` 自己给宿主打上 `moe-copy-host`，浮现规则只认这个标记：

```css
.moe-copy-host:hover > .moe-copy, .moe-copy-host:hover .moe-copy { opacity:1; pointer-events:auto }
```

不依赖 Discord 类名，表情格/贴纸格/消息里的表情/消息里的贴纸共用同一条仍成立的路。

### 钉住的三条回归

1. **每个钮的宿主都带 `moe-copy-host`**（上一版：钮数=4、带标记=0 → 直接红）
2. `.moe-copy-host:hover` 这条规则真的在样式里，且消息宿主能匹配它
3. 【真页形态】消息里的表情（宿主是 span 容器）也有钮

另外用 `chrome_computer` 的真实鼠标悬停（CDP `Input.dispatchMouseEvent`，会真的改变 `:hover`
状态）在真页上验一眼：悬停后 `opacity` 应从 `0` 变 `1`。

验证：仿真台 **55 条全绿**；算法单测 64/64。行为没变（仍是 3.7.15 那两条：表情栏只有上锁的才插链、
聊天里的表情复制成链接），本版只把「看不见」修成「看得见、点得中」。

## v3.7.15 — 表情栏改回去：只有上锁的用链接发；聊天里的外服表情才能复制成链接

主人三句话把上一版的方向纠正过来：
**「神经病啊，表情栏给我改回去，只有上锁的才用链接发送。还有那个表情栏的链接复制是何意味？给我去掉。
我他妈让从始至终解决的是——在聊天中别人发的外服表情复制然后转换成链接。」**

我 3.7.14 把「一律走链接」理解成了「所有表情（包括能原生发的、包括输入框里粘贴进来的）都降级成链接」，
并把复制钮贴到表情栏格子上 —— 这是把方向读反了。现在按原话收回。

### 现在只做两件事

**A · 表情栏**：只有 Discord 判为**上锁**的格子才接手 → 插 `[. ](图链)`；能用的表情一律交回原生。
锁信号以 fiber 上的 `isLocked` 为准（实页一手证据：格子 fiber 的 `props.children.props = {emoji:{…}, isLocked:<bool>, allowAnimatedEmoji}`），
DOM 猜法（`aria-disabled` / 锁图标）只在拿不到 fiber 时兜底。标准 unicode 表情没有 `data-id`，天然不碰。

**B · 聊天里别人发的外服表情 → 复制成链接**（主人从始至终要的那件事）：消息上的表情长出一个 🔗（左上角、
悬停才浮现、不挡图），点一下剪贴板里就是 `[. ](图链)`，覆盖两种形态：

| 形态 | id 来源 | 备注 |
|---|---|---|
| 渲染成图 `<img data-id>` | DOM 直接给 | 外服但客户端能解析的那类 |
| 渲染成字面 `:名字:` | 从同条消息的原始 content 找回：实页取证 fiber `baseMessage.content` = `<:rin_miao_full_angry:1397468110776172654>` | **正是发不出去那一类**（Discord 自己就解析不了） |
| 字面 `:名字:` 但原始 content 里没 token | 找不回 | **什么都不做**，不猜、不乱链 |

### 删掉的东西

| 删除 | 原因 |
|---|---|
| **输入框 chip 转换整条链**（`convertBrokenEmojiChips`/`findNextBrokenChip`/`replaceChipWithText`/`composerChips`/`chipEmojiUrl`/`placeCaretAfter`/`findChipAgain`） | 连本来能原生发的表情都被降级 —— 主人明确否掉；且「能用的不走原生」从来就不是需求 |
| **表情栏格子上的 🔗 复制钮** | 主人：「那个表情栏的链接复制是何意味？给我去掉」 |
| 网关探针、面板搜索探针、渲染学习名单 | 全部没有消费者了（3.7.14 删，本版确认没残留） |

**贴纸的复制钮保留**（那是主人早前点名的缺口：Discord 对贴纸没有任何复制入口）；
点贴纸本身仍不插入（只复制）。

### 这一轮自己造成的两个坑（都已钉住）

1. **嵌套转义把正则吃了**：JS 字符串里的 `"\d"` 就是字母 `d`，所以 `new RegExp('...:(\\d{15,25})>')` 永远匹配不上 →
   字面形态的 id 一直找不回。改用 `[0-9]` 彻底不依赖反斜杠（与本项目「反斜杠陷阱」铁律同一个家族）。
2. **两条假绿用例**：一条拿非空字符串当 `cond`（永真）；一条用 `msgbox.querySelector('.moe-copy')` 拓错了钮
   （字面形态的钮嵌在 span 里，文档序在前）。已改成 `:scope >` 分层取钮，并删掉永真断言。

验证：仿真台 **52 条全绿**（新增：没锁的格子不接手、DOM 无锁标记但 `isLocked=true` → 才接手、
`isLocked=false` 一律不碰、chip 转换机制已撑销、图形态与字面形态各自拿到正确 URL、
找不回 id 不长钮、表情栏无钮、门禁 API 一个不剩）；算法单测 64/64。

## v3.7.14 — 不再判可用性：自定义表情一律提取图链、以链接形式发送

主人这句话把整套门禁判了死刑：**「不对啊，就是让你提取表情链接，然后以网址链接形式发送，不是要走原生上的路线，就像表情栏锁上表情解锁发送一样。」**

规则塌缩成一条：**输入框里出现自定义表情的 chip（带 `data-id` + `alt=":name:"`）→ 一律原地换成 `[. ](图链)`**；表情面板里点格子（带 `data-id`）→ 一律插 `[. ](图链)`。不判「能不能用」、不走原生、不看会员。标准 unicode 表情没有 `data-id`，天然不碰。

### 删掉的东西（约 250 行 + 一个页面级钩子）

| 删除 | 原本是干什么的 |
|---|---|
| `probeUsable` / `useVerdict` / `probeTries` / 面板搜索探针 | 用面板搜索结果判「库里给不给我用」 |
| `tileLockInfo` / `fiberEmojiBag` / `emojiUnusable` / `emojiEnt` / `harvestDescriptors` | 从 React fiber 读 Discord 的 `isLocked` 与表情实体 |
| `markEmojiLock` / `emojiLocked` / `emojiLockedLive` / `data-moe-lock` | 猜 DOM 锁标记（曾把本服表情误伤） |
| `scanEmojiRender` / `emoGood` / `emoBroken` | 从已渲染消息里学可用性 |
| hook.js 的**网关探针**（包页面 `JSON.parse`、`GUILD_CREATE` 集合、`__moeGw`、`data-gw`）+ content 侧客户端 | 按「我加入的服务器」集合判外服 |

**副作用一起消失**：不再为了探测而打开表情面板打字 → **零可见副作用**；不再有任何误判空间；
不再往页面的 `JSON.parse` 上挂钩子（footprint 更小，也消除了「顶掉别人的 JSON.parse」这类风险）。
产物 310.3 KB → **281.7 KB**。

### 这一轮被用例抓出来的三个机制问题（已固化成规则）

1. **删代码时删掉了活着的声明**：`composerChips()` / `emoTried` / `emoTick` 跟在被删的块里一起没了
   → 17 条用例齐红。已把「两条选择器通道都必须留」写进 `composerChips` 的注释。
2. **`try { … } catch {}` 会静默咽掉 ReferenceError**：这就是为什么红了 17 条却**一条日志都没有**。
   现在接手监听器的 catch 会把异常打到诊断面板（`data-hijack=throw:…`）——
   「绝不能影响 Discord」和「必须留痕」不该互相牺牲。
3. runner 补了两处：async 主脚本的报错走 `unhandledrejection`（原来只挂 `error`，挂死 90 秒毫无线索）；
   `ok()` 每条即时倒一条进度，超时时能看出挂在第几条之后。

### 一次真实事故记录（不掩盖）

改版本号时用了一段 Python 写文件，`encoding` 参数传错抛异常，但文件在 `'w'` 打开的瞬间已被截断
→ `manifest.json` 变 0 字节。靠 git 恢复（`git checkout -- manifest.json`），零损失。
教训：**改文件优先用编辑工具的精确替换，不要拿 shell 里的 python 现场拼**（本项目铁律 §4 的同一家族）。

验证：仿真台 **53 条全绿**（新增：三张 chip 全转且各就各位、只带 `class="emoji"+data-id` 的旧形态也扫到、
动图/静态格子一律插链、无 `data-id` 的格子不接手、**门禁 API 一个都不剩**的拆除确认、
hook 不再碰 `JSON.parse`）；算法单测 64/64。

## v3.7.13 — 通杀的最后一环：面板搜索当神谕（复制的别人的表情也吃下）

主人这一条把判据逼到终局：**「在聊天中直接复制外服表情依旧没有复制成链接，为什么？」**

### 一、为什么上一版不行（两条，都是判据用错了轴）

1. **「消息里渲染成图」被当成「我能发」** —— 这是错的。渲染按**阅读者**的权限，
   发送看**作者**的权限。你复制的那个外服表情在原消息里是图（发的人有 Nitro/伙伴服），
   于是它被记进 `emoGood`「永不接手」→ 放行走原生 → 你发出去报没会员。
   现在 `emoGood` 只认一个硬证据：**我自己发出去过、且现在仍渲染成图**
   （作者 id 从真 Discord 的 `[id^="message-content-<作者>-<消息>"]` 里取，实测有效）。
2. **chip 自己身上拿不到判定** —— 实页实测：消息/输入框里的表情 `<img>` 的 fiber 只有
   `src`/`alt`/`data-id`，**没有** emoji 实体（四条样本全 null）。面板格子才有
   `isLocked`。所以「点面板」能判，「复制进来」判不了。

### 二、可用的神谕：表情面板的搜索框（实页 A/B）

`input[aria-label="搜索"]`（placeholder「探索最适用的表情符号」）—— 搜的就是
**Discord 自己算好的「我此刻能用的表情库」**：

| 搜索词 | 结果格数 | `isLocked` | 结论 |
|---|---|---|---|
| `qq_chaoticshock`（本服静态） | 1（guildId=当前服务器） | false | 能用 |
| `nienie_shengjiang` | 1 | false | 能用 |
| `rin_miao_full_angry`（发出去报没会员那个） | **0** | — | **用不了** |

⇒ **搜不到 = 库里不给我用**；搜到则看它自己的 `isLocked`。零网络、零 token、不碰内部函数名。
每个名字只探一次（结论缓存），面板是我们开的就自己关上，搜索框用完清空。

**代价（知情）**：遇到没结论的表情，会短暂打开表情面板并往搜索框打字（约 1–2 秒）后自动收尾。
纯本地 UI 动作，不发任何请求。

### 三、这一段被用例抓出来的四个真 bug（不是理论问题）

| Bug | 后果 | 抓它的用例 |
|---|---|---|
| 网关集合为空（实页 `e=0`）时，「不在集合里」= 全判外服 | **所有表情都被误换成链接** | 断言「自家服务器的表情不转」直接变红 |
| 探针给出 `unusable` 后，`findNextBrokenChip` 不认这个结论 | 那颗 chip 成孤儿，**永远不转**（正是主人报的现象） | 探针调用 23 次、0 结论、chip 原地不动 |
| 「搜索后 0 格」与「面板没渲染出来」被当成同一件事 | 反复白开面板，永远判不出 | 数搜索前/后格数：前 >0 且后 =0 才算「库里没有」 |
| `composerChips()` 丢了旧选择器的第二条通道 `img.emoji[data-id]` | **整个「输入栏就地转链」静默失效** | 仿真台的 chip 一颗都扫不到 |

### 四、复制钮扩到消息里的表情

主人要「在聊天中直接复制外服表情」就是链接格式 —— 现在**消息里渲染出来的表情**也长 🔗
（连同贴纸格、表情格、消息里的贴纸），点一下复制的是 `[. ](URL)`。
钮统一在**左上角**、默认不浮现、悬停才出现，不挡表情也不挡贴纸。

验证：仿真台 59 → **68 条全绿**（新增探针 A/B、轴心修正回归、假阳性守卫、
结论缓存不反复开面板、复制钮覆盖消息表情）；算法单测 64/64。

## v3.7.12 — 2026-11-16

### 🐛 表情/贴纸解锁的两处体验修正

**一、接手后表情面板不再赖在那儿**

点被锁的动图/外服表情，原生行为是「插进输入框 + 面板自动收起」，我们接手后只有前半条。
根因（面板 DOM 一手证据）：Discord 自己的 `onClick` 末尾是

```js
c(t, { isFinalSelection: !e.shiftKey, toggleFavorite: n })
```

——不按 Shift 就是「最终选择」，它自己收面板。而我们在 `document` 捕获阶段就
`stopPropagation`，那条 handler 根本没跑到。

修法：三档，从最像人到最兼容 ——
① 给 popout 的 `clickTrap` 派发一套 pointer/mouse 序列（= 「点了面板外面」；
   事件只向上冒泡，面板内部收不到，不会误触发选中）
② 再点一次表情按钮（开关式，不依赖 class 名）
③ Escape（最后一道，副作用是会顺手取消「回复」，所以只当前两项都找不到）

按住 Shift 时不关 —— 跟原生一样留着连续挑。
实页实测：面板关闭、输入框草稿 124 字符前后**一字未动**；贴纸面板用的是同一个
`trapClicks` 容器，25 张贴纸实测同样能关。

**二、发出去的文本从一个 URL 缩短成一个字**

以前插的是裸 CDN 地址（60+ 字），消息里一大串噪声。现在插
`[. ](https://cdn.discordapp.com/emojis/…)` —— 链文字只占一个字。

【关键：图照旧出】这不是推演，是实页开火量的：同一个表情（`ob_fat`，gif）在安静频道
连发两条对照，两条的服务端 embed 完全一致：

| 形式 | embed 节点 | 渲染 | 2.5s 后复查 |
|---|---|---|---|
| 裸 `https://…/emojis/<id>.gif?size=96` | 2（`inlineMediaEmbed` + `imageContent`） | 96×96 图 | 仍是 2 |
| `[. ](https://…/emojis/<id>.gif?size=96)` | 2（`inlineMediaEmbed` + `imageContent`） | 96×96 图 | 仍是 2 |

屏蔽预览的写法是尖括号 `<url>`，链文字不影响 embed 抽取 —— 这一条已推翻「裹上 markdown 就不出图」的担心。

（油猴版与扩展版同源，两边一起生效。）

**三、外服表情在输入栏里就被换成短链（发出去不再是一串字符）**

【现象】用了你不在的服务器的表情（非伙伴/认证服），输入栏里能正常渲染成图，
但 Discord 照样把 `<:name:id>` 发出去，接收端（连自己）只看到一串字面字符。

【一手证据 2026-11-16 实页】

```text
发送 body : {"content":"<:rin_miao_full_angry:1397468110776172654>", ...}
渲染结果 : <span>:rin_miao_full_angry:</span>      ← 没图
同屏另外两条外服表情 → 渲染成 img.emoji
三条的 CDN 全是 HTTP 200（webp 200 / gif 415）
```

→ 差异不在图还在不在，而在【我们自己的客户端能不能解析它】—— 这就是判据，
不用猜 guild_id，也不用碰 Nitro 状态。

【做法】两个名单，全从已渲染的消息里学，零猜测：

| 名单 | 怎么学到 | 处理 |
|---|---|---|
| `good` | 某个表情名在消息里渲染成 `<img>` | 可用，永不接手 |
| `broken` | 某个表情名在消息里渲染成字面 `:name:` 文本 | 输入栏里命中就就地换掉 |

输入栏里的 chip 自带 `data-id` 与 `alt=":name:"`，**URL 就是它自己的 `src`**（只把
`size=44` 提到 `size=96`，扩展名保持原样，不用猜 gif/webp）。不改 DOM 节点本身——
Slate 不认手改的节点，一重绘就丢，只能走它自己的事件通道。

【踩了两枪才找对的替换序列】都是实页上的硬证据：

| 枪 | 做法 | 实页结果 |
|---|---|---|
| ✗ 一 | 选中 chip → 三条插入通道（execCommand / paste / beforeinput）逐个试 | `data-emo=all-failed`。chip 包在 `<span data-slate-void="true" contenteditable="false">` 里，选一个不可编辑子树里的节点，Slate 根本不认这个选区 |
| ✗ 二 | 光标放 chip 后 → 退格删掉 → 贴回链接 | `data-emo=paste-fail`。**删除成功了、贴回失败 → 表情直接丢了**。删了就不能反悔，这个顺序不可接受 |
| ✓ 三 | 光标放 chip 后 → 先贴短链 → **确认文本真的落下来** → 重新查那张 chip → 再退格删掉 | 贴不上就一根毛不碰（顶多没换，不会丢东西）。实页已证三个零件各自能跑：退格删 chip ✓、贴文本 ✓、文本位置 ✓ |

【四硬要求（主人原话）】每一个表情单独处理 / 不影响其他表情 / 替换该替换的位置而不是把输出全覆盖 / 多张叠加也要正常。实现上对应：

- **串行、一次只动一张**：处完一张重新查 DOM 再找下一张（React/Slate 一改内容就整段重绘，
  手里拿的后面几张 chip 引用当场作废，轻则漏换、重则插错位置），`emoBusy` 防重入；
  失败就收手，下一轮重来
- **就地**：文本贴在 chip 后面再把 chip 退格掉，前后文字与其他表情一律不动；
  可用名单（`good`）与未知表情完全不碰
- 仿真台用例就按这个形状写：`甲[chip] 乙[good chip] 丙[chip2] 丁` 混排，
  断言两张各自就位、可用的不误伤、四个字一个不少（实测产物 `甲[. ](url1) 乙丙[. ](url2) 丁`）

为什么不在发送那一刻改 body？那样你根本看不见换了什么，而且上传/编辑/回复多条路径都要堵。

【已知局限（诚实）】一个表情**第一次**用（滚动条里从没见过它的字面渲染）时判不出来，
那条依旧原样发；但它当场就在滚动条里留下了字面文本，从下一个起自动转链。
你那个 `rin_miao_full_angry` 已经发过两次，所以现在就已经在名单里了。

**四、通杀的判据换到「Discord 自己算的结论」这一层**

主人原话：「每一个表情单独处理…而且我直接复制别人的表情，这个是已有服务器的，会直接报错没有会员，
我希望像通杀外服表情一样通杀这个。」这一条把判据逼到了正确的层。三条战线都是实弹打的，
**两条被打死、一条活了下来**，全部如实记在这里：

| 候选判据 | 结果 | 一手证据 |
|---|---|---|
| ✗ 从 Discord 内部挖「可用性」函数 | **死**：webpack 9044 个模块里 `getAllReadyEmojis`/`isUsable`/`EmojiStore`/`unsendable` **0 命中**（属性名被 terser 打了） | 全模块源码扫描 |
| ✗ 网关 `GUILD_CREATE.emojis[]/stickers[]` 集合 | **死在这台机器上**：包装器在位、实时 dispatch 也确实流过（6 秒抓到 `MESSAGE_CREATE×2`/`TYPING_START`/`PRESENCE_UPDATE`），`premium_type` 也从 `READY` 读到了（=0），**但一条 `GUILD_CREATE` 都没有** → `g=0 e=0 s=0`，判据永远停在 unknown | 实页探针 + `data-gw` |
| ✗ 把 `<:name:id>` 当文本插进输入框，看 Discord 解析不解析回 chip | **死**：正样本（消息里已渲染成图、确定能用的 `nienie_shengjiang`）与反样本（`rin_miao_full_angry`）**都不解析**，两条都留在字面文本 → 输入框不是这个用法的神谕 | 实页 A/B，做完把输入框恢复原样 |
| ✓ **React fiber 里 Discord 自己的判定** | **活**。表情格子的 fiber 上摆着： | 见下 |

```text
props.children.props = {
  emoji: {guildId, id, animated, name, require_colons, available, roles, managed, version, type},
  isLocked: false, allowAnimatedEmoji: true, size: 40, columnIndex, rowIndex }
// 整面板的清单在同一条 fiber 的 props.emojiDescriptors[N].emoji
```

`isLocked` 是 Discord **算完**的「这条频道里我此刻能不能用它」——外服、跨服务器使用、
动图要会员、角色限制（`roles`）全在里面，不用我自己复述它的规则。于是：

- **表情格子**：`isLocked===true` 才接手（插 `[. ](图链)`）；`===false` 一律交回原生。
  顺带修掉一个真 bug：上一版靠 `aria-disabled`/锁图标猜，实测把 `isLocked:false` 的
  **本服静态表情当成锁着 → 好好的表情被换成链**（就是主人说的「影响其他表情」）。
- **输入框里的 chip**：chip 自己的 fiber 也走同一条读取；再兜底
  `emojiDescriptors` 缓存（id→`{guildId,animated,locked}`）+ `premium_type` + URL 里的
  当前服务器：没会员且 `guildId ≠ 当前服务器` = 用不了 = 就地转链
  ——**「复制别人服务器里我有的表情，发出去报没会员」这一类就是这么吃下的。**
- `locked` 保持**三态**（true / false / undefined）：拿不到判定绝不当成「能用」或「不能用」，
  未知就不动手。网关集合与旧版渲染学习退成旁证/兜底，只在 fiber 读不到时才用。

**五、贴纸：按拍板改成「只给复制钮，不再抢点击」**

主人原话：「这个贴纸默认情况下是没有复制按钮的，你添加一个复制，直接复制成那个格式」，
追问后拍板「取消点击插入，只保留复制钮」。所以：

- 删掉贴纸点击接手（`hijackStickerClicks` 整段移除）——能发的交回 Discord 原生发真贴纸。
- 复制钮贴在**表情格、贴纸格、消息里已渲染出的贴纸**上；贴纸本质就是
  `media.discordapp.net` 上一张公开图（实测 206 OK、无需凭证），Discord 自己不给任何复制入口。
- 钮的格式就是发送格式：`[. ](https://media.discordapp.net/stickers/<id>.png?size=160)`。
- 【位置按你说的】挪到**左上角**，而且**默认完全不浮现**（`opacity:0` + `pointer-events:none`），
  悬停到格子/贴纸上才出现 —— 不挡表情也不挡贴纸。
- 事件顺序坑（记下来免得再踩）：接手监听在 `document` 捕获阶段，捕获阶段一 `stopPropagation`
  事件就饿死在钮前面 —— 所以接手监听开头先 `if (t.closest('.moe-copy')) return;` 放行。

仿真台 41 → **59 条全绿**（新增：fiber 实体采集、`isLocked=false` 不接手回归、
`isLocked=true` 的 chip 就地转链、贴纸点击不插入、钮在左上且默认不浮现、复制内容逐字符校验）；
算法单测 64/64。

---

## v3.7.11 — 2026-11-10（新增第 4 个包：油猴单文件版）

### 🐵 油猴版（`moeguard.user.js`）

把整个扩展原样移植成单文件油猴脚本（260+ KB，零外部依赖）。算法 / 审查层 / 解码管线 /
表情贴纸解锁 / 各种 realm 与 blob: 渲染兼容全部沿用同一份源码，**内核零改写**：

- 在 IIFE 里用 `const chrome = {...}` 影子掉页面的 `window.chrome`，把
  `runtime.sendMessage / storage / tabs / downloads / permissions` 全落到 `GM_*`，
  因此 `content.js` / `popup.js` / `options.js` 一行都不用改。
- 弹窗与设置页合并成页内浮层（`Alt+M`），原两份 HTML/CSS/JS 原样搬进去，分别作用域。
- 原生右键菜单换成页内菜单（只接管附件图，`Shift+右键` 放行给 Discord）。
- `build-user.js` 从 `manifest.json` 取版本、带断言拼接，锚点丢失直接报错退出，
  不会静默出一个半残的包。

### 🔧 顺手修掉的上游 bug（扩展版同样受益）

| 症状 | 根因 |
|---|---|
| 点「解码本页所有图片」后图再也回不来 | 重扫删了 `data-moe-scan*`，而图此时已是 `blob:`，原始地址只剩 `data-moe-orig` → 之后每轮扫描算不出 `raw` 直接跳过 |
| 图已拖进输入框，按 Enter 后附件卡 45 秒 | 发送意图在「解码+指纹」预处理完成前到达 → 队列还空着，意图被丢弃，只能等 TTL |
| 删预览图/切频道后仍会上传 | `abort()` 只能看见已入队的项，预处理期与放行期的取消都看不见 |
| 同时发两张相似图，可能有一张原图直出 | 内容键没命中时回退到感知指纹容差匹配，A 图的「原图直通」会套到 B 图上 |

### 🔬 审查

五个不同模型的子代理各查一个角度（加载时序 / 上传链路 / 面板 UI / 油猴环境 / 打包器），
共 20 条发现：17 条已修并写了用例钉住，3 条属上游设计取舍（编码失败 fail-open、
`fetch` 分支不进挂起队列、45s TTL 自动放行），已在 `README-userscript.md` 里明写。

验收：`node dev/run.js` 29/29（真 Chrome headless，canvas/PNG/DOM 全真跑）、
`node tests/core.test.js` 64/64。

### 🔓 修 Discord 2026 新渲染导致的解码失效（消息图全走 blob:，扫描器一张不接）

根因（现场一手证据）：2026 年 Discord 网页改了消息图渲染 —— lazyImg 组件自己
fetch 媒体代理的 webp，再以 `blob:https://discord.com/…` 当 `<img>` src，img 上再也
看不到 media.discordapp.net/attachments/ 地址 → `isAttachment(blob:)` 永不命中 →
解码管线整条跳过（诊断面板 `new=0`），看到的一直是混淆图。

**不是平台剥块**：自测喵图的 cdn 原图 `moEg`/`moMt` 块完好（IHDR 1048×1304 →
`6d 6f 45 67` 标记 + 120KB 工作流元数据），无损还原 832×1216 复核通过 ——
字节层没变，纯粹是网页渲染方式变了。

修法：src 拿不到地址就从同容器的 originalLink 锚点反查 —— `href` = cdn 原图
（带 ex/is/hm 签名，首选），`data-safe-src` = 媒体代理重编码 URL（兜底回源）。
只认「恰好一个附件锚点」的那一层，防多图 mosaic 串位。配套：解码结果记 `moeUrl`，
Discord 重渲染覆盖 src 时立刻夺回；占位模糊图跳过（占位与真图是两个 <img>）；
右键/长按解码与大图弹窗原图升级同步兼容 blob: 渲染。

---

## v3.7.10 — 2026-09-14

### 🤖 补 Noto Sans Math：频道名里的数学花体字母不再是灰块

Discord 里常见的 `𝑩𝑶𝑻` / `𝑨𝒂𝒂𝒍𝒊𝒄𝒆`（U+1D400–U+1D7FF Unicode 数学字母数字符号）
**不是 emoji**，安卓系统字体（尤其模拟器）常缺这些字形 → 显示成灰方块。
随扩展打包 **Noto Sans Math v3.000**，用第二条 `@font-face` 按
`U+1D400-1D7FF,U+2100-214F,U+2200-22FF,U+2A00-2AFF` 范围补上，
字体栈里排在 emoji 字体之后（两者范围不相交）。GeckoView 专属，桌面不注入。

实测：搜索框输入 `𝑩𝑶𝑻` 正确渲染为粗斜体 BOT。

---

## v3.7.9 — 2026-09-14

### 🤖 emoji 字体换成 Noto Color Emoji COLRv1（修新 emoji 灰块）

根因两层：
1. 原字体 Twemoji Mozilla **v0.7.0（2022-10）只覆盖到 Unicode 14** —— 🩷🫨🩵🪿🫸
   这类 Unicode 15/16 新 emoji 全部缺字形，在输入框里显示成灰方块（实测截图坐实）。
2. Discord 的 CSP `font-src` 里没有 `moz-extension:`，注入的字体被拦死。

改为：
- 打包 **Noto Color Emoji COLRv1 v2.051**（覆盖 Unicode 15/16）。
  **不能藏 CBDT 位图版**：CBDT 在 `@font-face` 里加载无效，emoji 反而全变灰块（实测）。
- 注入必须用 `<style>` 里的 `@font-face`，**不能用 FontFace API**（内容脚本 Xray 隔离）。
- GeckoView 上用 `webRequest.onHeadersReceived` 把 `moz-extension:` 加进 `font-src`。

桌面浏览器无变化（系统自带 emoji 字体，不需要也不注入）。

---

## v3.7.8 — 2026-09-14

### 🤖 GeckoView 上放行 moz-extension 字体（CSP font-src）

实测 discord.com 响应头 `font-src` 只有 `'self'` + 几个 https 域，没有
`moz-extension:` / `data:` / `blob:` → 内容脚本注入的 face 字体直接加载失败。
用 `webRequest` 改写响应头补上 `moz-extension:`。新增 `webRequest` /
`webRequestBlocking` 权限。仍不解决字体本身的覆盖面问题（见 v3.7.9）。

---

## v3.7.7 — 2026-09-14

### 🤖 移除 GeckoView 粘贴中继（整条 native messaging 在 155 上是死的）

实机日志：后台 `connectNative('app')` 反复炸 `Native manifests are not supported on
android`（后台起跑早于 App 注册 MessageDelegate，且 GeckoView 155 的 native
messaging 走 NativeManifests 直接抛错）。v3.7.5/v3.7.6 的中继 + 重试全部移除。

安卓粘贴改由 **App 侧合成 Ctrl+V 键事件**完成（`SessionTextInput.onKeyDown/Up`）：
Gecko 原生 paste 命令自己读安卓剪贴板，React 受控框 / Slate 编辑器通吃。
曾尝试 `InputConnection.commitText`，实测为**假成功**（返回 true 但无 IME 会话时
GeckoEditable 丢弃 IPC）——此路不通，勿再踩。

桌面浏览器无任何变化。

---

## v3.7.6 — 2026-09-06

### 🤖 粘贴中继加自动重连（后被 v3.7.7 移除）

后台 `connectNative` 起跑早于 App 注册 delegate，加 2s × 30 次重试。
实机验证 native messaging 在 GeckoView 155 整条不可用，本版方案作废。

---

## v3.7.5 — 2026-09-06

### 🤖 修复安卓粘贴桥完全不通

GeckoView 155 实测：内容脚本调 `connectNative` 直接报
`Native messaging not allowed (envType=content_child)` —— 只能由后台起连接。
改为：后台（仅 GeckoView）起 `connectNative('app')` 长连接，内容脚本用
`runtime.connect('moe-ui')` 连后台，后台中继 App 推来的粘贴文本。

---

## v3.7.4 — 2026-09-06

### 🤖 原生桥粘贴支持普通输入框（登录页能粘账号密码了）

v3.7.3 的桥只认 Slate 输入框，登录页的邮箱/密码是原生 `<input>` → 粘不进去。
现在分流：焦点在 Slate → 四通道插入；否则找可见的原生输入框
（没聚焦就取第一个空着的，登录页正好是 邮箱→密码 顺序），
用页面 realm 的原生 value setter + input/change 事件写入（React 受控组件安全）。

---

## v3.7.3 — 2026-09-06

### 🤖 模拟器里 Ctrl+V 能粘贴了（安卓）

MuMu 会把 Windows 剪贴板同步进安卓剪贴板，但 Ctrl+V 按键到不了
GeckoView 的网页输入框 → 粘不上。现在内容脚本在 GeckoView 上开
`connectNative('app')` 长连接，壳拦下 Ctrl+V 把剪贴板文本推给页面，
走 `insertIntoComposer` 四通道写进 Slate 输入框（桌面端不受影响）。

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
