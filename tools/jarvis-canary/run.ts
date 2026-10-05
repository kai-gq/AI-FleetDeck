/**
 * jarvis-canary 金丝雀真链路冒烟 —— CLI 入口
 *
 * 用法（在仓库根目录）：
 *   npx tsx tools/jarvis-canary/run.ts --level=smoke          # 阶段门必跑（低侵入）
 *   npx tsx tools/jarvis-canary/run.ts --dry-run              # 只做连通+前置检查，不发消息
 *   npx tsx tools/jarvis-canary/run.ts --level=full           # opt-in：真派活（真实 LLM 消耗）
 *   npx tsx tools/jarvis-canary/run.ts --self-test            # 离线自测（不依赖 dev server）
 *   npx tsx tools/jarvis-canary/run.ts --scenario=dialog --dry-run
 *
 * 退出码：0 全通过（dry-run 的前置检查通过）；1 有失败/全局错误/（未 --allow-skip 时的）跳过；2 参数错误。
 *
 * 边界：脚本自身不写任何数据（EventDB 只读打开）；只发 HTTP/WS 请求。full 场景会真派活，
 * 详见 README.md「真跑注意」。
 */

import { createTransport } from './client.js';
import { openReadOnlyLogQuery, resolveDbPath, type ReadOnlyLogQuery } from './log-query.js';
import { printSummary, buildReport, computeExitCode, defaultReportPath, writeReport } from './report.js';
import { QUOTA_DEFAULT_REQUESTS, SCENARIOS, runPrereqs, selectScenarios } from './scenarios.js';
import type {
  CanaryOptions, CanaryReport, PrereqResult, ScenarioContext, ScenarioDef, ScenarioResult,
} from './types.js';

// ─── 参数解析 ───

export function defaultOptions(): CanaryOptions {
  return {
    baseUrl: 'http://127.0.0.1:6200',
    level: 'smoke',
    scenarioFilter: [],
    dryRun: false,
    httpTimeoutMs: 180_000,
    wsTimeoutMs: 8_000,
    scenarioTimeoutMs: 600_000,
    logWaitMs: 30_000,
    pollMs: 1_000,
    bossWaitMs: 180_000,
    reportWaitMs: 300_000,
    dialogText: '列出团队成员',
    taskText: '让团队做一件金丝雀冒烟验证任务：只回复"收到"即可，不要执行任何实际操作。',
    cancelText: '别做了，取消刚才的任务',
    simulateReceipt: false,
    quotaRequests: QUOTA_DEFAULT_REQUESTS,
    allowSkip: false,
    verbose: false,
  };
}

export interface ParsedArgs {
  options: CanaryOptions;
  help: boolean;
  selfTest: boolean;
  errors: string[];
}

const NUMERIC_FLAGS: Array<[string, keyof CanaryOptions]> = [
  ['timeout-ms', 'httpTimeoutMs'],
  ['ws-timeout-ms', 'wsTimeoutMs'],
  ['scenario-timeout-ms', 'scenarioTimeoutMs'],
  ['log-wait-ms', 'logWaitMs'],
  ['poll-ms', 'pollMs'],
  ['wait-boss-ms', 'bossWaitMs'],
  ['wait-report-ms', 'reportWaitMs'],
  ['quota-requests', 'quotaRequests'],
];

export function parseArgs(argv: string[]): ParsedArgs {
  const options = defaultOptions();
  const errors: string[] = [];
  let help = false;
  let selfTest = false;

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') { help = true; continue; }
    if (arg === '--self-test') { selfTest = true; continue; }
    if (arg === '--dry-run') { options.dryRun = true; continue; }
    if (arg === '--simulate-receipt') { options.simulateReceipt = true; continue; }
    if (arg === '--allow-skip') { options.allowSkip = true; continue; }
    if (arg === '--verbose') { options.verbose = true; continue; }

    const match = /^--([a-z0-9-]+)(?:=(.*))?$/.exec(arg);
    if (!match) { errors.push(`无法识别的参数：${arg}`); continue; }
    const [, key, rawValue] = match;
    const value = rawValue ?? '';

    if (key === 'level') {
      if (value !== 'smoke' && value !== 'full') errors.push(`--level 只支持 smoke|full，收到：${value}`);
      else options.level = value;
    } else if (key === 'scenario') {
      const names = value.split(',').map((s) => s.trim()).filter(Boolean);
      if (names.length === 0) errors.push('--scenario 需要给出场景名（逗号分隔）');
      else options.scenarioFilter.push(...names);
    } else if (key === 'base-url') {
      if (!value) errors.push('--base-url 不能为空');
      else options.baseUrl = value;
    } else if (key === 'report') {
      options.reportPath = value || undefined;
    } else if (key === 'db') {
      options.dbPath = value || undefined;
    } else if (key === 'token') {
      options.token = value || undefined;
    } else if (key === 'dialog-text') {
      options.dialogText = value;
    } else if (key === 'task-text') {
      options.taskText = value;
    } else if (key === 'cancel-text') {
      options.cancelText = value;
    } else if (NUMERIC_FLAGS.some(([flag]) => flag === key)) {
      const target = NUMERIC_FLAGS.find(([flag]) => flag === key)![1];
      const num = Number(value);
      if (!Number.isFinite(num) || num < 0) errors.push(`--${key} 需要非负数字，收到：${value}`);
      else (options as unknown as Record<string, number>)[target] = Math.floor(num);
    } else {
      errors.push(`无法识别的参数：${arg}`);
    }
  }

  if (!options.token && process.env.AUTH_TOKEN) options.token = process.env.AUTH_TOKEN;
  return { options, help, selfTest, errors };
}

