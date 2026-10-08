# 声纹门禁「只认主人」工具

给语音伙伴大脑加一道声纹门:**只有你自己的声音能进大脑**,家人说话、电视背景音被静默丢弃(转写一闪即消,不产生回合、不播报)。

原理:火山 SAUC 大模型流式识别自带的「短音频声纹识别(ssd_mode=2)」——建会话时带上已注册声纹 ID,服务端对每段话返回说话人标识;TC 服务端比对:
- 命中本人 → 放行(正常应答);
- 明确不是本人 → 丢弃(空 final,大脑全程不知道这段存在);
- 拿不到说话人信息(极短句/资源不支持)→ 放行(fail-open,防误伤「嗯/好」)。

## 工具一览

| 文件 | 作用 |
| --- | --- |
| `enroll.mjs` | 录音/选文件 → 上传托管 → 调云端注册接口 → 写 `tools/voice-companion/voiceprint.local.json`(enabled=true) |
| `status.mjs` | 查看本地配置 + 云端注册状态;`--off`/`--on` 开关;`--list` 列表;`--delete` 软删 |
| `probe.ts` | 用本地 wav 走真实识别链路,打印「声纹判定」日志(注册后先验一遍,不用人对着麦说话) |

## 用法

```bash
# 1) 注册(用平时对电脑说话的同一支麦克风,正常说 20 秒)
node tools/voiceprint/enroll.mjs --record

#    已有录音文件也可以(自动转 16k 单声道)
node tools/voiceprint/enroll.mjs --file 某段话.wav
#    不想走临时文件床托管,自己传一个公网可下载 URL
node tools/voiceprint/enroll.mjs --file 某段话.wav --url https://example.com/me.wav

# 2) 验证(可选但推荐):本地探一遍,看日志里 speaker_id 与判定
npx tsx tools/voiceprint/probe.ts --file tools/voiceprint/samples/<刚录的>.wav

# 3) 正常用语音伙伴说话 → TC 服务端日志出现「声纹判定 matched/rejected/unknown」

# 回滚(立即生效,下一句话起)
node tools/voiceprint/status.mjs --off
#    或直接删掉 tools/voice-companion/voiceprint.local.json
```

## 重要提醒

- **同一支麦克风**:注册用的设备要和平时说话的设备一致(耳机/音箱换着用会掉准确率;官方明确)。录音前先在 TC 里关掉语音聆听,否则麦克风被占用会录音失败。
- **采样时长 5~30 秒**;说话内容不重要,自然说满即可。
- **隐私**:采样默认会短暂上传到临时文件床(litterbox,1 小时后自动删)让云端拉取注册;介意就用 `--url` 自己传。
- **绝不打印密钥**:工具读 `tools/voice-companion/config.json` 的 `stt.volcengine.apiKey`,只用于请求头。

## 配置与开关

`tools/voice-companion/voiceprint.local.json`(gitignored,每段话建会话时现读):

```json
{
  "enabled": true,
  "speakId": "……",
  "speakerName": "主人",
  "groupId": "可选",
  "ssdVersion": "可选,如 200"
}
```

- 文件不存在 = 门禁未启用 → 识别链路逐字节同旧版(零风险回滚)。
- 端点必须是 `bigmodel_async`(短音频声纹要求二遍链路);其它端点自动跳过并在日志提示。
- `ssdVersion`:部分资源需要该字段才返回说话人信息,按 spike 结果配置。

## 已知局限(v1)

- 门禁只管「进大脑」;别人说话仍可能触发客户端 VAD 打断(bargeIn)正在播报的语音。
- 段级判定:同一段里混了两个人的话(几乎只有 VAD 没切开时)→ 命中本人即整段放行。
- `<1s` 的极短句难提取声纹特征 → 服务端可能不给说话人信息 → fail-open 放行。
- 预生成垫话(慢档/静态池)在判定前就跑了;默认静态池不读内容、不进大脑。
