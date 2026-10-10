# tools/whisper · 本地语音转文字(STT)引擎栈

应用内「语音输入」(录音 → 转文字)**默认走本机 whisper**(离线);可选用
**云通道**(火山引擎批量识别,中文更准,失败自动回退本地,见下):

```
客户端 useSTT.ts 录音(webm/opus)
  → POST /api/stt/transcribe
  → 服务端 routes/stt.ts ─┬─(可选)云通道:ffmpeg 转 PCM16k → 火山引擎
                          │   (凭据复用「语音伙伴」config.json,services/stt-volcengine.ts)
                          └─ spawn('whisper', …) → whisper.exe(本目录 shim)
                              → 常驻转写服务 server.py(模型常驻显存)
```

本目录 = 本地引擎的全部文件 —— 和 `tools/piper/`(TTS)同一个思路:
本地跑、免费、离线、语音不出本机。云通道 2026-10-10 起**上移 TC 服务端**
(统一到火山引擎,垫片不再直连云),本目录的 `cloud.json` 只剩模式开关。

## 目录

| 路径 | 作用 |
| --- | --- |
| `venv/` | Python 3.14 venv:torch 2.9.1+cu128(GPU)+ openai-whisper |
| `ffmpeg/bin/ffmpeg.exe` | whisper 解码 webm/opus 必需(ffmpeg 4.1) |
| `models/large-v3-turbo.pt` | turbo 模型(≈1.6GB);`~/.cache/whisper` junction 到此 |
| `server.py` | **常驻转写服务**(模型只加载一次;HTTP 127.0.0.1:17128) |
| `shim/` | 小包:安装后提供 `whisper.exe`,把 CLI 调用转发给常驻服务(云通道已上移服务端) |
| `cloud.json` | 云通道模式开关(只剩 `{mode}`;**服务端读取**,垫片不再读;gitignore,模板见 `cloud.example.json`) |
| `server.log` | 服务日志(排障先看这里) |
| `_dl/` | 下载 / 测试临时文件(可随手删) |

`venv/` `ffmpeg/` `models/` `_dl/` `server.log` `cloud.json` 均已 gitignore,不入库。

## 为什么需要 shim + 常驻服务(延迟)

作者原版是「**每次**语音输入 spawn 一个**全新** whisper 进程」,每次都要重新
导入 torch、把 1.6GB 模型加载进显存 —— 冷启动合计 ≈ 30 秒,而**转写本身只要
~0.5 秒**(19 倍实时)。这是作者设计的固有成本,不是本机配置问题
(GPU 实测 11.5 TFLOPS、SM 2805MHz,完全健康;慢的全是进程一次性开销)。

本目录的做法:

- `server.py` 常驻,模型加载一次后一直留在显存 → 之后每次转写 **≈1 秒**;
- `whisper.exe` 是 shim:把调用转发给服务,并按 CLI 约定写出 `<base>.txt`,
  所以 `stt.ts` 和 `audio-transcription.ts` **一行都不用改**
  (集成路径 WhatsApp/Slack 语音同样受益);
- 服务**空闲 15 分钟自动退出**,释放显存;下次使用自动拉起;
- 任何一步失败(服务起不来、参数形状不认识)→ shim **原地回退真正的 CLI**,
  最坏情况 = 原版行为,绝不会更差。

内存 / 显存:服务常驻约占 **显存 ~2GB、内存 ~1.5GB**;不用语音 15 分钟后归零。
想更省:调短 `server.py --idle-timeout`,或换 `small` 模型(`--model small`,
显存 ~0.9GB,中文准确率会降)。

## 它靠什么被找到(三条链路)

1. **`whisper` 命令** — 服务端 `spawn('whisper')` 靠 **PATH** 解析,指到
   `tools/whisper/venv/Scripts/whisper.exe`(即 shim)
2. **ffmpeg** — whisper 内部再调 `ffmpeg` 解码音频,同样走 PATH
   (server.py 启动时也会自愈 PATH,双保险)
