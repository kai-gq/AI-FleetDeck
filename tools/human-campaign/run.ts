/**
 * 真人化全系统真链路测试战役 —— CLI 入口（工具19·B 主体）
 *
 * 用法（仓库根目录）：
 *   npx tsx tools/human-campaign/run.ts --list                 # 探针清单
 *   npx tsx tools/human-campaign/run.ts --wave=1 --dry-run     # 预检（连通+前置，不发消息）
 *   npx tsx tools/human-campaign/run.ts --wave=1               # C1 真跑（真 LLM 回合）
 *   npx tsx tools/human-campaign/run.ts --probe=HC-28          # 单探针（C3 冷腿先行）
 *   npx tsx tools/human-campaign/run.ts --env-prep=setup       # C3 环境布置（写环境，需用户确认）
 *   npx tsx tools/human-campaign/run.ts --env-prep=verify|teardown
 *   npx tsx tools/human-campaign/run.ts --cleanup              # 停所有 running agent（波次善后）
 *   npx tsx tools/human-campaign/run.ts --probe=HC-37 --stage=prep|verify|cleanup   # 分段（含重启）
 *   npx tsx tools/human-campaign/run.ts --self-test            # 离线自测（唯一质量门，不依赖 dev server）
 *
 * 退出码：0=全通过（含 optional SKIP）；1=失败/全局错误/非 optional SKIP（未 --allow-skip）；
 *         2=参数错误。锚点纪律：t0=now-5s、逐字精确文本锚点、只认 id>锚点、间隔≥5s。
 *
 * 边界：log-query 只读打开 events.db；环境写入仅 env-prep 与 effect∈{env,restart} 的探针；
 * 探针不 commit、不改 src；报告落 tools/human-campaign/reports（gitignored）。
 */

import { createTransport } from '../jarvis-canary/client.js';
import { openReadOnlyLogQuery, resolveDbPath, type ReadOnlyLogQuery } from '../jarvis-canary/log-query.js';
import type { PrereqResult, ProbeDef, ProbeResult, WsMsg, WsObserverLike } from './types.js';
import { readStateFile, runPrereqs } from './runner.js';
import { connectMainWs } from './ws-client.js';
import { allProbes, checkRegistry, findProbe, PLANNED_TOTAL, probesForWave } from './probes/registry.js';
import { buildReport, defaultReportPath, gateVerdict, printReport, writeCampaignReport } from './report.js';
import type { CampaignReport } from './types.js';

// ─── 选项 ───

export interface ParsedArgs {
  options: import('./types.js').HumanOptions;
  help: boolean;
  selfTest: boolean;
  list: boolean;
  envPrep: 'snapshot' | 'setup' | 'verify' | 'teardown' | undefined;
  cleanup: boolean;
  errors: string[];
}

export function defaultOptions(): import('./types.js').HumanOptions {
  return {
    baseUrl: 'http://127.0.0.1:6200',
    probeFilter: [],
    dryRun: false,
    allowSkip: false,
    verbose: false,
    httpTimeoutMs: 180_000,
    wsTimeoutMs: 8_000,
    probeTimeoutMs: 600_000,
    logWaitMs: 30_000,
    pollMs: 1_000,
    bossWaitMs: 180_000,
    reportWaitMs: 300_000,
    includeAdversarial: false,
    keepEnv: false,
  };
}

const NUMERIC_FLAGS: Array<[string, keyof import('./types.js').HumanOptions]> = [
  ['timeout-ms', 'httpTimeoutMs'],
  ['ws-timeout-ms', 'wsTimeoutMs'],
  ['probe-timeout-ms', 'probeTimeoutMs'],
  ['log-wait-ms', 'logWaitMs'],
  ['poll-ms', 'pollMs'],
  ['wait-boss-ms', 'bossWaitMs'],
  ['wait-report-ms', 'reportWaitMs'],
];

