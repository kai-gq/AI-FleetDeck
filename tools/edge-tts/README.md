# tools/edge-tts · 语音播报引擎(微软神经语音,在线)

Tide Commander 的「语音播报」原本走 piper(`tools/piper/`),中文只有
`zh_CN-huayan-medium` 一个模型,机器味重。这里把它换成 **edge-tts**(微软
Edge 浏览器的神经语音:免费、免注册、国内直连),音色即真人级——当前用
**晓晓(温柔女声)**,试听在 `E:\tide-commander\tts-audition\`。

```
浏览器 useTTS → POST /api/tts/speak
  → 服务端 tts.ts spawn('piper', --model …, --output_file …)   ← 一行未改
  → tools/piper/piper.exe(本目录垫片,顶替了原版 piper)
  → 本进程直接 edge-tts 合成 → ffmpeg 转 WAV → 返回
```

- 服务端代码**零改动**(tts.ts 的 `resolvePiperBin()` 就找 `tools/piper/piper.exe`);
- **单次合成、无常驻进程**:垫片每次播报现起现退,不占常驻内存;代价是每句
  多 ~0.5s 的 edge-tts import 时间,实测每句 ~1.6-2.0s;
- 原版 piper 保留为 `tools/piper/piper_real.exe`:断网 / 接口失效时,垫片
  **原样回退**执行它(最坏 = 原来的机器音,绝不更差);
- 嫌慢可以加回常驻服务(git 历史 `f6193d4a` 有实现:常驻 ~52MB 内存,每句快 ~0.5s)。

## 目录

| 路径 | 作用 |
| --- | --- |
| `shim/` | `piper.exe` 兼容垫片(解析 `--model/--output_file` + stdin,本进程合成) |
| `voices.json` | 语言 → 音色映射(改这里换声音,不用动代码) |
| `venv/` | Python venv(edge-tts 7.2.8) |
| `shim.log` | 排障日志(gitignore) |

## 当前音色(voices.json)

| 语言 | 音色 |
| --- | --- |
| zh | `zh-CN-XiaoxiaoNeural`(晓晓·温柔女声) |
| en | `en-US-JennyNeural` |
| es | `es-MX-DaliaNeural` |

换音色:改 `voices.json` 即可;音色名用
`venv/Scripts/python.exe -m edge_tts --list-voices` 查;临时试音色可
`set EDGE_TTS_VOICE=zh-CN-XiaoyiNeural` 再跑一次(不改配置文件)。
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
# 每句 ~1.6-2.0s;D:/tools/t.wav 应为正常 WAV,听感即晓晓
```

## 备注

- 本目录**源码入库**;`venv/`、日志 gitignore(同 `tools/whisper/` 先例);
- piper 本体(`tools/piper/`,159MB)依旧永不提交,`piper_real.exe` 亦然;
- 垫片日志 `shim.log` 会记录每次合成(ok)与回退原因,排障先看它。
