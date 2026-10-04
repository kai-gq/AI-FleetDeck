# test-baseline —— test:ci 基线白名单（2026-10-04 钉死）

对应《任务总览》§5 第 8 条。本工具解决一个口径问题：

> 本仓在 Windows 上有一批**环境型既有失败**（POSIX `/tmp` 路径假设、tmux 隔离、超时抖动等），
> "test:ci 全绿"不可达，门禁纪律实际是"**零新增失败**"——
> 但"零新增"的判定权必须归**文件**，不能归任何开发 agent 的口头解释。

## 规则（严格模式）

| 情形 | 判定 |
| --- | --- |
| 失败且**不在**白名单 | ❌ 新增失败 → **exit 1，阻塞波次** |
| 白名单条目**已转绿/消失** | ❌ 垃圾条目 → exit 1，强制删除（白名单只进不出会腐烂） |
| 与白名单完全一致 | ✅ exit 0 |

- 判定粒度 = `文件 :: 完整测试名`（describe 层级全名），逐条对齐；
- 每条含 `reason`（原因）与 `since`（证据日期），新增条目必须在提交信息里点名；
- 确属环境型的**新**失败要入白名单：先 `--record` 重建，再人工补齐 reason（脚本会保留已有 reason）。

## 用法

```bash
# 对照（跑与 test:ci 同口径的 vitest + 白名单比对）——波次门/阶段门执行这条
node tools/test-baseline/check.mjs

# 只对照已有 vitest JSON 报告（不重跑）
node tools/test-baseline/check.mjs --report path/to/report.json

# 重建白名单（干净树上执行；W5 波次门首次生成）
node tools/test-baseline/check.mjs --record
```

## 注意

- `check.mjs` 里镜像了 `package.json#test:ci` 的两个 `--exclude`；**改 test:ci 口径要同步本工具**，否则两边数字对不上。
- `baseline-failures.json` 骨架文件（`entries:[]`）在 `--record` 前不具备判定力——首次使用先 `--record`。
- 减少白名单的正确方式是**修失败**（例如把 `/tmp` 硬路径改成 `os.tmpdir()`），而不是新增豁免；`--record` 每次重建都会自动剔除已转绿条目，白名单只会缩。
- 与 i18n allowlist（`tools/i18n/allowlist.json`）同模式：文件即判定权，agent 不得口头豁免。
