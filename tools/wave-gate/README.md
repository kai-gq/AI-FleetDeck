# wave-gate —— 波次门编排队（任务37）

把手工五连收敛为**一条命令、单一退出码**，并把每次运行的关键计数追加成趋势文件（漂移免费可见）：

```bash
node tools/wave-gate/gate.mjs                 # 全量五门（波次门标准入口）
node tools/wave-gate/gate.mjs --quick         # 快检：仅 ① lint:types + ④ i18n audit
node tools/wave-gate/gate.mjs --self-test     # 离线自测（内置样例，不跑任何门）
```

零新依赖：只用 node 内置模块，全部通过子进程调用既有工具（`tools/test-baseline`、`tools/i18n`、`tools/jarvis-canary` 本体一律不改）。

## 开关

| 开关 | 语义 |
| --- | --- |
| `--quick` | 只跑 ① lint:types + ④ i18n audit；不跑全量 vitest 与金丝雀，**默认不写趋势文件**（避免半份数据混入趋势） |
| `--skip-canary` | 跳过 ⑤（金丝雀），其余四门照跑；趋势照写、`canarySummary` 为 null |
| `--canary=smoke` | ⑤ 用 `run.ts --level=smoke`（默认） |
| `--canary=l3` | ⑤ 用 `run.ts --level=full --scenario=delegation`（L3 派活链，真实 LLM 消耗） |
| `--canary=l2` | ⑤ 用 `l2-sandbox.ts`（临时 XDG + stub LLM 沙箱；默认场景 dialog、level smoke） |
| `--vitest-report=<path>` | 复用已有 vitest JSON，跳过 ② 的全量运行（②③ 读它）——已缓存报告复检用 |
| `--no-trend` | 不追加趋势文件 |
| `--self-test` | 用内置样例验证各解析函数 / delta / 退出码聚合（不真跑全量） |
| `--help` | 用法 |

## 五门与解析口径

| # | 门 | 子进程命令 | 权威产物 | 解析口径 | 通过判定 |
| --- | --- | --- | --- | --- | --- |
| ① | lint | `npm run lint:types` | 退出码 + 输出 | 计数 `error TS\d+`（npm 两行 banner 不算错误） | 退出码 0 且 TS 错误数 0 |
| ② | 全量 vitest | `npx vitest run <test:ci 的 --exclude…> --reporter=json --outputFile=<临时 JSON>` | JSON 报告 | 根字段 `numTotalTests/numPassedTests/numFailedTests/numPendingTests`；缺失时遍历 `testResults[].assertionResults[].status` 兜底 | **报告可解析**（见下方"判定权"） |
| ③ | 基线白名单对照 | `node tools/test-baseline/check.mjs --report <②的 JSON>` | 退出码 + 文本 | 取 `[test-baseline] 失败 N / 白名单 M` 行；退出码语义沿用 check.mjs 不重造（0 一致 / 1 有新增或垃圾条目 / 2 配置错） | 退出码 0 |
| ④ | i18n | `node tools/i18n/audit.mjs --strict --allowlist tools/i18n/allowlist.json` | 退出码 + 文本 | 取最后一次 `totals: X FAIL · Y WARN · Z INFO` 尾行 | 退出码 0 |
| ⑤ | 金丝雀 | smoke/l3 → `npx tsx tools/jarvis-canary/run.ts …`；l2 → `npx tsx tools/jarvis-canary/l2-sandbox.ts` | 退出码 + 报告 JSON | 取 stdout `汇总: 共 N \| 通过 N \| …` 行；再解析 `报告已写入: <path>` 读 JSON 的 `summary`（结构化优先，stdout 兜底） | 退出码 0（沿用 run.ts 语义：全局错误/失败/未允许的 skip 即 1） |

### ②③ 的判定权（重要）

本仓在 Windows 有一批**白名单内环境型既有失败**（见 `tools/test-baseline/README.md`），原始 vitest 退出码非 0 是预期路径。因此：

- **② 只负责"跑完 + 计数"**：产出可解析 JSON 即算通过，退出码记 0（note 里会如实标注 vitest 原始退出码）；
- **③ 是失败的唯一判定权**：新增白名单外失败、或白名单条目已转绿，都使 ③ 非零 → 整门非零。

这样"波次门"的纪律仍是 **零新增失败**，而不是不切实际的"全绿"。

### ②与③共用一次全量

check.mjs 支持 `--report` 只对照不跑测试。gate 让 ② 跑一次 `test:ci` 口径的 vitest 并产出 JSON，③ 直接 `--report` 复用——**全量只跑一遍**。② 的 `--exclude` 列表从 `package.json#scripts.test:ci` 运行时解析（唯一真源），解析失败才回退到与 `check.mjs` EXCLUDES 镜像的两条兜底。

## 趋势文件

每次**非 quick** 运行向 `tools/wave-gate/trend.jsonl`（gitignored）追加一行 JSONL，并与上一行做 delta 对照打印（数字变化以 `↑/↓ (±N)` 高亮；TTY 下带色，管道场景仍有符号标记）：

| 字段 | 来源 |
| --- | --- |
| `ts` / `commit` / `branch` | 运行时刻（ISO）/ `git rev-parse --short HEAD` / `git rev-parse --abbrev-ref HEAD` |
| `lintErrors` | ① 的 `error TS` 计数 |
| `testTotal` / `testPassed` / `testFailed` | ② 的 vitest JSON 报告 |
| `whitelistBaselineFailures` / `whitelistEntries` | ③ 的「失败 N / 白名单 M」 |
| `i18nFails` | ④ 的 totals 行 |
| `canarySummary` | ⑤ 的 `smoke total=N pass=N fail=N skip=N planned=N`（跳过时 null） |

未来（任务03/19 等观测点）可直接消费该文件。

## 退出码

- `0` 全绿；`1` 至少一门失败（任一非零即非零）；`2` 参数错误。
- 子进程超时按 124、启动失败按 127、② 无报告/报告不可解析按 2 计入聚合（均为非零）。
- 失败门会打印输出尾部（最多若干十行）便于定位。

## 自测

```bash
node tools/wave-gate/gate.mjs --self-test
```

用内置样例验证：lint 报错计数、`test:ci` 口径提取、vitest 报告两种解析路径、基线对照行、i18n totals（取尾行）、金丝雀汇总行/报告路径、canarySummary 格式化、delta 计算（变化/不变化/无对照）、退出码聚合、参数解析。全绿输出 `自测通过 N/N ✅` 并 exit 0。

## 注意

- Windows 下子进程统一 `shell: true`（cmd.exe），与 `check.mjs` 的 `execSync` 同模式；输出按 UTF-8 解码（各工具均为 node 写出）。
- 改动 `package.json#test:ci` 口径后无需改本工具（运行时解析）；但 `check.mjs` 内的镜像仍需手工同步（其原有约束）。
- `--quick` 不写趋势；如需记录完整趋势请跑全量（或 `--vitest-report` + 非 quick 复检）。
- 本工具不修改 `src/**`、`package.json`；`trend.jsonl` 不入库。
