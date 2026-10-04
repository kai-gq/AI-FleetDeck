# jarvis-canary —— 金丝雀真链路冒烟

对应《任务总览》§5 第 7 条：**阶段门必须跑本工具**；它连**真 dev server**（client 5173 / server 6200 在线），走真实链路，再用 `system_log` 断言「事件链真的发生了」——不是 mock 单测，也不是看接口 200 就算过。

```
tools/jarvis-canary/
├── run.ts        CLI 入口（参数解析 / 场景执行 / 主流程）
├── scenarios.ts  场景注册表 + 前置条件 + 断言实现
├── client.ts     HTTP(fetch) + WS(ws) 真链路传输与语义封装
├── log-query.ts  system_log 只读查询（better-sqlite3 readonly，直读 events.db）
├── report.ts     报告构建 / 落盘 / 控制台摘要（含「缺失证据明细」）
├── types.ts      共享类型（无副作用，便于 selftest 注入 mock）
├── selftest.ts   离线自测（--self-test，不依赖 dev server）
└── reports/      运行报告（JSON，gitignored）
```

## 快速开始

```bash
# 0) 离线自测（不依赖 dev server；交付前 / 改完代码先跑这个）
npx tsx tools/jarvis-canary/run.ts --self-test

# 1) 预检：只做连通性 + 前置检查，不发任何消息（connectivity 场景只读真执行）
npx tsx tools/jarvis-canary/run.ts --dry-run

# 2) 阶段门必跑（低侵入：会发 1 条查询类消息，走真实秘书 hop1，1 次 LLM 消耗）
npx tsx tools/jarvis-canary/run.ts --level=smoke

# 3) opt-in 真派活（🔴 真实 LLM 消耗：秘书 hop1 + Boss 拆解 + 下属执行）
npx tsx tools/jarvis-canary/run.ts --level=full
npx tsx tools/jarvis-canary/run.ts --level=full --simulate-receipt   # ④ 用接口模拟回执（半合成）
```

退出码：`0` 全通过（dry-run 的前置检查通过）；`1` 有失败 / 全局错误 / 真跑存在跳过（未加 `--allow-skip`）；`2` 参数错误。dry-run 下「能力未交付」的跳过不阻断。

## 场景总览

| 级别 | 场景（别名） | LLM? | 做什么 | 断言（全部落在 `system_log` 真行上） |
| --- | --- | --- | --- | --- |
| smoke | `connectivity`（`conn`） | 否 | HTTP / WS / DB 三通道连通；**只读** | a1 `/api/health` 200 且 `status=ok`；a2 `/api/voice-companion/status` `available=true`；a3 WS 握手收到首帧（`server_time` 等）；a4 `system_log` 只读可查（报行数/最近写入时间） |
| smoke | `dialog-roundtrip`（`dialog`） | 是（1 次 hop1） | 发 1 条查询类消息（默认「列出团队成员」） | a1 HTTP 200；a2 `dialog{direction:'in', text:<原样>}` 落盘；a3 `dialog{direction:'out'}` 落盘；a4 窗口内 `delegation` 行数 = 0（查询类不得派活） |
| full | `delegation-chain`（`delegation`） | 是（hop1+Boss） | 发任务类消息（默认金丝雀最小任务） | a1 HTTP 200；a2 `dialog out.action ∈ {delegate_to_boss, send_to_agent}`；a3 `delegation{phase:'dispatched', channel:'voice-companion', toAgentId:<Boss>}`；a4 不存在 dispatched 到非 Boss 的行（**全走 Boss 不变式**，任务05 L3 判据）；`blocked` 行只告警不判失败（决策观测点①） |
| full | `receipt-chain`（`receipt`） | 是（Boss+下属，可半合成） | 等下属 `report-task` 回执 | a1 `delegation{phase:'reported', channel:'subordinate'}` 落盘；a2 `reported.forwarded === true`（已转发 Boss）；`closed` 只记录不判失败 |
| full | `cancel-chain`（`cancel`） | — | 「别做了」→ 撤回 | **恒 SKIP：任务16 未交付**（服务端无撤回入口、无 cancelled 事件源）。断言函数 `assertCancelEvidence` 已按 `phase/status=cancelled` 形态备好 |

事件/字段口径来自任务 01/02 埋点（`activity-log.ts`）：`dialog{direction,text,action,degraded,targetAgentId}`、`delegation{phase,channel,routedBy,toAgentId,toAgentName,message,delivery,status,forwarded}`。

### 断言实现要点

- **时间窗口**：发消息前记 `t0 = now - 5s`（`CLOCK_MARGIN_MS`，抵消时钟漂移/写入延迟），所有断言查询都带 `since >= t0`，只认本次链路新写入的行，不会被历史事件误判。
- **轮询**：`waitFor` 按 `--poll-ms` 轮询到 `--log-wait-ms`（默认 30s）；full③ 另有 `--wait-boss-ms`（默认 180s）等 Boss 的 `delegated` 二级证据；full④ `--wait-report-ms`（默认 300s）等真回执。
- **证据**：每条命中给 `logId + ISO 时间 + category/source + 关键字段`（长文本截断到 120 字，不回显全文/密钥）；失败时打印「缺失证据明细」：哪场景、期望什么事件、实际查到什么、窗口内观测摘要（≤50 条）。
- **④ 的证据来源**：优先用本次③在进程内共享的 `delegationChain`；③ 未跑时回溯最近 30 分钟内真实发生的 `delegated` 事件。

## 前置清单（真跑前逐项确认）

