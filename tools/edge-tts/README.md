# tools/edge-tts · 语音播报引擎(微软神经语音,在线)

FleetDeck 的「语音播报」原本走 piper(`tools/piper/`),中文只有
`zh_CN-huayan-medium` 一个模型,机器味重。这里把它换成 **edge-tts**(微软
Edge 浏览器的神经语音:免费、免注册、国内直连),音色即真人级——当前用
**晓晓(温柔女声)**,试听在 `E:\tide-commander\tts-audition\`。

```
浏览器 useTTS → POST /api/tts/speak
  → 服务端 tts.ts spawn('piper', --model …, --output_file …, [--rate …, --volume …])
  → tools/piper/piper.exe(本目录垫片,顶替了原版 piper)
  → 本进程直接 edge-tts 合成 → ffmpeg 转 WAV → 返回
```

- 服务端代码**零改动**(tts.ts 的 `resolvePiperBin()` 就找 `tools/piper/piper.exe`);
- **单次合成、无常驻进程**:垫片每次播报现起现退,不占常驻内存;代价是每句
  多 ~0.5s 的 edge-tts import 时间,实测每句 ~1.6-2.0s;
- 原版 piper 保留为 `tools/piper/piper_real.exe`:断网 / 接口失效时,垫片
  **原样回退**执行它(`--rate/--volume` 会先剥离,rate 非 0 映射为
  `--length_scale = 1/(1+rate/100)`;最坏 = 原来的机器音,绝不更差);
- 嫌慢可以加回常驻服务(git 历史 `f6193d4a` 有实现:常驻 ~52MB 内存,每句快 ~0.5s)。

## 目录

| 路径 | 作用 |
| --- | --- |
| `shim/` | `piper.exe` 兼容垫片(解析 `--model/--output_file/--rate/--volume` + stdin,本进程合成) |
| `voices.json` | 语言 → 音色映射(入库默认) |
| `voices.local.json` | 顶栏话筒弹窗「文字转语音」写入的用户覆盖:音色 + 语速/音量(gitignore;不存在 = 用 voices.json) |
| `venv/` | Python venv(edge-tts 7.2.8) |
| `shim.log` | 排障日志(gitignore) |

## 当前音色(voices.json)

| 语言 | 音色 |
| --- | --- |
| zh | `zh-CN-XiaoxiaoNeural`(晓晓·温柔女声) |
| en | `en-US-JennyNeural` |
| es | `es-MX-DaliaNeural` |

换音色:**在顶栏话筒弹窗 →「文字转语音」标签里直接选**(中文 14 个:晓晓/晓伊/云希/云扬/方言/粤语/台湾,另有英文、西语;每行带「试听」)。

- 保存写入 `voices.local.json`,垫片读取优先级:`voices.local.json` > `voices.json`(删除 local 文件 = 恢复默认);
- 「试听」= 先保存当前选择、再播放该语言样句(浏览器直接播,走完整 tts.ts → 垫片链路);
- 手工改 `voices.json` 仍有效(兜底默认),但工具箱一旦保存过,local 会盖过它;
- 全量音色名: `venv/Scripts/python.exe -m edge_tts --list-voices` 查;临时试音色可
`set EDGE_TTS_VOICE=zh-CN-XiaoyiNeural` 再跑一次(不改配置文件)。
语言由 `--model` 文件名前缀决定(如 `zh_CN-huayan-medium.onnx` → `zh`),
这也是 tts.ts 自动检测语言后传入的。

## 语速与音量

- 范围 `-100..100`(百分数,`10` = 快 10%),`0` = 原速原音量;
- 优先级:**CLI `--rate/--volume`(如工具箱「试听」即时传参)> `voices.local.json` 的
  `rate/volume` 字段 > 0**;旧版 voices.local.json 没有这两个字段 = 默认,无需迁移;
- 落点:顶栏话筒弹窗 →「文字转语音」标签里的两行输入框,与音色存在同一份文件里一起保存;
- 垫片把百分数转成 edge-tts 需要的 `"+10%"/"-5%"` 形式,传入
  `edge_tts.Communicate(voice, rate=…, volume=…)`;
- 回退 piper_real 时新参先剥离,rate 映射 `--length_scale = 1/(1+rate/100)`
  (钳 [0.25,4]);piper 本无音量参数,音量在回退路径**不生效**(可接受:回退本身已是兜底);
- 冒烟:`printf '测试。' | tools/piper/piper.exe --model tools/piper/voices/zh_CN-huayan-medium.onnx --output_file D:/tools/t.wav --rate +20% --volume -10%`,
  看 `shim.log` 里的 `rate=+20% volume=-10%`。

## 依赖与外部性

- **ffmpeg**(mp3→wav):借 `tools/whisper/ffmpeg/bin/ffmpeg.exe`,缺失时找 PATH;
- 文本会发送到微软服务器(edge-tts 走 Edge 的语音接口,**非官方 API**,微软改动
  接口时需 `pip install -U edge-tts` 更新);要完全离线得换本地大模型 TTS。
- **403 速查(2026-10-14 实例)**:`shim.log` 出现 `WSServerHandshakeError: 403 ...
  speech.platform.bing.com` 而列音色端点仍正常(`edge_tts.list_voices()` 能返回 322 条)
  → 网络没断,是**库版本太旧被微软在合成端点上卡了最低客户端版本**。升级即解(7.2.8→7.3.1 一次通):
  `tools/edge-tts/venv/Scripts/python.exe -m pip install -U edge-tts -i https://pypi.tuna.tsinghua.edu.cn/simple`
  。注意症状伪装:合成失败会**静默回退 piper**(本地只有一个中文声),界面上表现为
  「所有音色听起来同一个声音」——排障第一步永远是先看 `shim.log` 有没有 `fallback -> piper_real.exe`。

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

- 本目录**源码入库**;`venv/`、日志、`voices.local.json` gitignore(同 `tools/whisper/` 先例);
- piper 本体(`tools/piper/`,159MB)依旧永不提交,`piper_real.exe` 亦然;
- 垫片日志 `shim.log` 会记录每次合成(ok)与回退原因,排障先看它;
- `tools/piper/voices/es_MX-claude-high.onnx` 是**空占位文件**(作者未装西语 piper 模型,
  tts.ts 只做存在性检查):在线合成不读模型文件,西语同样走 edge-tts;离线回退 piper 时
  西语照旧不可用(与放占位前一致,无回归)。