3. **模型** — whisper 在 `~/.cache/whisper/` 找;已建 **junction** 指向本目录 `models/`

所以 PATH 里要加这两个目录(**加完必须重启 Tide Commander 服务**,进程启动时才读 PATH):

```
E:\tide-commander\tide-commander\tools\whisper\venv\Scripts
E:\tide-commander\tide-commander\tools\whisper\ffmpeg\bin
```

加 PATH 用本目录的 `add_path.ps1`(幂等,只改当前用户,重复执行安全;
目录按脚本位置推导——仓库挪动后在新位置重跑即可)。由你亲自执行:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\whisper\add_path.ps1
```

看到 `ADDED: ...` 或 `ALREADY_PRESENT` 即成功,**必须重启 Tide Commander** 生效。

## 日常使用

- 什么都不用管:应用里按麦克风说话即可。**第一次 ~10 秒**(拉起服务 + 加载
  模型 + 预热),之后每次 **~1 秒**。
- 看服务状态:`curl.exe http://127.0.0.1:17128/health`(返回模型、空闲秒数、PID)
- 排障:看 `server.log`;确认 shim 在位:`whisper --shim-version`
- 想立刻释放显存:`netstat -ano | findstr 17128` 找 PID → `taskkill /PID <pid>`

## 参数约定

- `--model turbo`(large-v3-turbo):8GB 显存下速度/准确率的最优解;
  想更准可换 `large-v3`(3.1GB、速度约 1/3)
- `--language Chinese`:客户端两处调用(useSTT 默认值 + VoiceAssistant /
  TerminalInputArea 显式传参)写死中文;作者原版默认 `Spanish` 属遗留。
  whisper 会把混在中文里的英文术语(如 `git commit`)原样保留

## 云通道(可选:火山引擎批量识别,云优先 + 本地兜底)

本地 whisper 用 `turbo` 蒸馏模型,中文短句准确率一般。云通道 = **火山引擎
「大模型流式语音识别」**,由 TC 服务端调用(`services/stt-volcengine.ts`,
复用已验证的 `VolcengineAsrSession` 协议客户端:把整段音频喂完再收末包,
当批量用),**凭据复用「语音伙伴」的 `tools/voice-companion/config.json`**
(`stt.volcengine` 一节)—— 与流式转写同一家供应商、同一套凭据。

`cloud.json` 只剩模式开关(不存在 = auto,行为与以前一样):

```json
{ "mode": "auto" }
```

| mode | 行为 |
| --- | --- |
| `auto`(默认) | 有火山凭据 → 云优先;任何云失败(断网/握手失败/超时)→ 回落到本地 whisper |
| `local` | 完全离线,行为不变 |
| `cloud` | 只走云;失败 → 报错,**不回退**(避免"以为在云上实际在本地");无凭据时退化为本地 |

- **配凭据**:工具箱 → **语音伙伴**(火山引擎 stt.volcengine,apiKey 或
  appId+accessToken);「语音转文字」区块只显示「已配置/未配置」状态
- **改模式**:工具箱 → 语音(引擎模式),或手改本文件;`mode: local`(或删掉文件)= 纯本地
- 云路径细节:服务端先用本地 ffmpeg 把录音转 **PCM16LE/16k/单声道** 再喂
  火山(录音是 webm/opus,火山不收);此时 CLI 的 `--language`/`--model`
  不参与云识别;单次整体超时 30s(自动模式超时即回退)
- **隐私**:云通道会把语音上传火山引擎;`auto` 断网/失败时落回本地
- **声纹门禁跟随**:会话带「只认主人」门禁(与语音伙伴同一套判定;未注册
  声纹 = 放行,判拒 → 空结果)
- 集成路径(WhatsApp/Slack 语音转写)同款决策(services/audio-transcription.ts);
  注意 `audio-transcription.ts` 会把结果缓存成 `.txt`,重转需先删缓存
