# 语音伙伴(Voice Companion)

豆包风格的**持续语音助手**:开启后麦克风常开,说完自动断句;转写文本交给一个持久记忆的
语音大脑(`claude`,默认 Haiku)处理——查 agent 状态、读 agent 输出、给 agent 派活;
重要事件主动开口汇报。回复**边生成边按句播报**(首句一出就起声,不用等整段),
人设可在 顶栏话筒弹窗 →「语音伙伴」里换(预设 4 套 + 自定义)。全部逻辑在本机,
语音只在你开启时进入识别链路。

```
麦克风(常开)
  └─ 浏览器 VAD(能量 / 本地 Silero 小模型;静音判停 / 结束词 / 抢话)
       ├─ 流式: PCM16k 帧 ──▶ /ws/voice-companion ──▶ 火山引擎流式 ASR(实时上屏)
       └─ 回退: 分段录音 ────▶ /api/stt/transcribe(现有的本地/云批量转写)
                 │ 最终文本
                 ▼
        POST /api/voice-companion/process ──▶ 语音大脑(claude --resume,持久会话 + 记忆)
                 ▲                                  ├─ 查 agent 状态 / 读输出(两跳)
                 │                                  ├─ 派活给 agent(排队 / 明确急迫才打断)
    主动汇报(store 快照 diff + 定时巡查)─────────────┘
                 │
                 ▼
        分句流式播报(edge-tts·晓晓;模型边生成边播,首句先出声)+ 气泡上屏
```

## 快速开始

1. **打开开关**:顶栏话筒图标 →「语音伙伴」→ 打开「启用语音伙伴」→ 保存。
   左侧浮出麦克风圆钮,点一下开始常开聆听(再点一下关闭;播报中点击 = 打断播报)。
2. **(可选但推荐)接入火山引擎流式识别**:见下节。不填也能用——自动回退本机批量转写
   (`tools/whisper`),只是没有边说边出字。
3. **说话**:正常说完停下即可(默认静音 800ms 判定一句);也可以说结束词(默认
   「发送 / 完事了 / 就这些」)立即提交。回复会同时上屏 + 播报。

## 火山引擎流式识别(可选)

费用以火山控制台为准(通常新开通有免费额度)。音频只在**你说出话的时段**上传
(客户端 VAD 裁剪,不发静音),与直接用云 STT 的隐私面相同。

