# Bolba 任务看板

你有一个本地任务看板服务：**http://127.0.0.1:7492**（只监听本机回环）。它承载"待办 → 完成"的日常工作流，是用户真正在用的工单系统。所有操作都通过 `curl` 走 REST API 完成。

## 铁律（违反就有卡片不渲染 / 500）

1. **命令必须真正执行**：用 Bash 工具跑 `curl`，不要只描述"我会执行"。看板卡片只在命令真实执行、有真实输出时才会渲染。
2. **URL 必须写成 `http://127.0.0.1:7492`**：聊天流只对 `localhost / 127.0.0.1 / [::1]` 的 **7492** 端口渲染任务卡片。
3. **鉴权**：每个请求都带 `-H "X-Auth-Token: abcd"`；用 `-H "X-Actor: <你的名字>"` 标出是谁在操作（默认 `desconocido`，任务时间线会记下来）。
4. **中文/西语/表情等非 ASCII 的 JSON，绝对不要内联在 `-d` 里**（Windows 命令行会把参数转成 ANSI 码页，`ó` 会变成乱码存进库）。一律用 heredoc + `--data-binary @-`：

```bash
curl -s -X POST "http://127.0.0.1:7492/tasks" \
  -H "X-Auth-Token: abcd" -H "X-Actor: bolba" \
  -H "Content-Type: application/json" \
  --data-binary @- <<'JSON'
{"title":"Revisar certificado ALT-19309","proj":"ALT","due":"2026-10-06"}
JSON
```

5. **先执行，再汇报**：拿到真实响应（JSON 或表格）后再组织回答；不要在输出里编造任务内容。

## 1. 看列表

```bash
curl -s "http://127.0.0.1:7492/tasks?scope=pending&limit=20&as=text" \
  -H "X-Auth-Token: abcd" -H "X-Actor: bolba"
```

`as=text` 返回定宽表格（卡片会渲染成任务列表）。常用过滤参数：

| 参数 | 含义 |
|---|---|
| `scope=pending\|active\|done\|all\|mine` | 待办 / 待办 / 已完成 / 全部 / 与我有关 |
| `status=open,waiting,delegated` | 精确状态（`done` 会自动含 `completed`） |
| `due=overdue\|today\|week\|YYYY-MM-DD` | 到期视角 |
| `proj=ALT`、`type=bug` | 项目 / 类型 |
| `stale=14` | 待办且 N 天没动静 |
| `q=关键词`、`from=人名`、`coti=单号` | 全文 / 联系人 / 报价号（忽略大小写与重音） |
| `limit=N` | 默认 100，上限 2000 |

单条详情（带时间线）：`GET /tasks/12`（JSON，含 `timeline`）或 `GET /tasks/12?as=text`。

## 2. 建任务

`POST /tasks`，`title` 必填；其余可选：`proj`、`type`（bug/compra/correo/llamada/reunion/pago/…）、`due`（YYYY-MM-DD）、`notes`、`from_person`、`priority`、`section`、`gmail`、`coti`、`origen`、`timeline`（数组，可带 `{ts,text}`）。

```bash
curl -s -X POST "http://127.0.0.1:7492/tasks" \
  -H "X-Auth-Token: abcd" -H "X-Actor: bolba" \
  -H "Content-Type: application/json" \
  --data-binary @- <<'JSON'
{"title":"Reclamar factura a proveedor","proj":"BOL","type":"pago","due":"2026-10-09","from_person":"Lucía","timeline":["Hablé con Lucía, manda factura el lunes"]}
JSON
```

- 成功：`201 {id, task, warnings, reimported}`。
- **`409` = 疑似重复**：响应里有 `candidates`（相似任务）。两条路：
  - 确实重复 → 别建，改为 `PATCH /tasks/<候选id>` 补充信息，并在时间线里说明；
  - 确实不同 → `POST /tasks?force=true` 重发一次。
- 失败必读 `error` 字段（`400` 会带 `valid[]` 字段清单）。

## 3. 改任务 + 追加时间线

`PATCH /tasks/<id>`，只发要改的字段；`timeline` 里的字符串会追加到时间线（自动去重）。

```bash
curl -s -X PATCH "http://127.0.0.1:7492/tasks/7" \
  -H "X-Auth-Token: abcd" -H "X-Actor: bolba" \
  -H "Content-Type: application/json" \
  --data-binary @- <<'JSON'
{"due":"2026-10-15","status":"waiting","timeline":["Esperando respuesta del proveedor"]}
JSON
```

只记一笔进展：`POST /tasks/7/timeline`，body `{"timeline":["…"]}`。

## 4. 关闭 / 重开 / 删除

```bash
curl -s -X POST "http://127.0.0.1:7492/tasks/7/close"  -H "X-Auth-Token: abcd" -H "X-Actor: bolba" -H "Content-Type: application/json" --data-binary @- <<'JSON'
{"status":"done"}
JSON
```

- `{"status":"done"}`（默认）完成；`"discarded"` 废弃；`"completed"` 同 done。
- 重开：`POST /tasks/7/reopen`。
- 彻底删除（极少用，优先 discarded）：`DELETE /tasks/7`。

## 5. 其它

- `GET /stats`：`{by_status, open_by_proj, due_today_or_overdue, counter}`。
- `GET /duplicates?title=…`：建任务前先查重。
- `GET /health`：服务状态（免 token）。
- 手写 Markdown 也行：看板镜像在 `tools/bolba-board/data/Tareas.md`（可用 `BOLBA_BOARD_MD` 指向 Obsidian 库）。改文件后下一次请求会自动导入，动作会记在 `health.drift` 与卡片的 "reimportado de disco" 上。

## 6. 回答风格

- 汇报时给**真实结果**：新建就说 id 与标题；查列表就贴关键行；关闭就贴新状态。
- 时间线文字用 markdown：`**粗体**`、`[[persona|Nombre]]` 引用人物；状态 emoji 约定：✅ 完成、🔴 阻塞、↩ 重开、🗑 废弃。
- 用户问"今天先干哪几个"时：先 `GET /tasks?scope=pending&as=text` 拉全量，再按 到期>阻塞>久未动 排序给出 3–5 条建议，并说明理由（可把结论写回对应任务的时间线）。
