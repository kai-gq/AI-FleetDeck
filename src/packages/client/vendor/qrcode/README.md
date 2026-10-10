# qrcode-generator（vendored，勿手改）

微信 ClawBot 扫码绑定需要把腾讯返回的 `qrcode_img_content` 短链渲染成二维码。
本仓不装 npm QR 依赖（package.json 属上游高频施工区，见 `.claude/CLAUDE.md`），
故将上游库的 **TypeScript 源码** 两个文件原样 vendor 进本目录。

- 上游：<https://github.com/kazuhikoarase/qrcode-generator> · npm 包 `qrcode-generator@2.0.4`
- 许可：MIT（原文见 `LICENSE.txt`，Copyright (c) 2009 Kazuhiko Arase）
- 来源文件：`experiment/vt/src/main/qrcode.ts`、`experiment/vt/src/main/types.ts`
  （官方 TS 源码，上游 tsconfig 开 `strict`，可直接过本仓 `tsc --noEmit`）

## 获取方式（更新时重跑）

```bash
curl -sL "https://cdn.jsdelivr.net/npm/qrcode-generator@2.0.4/experiment/vt/src/main/qrcode.ts" -o qrcode.ts
curl -sL "https://cdn.jsdelivr.net/npm/qrcode-generator@2.0.4/experiment/vt/src/main/types.ts" -o types.ts
```

## 校验（sha256）

| 文件 | sha256 |
|---|---|
| `qrcode.ts` | `50bc112ef0bbdde915eacb247dfe1833eeaa26ace60b505289b8b9b4265f90cc` |
| `types.ts` | `22aaa5198dd68833470618c081dee2af30320329624127de0bc61a3abd61031d` |

更新流程：改版本号重新下载 → 更新上表 sha256 → `npx tsc --noEmit` +
`npx vitest run src/packages/client/utils/wechatQr.test.ts` 必须全绿。

## 注意

- 上游默认 `qrcode.stringToBytes` 只做 ISO-8859-1 截断（`c & 0xff`），非 ASCII
  内容会乱码；`src/packages/client/utils/wechatQr.ts` 在模块加载时将其覆盖为
  UTF-8 编码（`qr8BitByte` 在 `addData` 时动态读取，覆盖生效）。
- 本包 `"type": "module"`，npm 包里的 UMD `qrcode.js` 版（`module.exports`）在此
  环境不可用，必须用上述 TS 源码。
- `qrcode.typeNumber = 0` 为自动版本选择；`addData(data, mode)` 类型声明要求
  显式传 `mode`（运行时默认 `'Byte'`），调用处一律传 `'Byte'`。
