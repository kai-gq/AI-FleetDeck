<p align="center">
  <strong style="font-size:2.2em;letter-spacing:.02em;">⚓ FleetDeck</strong>
</p>

<p align="center">
  <strong>舰队甲板 · 多智能体指挥台</strong>
</p>

<p align="center">
  <em>Your fleet, one deck.</em> —— 一个人，指挥一支智能体舰队。
</p>

<p align="center">
  Claude Code &nbsp;·&nbsp; Codex &nbsp;·&nbsp; OpenCode &nbsp;·&nbsp; Grok &nbsp;·&nbsp; Pi
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-AGPL--3.0-2563EB?style=flat-square" alt="AGPL-3.0 license" />
  <img src="https://img.shields.io/badge/Node.js-18%2B-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js 18+" />
  <img src="https://img.shields.io/badge/tests-4461%20cases-16a34a?style=flat-square" alt="4461 test cases" />
  <img src="https://img.shields.io/badge/UI-简体中文%20%2F%2010%20languages-0ea5e9?style=flat-square" alt="Chinese-first UI" />
</p>

> **不是聊天窗口，是指挥台。** FleetDeck 把已经装好的 CLI 编码代理组织成一支有上下级的舰队：Boss 负责拆解与选人，下属真实执行，办结自动向你汇报。每一个角色都是跑在项目文件上的真实进程——真工具、真凭据、真会话历史。

