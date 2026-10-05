# human-campaign —— 真人化全系统真链路测试战役（任务19·B 主体）

> 以"模拟真人的思维、设计各维度真实问题、逐一真跑、完全走真实路径"为口径：真 LLM 回合、
> 真 agent 派活、真 events.db 取证、真语音、真 cron。**零 src 改动**；所有产物落本目录
> （reports/、scratch/ 与回填文件 gitignored）。与 `tools/jarvis-canary/`（冻结的金丝雀冒烟）
> 并列：本工具只**导入** canary 的只读原语（types/client/log-query/scenarios），不修改它。

## 五波 · 43 探针（HC-01..43）

| 波 | 覆盖 | 探针 | 运行面 |
|---|---|---|---|
| C1 | 对话与判断层：双跳、真人语言形态（模糊/错字/情绪/否定/跨话题/空输入/超长）、记忆、人设、闸门低相关、红队② | HC-01..14 | 零环境写入（14 个秘书回合） |
| C2 | 单项目派活闭环：只走 Boss 不变式、真回执、查进度、委派史、卡/病历、评价、撤回、红队③、回执播报 | HC-15..24 | 真派活（~10 秘书+6 Boss+5 下属回合） |
| C3 | 多项目（19·B D3 五场景 + 红队①）：并行隔离、项目路由、跨项目转交、撤回、配额、并发插话 | HC-25..33 | env-prep 布置 A/B/C；**HC-28 冷腿先行**（order=1） |
| C4 | 机器面与长周期：常驻化冷热、系统活动、日志分析日报、哨兵闸口、真 cron 隔夜、Bolba、孤儿恢复 | HC-34..40 | 含两次重启（分段执行）+ 隔夜取证 |
| C5 | 语音真链路 + 对抗 + 收口：TTS→STT 回环、流式 STT、真麦抽验、人类对抗包 | HC-41..43 | HC-42 为 manualOnly（见 MANUAL.md）；HC-43 季度 opt-in |

## 用法（仓库根目录）

```bash
npx tsx tools/human-campaign/run.ts --list                 # 探针清单 + 注册自检
npx tsx tools/human-campaign/run.ts --self-test            # 离线自测（唯一质量门，不连服务）
npx tsx tools/human-campaign/run.ts --wave=1 --dry-run     # 预检（连通+前置；不发消息）
npx tsx tools/human-campaign/run.ts --wave=1               # C1 真跑
npx tsx tools/human-campaign/run.ts --probe=HC-28          # 单探针（C3 冷腿先行）
npx tsx tools/human-campaign/run.ts --env-prep=snapshot|setup|verify|teardown   # C3 环境（写环境）
npx tsx tools/human-campaign/run.ts --cleanup              # 波次善后：停所有 running agent
npx tsx tools/human-campaign/run.ts --probe=HC-37 --stage=prep|verify|cleanup   # 跨重启分段
npx tsx tools/human-campaign/run.ts --wave=5 --include-adversarial              # 对抗包（季度 opt-in）
```

常用选项：`--report=<path>`、`--db=<path>`、`--token=<token|AUTH_TOKEN>`、`--verbose`、
`--allow-skip`（非 optional SKIP 仍 0 退出）、`--keep-env`（调试不自动清）。
**退出码**：0=全通过（含 optional SKIP）/ 1=失败/全局错误/非 optional SKIP / 2=参数错误。

## 锚点纪律（全部探针共用）

- 每回合 `t0 = now - 5s`（CLOCK_MARGIN_MS），逐字精确文本锚点、**只认 `id > 锚点`**、间隔 ≥5s；
- 锚点缺失时不静默：退回窗口全域判定并在 notes 记 `ANCHOR_FALLBACK_NOTE`；
- 只读打开 events.db（`readonly:true`，不迁移、不写 WAL）；环境写入仅 env-prep 与
  `effect ∈ {env,restart}` 的探针（HC-37/HC-40 分段，重启需用户点头）。

## env-prep（C3 多项目环境）

`snapshot` 记录 workspaces/areas/active/agents 全表 → `setup` 布置：A=现有 test 工作区补 area、
B/C=新建工作区（名「项目B」「项目C」）+ 战役主管/下属 + area 绑定（WS `spawn_boss_agent` +
`sync_areas` + `PUT /api/workspaces/:id`）→ `verify` 断言每条链（workspace→area→唯一 Boss）→
`teardown` 全链还原并复核计数。状态存 `.env-prep-state.json`（gitignored）。**setup/teardown 写环境，
需用户在场确认。**

## 产物与报告

- `reports/campaign-<ISO>.json`：每波报告（探针结果、断言 expected/actual、证据 log#id、窗口 observed）；
- `reports/ws-<ISO>.jsonl`：WS 观测记录（回执播报等唯一证据面，HC-23）；
- `scratch/`：中途状态（HC-37 哨兵快照、HC-40 重启状态、HC-41 wav）。
- 人工回填：`manual-fills.template.json` → 复制为 `manual-fills.local.json`（见 MANUAL.md）→
  `npx tsx tools/human-campaign/manual-ingest.ts`（`--lookup` 可先打印近 45 分钟证据行协助标注）。

## 边界与纪律

- 工具自身**不 commit**、不改 src、不写 DB；失败探针只登记（缺陷候选按战役纪律走用户裁决）；
- 探针话术与断言在 `probes/w1-dialog.ts … w5-voice.ts` 逐条自描述（`steps`/`assertionDocs` 进报告）；
- `--self-test` 覆盖：注册表完整性（导入即校验 5 波全部模块）、parseArgs、门禁三分支
  （optional SKIP 不阻塞）、executeProbe 五态、锚点助手、相似度、报告往返。
