# MoeGuard 喵图混淆

给 Discord 用的发图插件。选好的图片在本地先打散成一张花纹图再发出去，
聊天里装了这个插件的人会自动看到原图，没装的人只能看到那张花纹。

不是加密。任何人拿到那张花纹图、又知道用的是哪个工具，就能把它还原。
它挡的是"顺手点开随便看看"的人，不是防专业取证。

- 全部在本地算，不联网、不上传、没有服务器、没有账号、不需要密钥
- 原图不丢：花纹图里编码了完整的原图像素，装插件的人看到的就是原图
- 支持 Discord 网页版（Chrome / Edge / Firefox / 油猴）和 Discord 客户端（Equicord 插件）
- 安卓版是另一套东西：改的是 Discord APK 本身，见下面的安卓说明

## 怎么用

1. 在聊天框选图或拖图进来
2. 插件先做一次本地评分，判断这张图敏不敏感
3. 敏感的图会被打散成花纹再发；不敏感的按原图发
4. 想改某张图的结果，在发送前的预览卡上点一下那个开关

评分不是必答题：你也可以把它设成"全部都混淆"或"全部都不混淆"。
默认是"只混淆评分高的图"，这个默认在设置里能改。

## 装哪个

| 你在哪用 Discord | 装什么 | 怎么装 |
| --- | --- | --- |
| Chrome | `moeguard-chrome-x.y.z.zip` | 解压，扩展页开开发者模式，加载已解压的扩展程序 |
| Edge | `moeguard-edge-x.y.z.zip` | 同上 |
| Firefox | `moeguard-firefox-x.y.z.zip` | 解压，`about:debugging` 临时载入 manifest.json |
| 任意浏览器 + 油猴 | `moeguard.user.js` | Tampermonkey 新建脚本，全选粘贴 |
| Equicord | `moeguard-equicord-x.y.z.zip` | 解压到 Equicord 的 src/userplugins，重新构建 |
| 安卓 | `MoeGuard-Android-*.apks` | 见下 |

安卓包是改过的 Discord 客户端，不是插件：它基于 Discord 354012 改的，
Discord 官方一更新就可能失效。装之前先备份应用数据，装错了登不回去别找我。
它做的事和网页版一样：发图前混淆、收图时自动还原、自己的图也走还原、下载直接存还原后的图。

## 已知限制

- 只处理 PNG 和 JPEG，单张上限 32 MiB
- 动图（GIF / 动态 WebP）不处理，原样发出去
- 混淆后体积会变大，图片尺寸会补到分块边界，可能比原图大一圈
- 对方的 Discord 需要装同版本插件才能看到原图；版本差太多可能解不出来
- 网页端用的是"先扣住上传、按发送时再放行"的做法，所以你选图后预览卡的进度条会停在 0%，按发送才开始传。这是正常的，不是卡死

## 风险

改 Discord 客户端行为本身违反 Discord 服务条款（修改客户端 / 使用未授权第三方软件）。
实际执法上，同类客户端 mod（BetterDiscord、Vencord）用户量比这个大得多，
公开记录里没有单纯因为用 mod 被封号的，被封的都是拿它做 API 滥用、自动化、self-bot 那类事。
但这句话不是保证，账号风险自己判断，后果自己承担。

## 开发

```
node build.js            # Chrome / Edge / Firefox 三个 zip + 解压目录
node build-user.js       # 油猴单文件 dist/moeguard.user.js
node build-equicord.js   # Equicord 插件包
node dev/audit-6.js <android.apks> <输出目录>   # 六个产物的一致性审查
node tests/core.test.js         # 混淆算法单测
node tests/send-intent.test.js  # 发送/双回车回归
node tests/upload-lifecycle.test.cjs  # 上传放行与失败回退
```

版本号只有一个来源：`manifest.json`。其他文件都从它读。

## 许可

GPL-3.0。算法与实现说明见 [CHANGELOG.md](CHANGELOG.md) 和源码。
