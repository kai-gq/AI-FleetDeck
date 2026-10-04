# stub-llm —— 金丝雀 L2「接线层」mock LLM

> 2026-10-04 交付。配套纪律见 `../README.md` 的「跑法分级」与
> `obsidian-docs/06-功能域专题/06-12-tasks/00-README-任务总览.md` §5⑦。

## 它解决什么问题

金丝雀失败时要能一分为二定位：

| 层级 | LLM | 验证对象 | 失败含义 |
|---|---|---|---|
| **L2（本目录）** | mock（固定规则） | 契约 → Boss → 回执 → 播报 → system_log 的**接线** | 接线 bug |
| **L3** | 真 LLM | 接线 **+** 模型/prompt 行为 | 可能是模型说错，需人判 |

L2 全绿而 L3 红 → 问题出在模型/prompt（不是代码）；L2 红 → 代码接线坏了。
**L2 用真服务器，只把「claude CLI 可执行文件」换成本 stub**（`TC_CLAUDE_EXECUTABLE`）。

## 组成

| 文件 | 作用 |
|---|---|
| `claude-stub.mjs` | 引擎：按 stream-json 协议收发，规则驱动回复，零依赖零网络 |
| `claude-stub.cmd` | Windows 垫片（服务器在 Windows 上以 `shell:true` spawn，`.cmd` 可直接执行）。**保持纯 ASCII**——cmd.exe 按系统码页(GBK)解码 .cmd，中文 UTF-8 注释会破坏脚本 |
| 规则文件 | 由你提供（`TC_STUB_RULES` 指向），按 prompt 子串/正则 → 固定回复 |

## 接入方式（接缝）

`backend.ts` 的 `getExecutablePath()` 优先读取环境变量 `TC_CLAUDE_EXECUTABLE`
（2026-10-04 加法式接缝，含单测）。所有 claude 通道同源经过它：

- Boss 委派 `boss-service.ts`、下属 agent `runner/process-lifecycle.ts`、
  语音伙伴 `voice-companion-service.ts`、交互式会话、日志分析 invoker。
- 给服务器进程设 `TC_CLAUDE_EXECUTABLE=<绝对路径>\claude-stub.cmd` 即整体切到 mock。
- 注意路径**不要含空格**（Windows `shell:true` 下 cmd.exe 不负责引号）。

## 配置（全部环境变量）

| 变量 | 缺省 | 作用 |
|---|---|---|
| `TC_STUB_RULES` | 无 | 规则文件路径（JSON，见下）；缺省全走 fallback |
| `TC_STUB_FALLBACK` | `收到。` | 无规则命中时的回复文本 |
| `TC_STUB_MODEL` | `claude-opus-4-5` | 无 `--model` 参数时 init 事件的模型名 |
| `TC_STUB_COST` | `0.0001` | 每轮 `result.total_cost_usd`（喂成本类埋点） |
| `TC_STUB_STREAM` | 关 | `=1` 时额外发最小 stream_event 增量（message_start/text_delta/message_stop） |
| `TC_STUB_TRACE` | 无 | 追加写文件：每行发出的原始 JSON（调试） |

规则文件格式：

```json
{
  "rules": [
    { "match": "你是Boss",  "reply": "{\"delegations\":[...]}" },
    { "regex": "^/status",  "reply": "STATUS" }
  ],
  "defaultReply": "下属已收到指令。"
}
```

先到先得：按数组顺序，`match`（子串）或 `regex` 命中即用其 `reply`。

## 协议依据（ground truth）

2026-10-04 用本机真 CLI（2.1.287）以服务器同参数探测捕获的**最小事件序列**
（每行一条 JSON，stdout）：

```
system/init（session_id/cwd/model/permissionMode）
  → [stream_event*（可选，本 stub 缺省不发）]
  → assistant（message.content[0].text 全文）
  → result（total_cost_usd / usage / modelUsage，服务器据此落 step_complete.cost）
```

stdin 输入行：`{"type":"user","message":{"role":"user","content":"..."}}`。
`--resume <id>` 沿用会话 id；`--fork-session` 另开新 id。

## 自测

```bash
node tools/jarvis-canary/stub-llm/claude-stub.mjs --self-test
```

当前 10/10 通过（参数解析 / 规则匹配 / 端到端事件序列 / 会话沿用）。
另已验证：与服务器同形态 spawn（`shell:true` 起 `.cmd`）、规则文件驱动、多轮同会话。

## 已知限制（设计内）

- 不发 `stream_event` 增量（缺省；`TC_STUB_STREAM=1` 可开最小版）——L2 只看接线，
  不验渲染。无增量路径服务器有完整分支。
- `control_request` 的应答形状**未对真 CLI 验证**（乐观应答；L2 场景暂不触发）。
- 不做工具调用 / 权限询问 / 上下文压缩等真实行为——那是 L3 的事。