export function parseArgs(argv: string[]): ParsedArgs {
  const options = defaultOptions();
  const errors: string[] = [];
  let help = false, selfTest = false, list = false, cleanup = false;
  let envPrep: ParsedArgs['envPrep'];
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') { help = true; continue; }
    if (arg === '--self-test') { selfTest = true; continue; }
    if (arg === '--list') { list = true; continue; }
    if (arg === '--dry-run') { options.dryRun = true; continue; }
    if (arg === '--cleanup') { cleanup = true; continue; }
    if (arg === '--allow-skip') { options.allowSkip = true; continue; }
    if (arg === '--verbose') { options.verbose = true; continue; }
    if (arg === '--include-adversarial') { options.includeAdversarial = true; continue; }
    if (arg === '--keep-env') { options.keepEnv = true; continue; }
    const m = /^--([a-z0-9-]+)(?:=(.*))?$/.exec(arg);
    if (!m) { errors.push(`无法识别的参数：${arg}`); continue; }
    const [, key, rawValue] = m;
    const value = rawValue ?? '';
    if (key === 'wave') {
      const n = Number(value);
      if (![1, 2, 3, 4, 5].includes(n)) errors.push(`--wave 只支持 1..5，收到：${value}`);
      else options.wave = n as 1 | 2 | 3 | 4 | 5;
    } else if (key === 'probe') {
      const ids = value.split(',').map((s) => s.trim()).filter(Boolean);
      if (ids.length === 0) errors.push('--probe 需要探针 id（如 --probe=HC-28，逗号分隔可多选）');
      else options.probeFilter.push(...ids);
    } else if (key === 'base-url') { if (!value) errors.push('--base-url 不能为空'); else options.baseUrl = value; }
    else if (key === 'report') { options.reportPath = value || undefined; }
    else if (key === 'db') { options.dbPath = value || undefined; }
    else if (key === 'token') { options.token = value || undefined; }
    else if (key === 'stage') {
      if (!['prep', 'verify', 'cleanup'].includes(value)) errors.push(`--stage 只支持 prep|verify|cleanup，收到：${value}`);
      else options.stage = value;
    } else if (key === 'env-prep') {
      if (!['snapshot', 'setup', 'verify', 'teardown'].includes(value)) errors.push(`--env-prep 只支持 snapshot|setup|verify|teardown，收到：${value}`);
      else envPrep = value as ParsedArgs['envPrep'];
    } else if (NUMERIC_FLAGS.some(([f]) => f === key)) {
      const target = NUMERIC_FLAGS.find(([f]) => f === key)![1];
      const num = Number(value);
      if (!Number.isFinite(num) || num < 0) errors.push(`--${key} 需要非负数字，收到：${value}`);
      else (options as unknown as Record<string, number>)[target] = Math.floor(num);
    } else {
      errors.push(`无法识别的参数：${arg}`);
    }
  }
  if (!options.token && process.env.AUTH_TOKEN) options.token = process.env.AUTH_TOKEN;
  return { options, help, selfTest, list, envPrep, cleanup, errors };
}

export function printHelp(): void {
  console.log(`真人化全系统真链路测试战役（human-campaign）

用法:
  npx tsx tools/human-campaign/run.ts [选项]

选项:
  --wave=1..5             只跑该波（C1 对话 / C2 派活 / C3 多项目 / C4 机器面 / C5 语音）
  --probe=HC-xx,...       只跑指定探针（C3 冷腿请先跑 --probe=HC-28）
  --dry-run               预检：连通+前置+env diff（不发任何消息）
  --env-prep=snapshot|setup|verify|teardown   C3 环境布置/还原（setup/teardown 写环境）
  --cleanup               波次善后：stop_agent 停所有 running/processing
  --stage=prep|verify|cleanup   分段探针（HC-37/HC-40，跨服务端重启）
  --include-adversarial   季度 opt-in：对抗包（HC-43）
  --keep-env              env-prep 调试用（不自动清）
  --base-url=<url>        服务端地址（默认 http://127.0.0.1:6200）
  --report=<path>         报告输出（默认 tools/human-campaign/reports/campaign-<ISO>.json）
  --db=<path>             events.db 覆盖（默认 ~/.local/share/tide-commander/events.db）
  --token=<token>         鉴权（或环境变量 AUTH_TOKEN）
  --timeout-ms=<n>        HTTP 单请求超时（默认 180000）
  --ws-timeout-ms=<n>     WS 握手超时（默认 8000）
  --probe-timeout-ms=<n>  单探针总超时（默认 600000）
  --log-wait-ms=<n>       等 dialog out（默认 30000）
  --poll-ms=<n>           轮询间隔（默认 1000）
  --wait-boss-ms=<n>      等 dispatched/delegated（默认 180000）
  --wait-report-ms=<n>    等回执/出队（默认 300000）
  --allow-skip            非 optional SKIP 仍以 0 退出
  --verbose               打印过程日志
  --list                  探针清单
  --self-test             离线自测（不依赖 dev server）
  --help                  本帮助

退出码: 0=全通过; 1=失败/全局错误/非 optional SKIP(未 --allow-skip); 2=参数错误
`);
}

