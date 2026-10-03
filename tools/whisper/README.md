# tools/whisper · 本地语音转文字(STT)引擎栈

应用内「语音输入」(录音 → 转文字)**默认走本机 whisper**(离线);可选用
**云通道**(硅基流动 SenseVoice,中文更准,失败自动回退本地,见下):

```
客户端 useSTT.ts 录音(webm/opus)
  → POST /api/stt/transcribe
  → 服务端 src/packages/server/routes/stt.ts spawn('whisper', …)
  → whisper.exe(本目录 shim)─┬─(可选)云通道:ffmpeg 转 wav → 硅基流动 SenseVoice
                              └─ 本地:常驻转写服务 server.py(模型常驻显存)
```

本目录 = 这套引擎的全部文件 —— 和 `tools/piper/`(TTS)同一个思路:
本地跑、免费、离线、语音不出本机、**应用代码零改动**(云通道同理,只加垫片逻辑)。

## 目录

| 路径 | 作用 |
| --- | --- |
| `venv/` | Python 3.14 venv:torch 2.9.1+cu128(GPU)+ openai-whisper |
| `ffmpeg/bin/ffmpeg.exe` | whisper 解码 webm/opus 必需(ffmpeg 4.1) |
| `models/large-v3-turbo.pt` | turbo 模型(≈1.6GB);`~/.cache/whisper` junction 到此 |
| `server.py` | **常驻转写服务**(模型只加载一次;HTTP 127.0.0.1:17128) |
| `shim/` | 小包:安装后提供 `whisper.exe`,把 CLI 调用转发给服务(或云通道) |
| `cloud.json` | 云通道配置(模式 / API key;**含密钥,gitignore**,模板见 `cloud.example.json`) |
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

加 PATH 的命令(PowerShell,只改当前用户,重复执行安全):

```powershell
$p=[Environment]::GetEnvironmentVariable('Path','User')
$add='E:\tide-commander\tide-commander\tools\whisper\venv\Scripts;E:\tide-commander\tide-commander\tools\whisper\ffmpeg\bin'
if ($p -notlike "*tools\whisper\venv\Scripts*") { [Environment]::SetEnvironmentVariable('Path', $p + ';' + $add, 'User') }
```

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

## 云通道(可选:硅基流动 SenseVoice,云优先 + 本地兜底)

本地 whisper 用 `turbo` 蒸馏模型,中文短句准确率一般。云通道接硅基流动的
**SenseVoiceSmall**(中文明显更准、免模型加载秒级返回、目前免费),失败
自动回退本地。配置在 `cloud.json`(不存在 = 纯本地,行为与以前完全一样):

```json
{ "mode": "auto", "provider": "siliconflow", "apiKey": "sk-…", "model": "FunAudioLLM/SenseVoiceSmall" }
```

| mode | 行为 |
| --- | --- |
| `auto`(默认) | 配了 key → 云优先;任何云失败(断网/401/超时)→ 回落本地服务 |
| `local` | 完全离线,行为不变 |
| `cloud` | 只走云;无 key / 未支持的 provider / 失败 → 报错退出,**不回退**(避免"以为在云上实际在本地") |

- **拿 key**:siliconflow.cn 注册(免费、不绑卡)→ API 密钥页生成 `sk-…`;
  在应用里 **工具箱 → 语音转文字** 直接填(会写进本文件),或手改本文件
- **改模式也可以手改本文件**;`mode: local`(或删掉文件)= 回到纯本地
- 云路径细节:上传前先用本地 ffmpeg 把录音转 **16kHz 单声道 wav**
  (云 API 的格式列表不含 webm);此时 CLI 的 `--language`/`--model` 被忽略
  (SenseVoice 自动识别语言,模型以本文件为准);单次请求超时 10s
- **隐私**:只有云通道会把语音上传到硅基流动;`auto` 断网时会落回本地
- 集成路径(WhatsApp/Slack 语音转写)走的也是同一垫片,同样吃云通道;
  注意 `audio-transcription.ts` 会把结果缓存成 `.txt`,重转需先删缓存
- 排障:垫片把云通道结果/失败原因都打到 stderr(`云端转写完成/失败 …`)

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

# 云通道自检(先在 cloud.json 配好 key):stderr 应显示「云端转写完成 …」;
# 把 mode 改 cloud 再故意写坏 key,应报 HTTP 401 且不产出 txt(不回退)
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