| # | 前置 | 检查方式 |
| --- | --- | --- |
| 1 | server 在线 | `curl -s http://127.0.0.1:6200/api/health` → `{"status":"ok"}` |
| 2 | client 在线（人工旁观用，工具不依赖） | 浏览器打开 `http://localhost:5173` |
| 3 | 语音伙伴可用 | `curl -s http://127.0.0.1:6200/api/voice-companion/status` → `available:true` |
| 4 | `events.db` 存在且服务端在线（WAL 只读需 `-shm`） | 默认 `~/.local/share/tide-commander/events.db`；可用 `--db=` 覆盖 |
| 5 | 团队有 Boss（full③ 必需） | `curl -s http://127.0.0.1:6200/api/agents`，找 `isBoss`/`class:"boss"` |
| 6 | AUTH_TOKEN（仅当服务端启用鉴权） | `export AUTH_TOKEN=...`（也可 `--token=`）；未设置时服务端免认证 |
| 7 | 任务16 已交付（full⑤ 必需） | 未交付前 `cancel-chain` 恒 SKIP，属预期 |

> ⚠️ **Windows + Git Bash 手工验证的坑**：`curl -d` 传非 ASCII（中文）会被转码成乱码。手工发消息必须用 heredoc + `--data-binary @-`：
> ```bash
> curl -s -X POST http://127.0.0.1:6200/api/voice-companion/process \
>   -H 'Content-Type: application/json' --data-binary @- <<'JSON'
> {"text":"列出团队成员","event":false,"stream":false}
> JSON
> ```
> 本工具用 `fetch` + `JSON.stringify`（天然 UTF-8），不受此坑影响。

## 真跑命令与预期证据（留给主脑在波次门执行）

### smoke（阶段门必跑）

```bash
npx tsx tools/jarvis-canary/run.ts --level=smoke
```

预期：`connectivity` 4 断言通过（首帧 `server_time`、DB 行数/最近写入时间）；`dialog-roundtrip` 4 断言通过（`dialog in/out` 各一条、`delegation` 0 条）。报告落盘 `tools/jarvis-canary/reports/<ISO>.json`，控制台汇总 `通过 2 | 失败 0`。

副作用（真实、不可回滚）：秘书会话多 1 轮对话，消耗 1 次 hop1 LLM；写入若干 `dialog`/`broadcast` 行。**不派活、不改任何业务数据**。

### full（opt-in）

```bash
npx tsx tools/jarvis-canary/run.ts --level=full
# 或只跑某几段：
npx tsx tools/jarvis-canary/run.ts --scenario=delegation,receipt
```

预期：①②同 smoke；③ `delegation-chain` 通过——`dispatched` 直达 Boss（`routedBy=delegate_to_boss`）；若模型话术指名普通 agent，会先落 `blocked` 再改道 Boss（a4 仍通过，notes 告警，需人工复核话术）。④ 若 Boss 真拆解且下属完成，`reported.forwarded=true` 通过；下属未完成则该场景 SKIP（不计失败，但退出码 1，除非 `--allow-skip`）。

副作用与成本：③④会真的让 Boss/下属开始工作（Boss 拆解 + 下属执行，多次 LLM 消耗与工具调用）。默认 `--task-text` 已写成「只回复收到即可，不要执行任何实际操作」的 no-op 任务，请勿改成真实业务指令。

### 隔离建议（full）

`/api/voice-companion/process` 的派活目标由服务端解析为「团队中第一个 boss-like agent」（`voice-companion-service.ts:712-734`），**无法指定某个测试 agent**。要避免影响真实工作：

1. 优先在团队空闲时跑，保持默认 no-op 任务话术；
2. 需要彻底隔离时，在专用测试环境（仅一个测试 Boss 的项目/实例）跑 full；
3. 只想验证回执链时用 `--simulate-receipt`：跳过下属真执行，直接以被派活下属身份 `POST /api/agents/:id/report-task`（仍会真写 `reported` 事件并转发进 Boss 会话——半合成，非纯 mock）。

## 已知限制 / 未覆盖项

1. **只读是刻意的**：`log-query.ts` 不复用 `querySystemLog()`（它依赖 `initEventDb()`，会跑迁移/写 WAL pragma），改用 better-sqlite3 `readonly:true, fileMustExist:true` 直读同一 `events.db`，过滤语义与 `system-log.ts:buildFilter` 逐条对齐。代价：表结构若变更需同步此处（打开时会校验必需列，漂移即报明确错误）。
2. WAL 库的只读连接需要 `-shm` 存在 → **dev server 必须在线**（报错文案会提示）。
3. full⑤（撤回链）待任务16交付：把 `cancelChainSupported` 前置改为能力探测即可启用；`assertCancelEvidence` 已按 `phase/status ∈ {cancelled,cancel,canceled}` 预留。
4. `delegated`（Boss 拆解）依赖 Boss 响应链路，等待窗口内未出现只记 notes：③ 仍以「秘书→Boss」判定通过；④ 因缺前置 SKIP——这是证据分级，不是掩盖失败。
5. 工具**只发 HTTP/WS 请求 + 只读 DB**，不调任何删除/写库接口；`--simulate-receipt` 是唯一主动写事件路径（且需显式开启）。
6. 报告默认写 `tools/jarvis-canary/reports/`（gitignored）；`--report=<path>` 可覆盖。

## 自测（离线）

```bash
npx tsx tools/jarvis-canary/run.ts --self-test    # 亦可：npx tsx tools/jarvis-canary/selftest.ts
```

用**假传输（假 WS/HTTP）+ 假日志查询 + 临时 SQLite**（`os.tmpdir()`，用完即删，绝不碰真实 `events.db`）覆盖：参数解析、场景选择/别名、轮询、截断/证据抽取、只读查询（含表缺失/文件缺失报错）、全部 5 个场景的通过/失败/跳过/planned 分支、dry-run 行为、报告与退出码映射、过滤条件构造。当前 **91 项全部通过**。