// ─── WS 缺席时的兜底（不崩非 WS 探针；用到 WS 的探针会如实失败） ───

class NullWs implements WsObserverLike {
  readonly messages: WsMsg[] = [];
  private reason: string;
  constructor(reason: string) { this.reason = reason; }
  send(): void { throw new Error(`WS 不可用：${this.reason}`); }
  async waitFor(): Promise<WsMsg | undefined> { return undefined; }
  async waitForType(): Promise<WsMsg | undefined> { return undefined; }
  receivedSince(): WsMsg[] { return []; }
  close(): void { /* noop */ }
}

// ─── 探针执行 ───

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  if (ms <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

/** 探针五态管线（pass/fail/skip/planned/manual）。导出供 selftest 离线注入合成 ProbeDef 验证。 */
export async function executeProbe(def: ProbeDef, ctx: import('./types.js').ProbeContext, dryRun: boolean): Promise<ProbeResult> {
  const startedAt = Date.now();
  const base = { id: def.id, wave: def.wave, title: def.title, dim: def.dim, effect: def.effect, optional: def.optional };
  const prereqs = await runPrereqs(def, ctx, dryRun);
  const failed = prereqs.filter((p) => !p.ok && !p.deferred);

  if (dryRun) {
    if (def.manualOnly) {
      return { ...base, status: 'manual', startedAt: new Date(startedAt).toISOString(), elapsedMs: Date.now() - startedAt, prereqs, assertions: [], notes: ['人工抽验（真跑时记 manual 等回填）'], observed: [] };
    }
    if (failed.length > 0) {
      return {
        ...base, status: 'fail', startedAt: new Date(startedAt).toISOString(), elapsedMs: Date.now() - startedAt, prereqs,
        assertions: [], notes: [`前置失败（dry-run 不发消息）：${failed.map((p) => `${p.id}：${p.detail}`).join('；')}`], observed: [],
      };
    }
    return {
      ...base, status: 'planned', startedAt: new Date(startedAt).toISOString(), elapsedMs: Date.now() - startedAt, prereqs,
      assertions: [], notes: [`计划步骤：${def.steps.join(' → ')}`, `断言：${def.assertionDocs.join('；')}`], observed: [],
    };
  }

  if (failed.length > 0) {
    return {
      ...base, status: 'skip', startedAt: new Date(startedAt).toISOString(), elapsedMs: Date.now() - startedAt, prereqs,
      assertions: [], notes: [`前置未满足，跳过：${failed.map((p) => `${p.id}(${p.detail})`).join('；')}`], observed: [],
      skipReason: `前置未满足：${failed.map((p) => p.id).join(',')}`,
    };
  }

  try {
    const outcome = await withTimeout(def.run(ctx), ctx.options.probeTimeoutMs, `探针 ${def.id} 超时（${ctx.options.probeTimeoutMs}ms）`);
    const status = outcome.skipReason ? 'skip' : (outcome.assertions.length > 0 && outcome.assertions.every((a) => a.ok) ? 'pass' : 'fail');
    return {
      ...base, status, startedAt: new Date(startedAt).toISOString(), elapsedMs: Date.now() - startedAt, prereqs,
      assertions: outcome.assertions, notes: outcome.notes, observed: outcome.observed ?? [], skipReason: outcome.skipReason,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ...base, status: 'fail', startedAt: new Date(startedAt).toISOString(), elapsedMs: Date.now() - startedAt, prereqs,
      assertions: [], notes: [`探针执行异常：${msg}`], observed: [],
    };
  }
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
    return runSelfTest(argv);
  }
  if (parsed.list) {
    const issues = checkRegistry();
    const waves: Array<{ wave: number; probes: ProbeDef[] }> = [1, 2, 3, 4, 5].map((n) => ({ wave: n, probes: probesForWave(n as 1 | 2 | 3 | 4 | 5) }));
    for (const { wave, probes } of waves) {
      console.log(`── C${wave} ──`);
      for (const p of probes) {
        const tags = [p.optional ? 'optional' : '', p.manualOnly ? 'manual' : '', p.order !== undefined ? `order=${p.order}` : ''].filter(Boolean).join(',');
        console.log(`  ${p.id}  [${p.effect}]${tags ? ` (${tags})` : ''}  ${p.title}`);
      }
    }
    console.log(`共 ${allProbes().length}/${PLANNED_TOTAL} 探针；注册自检：${issues.length === 0 ? '通过' : issues.map((i) => i.msg).join('；')}`);
    return issues.some((i) => i.level === 'error') ? 1 : 0;
  }

  const options = parsed.options;
  const startedAt = Date.now();
  const globalErrors: string[] = [];

  // 探针选择
  let selected: ProbeDef[];
  if (options.probeFilter.length > 0) {
    selected = [];
    for (const key of options.probeFilter) {
      const hits = findProbe(key);
      if (hits.length === 0) { console.error(`未知探针: ${key}（--list 查看）`); return 2; }
      for (const h of hits) if (!selected.includes(h)) selected.push(h);
    }
  } else if (options.wave) {
    selected = probesForWave(options.wave);
  } else {
    selected = allProbes();
  }

  // 只读日志 + 传输
  let logQuery: ReadOnlyLogQuery | undefined;
  try {
    logQuery = openReadOnlyLogQuery(resolveDbPath(options.dbPath));
  } catch (err) {
    globalErrors.push(err instanceof Error ? err.message : String(err));
  }
  const transport = createTransport(options.baseUrl, {
    token: options.token, httpTimeoutMs: options.httpTimeoutMs, wsTimeoutMs: options.wsTimeoutMs, verbose: options.verbose,
  });

  let ws: WsObserverLike;
  let wsNote = '';
  try {
    ws = await connectMainWs(options.baseUrl, options.token, options.wsTimeoutMs);
    wsNote = 'WS 已连接';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ws = new NullWs(msg);
    wsNote = `WS 连接失败（env-prep/HC-40 cleanup 不可用）：${msg}`;
    if (parsed.envPrep || parsed.cleanup) globalErrors.push(wsNote);
  }

  const envState = readStateFile();
  const shared: Record<string, unknown> = {};
  if (envState.ok && envState.state) shared.envPrep = envState.state;

  const dbStats = logQuery
    ? { dbPath: logQuery.dbPath, totalRows: logQuery.countAll(), rows24h: logQuery.countSince(Date.now() - 86_400_000), latestTs: logQuery.latestTs() }
    : { dbPath: options.dbPath ?? '(未打开)', totalRows: -1, rows24h: -1, latestTs: undefined };

  const ctx: import('./types.js').ProbeContext = {
    transport, ws, options,
    query: logQuery
      ? logQuery.query
      : () => { throw new Error('events.db 未打开（见全局错误）'); },
    shared,
    dbStats,
    log: (msg) => { if (options.verbose) console.log(`  · ${msg}`); },
  };

  console.log(`══ human-campaign ══ ${options.dryRun ? '（dry-run 预检）' : ''}`);
  console.log(`base=${options.baseUrl} db=${dbStats.dbPath} rows=${dbStats.totalRows}（24h ${dbStats.rows24h}）；${wsNote}`);
  console.log(`选中探针 ${selected.length} 个${options.wave ? `（C${options.wave}）` : ''}${options.stage ? `；stage=${options.stage}` : ''}`);

  // ── 环境模式（snapshot / setup / verify / teardown）与 cleanup ──
  if (parsed.envPrep) {
    const mod = await import('./env-prep.js');
    let detail = '', ok = false;
    if (parsed.envPrep === 'snapshot') { const r = await mod.envSnapshot(ctx); ok = r.ok; detail = r.ok ? r.detail : (r.error ?? ''); }
    if (parsed.envPrep === 'setup') {
      const snap = await mod.envSnapshot(ctx);
      if (!snap.ok) { ok = false; detail = `snapshot 失败：${snap.error}`; }
      else { const r = await mod.envSetup(ctx); ok = r.ok; detail = r.ok ? r.detail : (r.error ?? r.detail); }
    }
    if (parsed.envPrep === 'verify') { const r = await mod.envVerify(ctx); ok = r.ok; detail = r.detail; }
    if (parsed.envPrep === 'teardown') { const r = await mod.envTeardown(ctx); ok = r.ok; detail = r.detail || (r.error ?? ''); }
    console.log(`[env-prep=${parsed.envPrep}] ${ok ? 'OK' : 'FAIL'}：${detail}`);
    ws.close(); transport.close(); logQuery?.close();
    return ok ? 0 : 1;
  }
  if (parsed.cleanup) {
    const mod = await import('./env-prep.js');
    const r = await mod.stopAllRunning(ctx);
    console.log(`[cleanup] 已停 ${r.stopped.length} 个；仍 busy：${r.remaining.join(', ') || '无'}`);
    ws.close(); transport.close(); logQuery?.close();
    return r.remaining.length === 0 ? 0 : 1;
  }

  // ── dry-run 的 24h 提及预核（HC-28 冷腿条件之一）──
  if (options.dryRun && envState.ok && envState.state) {
    const st = envState.state as { projects?: Array<{ name: string }> };
    const names = (st.projects ?? []).map((p) => p.name.trim().toLowerCase()).filter(Boolean);
    if (names.length > 0 && logQuery) {
      try {
        const rows = logQuery.query({ category: 'dialog', since: Date.now() - 86_400_000, order: 'desc', limit: 400 });
        const hits = rows.filter((r) => {
          const t = String((r.body as { text?: unknown } | undefined)?.text ?? '').toLowerCase();
          return names.some((n) => t.includes(n));
        });
        console.log(`[冷腿预核] 24h 内项目名提及：${hits.length} 条${hits.length > 0 ? `（最近 #${hits[0]!.id}）` : ''}${hits.length > 0 ? ' —— HC-28 冷腿可能不成立（登记口径）' : ' —— 冷腿条件满足'}`);
      } catch (err) {
        globalErrors.push(`24h 提及预核失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ── 探针执行 ──
  const results: ProbeResult[] = [];
  if (!logQuery) {
    for (const def of selected) {
      results.push({
        id: def.id, wave: def.wave, title: def.title, dim: def.dim, effect: def.effect, optional: def.optional,
        status: 'fail', startedAt: new Date(startedAt).toISOString(), elapsedMs: 0, prereqs: [], assertions: [],
        notes: ['events.db 打开失败，探针未执行（见全局错误）'], observed: [],
      });
    }
  } else {
    for (const def of selected) {
      process.stdout.write(`▶ ${def.id} ${def.title} … `);
      const r = await executeProbe(def, ctx, options.dryRun);
      const label = { pass: 'PASS ✔', fail: 'FAIL ✘', skip: 'SKIP －', planned: 'PLAN …', manual: 'MANUAL ☞' }[r.status];
      console.log(`${label}（${(r.elapsedMs / 1000).toFixed(1)}s）${r.skipReason ? ` ${r.skipReason}` : ''}`);
      if (options.verbose) for (const n of r.notes) console.log(`    · ${n}`);
      results.push(r);
    }
  }

  ws.close();
  transport.close();

  const report: CampaignReport = buildReport({
    startedAt, finishedAt: Date.now(), wave: options.wave, dryRun: options.dryRun,
    baseUrl: transport.baseUrl, dbPath: logQuery?.dbPath, globalErrors, results,
  });
  const reportPath = options.reportPath ?? defaultReportPath();
  let written: string | undefined;
  try { written = writeCampaignReport(report, reportPath); }
  catch (err) { globalErrors.push(`报告写入失败：${err instanceof Error ? err.message : String(err)}`); }

  printReport(report, options.verbose);
  if (written) console.log(`报告：${written}`);
  logQuery?.close();

  const verdict = gateVerdict(report, options.allowSkip);
  if (!verdict.ok) {
    for (const reason of verdict.reasons) console.log(`✘ 门禁未过：${reason}`);
    return 1;
  }
  if (globalErrors.length > 0) return 1;
  return 0;
}

if (process.argv[1] && /run\.ts$/.test(process.argv[1])) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error('human-campaign 未捕获异常:', err);
      process.exitCode = 1;
    });
}
