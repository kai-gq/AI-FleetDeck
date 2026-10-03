# tools/edge-tts · 语音播报引擎(微软神经语音,在线)

Tide Commander 的「语音播报」原本走 piper(`tools/piper/`),中文只有
`zh_CN-huayan-medium` 一个模型,机器味重。这里把它换成 **edge-tts**(微软
Edge 浏览器的神经语音:免费、免注册、国内直连),音色即真人级——当前用
**晓晓(温柔女声)**,试听在 `E:\tide-commander\tts-audition\`。

```
浏览器 useTTS → POST /api/tts/speak
  → 服务端 tts.ts spawn('piper', --model …, --output_file …)   ← 一行未改
  → tools/piper/piper.exe(本目录垫片,顶替了原版 piper)
  → HTTP 127.0.0.1:17129(本目录 server.py 常驻服务)
  → edge-tts(微软在线神经语音)→ mp3 → ffmpeg 转 WAV → 返回
```

- 服务端代码**零改动**(tts.ts 的 `resolvePiperBin()` 就找 `tools/piper/piper.exe`);
- 原版 piper 保留为 `tools/piper/piper_real.exe`:服务起不来 / 断网 / 接口失效时,
  垫片**原样回退**执行它(最坏 = 原来的机器音,绝不更差,代价 ~8s);
- 常驻服务空闲 30 分钟自动退出,下次播报自动拉起;
- 实测:热播报 ~1.4s,服务被清掉的首次 ~3.3s;whisper 反听一字不差。

## 目录

| 路径 | 作用 |
| --- | --- |
| `server.py` | 常驻合成服务(127.0.0.1:17129,`GET /health`、`POST /synth`) |
| `shim/` | `piper.exe` 兼容垫片(解析 `--model/--output_file` + stdin,转发服务) |
| `voices.json` | 语言 → 音色映射(改这里换声音,不用动代码) |
| `venv/` | Python venv(edge-tts 7.2.8) |
| `server.log` / `shim.log` | 排障日志(均 gitignore) |

## 当前音色(voices.json)

| 语言 | 音色 |
| --- | --- |
| zh | `zh-CN-XiaoxiaoNeural`(晓晓·温柔女声) |
| en | `en-US-JennyNeural` |
| es | `es-MX-DaliaNeural` |

换音色:改 `voices.json` 即可;音色名用
`venv/Scripts/python.exe -m edge_tts --list-voices` 查。
语言由 `--model` 文件名前缀决定(如 `zh_CN-huayan-medium.onnx` → `zh`),
这也是 tts.ts 自动检测语言后传入的。

## 依赖与外部性

- **ffmpeg**(mp3→wav):借 `tools/whisper/ffmpeg/bin/ffmpeg.exe`,缺失时找 PATH;
- 文本会发送到微软服务器(edge-tts 走 Edge 的语音接口,**非官方 API**,微软改动
  接口时需 `pip install -U edge-tts` 更新);要完全离线得换本地大模型 TTS。

## 重建(换机器 / 清理后)

```bash
python -m venv tools/edge-tts/venv
tools/edge-tts/venv/Scripts/python.exe -m pip install edge-tts -i https://pypi.tuna.tsinghua.edu.cn/simple
tools/edge-tts/venv/Scripts/python.exe -m pip install -e tools/edge-tts/shim --no-deps
# 安装垫片到 piper 的调用位置(原版改名兜底,只需做一次)
cp tools/edge-tts/venv/Scripts/piper.exe tools/piper/piper.exe
```

## 验证

```bash
printf '老板,任务完成了。' | tools/piper/piper.exe --model tools/piper/voices/zh_CN-huayan-medium.onnx --output_file D:/tools/t.wav
curl.exe -s http://127.0.0.1:17129/health
```

## 备注

- 本目录**源码入库**;`venv/`、日志 gitignore(同 `tools/whisper/` 先例);
- piper 本体(`tools/piper/`,159MB)依旧永不提交,`piper_real.exe` 亦然;
- 垫片实现细节:本机对**未监听端口**的 TCP 连接是超时(非秒拒),所以健康检查
  超时压到 0.5s、轮询 8×0.4s——调大这些值会把回退耗时放大到几十秒。