1. 注册/登录 [火山引擎](https://console.volcengine.com/) → 实名认证;
2. 开通「语音技术 → 大模型流式语音识别」;
3. 控制台取凭据(二选一):
   - 新版:**ApiKey**(填「ApiKey」一栏即可);
   - 旧版:**APP ID + Access Token**(两栏都填);
4. 填进 顶栏话筒弹窗 →「语音伙伴」→ 保存。凭据只写本机 `tools/voice-companion/config.json`
   (已 gitignore),不会进仓库、不会写日志。

改完即可验证(无需麦克风):

```bash
node tools/voice-companion/selftest.mjs 你的样例.wav
# 期望:ready → partial(实时增量)→ final
# partial 攒够 6 个字还会出现一行 filler hint(垫话预生成就绪,W7 协议消息),属正常
# 未配凭据时会明确报 no_credentials,客户端自动回退批量转写,功能不残
```

wav 任意采样率/声道/位深(PCM)都会自动转成 16k 单声道;`--url` 换服务端、`--token`
用于开启鉴权的环境、`--speed 2` 加速发送。

## 配置(config.json)

模板见 [config.example.json](config.example.json)。全部字段都可以在设置面板里改
(面板保存会按下列范围夹取),直接改文件也行(保存后即时生效)。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 总开关;关 = 悬浮按钮隐藏、一切不工作 |
| `model` | `haiku` | 大脑模型;`sonnet` 更聪明但慢 |
| `persona.preset` | `doubao` | 人设预设:`doubao` 豆包风(默认,真人感、有主见敢质疑)/ `butler` 老练管家 / `sharp` 直率损友 / `pro` 严谨助理;`custom` = 用自定义文本 |
| `persona.custom` | 空 | 自定义人设文本(≤600 字,仅 `preset='custom'` 时生效;为空回退默认预设)。**换人设会自动轮换会话**——`--resume` 的对话历史会盖过新提示词,不轮换模型会一直沿用旧身份;记忆不受影响 |
| `stt.mode` | `auto` | `auto` 流式优先(无凭据自动回退)/ `stream` 仅流式 / `segment` 仅批量 |
| `stt.volcengine.apiKey` | 空 | 新版控制台 ApiKey(优先) |
| `stt.volcengine.appId` / `accessToken` | 空 | 旧版控制台凭据 |
| `stt.volcengine.resourceId` | `volc.bigasr.sauc.duration` | 资源 ID,**必须与控制台开通的版本一致**:小时版 `…duration` / 并发版 `…concurrent`;留空 = 不发送该头(平台预置模型) |
| `stt.volcengine.endpoint` | `bigmodel_async` | `bigmodel_async` / `bigmodel` / `bigmodel_nostream` |
| `listening.silenceMs` | `800` | 静音判停:说停后多久算一句(200–10000) |
| `listening.confirmMs` | `250` | 确认时长:说话持续这么久才开段,更短的声响直接忽略(100–400)。旧字段 `minSpeechMs` 首次加载时按 ×0.625 自动迁移 |
| `listening.engine` | `auto` | 判停引擎:`auto` 小模型优先(失败自动回退能量)/ `model` 仅小模型 / `energy` 仅能量。小模型 = 本地 Silero VAD(onnxruntime-web,模型随应用内置约 2.2MB),只说人声、嘈杂环境误触发更少;引擎状态在设置面板里实时显示 |
| `listening.maxSegmentMs` | `30000` | 单段上限,超过强制切段(3000–120000) |
| `listening.startThreshold` | `0` | 固定起说阈值;0 = 纯自适应噪声底(嘈杂环境可调 0.01–0.05) |
| `listening.bargeIn` | `true` | 播报中允许抢话打断 |
| `listening.wakeWord` | 空 | 非空时一句话必须包含它才提交(会议场景防误触) |
| `listening.endWords` | `["发送","完事了","就这些"]` | 句尾命中则剥离并立即提交(最多 10 个) |
| `listening.autoSubmit` | `true` | 关 = 只上屏,点气泡里的「发送这条」手动提交 |
| `listening.pauseWhenHidden` | `true` | 页面切后台自动暂停聆听,回来自动恢复 |
| `proactive.enabled` | `false` | 主动汇报开关 |
| `proactive.intervalMinutes` | `30` | 静默巡查间隔(5–240) |
| `proactive.scope` | `important` | `important` 完成/出错/等待;`all` 额外报换任务 |
| `proactive.quietWindowMs` | `45000` | 事件合并静默窗口(5000–300000) |
| `ui.showTranscript` | `true` | 气泡显示实时转写 |
| `ui.bubbleTimeoutMs` | `6000` | 空闲多久气泡淡出(1500–30000) |
| `brain.hop1TimeoutMs` | `60000` | 大脑第一跳超时(5000–180000) |
| `brain.hop2TimeoutMs` | `45000` | 两跳查询第二跳超时(5000–180000) |
| `brain.maxTurns` | `120` | 会话最大轮数,超出自动轮换(记忆保留) |
| `brain.sessionMaxAgeDays` | `7` | 会话闲置多少天轮换 |
| `brain.maxNotes` | `40` | 记忆条数上限(溢出先裁自动条目) |

## 行为细节

- **分句流式播报**:模型边生成边从 JSON 契约里抽 `responseToUser` 的整句,首句一到就
  合成播放,后续句子接续(服务端 NDJSON 逐行下推,客户端合成/播放双泵,合成领先播放
  至多 2 句)。全部生成完会与已播文本比对,系统兜底话术(如找不到 agent)会补播,不吞词。
- **人设**:顶栏话筒弹窗 →「语音伙伴」→ 人设,预设 4 套(默认豆包风:真人感、有主见、
  敢质疑)+ 自定义文本。**换人设会自动开新会话**(CLI `--resume` 的历史会盖过新提示词),
  记忆保留;回复长度自适应——简单的事一两句,复杂的事可以展开,不再有机械硬限。
- **派活与打断**:默认把任务**排队**给 agent;只有你明确说「马上/立刻/停下/别做了/改用」
  这类急迫语义,大脑才会打断当前工作(对 Claude 是 stop 后重发)。打断会丢当前轮工作,
  所以策略偏保守;回复里会说明「已打断 X」。
- **主动汇报**:agent 完成 / 出错 / 等待确认时开口;同类事件在静默窗口内合并成一条
  (`⟦系统事件⟧ 过去 N 分钟:① … ② …`;定界符不可口述,防语音转写被误判为系统事件),
  聆听/思考/播报中不插话,推迟几秒再报。
  无事不打扰——定时巡查只兜底,没有事件不会开口。
- **多标签页**:localStorage 心跳选一个 leader,只有 leader 会自动聆听与汇报,避免抢麦。
- **记忆**:说的「记住:…」会落盘;查看/删单条/清空在设置面板。文件在
  `~/.local/share/tide-commander/voice-companion.json`(会话 id、轮数、记忆);
  删掉它 = 全部重置。设置里的「重置会话」保留记忆只清上下文。
- **判停引擎**:默认 `auto`——聆听启动时后台加载本地 Silero 小模型(约 2.2MB,已随应用
  内置,不联网),用「是不是人声」的概率替代能量阈值;加载失败自动回退能量并提示一次,
  聆听不中断。设置面板的「判停引擎」行可强制 `energy`(最轻)或 `model`(更准)。
- **与旧「语音助手」的关系**:`设置 → 「语音」分组 → 语音助手`(`/api/voice-assistant`,
  按住说话、`send_to_agent`,同样分句流式播报、同样可选人设)保持不变,两者互不影响;
  语音伙伴是常开、有记忆、能读结果的另一条链路。两个节的顶部都有关系说明条可直接互跳。

## 排障

| 现象 | 原因 → 处理 |
| --- | --- |
| 圆钮一直是「未配置火山凭据(自动模式 = 本地批量转写)」 | 正常回退;要实时上屏就填凭据 |
| 设置里提示「服务端语音伙伴接口不可用」 | 服务端还是旧进程 → 重启 FleetDeck |
| 说话没反应 | 浏览器麦克风权限;页面在后台且开了「切后台暂停」;唤醒词过滤;看气泡里的系统提示 |
| 转写/回复很慢 | 一轮 = 判停 0.8s + 转写 + 大脑(2–4s)+ 播报(1.6–2s)。回复已分句流式:首句通常 3–5s 出声,后续边生成边接播,不用等整段;想更快就换 `haiku`、开流式识别 |
| 会议中误触发 | 开唤醒词、提高 `startThreshold`、或干脆关掉开关 |
| 流式报错 `403 requested resource not granted` | **凭据有效,但资源 ID 与账号开通的版本不一致**。去控制台 →「流式语音识别大模型」看开通的是小时版还是并发版,把设置里「资源 ID」改成对应的那个;拿不准先选「不发送(平台预置模型)」。改完用 `selftest.mjs` 复验 |
| 流式报错 `no_credentials` | 没配凭据 → 按上文开通步骤填 ApiKey 或 APP ID + Access Token |
| 其它流式错误 | `selftest.mjs` 直接验证凭据;401 = 凭据无效,配额类按服务端日志(`X-Tt-Logid` 可给火山工单)处理 |
| 抢话打断播报不生效 | 检查 `listening.bargeIn`;免提外放时回声可能被当成语音,建议耳机 |
| 提示「小模型加载失败,已用能量判停」 | Silero 模型/运行时没加载起来(离线、文件缺失或浏览器太旧)。功能自动回退能量,不残;想再试一次就关掉再开聆听,或把「判停引擎」切到「能量」消掉提示 |
| 设置面板「判停引擎」一直显示加载中 | 模型 2.2MB,首次加载视网络而定;超过 ~8s 会判失败并回退。看 Network 里 `/silero_vad.onnx` 是否 200 |

## 基准(bench)

`bench.mjs` 走真实回合(与语音页同一条 `POST /api/voice-companion/process` 流式路径),
按套件/动作统计首句到达 tMs、首句字数与全程耗时,给「感知提速」这类改动做前后对比:

```bash
node tools/voice-companion/bench.mjs --label=before            # 默认 general + query 各 5 条
node tools/voice-companion/bench.mjs --suites=general --n=3 --label=after
node tools/voice-companion/bench.mjs --compare bench/before.jsonl bench/after.jsonl
node tools/voice-companion/bench.mjs --once "现在几点了？"      # 单条即测
```

- **跑的是真实回合**:会进秘书会话与 dialog 日志,请在没人正用语音页时跑(`--dry-run` 只打计划不联网)。
- 派活套件(`delegate`)会真派任务给主管,默认跳过,需显式 `--allow-dispatch`。
- 产物在 `bench/`(gitignored);首轮 W1–W6 的前后数据与结论见
  `obsidian-docs/06-功能域专题/06-10-语音、监控统计与浏览器桥.md` §1e。

## 代码地图

| 位置 | 作用 |
| --- | --- |
| `src/packages/server/services/voice-companion-service.ts` | 大脑:会话/记忆/agent 快照/两跳查询/投递 |
| `src/packages/server/routes/voice-companion.ts` | `/api/voice-companion/{process,status,reset,memory}` |
| `src/packages/server/voice/volcengine-asr-client.ts` | 火山大模型流式 ASR 二进制协议客户端 |
| `src/packages/server/voice/voice-companion-stream.ts` | `/ws/voice-companion` 代理通道 |
| `src/packages/server/voice/filler-pregen.ts` | W7 垫话预生成(说话期间按 partial 提前生成,密封后供回合取用) |
| `src/packages/client/voice/ttsPreload.ts` | W7 TTS 预合成缓存(命中免请求;在途去重,队列侧 abort 不影响共享请求) |
| `src/packages/client/voice/vad.ts` | 判停状态机(候选→确认→段;能量迟滞 / 小模型概率,二者同一套阈值语义) |
| `src/packages/client/voice/sileroVadCore.ts` | Silero 纯逻辑核心(64+512 窗口组装、单飞丢最旧队列;可单测) |
| `src/packages/client/voice/sileroVad.ts` | onnxruntime-web 胶水(懒单例、超时/契约自检、失败可重试);模型在 `public/silero_vad.onnx`(来源/许可见 `public/silero_vad.README.md`) |
| `src/packages/client/hooks/useContinuousListening.ts` | 常开聆听管线(流式 / 批量回退 / 抢话) |
| `src/packages/client/voice/proactiveReporter.ts` | 主动汇报(快照 diff + 静默窗口) |
| `src/packages/client/components/VoiceCompanion.tsx` | 悬浮钮 + 气泡 + FSM |
| `src/packages/client/components/toolbox/VoiceCompanionSection.tsx` | 设置面板节 |
| `tools/voice-companion/selftest.mjs` | 无麦克风流式链路自测 |
| `tools/voice-companion/bench.mjs` | 感知延迟基准(真实回合:首句 tMs/字数/全长;`--compare` 前后对比) |