> **English:** **FleetDeck** is a Chinese-first community edition of [Tide Commander](https://github.com/deivid11/tide-commander) (MIT). It keeps the full multi-agent mission-control platform and adds a zh-CN localization (5,584 entries across 202 client files), a Chinese voice companion, a WeChat (ClawBot) integration, a six-agent starter fleet seeded on first launch, Boss orchestration governance, and a commercial-grade UI reskin. Licensed under **AGPL-3.0**; upstream MIT notices are preserved in [NOTICE](NOTICE).

传统工具链把工作割裂在 IDE、终端、Git 客户端、文件浏览器、自动化画布和一堆 AI 聊天窗口之间。FleetDeck 把这些表面收拢到一个甲板上：你站在舰桥上说一句需求，整支舰队开始干活，结果自动回执。

你不需要住在代码里。用自然语言和可视化控件下达意图，需要深控时再打开文件、命令、diff、数据与基础设施。

## ⚡ 30 秒跑起来

```bash
# 安装依赖（Bun 或 npm）
bun install        # npm install

# 启动（Vite 5173 + API 6200）
bun run dev        # npm run dev
```

打开 **[http://localhost:6200](http://localhost:6200)**。只要本机已安装并登录任意一个支持的 CLI（`claude` / `codex` / `opencode` / `grok` / `pi`），就能拉起你的第一个智能体。全新数据目录首次启动会自动种下一支 6 人待岗编队（六个职业各一名），开箱就有一队人可用。

## 为什么用 FleetDeck

传统 IDE 是为「一个人一次编辑一个文件」设计的。AI 原生开发不同：多个智能体可以并行研究、规划、构建、测试、文档化、自动化和运维。FleetDeck 是面向这种转变的工作区——你负责方向，团队负责执行。

<p align="center"><strong>为一人开发者、独立创业者、研究者与所有用 AI 构建的人设计。</strong></p>

<table>
  <tr>
    <td width="33%" valign="top">
      <h3>🧭 从意图出发</h3>
      对主管说一句需求，Boss 拆解任务、按类型与负载选人，产出合规派活书——不用自己挑执行的人。
    </td>
    <td width="33%" valign="top">
      <h3>👀 看着工作发生</h3>
      实时看每个智能体的忙闲、当前任务、最近委派与工具调用，而不是盯着转圈等待。
    </td>
    <td width="33%" valign="top">
      <h3>🗂️ 一个工作台</h3>
      文件、Git、数据库、测试、终端、服务与专业预览，同一套工作区里完成，不用来回切工具。
    </td>
  </tr>
  <tr>
    <td width="33%" valign="top">
      <h3>🔀 用对的运行时</h3>
      Claude、Codex、OpenCode、Grok、Pi 混编在一支舰队里，任务中途可迁移会话。
    </td>
    <td width="33%" valign="top">
      <h3>📢 主动汇报</h3>
      办结、进展、异常自动播报回你，语音场景直接开口告知——不用反复追问进度。
    </td>
    <td width="33%" valign="top">
      <h3>🎙️ 中文语音伙伴</h3>
      秘书角色常驻：本地识别、流式应答、打断、分钟级提醒，像有个秘书在替你调度团队。
    </td>
  </tr>
</table>

## 你要的一切，都在甲板上

| | |
|---|---|
| **🎯 编排**<br>Boss/下属委派树、合规派活书、并发配额与排队、待岗/恢复、编制清单纪律、任务看板、团队笔记沉淀。 | **📡 可观测**<br>忙闲状态、当前任务、最近委派、工具卡、实时终端输出、后台任务轨、主动播报队列、会话恢复。 |
| **📁 统一工作台**<br>多根文件树、内嵌编辑、Git diff/历史/分支对比、全项目搜索、测试浏览器、`@file` / `@folder` / `@agent` 上下文。 | **🧩 可扩展**<br>约 29 个内置技能、服务端/客户端插件、8 类外部触发器（Webhook / 邮件 / Slack / Jira / 定时 / WhatsApp / 微信 ClawBot / Bitbucket）、状态机工作流编辑器。 |
| **🎙️ 语音伙伴**<br>中文语音、本地识别、流式分句、打断（barge-in）、分钟级确定性提醒（15s–24h，≤10 条）、主动播报通道、可选声纹门禁（只认主人声纹）。 | **📱 随处接手**<br>会话活在服务端，桌面、手机浏览器、Android 随时续上；另有浏览器桥驱动你已登录的真实浏览器。 |

## 🤖 支持的五种运行时

FleetDeck 把不同 harness 归一成同一种对话、工具、状态、上下文与 diff 体验，同时保留各厂商原生会话的完整能力。

| Harness | 必需命令 | 默认模式 | 可选持久/流式模式 |
|---|---|---|---|
| **Claude Code** | `claude` | 无头 `stream-json` 进程 + stdin 追问 | tmux 内交互式 TUI；一般 tmux 模式可在 FleetDeck 重启后保留进程 |
| **Codex** | `codex` | `codex exec --experimental-json` + 原生会话恢复 | 持久 `codex app-server`：token 流式、分离回合、重连 |
| **OpenCode** | `opencode` | `opencode run --format json` + 会话恢复 | 持久 `opencode serve` 守护进程，流式与重启恢复 |
| **Grok** | `grok` | 无头 `streaming-json` + 原生恢复 | 模型/effort 选择、账户档案、上下文与用量仪表 |
| **Pi** | `pi` | `pi --mode json` NDJSON 会话 | 持久 `pi --mode rpc`：回合中引导、原生 `/compact`、实时切换模型，tmux 重连 |

## 🎖️ 核心概念

### 智能体、主管与委派

每个角色都是一个真实 harness 进程，拥有自己的工作目录、运行时、模型、会话、提示词栈、记忆、权限、技能与任务状态。**Boss（主管）** 拥有下属，按工作量与类型选人，产出派活书，等待回执并核对收口。

任务有标签与状态（待命 / 执行中 / 已办结），工作在聊天之外可见。智能体可报告自己在思考、干活、受阻、等下属、待审或可清理。

### 项目区与多项目

矩形或圆形区域按项目/职责组织智能体。每个项目区可挂多个项目文件夹、为区内智能体注入专属指令、提供扎根于项目的即时 tmux 终端。**切换工作目录即切换整支团队**——每个项目有自己的一套主管与下属。

### 语音伙伴（秘书）与语音大脑

秘书是常驻的语音入口：所有派活都转交 Boss 编排，查询走只读通道，业务待办走 Bolba 板。它背后是一套**前后脑分工**的语音大脑：

- **前脑（快通道）**：常驻进程，识别、裁决与应答在同一热轮内完成——聊天、确认、简单问答、分钟级提醒 1-3 秒应声，不用等冷启动（实测热轮 2.1s，对照冷启动 16.6s）。
- **后脑（深通道）**：真正干活交给编码智能体后台执行，办结、进展、异常通过主动汇报通道播报给你——重活慢是慢，但不用你盯着等。
- **裁决纪律**：同一处歧义只裁一次、零对象指令直接最短反问、承诺边界只认系统真实存在的机制——长会话里不过度思考、不空口承诺。

支持打断（barge-in）、主动播报队列、分钟级提醒的确定性兑现（15s–24h，≤10 条）。

### 技能、插件与工作流

- **技能**：可复用的指令集 + 工具权限，可分配或按类继承；内置覆盖通知、委派回执、持久记忆、流式执行、Git/发布、日志、测试、数据库、浏览器/电脑控制、HTTP 请求、工作流与触发器。
- **插件**：斜杠命令、结构化结果卡、右侧栏视图、服务端处理器与集成配置。
- **工作流**：状态机编辑器（action / wait / decision / end），动作可派任务、等事件、设变量，按完成事件、条件、超时、cron 或手动决策流转；触发器接 Webhook、邮件、Slack、Jira、WhatsApp、微信（ClawBot）、Bitbucket。

### 建筑

建筑是功能性对象，不是装饰：

| 类型 | 作用 |
|---|---|
| **Server** | PM2/自定义启停、日志、健康、CPU/内存与端口检测 |
| **Docker** | 创建/接管容器或 Compose 项目，日志、健康与端口 |
| **Database** | MySQL / PostgreSQL / Oracle / SQLite / SQL Server，schema 浏览、SQL 编辑与历史（可选 SSH 隧道） |
| **Terminal** | 通过 ttyd 的持久浏览器终端（tmux 会话） |
| **Tests** | Maven/JUnit、Cucumber、Vitest、PHPUnit 套件扫描与运行 |
| **HTTP Requests** | IntelliJ 风格 `.http` / `.rest` 请求集 |
| **Folder / Link** | 打开项目路径或外部面板 |
| **Boss Building** | 聚合下属建筑，统一控制 |

## 📐 实测数字，不是 PPT 数字

以下来自本机开发记录（2026-10 实测），非实验室理想值：

| 数字 | 含义 |
|---|---|
| **3.9s** | 语音首句出声（播完回到聆听 7.7s） |
| **≈8×** | 语音伙伴常驻化提速：冷启动 16.6s → 热轮 2.1s，省 87% |
| **21.9×** | 长会话治理收益：p50 3.4s，对照退化基线 74.4s |
| **42.7s** | 一句话到回执播报全链闭环（派活 → 执行 → 核对 → 播报） |
| **2ms** | 分钟级提醒到点偏差（回执约 4s） |
| **4461** | 全量测试用例（353 个测试文件） |
| **5584** | 界面文案中文本地化条目（202 个客户端文件接线） |

## 🎮 一个真实的工作流长什么样

1. **建一个项目区**，挂上项目文件夹。
2. **拉起一支小队**——一个 Boss，配上研究、构建、测试等角色，各用合适的运行时。
3. **把结果交给 Boss**，而不是一列终端命令。它拆解、选人、发派活书。
4. **在指挥官视图里看执行**：工具卡、流式命令、后台任务、当前提示词、阻塞与上下文压力实时可见。
5. **原地审查产出**：渲染文档、数据网格、3D 预览、文件查看、Git diff 与测试输出。
6. **办结自动播报**：不用追问，回执主动送到你（语音场景直接开口）。

## ⚙️ 配置

常用环境变量：

| 变量 | 默认 | 说明 |
|---|---:|---|
| `PORT` | `6200` | 后端与生产 Web 端口 |
| `HOST` | `127.0.0.1` | 后端绑定主机 |
| `VITE_PORT` | `5173` | 开发前端端口 |
| `AUTH_TOKEN` | 未设置 | HTTP 与 WebSocket 鉴权令牌 |
| `LISTEN_ALL_INTERFACES` | 未设置 | 设为 `1` 绑定 `0.0.0.0` |

应用状态存放在 XDG 数据目录（通常 `~/.local/share/tide-commander/`）：智能体、区域、建筑、技能、类、密钥、会话历史、工作流、触发器与集成事件。各运行时对话保留在其原生会话存储中，FleetDeck 只引用读取，不替换厂商历史格式。

## 🧑‍💻 开发

```bash
bun install          # 安装依赖
bun run dev          # Vite(5173) + API(6200)
bun run dev:client   # 仅前端
bun run dev:server   # 仅后端
bun run lint:types   # 类型检查
bun run lint         # 代码规范
bun run test         # 全量测试（4461 用例）
bun run build        # 生产构建
```

## 📚 文档

项目设计文档（Spec / 任务拆解 / 功能域专题）与迭代日志不包含在本公开仓库中；代码注释与提交历史保留了完整的演进脉络。

## ⚓ 致谢

FleetDeck 借鉴了 [Tide Commander](https://github.com/deivid11/tide-commander)（MIT，作者 deivid11）的架构与设计思路，并在此基础上围绕中文语音伙伴、Boss 编排治理与一人舰队场景做了深度改造与再设计。

## 📄 License

本仓库整体以 [GNU Affero General Public License v3.0](LICENSE) 发布（SPDX：`AGPL-3.0-only`）。

本项目基于 [Tide Commander](https://github.com/deivid11/tide-commander)（MIT License，© 2026 David Alcalá）二次开发。上游 MIT 许可允许再许可（sublicense），本仓库以 AGPL-3.0 整体分发；依 MIT 条款要求，上游版权与许可声明完整保留于 [NOTICE](NOTICE)，适用于源自上游的部分。
