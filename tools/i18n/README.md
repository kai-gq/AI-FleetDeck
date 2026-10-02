# tools/i18n —— zh-CN 本地化工具链

零依赖 Node 脚本,放在 `tools/` 下、不进 `src/`,与上游 `deivid11/tide-commander` 零冲突。
**铁律:永不手改 `public/locales/zh-CN/*.json`。** 一切值都从「翻译记忆 + kit」经 `apply.mjs` 重建,保证 en 键序、LF、无 BOM、2 空格缩进。

## 文件

| 文件 | 作用 |
|---|---|
| `audit.mjs` | 审计 zh-CN 与 en 的奇偶/占位符/卫生/术语;**定义唯一计数口径** |
| `apply.mjs` | 由 en 键序 + 翻译记忆 + kit 重建 zh 文件(内存 `work/memory.json` 为权威) |
| `glossary.json` | 术语规则(`rules` 机械强制,`style` 文档性约定) |
| `allowlist.json` | 白名单:允许与 en 相同(`identical`)、允许无中文(`noCJK`)、批准 zh 独有 key(`localeOnly`,见下) |
| `work/` | 工作区(**gitignored**):`memory.json`、`kit-*.json`、sandbox 副本 |

## audit.mjs

```bash
node tools/i18n/audit.mjs                 # 全量审计(自动读取 glossary.json)
node tools/i18n/audit.mjs --strict        # 有 FAIL 时 exit 1(脚本/CI 用)
node tools/i18n/audit.mjs --ns config     # 只看某命名空间
node tools/i18n/audit.mjs --wiring        # 扫描 src/ 的 t() 接线(跨 ns 断线、defaultValue 缺 key)
node tools/i18n/audit.mjs --export-kit tools/i18n/work   # 导出待译 kit(--polish 连已有值一起导出)
node tools/i18n/audit.mjs --no-glossary   # 临时跳过术语检查
```

检查项:JSON 合法性(报行列)、重复 key、BOM/CR/尾换行、key 奇偶(复数族感知)、占位符多重集、值与 en 相同(白名单外 FAIL)、零中文 WARN、en 键序漂移 INFO、术语违规 FAIL。退出码:`0` 干净 / `1` 有 FAIL / `2` 解析或参数错误。

## apply.mjs

```bash
node tools/i18n/apply.mjs                       # 归一化:记忆→文件,en 序重排(--dry-run 先看)
node tools/i18n/apply.mjs --kit work/kit-x.json # 并入一批翻译(kit 可重复)
node tools/i18n/apply.mjs --glossary            # 对全部值重放术语替换(上游同步后必跑)
node tools/i18n/apply.mjs --adopt               # 把文件里的手改收编进记忆(一般不用)
```

- **kit 格式**:`{ "<ns>": { "<key>": "中文" | {"zh":"中文"} | null } }`;`null` = 删除该 key(如冗余复数形);复数族也可只写基础 key。
- **复数规范**:zh 基础 key 覆盖任意 count;与基础 key 同文的 `_other/_plural` 变体会被折入基础 key(报告折叠清单);异文 `_other` 保留并告警为 conflict。
- **stale 检测**:每条记忆存 en 值哈希;en 改了报 `stale en`,上游删 key 报 `orphaned` 并从记忆移除。
- **zh 独有 key**:代码补丁用 `t('ns:key', { defaultValue: '英文' })` 时,key 可以不在 en —— zh 直接补一条(记忆里 `h:null` 表示 zh 独有),en 文件零改动;audit 把这类 key 归 INFO `localeOnly`,需在 `allowlist.json` 的 `localeOnly` 数组登记(批准的 key 或 `re:` 前缀),否则报 WARN `extra`。

## 标准流程

上游同步后:

```bash
git fetch upstream --tags && git rebase upstream/master
node tools/i18n/apply.mjs --glossary   # 重建 zh 并重放术语(报告 stale/missing 线索)
node tools/i18n/audit.mjs --strict     # 0 FAIL 才算同步完成;缺译走下一节
```

翻译一批:

```bash
node tools/i18n/audit.mjs --export-kit tools/i18n/work --ns config   # 生成 kit(留空的跳过)
# 编辑 tools/i18n/work/kit-config.json,填 zh(术语/风格见 glossary.json)
node tools/i18n/apply.mjs --kit tools/i18n/work/kit-config.json
node tools/i18n/audit.mjs --strict
```

面向开发者的完整说明见 `obsidian-docs/08-二次开发指南/08-10-中文本地化与维护.md`。