export function printHelp(): void {
  console.log(`jarvis-canary 金丝雀真链路冒烟

用法:
  npx tsx tools/jarvis-canary/run.ts [选项]

选项:
  --level=smoke|full       冒烟级别（默认 smoke；full=smoke+缺省四链；opt-in 场景须显式点名）
  --scenario=<name,...>    只跑指定场景（可重复/逗号分隔）:
                           connectivity(conn) / dialog-roundtrip(dialog) / delegation-chain(delegation) /
                           receipt-chain(receipt) / cancel-chain(cancel，opt-in) /
                           project-routing(routing/project，opt-in) / cross-project-handover(handover，恒 SKIP) /
                           quota-concurrency(quota，opt-in) / adversarial(adv，opt-in)
  --dry-run                只做连通+查询前置检查，不发任何消息
  --base-url=<url>         服务端地址（默认 http://127.0.0.1:6200）
  --report=<path>          报告输出路径（默认 tools/jarvis-canary/reports/<时间戳>.json）
  --db=<path>              events.db 路径覆盖（默认 ~/.local/share/tide-commander/events.db）
  --token=<token>          AUTH_TOKEN（服务端启用鉴权时；也可用环境变量 AUTH_TOKEN）
  --timeout-ms=<n>         HTTP 单请求超时（默认 180000，LLM hop1 较慢）
  --ws-timeout-ms=<n>      WS 握手首帧超时（默认 8000）
  --scenario-timeout-ms=<n>单个场景总超时（默认 600000）
  --log-wait-ms=<n>        发消息后轮询日志窗口（默认 30000）
  --poll-ms=<n>            轮询间隔（默认 1000）
  --wait-boss-ms=<n>       full③⑤⑦⑨ 等待 Boss 拆解 delegated 的窗口（默认 180000；0=不等）
  --wait-report-ms=<n>     full④⑨ 等待下属回执/出队事件的窗口（默认 300000）
  --quota-requests=<n>     quota-concurrency 发起条数（默认 5，最小 2；需 > TC_JARVIS_QUOTA_BUDGET，缺省 3）
  --dialog-text=<text>     smoke② 发送的查询类消息（默认"列出团队成员"）
  --task-text=<text>       full③ 发送的任务消息（默认金丝雀最小验证任务）
  --cancel-text=<text>     cancel-chain 撤回话术（默认"别做了，取消刚才的任务"）
  --simulate-receipt       full④ 用 report-task 接口模拟下属回执（半合成，默认关）
  --allow-skip             允许跳过（有 SKIP 场景时仍以 0 退出）
  --verbose                打印更多过程日志
  --self-test              离线自测（不依赖 dev server）
  --help                   本帮助

退出码: 0=全通过; 1=失败/全局错误/存在跳过(未 --allow-skip); 2=参数错误

示例:
  npx tsx tools/jarvis-canary/run.ts --dry-run
  npx tsx tools/jarvis-canary/run.ts --level=smoke
  npx tsx tools/jarvis-canary/run.ts --level=full --simulate-receipt
`);
}

// ─── 场景执行 ───

