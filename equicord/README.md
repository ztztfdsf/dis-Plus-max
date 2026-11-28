# MoeGuard · Equicord userplugin（开发候选）

在本仓库运行 `node build-equicord.js`，得到 `dist/moeguard-equicord-candidate.zip`。把 ZIP 解压到 Equicord **源码树**的 `src/userplugins/`，确认入口是 `src/userplugins/moeGuard/index.tsx`，再按该版本 Equicord 的自定义插件构建说明编译。也可以直接复制 `dist/equicord/moeGuard/`。它不是官方插件目录的一键安装项。

- 主聊天输入栏的 MoeGuard 按钮：左键选择本机静态 PNG/JPEG。先本地生成带 `moEg` 标记的 PNG，再把 **PNG 而非原图** 交给原生附件草稿。发送仍由用户操作；不会截获回车。普通附件不变。
- 右键同一按钮：选本机 MoeGuard PNG，还原并保存 `*-decoded.png`；不会把还原图附到消息。插件设置可指定与其他端一致的盐值。这是可逆混淆，不是端到端加密。
- 复用 `src/core.js` 的编码、解码、文本元数据和标记格式。非协议图、盐值不符或文件太大时提示错误。仅支持静态图片，不承诺动画保真。
- 聊天内的普通 PNG 附件：通过 Equicord 的 `MessageAccessoriesAPI` 按消息 ID 和附件地址绑定原图。在可视范围上下各两屏内，先查协议标记，再本地解码；同时最多处理两张。还原时保留原图元素和占位，在该条消息头像栏显示「已解码」和对应的 PNG 下载链接。剧透、遮挡图、外站链接不处理；行复用和关闭插件会还原宿主显示。
- 验收边界：链接测试使用 Equicord `1.15.18.2` 的真实聊天按钮、设置、Webpack API 和 JSX 注入文件（上游 `8d63e9694b2ef5195806b3f8b2e03135a4b4ea2c`）。这是源码链接测试，不是完整客户端构建。离线 Chrome 场景检查实绘像素、角标出现时机、原位尺寸和行复用；真实登录客户端的原生草稿和消息行仍待验。本包不是 `3.8.1` 正式版。

接口：[Equicord 插件目录](https://docs.equicord.org/plugins/)、上游 `src/api/ChatButtons.tsx`、`src/webpack/common/utils.ts`（`UploadHandler.promptToUpload`）。