- 排障:服务端日志搜 `[STT]`(volcengine-batch 埋点在活动日志)

## 重建(换机器 / 清理后)

```bash
# 1) venv(用本机已有的 Python;torch 走官方 CUDA 源,依赖走清华镜像)
python -m venv tools/whisper/venv
tools/whisper/venv/Scripts/python.exe -m pip install "torch==2.9.1+cu128" \
  --index-url https://download.pytorch.org/whl/cu128 \
  --extra-index-url https://pypi.tuna.tsinghua.edu.cn/simple
tools/whisper/venv/Scripts/python.exe -m pip install openai-whisper \
  -i https://pypi.tuna.tsinghua.edu.cn/simple

# 2) ffmpeg(GitHub 直连/ghfast 都慢,npmmirror 的 npm 包秒下)
curl -Lo /tmp/ffmpeg.tgz https://registry.npmmirror.com/@ffmpeg-installer/win32-x64/-/win32-x64-4.1.0.tgz
tar -xzf /tmp/ffmpeg.tgz
mkdir -p tools/whisper/ffmpeg/bin && cp package/ffmpeg.exe tools/whisper/ffmpeg/bin/

# 3) 模型(1.6GB,断点续传;直连 azureedge ≈ 1.7MB/s,约 15 分钟)
curl -L -C - -o tools/whisper/models/large-v3-turbo.pt \
  https://openaipublic.azureedge.net/main/whisper/models/aff26ae408abcba5fbf8813c21e62b0941638c5f6eebfb145be0c9839262a19a/large-v3-turbo.pt

# 4) 模型缓存 junction(whisper 只认 ~/.cache/whisper)
cmd //c mklink /J "%USERPROFILE%\.cache\whisper" "<绝对路径>\tools\whisper\models"

# 5) shim(提供 whisper.exe → 转发给常驻服务;项目挪目录后需重跑)
tools/whisper/venv/Scripts/python.exe -m pip install -e tools/whisper/shim --no-deps
```

## 验证

```bash
# GPU 可用?
tools/whisper/venv/Scripts/python.exe -c "import torch; print(torch.cuda.is_available())"

# whisper.exe 是不是 shim?(原版 CLI 不认这个参数)
tools/whisper/venv/Scripts/whisper.exe --shim-version

# 端到端(生成一段语音 → 转写;首次 ~10s 拉起服务,再跑一次应 ~1s)
powerShell -c "Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).SetOutputToWaveFile('t.wav')"
tools/whisper/venv/Scripts/whisper.exe t.wav --model turbo --language Chinese --output_format txt --output_dir .

# 云通道自检(语音伙伴里配好火山凭据):对 /api/stt/transcribe 发一段 wav,
# 返回应带 engine:"volcengine";mode 改 cloud 后把 apiKey 写坏,应 500 且不回退本地
```

## 常见问题

- **语音输入 500 / `spawn whisper ENOENT`** → PATH 没加或没重启 Tide Commander
  (进程启动时才读 PATH);照上面「三条链路」检查
- **每次都要 30 秒** → 常驻服务没起来:看 `server.log` 有没有报错(端口被占、
  预加载失败);手动跑 `venv\Scripts\python.exe tools/whisper/server.py` 看输出
- **升级过 openai-whisper 后变慢** → `pip install -U openai-whisper` 会把
  whisper.exe 覆盖回原版,重跑上面第 5)步即可
- **`whisper --shim-version` 报 unrecognized arguments** → 同上,shim 没装/被覆盖

## 背景

作者原版没有随附 whisper:装了才可用,且每次调用都是冷启动进程(见上,`git log`
里 `stt.ts` 仅作者两个提交,该设计自 STT 功能引入起未变)。本目录是本地补全:
引擎装在项目内、PATH 指过来,应用代码**零改动**(仅客户端两处默认值
`Spanish` → `Chinese`、`medium` → `turbo`,见 git log)。