export async function runScenario(def: ScenarioDef, ctx: ScenarioContext): Promise<ScenarioResult> {
  const startedAt = Date.now();
  const base: Omit<ScenarioResult, 'status' | 'prereqs' | 'assertions' | 'notes' | 'observed'> = {
    name: def.name, title: def.title, level: def.level, startedAt, elapsedMs: 0,
  };

  if (def.unsupported) {
    return {
      ...base, status: 'skip', elapsedMs: Date.now() - startedAt,
      prereqs: [], assertions: [],
      notes: [`未交付能力：${def.unsupported}`],
      observed: [],
    };
  }

  const prereqs = await runPrereqs(def, ctx);
  const failedEnv = prereqs.filter((p) => !p.ok && p.kind === 'env');
  const failedRuntime = prereqs.filter((p) => !p.ok && p.kind === 'runtime');

  if (ctx.options.dryRun && !def.safeInDryRun) {
    const failed = [...failedEnv, ...failedRuntime];
    if (failed.length > 0) {
      return {
        ...base, status: 'fail', elapsedMs: Date.now() - startedAt,
        prereqs, assertions: [], notes: ['前置检查失败（dry-run 不发消息）'], observed: [],
      };
    }
    return {
      ...base, status: 'planned', elapsedMs: Date.now() - startedAt,
      prereqs, assertions: [],
      notes: [
        `计划步骤：${def.steps.join(' → ')}`,
        `断言：${def.assertionDocs.join('；')}`,
      ],
      observed: [],
    };
  }

  if (failedEnv.length > 0 || failedRuntime.length > 0) {
    const failed = [...failedEnv, ...failedRuntime];
    return {
      ...base, status: 'skip', elapsedMs: Date.now() - startedAt,
      prereqs, assertions: [],
      notes: [`前置未满足，跳过：${failed.map((p) => `${p.id}(${p.detail})`).join('；')}`],
      observed: [],
    };
  }

  ctx.log(`[场景开始] ${def.name}（${def.title}）`);
  try {
    const outcome = await withTimeout(
      def.run(ctx),
      ctx.options.scenarioTimeoutMs,
      `场景 ${def.name} 超时（${ctx.options.scenarioTimeoutMs}ms）`,
    );
    const status = outcome.assertions.every((a) => a.ok) ? 'pass' : 'fail';
    return {
      ...base, status, elapsedMs: Date.now() - startedAt,
      prereqs, assertions: outcome.assertions, notes: outcome.notes, observed: outcome.observed ?? [],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ...base, status: 'fail', elapsedMs: Date.now() - startedAt,
      prereqs, assertions: [],
      notes: [`场景执行异常：${msg}`], observed: [],
    };
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  if (ms <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); });
  });
}

// ─── 主流程 ───

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.errors.length > 0) {
    for (const e of parsed.errors) console.error(`参数错误: ${e}`);
    console.error('用 --help 查看用法。');
    return 2;
  }
  if (parsed.help) { printHelp(); return 0; }
  if (parsed.selfTest) {
    const { runSelfTest } = await import('./selftest.js');
    return runSelfTest();
  }

  const options = parsed.options;
  const startedAt = Date.now();
  const { selected, unknown } = selectScenarios(options.level, options.scenarioFilter);
  if (unknown.length > 0) {
    console.error(`未知场景: ${unknown.join(', ')}（可用: ${SCENARIOS.map((s) => s.name).join(', ')}）`);
    return 2;
  }

  const globalErrors: string[] = [];
  let logQuery: ReadOnlyLogQuery | undefined;
  try {
    logQuery = openReadOnlyLogQuery(resolveDbPath(options.dbPath));
  } catch (err) {
    globalErrors.push(err instanceof Error ? err.message : String(err));
  }

  const transport = createTransport(options.baseUrl, {
    token: options.token,
    httpTimeoutMs: options.httpTimeoutMs,
    wsTimeoutMs: options.wsTimeoutMs,
    verbose: options.verbose,
  });

  const results: ScenarioResult[] = [];
  if (logQuery) {
    const dayAgo = Date.now() - 24 * 60 * 60_000;
    const ctx: ScenarioContext = {
      transport,
      query: logQuery.query,
      options,
      shared: {},
      dbStats: {
        dbPath: logQuery.dbPath,
        totalRows: logQuery.countAll(),
        rows24h: logQuery.countSince(dayAgo),
        latestTs: logQuery.latestTs(),
      },
      log: (msg) => { if (options.verbose) console.log(`  · ${msg}`); },
    };

    const deletegationPlanned = selected.some((s) => s.name === 'delegation-chain');
    for (const def of selected) {
      if (options.verbose) {
        if (deletegationPlanned && def.name === 'receipt-chain' && !ctx.shared.delegationChain) {
          // 提示执行顺序依赖
          console.log('  · receipt-chain 依赖 delegation-chain 的 delegated 证据（本进程内共享）');
        }
      }
      results.push(await runScenario(def, ctx));
    }
  } else {
    // DB 打不开：为每个选中场景记一条失败结果，报告仍可落盘
    for (const def of selected) {
      results.push({
        name: def.name, title: def.title, level: def.level, status: 'fail',
        startedAt, elapsedMs: 0, prereqs: [], assertions: [],
        notes: ['EventDB 打开失败，场景未执行（见全局错误）'], observed: [],
      });
    }
  }

  transport.close();
  const report = buildReport({
    level: options.level,
    dryRun: options.dryRun,
    scenarioFilter: options.scenarioFilter,
    baseUrl: transport.baseUrl,
    dbPath: logQuery?.dbPath,
    globalErrors,
    results,
    startedAt,
  });

  const reportPath = options.reportPath ?? defaultReportPath(startedAt);
  let written: string | undefined;
  try {
    written = writeReport(reportPath, report);
  } catch (err) {
    globalErrors.push(`报告写入失败: ${err instanceof Error ? err.message : String(err)}`);
  }

  printSummary(report, written);
  logQuery?.close();
  return computeExitCode(report, { allowSkip: options.allowSkip });
}

if (process.argv[1] && /run\.ts$/.test(process.argv[1])) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error('jarvis-canary 未捕获异常:', err);
      process.exitCode = 1;
    });
}
