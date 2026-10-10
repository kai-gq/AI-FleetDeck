# tools/wechat-link —— 微信 ClawBot（iLink 协议）裸调验证

S0 阶段工具：在 TC 服务端零改动的前提下，把腾讯个人微信官方 Bot 通道
（「ClawBot」，底层 iLink 协议，`ilinkai.weixin.qq.com`）的**字段名、状态码、语义**
从「文档推测」跑成「实测结论」，供 `src/packages/server/integrations/wechat/`（S1）直接落地。

## 用法（仓库根目录执行）

```bash
# 0. 登录（终端出二维码；配色不同可能反色扫不动，扫不动就用 --html qr.html 浏览器开）
npx tsx tools/wechat-link/login.ts --html qr.html

# 1. 收信（回显模式：每条消息原路回 "echo: xxx"）
npx tsx tools/wechat-link/listen.ts --reply

# 2. 语义探测（p1-p5 默认目标取最近一条入站消息）
npx tsx tools/wechat-link/probe.ts p1        # 无 context_token 主动发送
npx tsx tools/wechat-link/probe.ts p3        # 同 token 连用两次
npx tsx tools/wechat-link/probe.ts p5 --yes  # 连发 10 条（会真发到手机）
npx tsx tools/wechat-link/probe.ts --long-run  # 24h 观测（轮询 + 30min 心跳）

# 3. 收尾：把结论回填下表 → 提交
```

状态与产物（全部 gitignored，token 绝不入库）：
`.state.json`（botToken/游标/baseurl/lastInbound）、`msgs.jsonl`（收到的原始消息）、
`probe-log.jsonl`（探测结论）、`qr.html`。

Windows 终端若花屏：先 `chcp 65001`。

## 实测结论表（S0 每跑一次更新）

| # | 项 | 结论 | 证据 |
|---|---|---|---|
| 1 | `get_qrcode_status` 状态序列拼写 | 待测 | login.ts 输出 |
| 2 | confirmed 响应字段（bot_token/baseurl/botUserId 真实拼写） | 待测 | login.ts 输出 |
| 3 | `getupdates` 响应字段（msgs 数组名/游标字段名/消息 id 字段名） | 待测 | listen.ts 原始 JSON |
| 4 | bot 自己发的消息是否回灌（message_type 过滤是否够用） | 待测 | listen.ts 原始 JSON |
| 5 | p1：无 context_token 主动发送是否可行（ret=0 且手机真收到？） | 待测 | probe.ts p1 + 手机确认 |
| 6 | p2：伪造 context_token 的错误码 | 待测 | probe.ts p2 |
| 7 | p3：同一 context_token 能否复用两次 | 待测 | probe.ts p3 |
| 8 | p4：固定 X-WECHAT-UIN 是否被拒 | 待测 | probe.ts p4 |
| 9 | p5：连发 10 条的限流表现 | 待测 | probe.ts p5 |
| 10 | p6：24h 后 getupdates/心跳的真实失效表现（要不要重扫码） | 待测（长跑中） | probe-log.jsonl |
| 11 | p7：语音转写文本的真实字段名（voice_item.xxx） | 待测 | 手机发语音 + listen.ts |
| 12 | baseurl 是否与默认域名一致 | 待测 | login.ts 输出 |
| 13 | `createASCII` 二维码在浅底/深底终端的可扫性 | 待测 | 人工扫码 |

## 对应 S1 落点

- 字段名结论 → `server/integrations/wechat/ilink-client.ts` 收紧多候选取值器
- p1/p3 结论 → `send-message` 是否强制 contextToken、`recentInbound` 缓存策略
- p6 结论 → `wechat-connection.ts` 的 `needs_reauth` 判定阈值
- p7 结论 → `extractWeChatText()` 的语音字段
