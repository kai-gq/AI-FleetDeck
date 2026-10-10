/**
 * WeChat Messaging Skill
 * BuiltinSkillDefinition that teaches agents how to reply to WeChat DMs
 * through the TC proxy (context-token-gated send-message).
 */

import type { BuiltinSkillDefinition } from '../../data/builtin-skills/types.js';

export const wechatSkill: BuiltinSkillDefinition = {
  slug: 'wechat-messaging',
  name: '微信消息（ClawBot）',
  description: '通过微信 ClawBot 集成回复个人微信私聊消息',
  allowedTools: ['Bash(curl:*)'],
  content: `# 微信消息（ClawBot）

通过 Tide Commander 的微信集成给个人微信回消息。底层是腾讯官方 ClawBot（iLink）通道，bot token 保存在服务端加密存储里，agent 永远不接触它；但每次调用 TC API **必须**带上 TC 自己的鉴权头（\`X-Auth-Token\`），与其他 TC API 调用一致。

> **token 从哪来**：就是你调用 \`/api/notify\`、\`/api/exec\` 用的那个 token（系统提示词 API Calling Convention 段里有原值）。下面示例里的 \`abcd\` 是占位符，替换成真实值。

**前提：**
- 微信集成已启用，且已在 TC 集成面板扫码绑定（状态为已连接）。
- 对方必须先给机器人发过消息 —— 回复能力靠入站消息里的 \`context_token\` 一次性授权。

## 铁律：回复必须带 context_token

iLink 的 \`sendmessage\` 需要入站消息携带的 \`context_token\`。触发器的提示词模板里已经注入好了两个变量：

- \`{{wechat.from}}\` — 对方 userId（收发都用它）
- \`{{wechat.contextToken}}\` — 回复凭证（**必带**，落下就发不出去）

**不要**自己编造 token；**不要**复用上一条消息的旧 token（可能已过期）。每次都从当前触发事件的变量里取。

---

## 快速配方

### 1. 回复当前触发的这条微信消息

\`\`\`bash
curl -s -X POST -H "X-Auth-Token: abcd" http://localhost:5174/api/wechat/send-message \\
  -H "Content-Type: application/json" \\
  --data-binary @- <<'EOF'
{"to":"{{wechat.from}}","text":"收到，我来处理。","contextToken":"{{wechat.contextToken}}"}
EOF
\`\`\`

**注意用 heredoc（\`--data-binary @-\` + \`<<'EOF'\`）而不是 \`-d\`**：正文含中文时 \`-d\` 在部分终端会被转码；且正文里出现 \`!\` 时 bash 历史展开会破坏 JSON。

### 2. 主动给最近联系过的用户发消息（受上下文限制）

只有当对方在最近 24 小时内给机器人发过消息、且服务端缓存仍持有其 \`context_token\` 时才能发。此时可以省掉 \`contextToken\`，服务端会从缓存回填：

\`\`\`bash
curl -s -X POST -H "X-Auth-Token: abcd" http://localhost:5174/api/wechat/send-message \\
  -H "Content-Type: application/json" \\
  --data-binary @- <<'EOF'
{"to":"xxxx@im.wechat","text":"定时提醒：该喝水啦"}
EOF
\`\`\`

缓存里没有 token 时会返回 400 \`no_context_token\` —— 这是限制而不是故障，不要重试，改为等对方先发消息。

---

## API 参考

### POST /api/wechat/send-message

| 字段 | 必填 | 说明 |
|---|---|---|
| \`to\` | 是 | 对方 userId（通常来自 \`{{wechat.from}}\`，形如 \`xxx@im.wechat\`） |
| \`text\` | 是 | UTF-8 正文 |
| \`contextToken\` | 否 | 回复当前消息时必带（通常来自 \`{{wechat.contextToken}}\`）；省略时服务端尝试从 recent-inbound 缓存回填 |

成功：\`{"success":true}\`。失败：\`{"error":"...","code":"rate_limited|no_context_token|not_connected"}\`。

### GET /api/wechat/status

\`\`\`bash
curl -s -H "X-Auth-Token: abcd" http://localhost:5174/api/wechat/status
\`\`\`

返回连接状态：\`state\` 取值 \`disabled / disconnected / qr_pending / connected / needs_reauth\`。\`needs_reauth\` 表示需人工去集成面板重新扫码 —— 遇到这个状态不要自行尝试重连。

### GET /api/wechat/recent-inbound

最近 24h 内给机器人发过消息的用户列表（含显示名与预览，不含 token）。用它找 \`to\` 的值：

\`\`\`bash
curl -s -H "X-Auth-Token: abcd" http://localhost:5174/api/wechat/recent-inbound
\`\`\`

## 常见错误

- **503 \`not_connected\`** — 未扫码绑定或 token 已失效；提醒用户到集成面板处理，不要重试。
- **400 \`no_context_token\`** — 对方近期没有入站消息，或 token 已过期。等对方先发消息。
- **429 \`rate_limited\`** — 出站超过每分钟限额（默认 20 条）。稍后合并发送。
- **502 \`ret=...\`** — iLink 侧拒绝（token 失效、参数被拒）。把 \`ret\` 值一并汇报。

## 备注

- ClawBot 目前仅支持单聊（一号一实例），没有群消息。
- 语音消息会自动带云端转写文本，变量 \`{{wechat.voiceTranscription}}\` 可用；回复仍然走文本。
- 图片/文件/视频入站目前只报告类型（\`{{wechat.mediaBlock}}\`），未下载媒体内容。
`,
};
