# bolba-board — 本地任务看板（TC 插件）

内置插件 `bolba-tasks` 连的是作者的私有看板服务 `http://127.0.0.1:7492`（未公开）。
本目录用**零依赖 Node** 实现了一个契约完全兼容的本地版：让该插件全功能点亮
（待办列表 / 侧边栏 Tasks / 详情时间线 / 完成·重开 / AI 推荐 / curl 卡片），
并还原作者"agent 用 curl 建·改·关任务 → 聊天流渲染任务卡片"的完整工作流。

- 数据:SQLite(`node:sqlite`,`Node >= 22`)
- 服务:纯 REST API,只绑 `127.0.0.1:7492`(**不要改端口** —— TC 客户端卡片正则硬编码了 7492)
- 镜像:`data/Tareas.md` 与看板**双向同步**(可指向 Obsidian 库)
- 无构建、无 npm 依赖、不进 `src/`(与上游零冲突)

## 组成

| 文件 | 职责 |
|---|---|
| `plugin.mjs` + `tide-plugin.json` | TC 服务端插件入口:随 TC 启停,in-process 起 REST 服务 |
| `server.mjs` | HTTP 服务、路由、鉴权、错误映射;按 mtime 热加载兄弟模块 |
| `handlers.mjs` | 15 个端点实现 |
| `store.mjs` | SQLite:任务 CRUD、过滤、排序、时间线、统计 |
| `text.mjs` / `validate.mjs` / `duplicates.mjs` | 渲染(`as=text`)、入参归一化、查重 |
| `markdown.mjs` | `Tareas.md` 双向同步(导出 + 懒导入 + drift) |
| `standalone.mjs` | 独立开发运行(不带 TC) |
| `test.mjs` | `node --test` 契约自测(28 项) |
| `skill/` | agent 技能(curl 配方)+ 一键安装脚本 |
| `data/` | 运行时数据(已 gitignore;**删除 = 重置看板**) |
| `config.example.json` | 配置样例 |

## 快速开始

**在 TC 里(推荐)** — 随服务端一起启停:

```bash
curl -X POST http://127.0.0.1:6200/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"sourcePath":"E:/tide-commander/tide-commander/tools/bolba-board"}'
```

装好后在 Plugins 面板启用内置的 `bolba-tasks`,刷新浏览器即可看到 Tasks 标签。
更新代码后:**disable → enable**(没有卸载端点;重装同 id 会 409)。

**独立开发**:

```bash
node tools/bolba-board/standalone.mjs --seed        # 造 4 条示例任务
node tools/bolba-board/standalone.mjs --port 7611   # 换端口(仅开发用)
```

TC 在跑时再起 standalone 会报 `puerto ocupado … (EADDRINUSE)` —— 正常,端口只能占一次。

## 配置(env > `config.local.json` > 默认)

| 键 / 环境变量 | 默认 | 说明 |
|---|---|---|
| `BOLBA_BOARD_PORT` / `port` | `7492` | **勿改**:客户端卡片正则硬编码 |
| `BOLBA_BOARD_TOKEN` / `token` | `abcd` | 也接受 `BOLBA_TASKS_TOKEN`;请求头 `X-Auth-Token` 或 `Authorization: Bearer` |
| `BOLBA_BOARD_DB` / `db` | `data/board.db` | 可外移(如 D 盘) |
| `BOLBA_BOARD_MD` / `md` | `data/Tareas.md` | 可指向 Obsidian 库内文件 |
| `BOLBA_BOARD_AUTOSYNC` / `autosync` | `on` | `off` = 不导出也不导入 |
| `counterPrefix` | `BOLBA` | `/stats.counter` 前缀 |

复制 `config.example.json` 为 `config.local.json` 修改(后者已 gitignore)。

## API 一览

