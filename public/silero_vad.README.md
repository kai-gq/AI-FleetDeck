# silero_vad.onnx(前端语音判停小模型)

「语音伙伴」的**判停引擎**在 `auto`/`model` 模式下加载本文件,用 Silero VAD 在浏览器本地
判断「这段音频是不是人声」,替代纯能量的阈值迟滞(嘈杂环境误触发更少、短口令更准)。
加载失败或用户选择 `energy` 时自动回退能量判停,聆听不会中断。

## 文件信息

| 项 | 值 |
| --- | --- |
| 来源 | https://github.com/snakers4/silero-vad (tag `v5.1.1`,路径 `src/silero_vad/data/silero_vad.onnx`) |
| 下载(镜像) | `https://ghfast.top/https://raw.githubusercontent.com/snakers4/silero-vad/v5.1.1/src/silero_vad/data/silero_vad.onnx` |
| 大小 | 2,327,524 字节 |
| SHA-256 | `2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f` |
| 许可 | MIT(模型与代码同仓) |

## 接口约定(16k 采样率,已实测)

- 输入:`input` f32 `[1, 576]`(576 = **64 上下文 + 512 跳距**,只喂 512 会失真)、
  `state` f32 `[2, 1, 128]`(LSTM 状态,随窗回灌)、`sr` int64 标量 `16000`;
- 输出:`output` f32 `[1, 1]`(语音概率 0–1)、`stateN` f32 `[2, 1, 128]`(下一窗状态)。

接线代码:`src/packages/client/voice/sileroVadCore.ts`(纯逻辑,可单测)+
`src/packages/client/voice/sileroVad.ts`(onnxruntime-web 胶水)。

## 更新方法

换版本时同步更新本 README 的 tag/大小/SHA-256,并跑一遍
`npx vitest run src/packages/client/voice/sileroVadCore.test.ts` 与设置面板的引擎状态提示
(就绪 → 正常;失败 → 应回退能量且提示「小模型加载失败」)。