| 端点 | 说明 |
|---|---|
| `GET /tasks` | 列表:`status,proj,type,due,stale,from,coti,q,scope,limit,as=text` |
| `GET /tasks/:id` | 单任务 + `timeline[]` / `timeline_events[]`(可 `as=text`) |
| `POST /tasks` | 建任务;疑似重复返回 409 + `candidates`,`?force=true` 跳过 |
| `PATCH /tasks/:id` | 部分更新 + `timeline`(字符串自动追加,按 `(ts,text)` 去重) |
| `POST /tasks/:id/timeline` | 只追加时间线 |
| `POST /tasks/:id/close` | `{"status":"done\|completed\|discarded"}`(默认 done) |
| `POST /tasks/:id/reopen` | 重开 |
| `DELETE /tasks/:id` | 删除(极少用,优先 discarded) |
| `GET /search?q=…` | 同列表 |
| `GET /duplicates?title=…` | 查重(jaccard/containment/similarity) |
| `GET /stats` | `{by_status, open_by_proj, due_today_or_overdue, counter}` |
| `GET /health` | 免 token;含 `drift[]`(Markdown 不一致项) |
| `GET /render` / `POST /sync` / `GET /config` | 附加:`as=text` 恒开 / 强制扫描导入 / 配置回显(不回显 token) |

写操作响应带 `reimported:["Tareas.md"]` —— 表示这次请求前先从磁盘导入过改动
(TC 卡片会显示 "reimportado de disco")。

## Markdown 双向同步

```markdown
- [ ] 🚢 BOL — 🛒 **Preparar cotización BOL-4471**
  - id:: 2
  - status:: open
  - proj:: BOL
  - due:: 2026-10-03
  - 2026-10-02 22:20 🆕 **创建** por bolba
```

- 每次写操作后**全量重写**(不含 discarded);文件被改动后**下一次请求自动导入**
  (mtime 记账,不会自己导自己)。`POST /sync` 可强制扫一遍。
- 勾选 `[x]` = 完成;`[-]` = 废弃;去掉勾 = 重开;改 `status::`/字段 = `PATCH`;
  手写新块(可只写 `- [ ] 🚢 PROJ — 🛠️ **标题**`) = 建任务。
- **整个块被删掉不会删库**,只进 `/health.drift`(防 Obsidian 同步旧版本误删)。删除请用 `[-]` 或 API。
- 多行 notes 以两字符 `\n` 转义往返;字段别名(`desde`→from_person、`prioridad`→priority …)均可写。

## Agent 技能

```bash
node tools/bolba-board/skill/apply-skill.mjs          # 装入 TC(重跑即更新)
```

技能教 agent 用 curl 操作看板(列表/建/改/关/重开/时间线),`allowedTools:["Bash"]`、
对所有 agent 生效。关键约定写在技能里:URL 必须 `http://127.0.0.1:7492`、
命令必须真执行(卡片才会渲染)、**Windows 下非 ASCII JSON 必须用 heredoc +
`--data-binary @-`,不能内联在 `-d` 里**(命令行会按 ANSI 码页转码,`ó`/中文会变乱码)。

## 测试

```bash
node --test tools/bolba-board/test.mjs
```

覆盖:鉴权、CRUD、404/405/400/409/413、`status=done&limit=8` 排序、`as=text` 用
**客户端自己的正则**逐行校验、Markdown 字段/复选框往返与 drift、重启持久化、
端口占用、配置优先级。

## 注意事项

- **`data/` 可删 = 重置看板**;`git clean -xfd` 会清掉它(可用 `BOLBA_BOARD_DB` 外移)。
- `node:sqlite` 在 Node 22 仍是实验 API,启动会打一条 ExperimentalWarning,可忽略;
  插件激活失败时会在 Plugins 面板给出可读错误。
- 删除任务是不可逆的;日常"不做了"请用 `discarded`。
- 技能里的 token 是明文默认值 `abcd`,与作者插件默认一致;若日后给 TC 开鉴权需两边同改。
