/**
 * l2-sandbox.ts —— 金丝雀 L2「接线层」沙箱启动 harness
 *
 * 用途：一条命令起「临时沙箱 + 真服务器 + stub LLM」，跑金丝雀场景，回收进程与目录。
 * 配合 `stub-llm/`（TC_CLAUDE_EXECUTABLE 注入）把「契约 → Boss → 回执 → system_log」
 * 的**接线**与「模型说了什么」分离定位：
 *   - 本 harness 全绿而真 LLM（L3）红 → 问题在模型/prompt；
 *   - 本 harness 红 → 代码接线坏了。
 *
 * 用法（在仓库根目录）：
 *   npx tsx tools/jarvis-canary/l2-sandbox.ts --scenario=dialog
 *   npx tsx tools/jarvis-canary/l2-sandbox.ts --scenario=dialog --keep --server-logs
 *   npx tsx tools/jarvis-canary/l2-sandbox.ts --scenario=delegation,receipt --simulate-receipt
 *   npx tsx tools/jarvis-canary/l2-sandbox.ts --self-test     # 离线自测（只测参数解析/纯函数）
 *
 * 沙箱布局（os.tmpdir()/jarvis-canary-l2-XXXX/，默认跑完即删，--keep 保留）：
 *   xdg/                          XDG_DATA_HOME（服务器全部状态，events.db 在 xdg/tide-commander/）
 *   logs/server-out.log|err.log   服务器 stdout/stderr
 *   no-dotenv.env                 空 dotenv 目标（DOTENV_CONFIG_PATH，隔离仓库 .env）
 *   stub-trace.ndjson             --trace 时的 stub 原始收发记录
 *   team-cwd/                     seed agent 团队的工作目录（POST /api/agents 的 cwd 必须存在）
 *   rules-l2.seeded.json          规则文件副本 + {{BOSS_ID}}/{{SUB1_ID}} 等占位符替换结果
 *
 * seed agent 团队（任务38，2026-10-04）：场景含 delegation/receipt 时，服务端就绪后经
 * 公开 HTTP API 建「1 主管 + 2 下属」并互挂 bossId/subordinateIds（POST /api/agents + PATCH
 * /api/agents/:id）——不落离线数据文件、不碰 src/**。随后把生成的 agent id 填进 stub 规则的
 * 占位符（真 id 只有运行时才存在，静态规则文件无法预知）。
 *
 * 回执链判定（任务38）：--scenario 含 receipt 时，金丝雀跑完后再只读查一次沙箱 events.db，
 * 断言任务08 回执埋点（delegation{phase:'receipt'}）已落盘；缺失按 EXIT_FAIL 处理（不许静默略过）。
 *
 * 退出码：0 金丝雀全通过；1 金丝雀有失败/跳过或内部错误（含 seed 失败、回执埋点缺失）；
 *         2 参数错误；3 沙箱服务端启动失败（未就绪/端口占用）。金丝雀自身的退出码优先透传（0/1/2）。
 *
 * 安全边界（2026-10-04 探索核实）：
 *   - CLAUDE_CREDENTIAL_KEEPALIVE=0：凭据保活服务直读写真实 ~/.claude（不走 XDG），必须关，
 *     否则沙箱启动即刷新真实 OAuth token；
 *   - 预置 backup-settings.json {"enabled":false}：备份服务默认启用且启动即跑 scripts/backup-data.sh；
 *   - DOTENV_CONFIG_PATH 指向沙箱空文件 + AUTH_TOKEN 等显式置空：与仓库 .env/宿主环境隔离；
 *   - tools/voice-companion/config.json 由服务器按 cwd 读取——本 harness 只读不碰、决不回显内容。
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openReadOnlyLogQuery } from './log-query.js';
import type { CanaryEntry } from './types.js';

// ─── 常量 ───

export const DEFAULT_PORT = 6399;
export const DEFAULT_READY_TIMEOUT_MS = 90_000;
const READY_POLL_MS = 500;
const HEALTH_PROBE_TIMEOUT_MS = 3_000;
const KILL_GRACE_MS = 8_000;

export const EXIT_OK = 0;
export const EXIT_FAIL = 1;
export const EXIT_ARGS = 2;
export const EXIT_SANDBOX = 3;

/** seed 团队：1 主管 + 2 下属（名字固定，供 stub 规则占位符替换与报告定位）。 */
export const SEED_TEAM = {
  boss: { name: 'L2金丝雀主管', agentClass: 'boss' },
  subordinates: [
    { name: 'L2金丝雀下属甲', agentClass: 'builder' },
    { name: 'L2金丝雀下属乙', agentClass: 'debugger' },
  ],
} as const;

/** 透传给 run.ts 的参数键（其余未知参数一律报错，避免拼错时静默漏传）。 */
const PASSTHROUGH_KEYS = new Set([
  'token', 'allow-skip', 'simulate-receipt', 'verbose', 'dry-run', 'report',
  'dialog-text', 'task-text', 'cancel-text',
  'log-wait-ms', 'poll-ms', 'wait-boss-ms', 'wait-report-ms',
  'timeout-ms', 'ws-timeout-ms', 'scenario-timeout-ms',
]);

// ─── 参数解析（纯函数，便于 --self-test） ───

export interface L2Options {
  port: number;
  keep: boolean;
  /** 用户提供的规则文件路径；缺省 null = stub-llm/rules-l2.json */
  rulesPath: string | null;
  readyTimeoutMs: number;
  serverLogs: boolean;
  trace: boolean;
  level: 'smoke' | 'full';
  scenario: string;
  /** 透传给 run.ts 的原始参数（含 --key=value 原样） */
  runArgs: string[];
  help: boolean;
  selfTest: boolean;
  errors: string[];
}

export function defaultL2Options(): L2Options {
  return {
    port: DEFAULT_PORT,
    keep: false,
    rulesPath: null,
    readyTimeoutMs: DEFAULT_READY_TIMEOUT_MS,
    serverLogs: false,
    trace: false,
    level: 'smoke',
    scenario: 'dialog',
    runArgs: [],
    help: false,
    selfTest: false,
    errors: [],
  };
}

export function parseL2Args(argv: string[]): { options: L2Options; help: boolean; selfTest: boolean; errors: string[] } {
  const options = defaultL2Options();
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--self-test') { options.selfTest = true; continue; }
    if (arg === '--keep') { options.keep = true; continue; }
    if (arg === '--server-logs') { options.serverLogs = true; continue; }
    if (arg === '--trace') { options.trace = true; continue; }

    const match = /^--([a-z0-9-]+)(?:=(.*))?$/.exec(arg);
    if (!match) { options.errors.push(`无法识别的参数：${arg}`); continue; }
    const [, key, rawValue] = match;
    const value = rawValue ?? '';

    if (key === 'port') {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        options.errors.push(`--port 需要 1-65535 的整数，收到：${value}`);
      } else options.port = port;
    } else if (key === 'ready-timeout-ms') {
      const num = Number(value);
      if (!Number.isFinite(num) || num < 0) options.errors.push(`--ready-timeout-ms 需要非负数字，收到：${value}`);
      else options.readyTimeoutMs = Math.floor(num);
    } else if (key === 'rules') {
      if (!value) options.errors.push('--rules 不能为空');
      else options.rulesPath = value;
    } else if (key === 'scenario') {
      if (!value.trim()) options.errors.push('--scenario 需要给出场景名（逗号分隔）');
      else options.scenario = value.trim();
    } else if (key === 'level') {
      if (value !== 'smoke' && value !== 'full') options.errors.push(`--level 只支持 smoke|full，收到：${value}`);
      else options.level = value;
    } else if (PASSTHROUGH_KEYS.has(key)) {
      options.runArgs.push(arg); // 原样透传，由 run.ts 自行校验
    } else {
      options.errors.push(`无法识别的参数：${arg}（--base-url/--db 由沙箱自管，不要传；用 --help 查看列表）`);
    }
  }
  return { options, help: options.help, selfTest: options.selfTest, errors: options.errors };
}

/** 组装 run.ts 的命令行参数（纯函数，便于 --self-test）。 */
export function buildRunArgs(
  opts: Pick<L2Options, 'level' | 'scenario' | 'runArgs'>,
  target: { runScript: string; port: number; dbPath: string },
): string[] {
  return [
    target.runScript,
    `--level=${opts.level}`,
    `--scenario=${opts.scenario}`,
    `--base-url=http://127.0.0.1:${target.port}`,
    `--db=${target.dbPath}`,
    ...opts.runArgs,
  ];
}

export function printHelp(): void {
  console.log(`jarvis-canary L2 沙箱 harness——临时沙箱 + 真服务器 + stub LLM

用法:
  npx tsx tools/jarvis-canary/l2-sandbox.ts [选项]

选项:
  --scenario=<name,...>    金丝雀场景（默认 dialog；透传 run.ts，可用 conn/dialog/delegation/receipt/cancel）
  --level=smoke|full       冒烟级别（默认 smoke；透传 run.ts）
  --port=<n>               沙箱服务端端口（默认 ${DEFAULT_PORT}）
  --rules=<path>           stub 规则文件（默认 tools/jarvis-canary/stub-llm/rules-l2.json）
  --ready-timeout-ms=<n>   等待 /api/health 就绪的超时（默认 ${DEFAULT_READY_TIMEOUT_MS}）
  --keep                   保留沙箱目录（默认跑完删除；失败排查时用它）
  --server-logs            把服务器 stdout/stderr 镜像到控制台（默认只落沙箱日志文件）
  --trace                  开启 TC_STUB_TRACE（写 <沙箱>/stub-trace.ndjson）
  --self-test              离线自测（只测参数解析/纯函数，不启动任何进程）
  --help                   本帮助

seed agent 团队（任务38）:
  --scenario 含 delegation/receipt 时，服务端就绪后经公开 HTTP API（POST /api/agents +
  PATCH /api/agents/:id）建「1 主管 + 2 下属」并互挂 bossId/subordinateIds，再把真实 id/名
  填进 stub 规则副本的 {{BOSS_ID}}/{{SUB1_ID}} 等占位符（运行时 id 静态规则文件无法预知）；
  seed 失败 → 退出码 1（不静默略过）。dialog/conn 场景不 seed（保持空团队）。

回执链判定（任务38）:
  --scenario 含 receipt 时，金丝雀跑完后再只读查沙箱 events.db，断言任务08 回执埋点
  delegation{phase:'receipt'} 已落盘；缺失 → 退出码 1（含 --simulate-receipt 半合成通道；
  --dry-run 不发消息、必然无埋点，跳过后验并打印说明）。

透传给 run.ts（原样）:
  --token= --allow-skip --simulate-receipt --verbose --dry-run --report=
  --dialog-text= --task-text= --cancel-text=
  --log-wait-ms= --poll-ms= --wait-boss-ms= --wait-report-ms=
  --timeout-ms= --ws-timeout-ms= --scenario-timeout-ms=

退出码: 0 金丝雀全通过; 1 金丝雀失败/跳过或内部错误（含 seed 失败、回执埋点缺失）;
        2 参数错误; 3 沙箱服务端启动失败（金丝雀自身的 0/1/2 原样透传）

示例:
  npx tsx tools/jarvis-canary/l2-sandbox.ts --scenario=dialog
  npx tsx tools/jarvis-canary/l2-sandbox.ts --scenario=conn --port=6401 --server-logs
  npx tsx tools/jarvis-canary/l2-sandbox.ts --scenario=delegation
  npx tsx tools/jarvis-canary/l2-sandbox.ts --scenario=delegation,receipt --simulate-receipt
`);
}

// ─── seed 团队（任务38：纯函数 + 公开 HTTP API 实现） ───
//
// 建法（2026-10-04 读服务端源码核实，未改产品代码）：
//   - 归属字段：agent 无 projectId，归属即 cwd（工作区目录）——POST /api/agents 的 cwd 必须存在
//     （agent-service.ts:453 校验 fs.existsSync；routes/agents.ts:1077-1078 必填 name/class/cwd）。
//   - isBoss：POST 传 class:'boss' → createAgent 内部 isBoss = isBoss || class==='boss'
//     （agent-service.ts:510），无需单独字段。
//   - 下属关联：服务端把 boss.subordinateIds 与 sub.bossId 双向互写（boss-service.ts:100
//     assignSubordinates；WS 的 boss_assign_subordinates 是 UI 入口，无 HTTP 路由），
//     PATCH /api/agents/:id 透传 updateAgent 的任意 Partial<Agent>（routes/agents.ts:1408），
//     因此用「PATCH 下属 {bossId} + PATCH 主管 {subordinateIds}」复刻同一双向关联。

export interface SeedAgent {
  id: string;
  name: string;
  agentClass: string;
}

export interface SeedTeam {
  boss: SeedAgent;
  subordinates: SeedAgent[];
  cwd: string;
}

/** 场景名列表（逗号分隔、小写化去空）。 */
export function scenarioNames(scenario: string): string[] {
  return scenario.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** 需要 seed agent 团队的场景（派活/回执链必须；dialog/conn 保持空团队，不影响既有断言）。 */
export function scenarioNeedsAgentSeed(scenario: string): boolean {
  return scenarioNames(scenario).some((n) =>
    n === 'delegation' || n === 'delegation-chain' || n === 'receipt' || n === 'receipt-chain',
  );
}

/** 需要以任务08 回执埋点（delegation{phase:'receipt'}）判定的场景。 */
export function scenarioNeedsReceiptCheck(scenario: string): boolean {
  return scenarioNames(scenario).some((n) => n === 'receipt' || n === 'receipt-chain');
}

/** 把 stub 规则里的 seed 占位符替换成真实 id/名（真 id 只有运行时才有；未 seed 时原样保留）。 */
export function substituteSeedPlaceholders(template: string, team: Pick<SeedTeam, 'boss' | 'subordinates'>): string {
  const map: Record<string, string> = {
    '{{BOSS_ID}}': team.boss.id,
    '{{BOSS_NAME}}': team.boss.name,
    '{{SUB1_ID}}': team.subordinates[0]?.id ?? '',
    '{{SUB1_NAME}}': team.subordinates[0]?.name ?? '',
    '{{SUB2_ID}}': team.subordinates[1]?.id ?? '',
    '{{SUB2_NAME}}': team.subordinates[1]?.name ?? '',
  };
  let out = template;
  for (const [token, value] of Object.entries(map)) {
    if (value) out = out.split(token).join(value);
  }
  return out;
}

export interface ReceiptEvidence {
  logId: number;
  tsIso: string;
  phase: string;
  entry?: string;
  matched?: boolean;
  forwarded?: boolean;
  dedupeKey?: string;
}

/** 从 system_log 行里挑出任务08 回执埋点（category 'delegation' + body.phase 'receipt'）。 */
export function pickReceiptEvidence(entries: readonly CanaryEntry[]): ReceiptEvidence[] {
  return entries
    .filter((e) => e.category === 'delegation' && e.body?.phase === 'receipt')
    .map((e) => ({
      logId: e.id,
      tsIso: new Date(e.ts).toISOString(),
      phase: 'receipt',
      entry: typeof e.body?.entry === 'string' ? e.body.entry : undefined,
      matched: e.body?.matched === true,
      forwarded: e.body?.forwarded === true,
      dedupeKey: typeof e.body?.dedupeKey === 'string' ? e.body.dedupeKey : undefined,
    }));
}

/**
 * 回执链后验（任务38②）：金丝雀跑完后只读打开沙箱 events.db，断言任务08 回执埋点
 * （delegation{phase:'receipt'}）已落盘。查到即打印证据行；缺失打印已见的 phase 分布，
 * 返回 false（调用方转成 EXIT_FAIL——不允许静默略过）。
 */
function verifyReceiptReceiptEvidence(dbPath: string, sinceMs: number): boolean {
  let logQuery: ReturnType<typeof openReadOnlyLogQuery>;
  try {
    logQuery = openReadOnlyLogQuery(dbPath);
  } catch (err) {
    console.error(`[l2-sandbox] 回执链判定失败：只读打开沙箱 events.db 出错：${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  try {
    const rows = logQuery.query({ category: 'delegation', since: sinceMs, order: 'asc', limit: 500 });
    const receipts = pickReceiptEvidence(rows);
    console.log(`[l2-sandbox] 回执链判定：窗口内 delegation 埋点 ${rows.length} 条，phase='receipt' ${receipts.length} 条`);
    for (const r of receipts) {
      console.log(`  · 回执埋点 #${r.logId} ${r.tsIso} entry=${r.entry ?? '?'} matched=${String(r.matched)} forwarded=${String(r.forwarded)} dedupeKey=${r.dedupeKey ?? '-'}`);
    }
    if (receipts.length === 0) {
      const phases = new Map<string, number>();
      for (const e of rows) {
        const p = typeof e.body?.phase === 'string' ? e.body.phase : '(无 phase)';
        phases.set(p, (phases.get(p) ?? 0) + 1);
      }
      const dist = [...phases.entries()].map(([p, n]) => `${p}×${n}`).join('、') || '（无任何 delegation 埋点）';
      console.error(`[l2-sandbox] 未发现回执埋点（任务08 delegation{phase:'receipt'}）：所查窗口内 phase 分布=${dist}
  可能原因：--simulate-receipt 未开（真回执需下属真跑完并调 report-task）、回执被去重跳过或管线未生效。`
      );
      return false;
    }
    return true;
  } finally {
    logQuery.close();
  }
}

interface SeedHttpResult {
  ok: boolean;
  status: number;
  json?: Record<string, unknown>;
  error?: string;
}

/** 直连沙箱服务器的 JSON 请求（公开 API；带超时，避免 seed 阶段卡死）。 */
async function seedRequest(
  port: number,
  method: 'POST' | 'PATCH',
  apiPath: string,
  body: Record<string, unknown>,
): Promise<SeedHttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${apiPath}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json: Record<string, unknown> | undefined;
    try {
      const parsed = text ? JSON.parse(text) : undefined;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
    } catch { /* 非 JSON 响应（保留状态码） */ }
    return { ok: res.ok, status: res.status, json };
  } catch (err) {
    const msg = err instanceof Error
      ? (err.name === 'AbortError' ? '请求超时（10000ms）' : err.message)
      : String(err);
    return { ok: false, status: 0, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

function seedAgentFrom(json: Record<string, unknown> | undefined, fallbackName: string): SeedAgent {
  const id = typeof json?.id === 'string' ? json.id : '';
  const name = typeof json?.name === 'string' ? json.name : fallbackName;
  const agentClass = typeof json?.class === 'string' ? json.class : '';
  if (!id) throw new Error(`POST /api/agents 返回缺少 id：${JSON.stringify(json ?? {})}`);
  return { id, name, agentClass };
}

/**
 * 经公开 HTTP API seed 团队：建 1 主管 + 2 下属，互挂 bossId/subordinateIds。
 * 任一步失败抛错，由调用方转成明确退出（不静默半建团队）。
 */
async function seedAgentTeam(port: number, sandboxRoot: string, verbose: (msg: string) => void): Promise<SeedTeam> {
  const cwd = path.join(sandboxRoot, 'team-cwd');
  fs.mkdirSync(cwd, { recursive: true });

  const boss = seedAgentFrom(
    (await createSeedAgent(port, SEED_TEAM.boss.name, SEED_TEAM.boss.agentClass, cwd)).json,
    SEED_TEAM.boss.name,
  );
  const subordinates: SeedAgent[] = [];
  for (const spec of SEED_TEAM.subordinates) {
    subordinates.push(seedAgentFrom((await createSeedAgent(port, spec.name, spec.agentClass, cwd)).json, spec.name));
  }

  // 双向关联（复刻 boss-service.assignSubordinates 的字段写入）
  for (const sub of subordinates) {
    const res = await seedRequest(port, 'PATCH', `/api/agents/${encodeURIComponent(sub.id)}`, { bossId: boss.id });
    if (!res.ok) throw new Error(`PATCH /api/agents/${sub.id} {bossId} 失败：HTTP ${res.status} ${res.error ?? ''}`);
  }
  const res = await seedRequest(port, 'PATCH', `/api/agents/${encodeURIComponent(boss.id)}`, {
    subordinateIds: subordinates.map((s) => s.id),
  });
  if (!res.ok) throw new Error(`PATCH /api/agents/${boss.id} {subordinateIds} 失败：HTTP ${res.status} ${res.error ?? ''}`);

  verbose(`seed 团队完成：主管 ${boss.name}(${boss.id})；下属 ${subordinates.map((s) => `${s.name}(${s.id})`).join('、')}`);
  return { boss, subordinates, cwd };
}

async function createSeedAgent(
  port: number,
  name: string,
  agentClass: string,
  cwd: string,
): Promise<SeedHttpResult> {
  const res = await seedRequest(port, 'POST', '/api/agents', { name, class: agentClass, cwd });
  if (!res.ok) {
    throw new Error(`POST /api/agents（${name}）失败：HTTP ${res.status} ${res.error ?? JSON.stringify(res.json ?? {})}`);
  }
  return res;
}

// ─── 小工具 ───

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** 忽略结果的 execFile（taskkill 在 pid 已退出时返回非 0，属预期）。 */
function execFileP(file: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true }, () => resolve());
  });
}

function isExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitExit(child: ChildProcess, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!isExited(child)) {
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
  return true;
}

/** Windows 下 shell:true 的 child.kill() 只杀 cmd.exe 包装层——用 taskkill /T /F 杀整棵树。 */
async function killTree(child: ChildProcess | undefined, verbose: (msg: string) => void): Promise<void> {
  if (!child || isExited(child)) return;
  const pid = child.pid;
  if (process.platform === 'win32' && pid) {
    await execFileP('taskkill', ['/pid', String(pid), '/T', '/F']);
  } else {
    try { child.kill('SIGTERM'); } catch { /* 忽略 */ }
  }
  if (await waitExit(child, KILL_GRACE_MS)) return;
  verbose(`进程树未在 ${KILL_GRACE_MS}ms 内退出，SIGKILL 兜底（pid=${pid}）`);
  try { child.kill('SIGKILL'); } catch { /* 忽略 */ }
  if (process.platform === 'win32' && pid) {
    await execFileP('taskkill', ['/pid', String(pid), '/T', '/F']);
  }
  await waitExit(child, 2_000);
}

function tailFile(filePath: string, lines = 25): string {
  try {
    const text = fs.readFileSync(filePath, 'utf-8');
    const arr = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    return arr.slice(-lines).join('\n') || '(空)';
  } catch {
    return '(读取失败/不存在)';
  }
}

/** 探测 /api/health；401 单独识别（沙箱理应无鉴权，出现即说明隔离没生效）。 */
async function probeHealth(port: number): Promise<{ ok: boolean; status: number; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal });
    if (res.status === 401) return { ok: false, status: 401, error: 'HTTP 401（沙箱鉴权未隔离：检查 AUTH_TOKEN/DOTENV_CONFIG_PATH）' };
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    const json = await res.json().catch(() => undefined) as { status?: string } | undefined;
    return { ok: json?.status === 'ok', status: res.status, error: json?.status === 'ok' ? undefined : `body.status=${String(json?.status)}` };
  } catch (err) {
    const msg = err instanceof Error ? (err.name === 'AbortError' ? `请求超时（${HEALTH_PROBE_TIMEOUT_MS}ms）` : err.message) : String(err);
    return { ok: false, status: 0, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

// ─── 沙箱自测（离线；不启动进程） ───

export function runSelfTest(): number {
  const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
  const check = (name: string, ok: boolean, detail?: string) => results.push({ name, ok, detail });
  const eq = (name: string, actual: unknown, expected: unknown) =>
    check(name, JSON.stringify(actual) === JSON.stringify(expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);

  // 1) 默认值
  const d = parseL2Args([]);
  eq('默认 port', d.options.port, DEFAULT_PORT);
  eq('默认 scenario=dialog', d.options.scenario, 'dialog');
  eq('默认 level=smoke', d.options.level, 'smoke');
  eq('默认 keep=false / serverLogs=false / trace=false', [d.options.keep, d.options.serverLogs, d.options.trace], [false, false, false]);
  eq('默认无错误', d.errors, []);

  // 2) 自有参数 + 透传
  const p = parseL2Args(['--port=6501', '--keep', '--trace', '--server-logs', '--scenario=conn,dialog', '--level=full',
    '--ready-timeout-ms=1234', '--token=abc', '--allow-skip', '--dialog-text=嘿', '--wait-boss-ms=0']);
  eq('port 解析', p.options.port, 6501);
  eq('布尔开关', [p.options.keep, p.options.trace, p.options.serverLogs], [true, true, true]);
  eq('scenario 透传保留', p.options.scenario, 'conn,dialog');
  eq('level=full', p.options.level, 'full');
  eq('ready-timeout-ms', p.options.readyTimeoutMs, 1234);
  eq('runArgs 收集透传参数', p.options.runArgs, ['--token=abc', '--allow-skip', '--dialog-text=嘿', '--wait-boss-ms=0']);
  eq('无错误', p.errors, []);

  // 3) 非法参数
  const bad = parseL2Args(['--port=70000', '--level=loud', '--ready-timeout-ms=abc', '--base-url=http://x', '--nope']);
  check('非法 port/level/timeout/base-url/nope 共 5 条报错', bad.errors.length === 5, JSON.stringify(bad.errors));

  // 4) --rules / --help / --self-test
  const r = parseL2Args(['--rules=stub-llm/rules-l2.json', '--help']);
  eq('rules 路径', r.options.rulesPath, 'stub-llm/rules-l2.json');
  eq('help 标记', r.help, true);
  eq('selfTest 标记', parseL2Args(['--self-test']).selfTest, true);

  // 5) buildRunArgs 组装
  const args = buildRunArgs(
    { level: 'smoke', scenario: 'dialog', runArgs: ['--allow-skip'] },
    { runScript: 'C:\\r\\tools\\jarvis-canary\\run.ts', port: 6399, dbPath: 'C:\\s\\xdg\\tide-commander\\events.db' },
  );
  eq('buildRunArgs 长度', args.length, 6);
  check('buildRunArgs 含 runScript', args[0] === 'C:\\r\\tools\\jarvis-canary\\run.ts', args[0]);
  check('buildRunArgs 含 base-url/db', args.includes('--base-url=http://127.0.0.1:6399') && args.includes('--db=C:\\s\\xdg\\tide-commander\\events.db'), args.join(' '));
  eq('buildRunArgs 透传参数在尾部', args[args.length - 1], '--allow-skip');

  // 6) 任务38：seed 场景判定（纯函数）
  eq('seed 判定 delegation=true', scenarioNeedsAgentSeed('delegation'), true);
  eq('seed 判定 receipt=true', scenarioNeedsAgentSeed('receipt'), true);
  eq('seed 判定 delegation,receipt=true', scenarioNeedsAgentSeed('delegation,receipt'), true);
  eq('seed 判定 dialog=false', scenarioNeedsAgentSeed('dialog'), false);
  eq('seed 判定 conn=false', scenarioNeedsAgentSeed('conn'), false);
  eq('seed 判定 别名 delegation-chain=true', scenarioNeedsAgentSeed('delegation-chain'), true);
  eq('receipt 判定 delegation=false', scenarioNeedsReceiptCheck('delegation'), false);
  eq('receipt 判定 别名 receipt-chain=true', scenarioNeedsReceiptCheck('receipt-chain'), true);
  eq('receipt 判定 混合（空格/大写）=true', scenarioNeedsReceiptCheck(' Delegation , Receipt '), true);

  // 7) 任务38：SEED_TEAM 结构与占位符替换（纯函数）
  eq('SEED_TEAM 主管 class=boss', SEED_TEAM.boss.agentClass, 'boss');
  eq('SEED_TEAM 下属数=2', SEED_TEAM.subordinates.length, 2);
  const fakeTeam = {
    boss: { id: 'boss-1', name: '主管X', agentClass: 'boss' },
    subordinates: [
      { id: 'sub-1', name: '下属甲', agentClass: 'builder' },
      { id: 'sub-2', name: '下属乙', agentClass: 'debugger' },
    ],
  };
  eq('占位符替换（id+名）',
    substituteSeedPlaceholders('id={{BOSS_ID}}/{{SUB1_ID}}/{{SUB2_ID}}; name={{BOSS_NAME}}/{{SUB1_NAME}}', fakeTeam),
    'id=boss-1/sub-1/sub-2; name=主管X/下属甲');
  eq('缺第二下属时 {{SUB2_ID}} 原样保留',
    substituteSeedPlaceholders('x={{SUB2_ID}}', { boss: fakeTeam.boss, subordinates: [fakeTeam.subordinates[0]] }),
    'x={{SUB2_ID}}');
  eq('无占位符原样返回', substituteSeedPlaceholders('plain', fakeTeam), 'plain');

  // 8) 任务38：回执埋点筛选（纯函数）
  const nowTs = Date.now();
  const entries: CanaryEntry[] = [
    { id: 1, ts: nowTs, category: 'delegation', level: 'info', body: { phase: 'receipt', entry: 'report-task', matched: true, forwarded: true, dedupeKey: 'k1' } },
    { id: 2, ts: nowTs, category: 'delegation', level: 'info', body: { phase: 'reported', forwarded: false } },
    { id: 3, ts: nowTs, category: 'dialog', level: 'info', body: { phase: 'receipt' } },
  ];
  const picked = pickReceiptEvidence(entries);
  eq('回执埋点仅取 delegation+receipt 行', picked.length, 1);
  eq('回执埋点字段映射', picked[0], {
    logId: 1, tsIso: new Date(nowTs).toISOString(), phase: 'receipt',
    entry: 'report-task', matched: true, forwarded: true, dedupeKey: 'k1',
  });

  const pass = results.filter((x) => x.ok).length;
  for (const x of results) process.stdout.write(`  ${x.ok ? '✅' : '❌'} ${x.name}${x.ok ? '' : ` —— ${x.detail ?? ''}`}\n`);
  process.stdout.write(`\n自测结果: ${pass}/${results.length} 通过\n`);
  return pass === results.length ? EXIT_OK : EXIT_FAIL;
}

// ─── 主流程 ───

export async function runL2Sandbox(argv: string[]): Promise<number> {
  const parsed = parseL2Args(argv);
  if (parsed.errors.length > 0) {
    for (const e of parsed.errors) console.error(`参数错误: ${e}`);
    console.error('用 --help 查看用法。');
    return EXIT_ARGS;
  }
  if (parsed.help) { printHelp(); return EXIT_OK; }
  if (parsed.selfTest) return runSelfTest();

  const opts = parsed.options;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..', '..');
  const stubDir = path.join(here, 'stub-llm');
  const rulesPath = path.resolve(opts.rulesPath ?? path.join(stubDir, 'rules-l2.json'));
  const verbose = (msg: string) => console.log(`[l2-sandbox] ${msg}`);

  if (!fs.existsSync(rulesPath)) {
    console.error(`[l2-sandbox] 规则文件不存在：${rulesPath}
  L2 沙箱需要一个能让 stub 直接回契约 JSON 的规则文件；默认文件为 stub-llm/rules-l2.json。`);
    return EXIT_ARGS;
  }

  // tsx 可执行：优先本地 node_modules/.bin（与 dev-server 同形），缺失回退 npx
  const tsxLocal = path.join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
  const useLocalTsx = fs.existsSync(tsxLocal);
  const tsxCmd = useLocalTsx ? tsxLocal : (process.platform === 'win32' ? 'npx.cmd' : 'npx');
  const tsxPrefix = useLocalTsx ? [] : ['tsx'];

  // ── 建沙箱 ──
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-canary-l2-'));
  const xdgDir = path.join(sandboxRoot, 'xdg');
  const dataDir = path.join(xdgDir, 'tide-commander');
  const logsDir = path.join(sandboxRoot, 'logs');
  const outLogPath = path.join(logsDir, 'server-out.log');
  const errLogPath = path.join(logsDir, 'server-err.log');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  // dotenv 隔离：指向沙箱内空文件，仓库 .env（若存在）不再被加载
  const dotenvPath = path.join(sandboxRoot, 'no-dotenv.env');
  fs.writeFileSync(dotenvPath, '');
  // 关闭备份调度：备份服务默认 enabled 且启动即跑 scripts/backup-data.sh
  fs.writeFileSync(path.join(dataDir, 'backup-settings.json'), JSON.stringify({ enabled: false }, null, 2) + '\n');
  // stub 规则落沙箱副本：seed 后把真实 agent id/名填进 {{...}} 占位符（运行时 id 静态规则文件无法预知）；
  // 先写一份未替换副本，保证服务端任何时候 spawn stub 都能读到文件。
  const sandboxRulesPath = path.join(sandboxRoot, 'rules-l2.seeded.json');
  const baseRulesText = fs.readFileSync(rulesPath, 'utf-8');
  fs.writeFileSync(sandboxRulesPath, baseRulesText);

  // stub 可执行（Windows 用仓库 .cmd 垫片——纯 ASCII，勿动；POSIX 生成沙箱内 shim）
  let stubExecutable: string;
  if (process.platform === 'win32') {
    stubExecutable = path.join(stubDir, 'claude-stub.cmd');
    if (!fs.existsSync(stubExecutable)) {
      console.error(`[l2-sandbox] stub 垫片不存在：${stubExecutable}`);
      fs.rmSync(sandboxRoot, { recursive: true, force: true });
      return EXIT_ARGS;
    }
    if (/\s/.test(stubExecutable)) {
      console.error(`[l2-sandbox] stub 路径含空格，Windows shell:true 下无法 spawn：${stubExecutable}
  请把仓库移到无空格路径（如 E:\\tide-commander\\...）后重试。`);
      fs.rmSync(sandboxRoot, { recursive: true, force: true });
      return EXIT_ARGS;
    }
  } else {
    stubExecutable = path.join(sandboxRoot, 'claude-stub.sh');
    fs.writeFileSync(stubExecutable, `#!/bin/sh\nexec node ${JSON.stringify(path.join(stubDir, 'claude-stub.mjs'))} "$@"\n`);
    fs.chmodSync(stubExecutable, 0o755);
  }

  console.log(`[l2-sandbox] 沙箱: ${sandboxRoot}`);
  console.log(`[l2-sandbox] 端口 ${opts.port} · stub ${stubExecutable}`);
  console.log(`[l2-sandbox] 规则 ${rulesPath}（沙箱副本 ${path.basename(sandboxRulesPath)}）`);
  console.log(`[l2-sandbox] 场景 ${opts.scenario} · seed 团队 ${scenarioNeedsAgentSeed(opts.scenario) ? '开' : '关（该场景不需要 agent 团队）'}`);

  // ── 启动服务端 ──
  const serverEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(opts.port),
    HOST: '127.0.0.1',
    XDG_DATA_HOME: xdgDir,
    DOTENV_CONFIG_PATH: dotenvPath,
    TC_CLAUDE_EXECUTABLE: stubExecutable,
    TC_STUB_RULES: sandboxRulesPath,
    // 凭据保活直读写真实 ~/.claude，必须关（见文件头「安全边界」）
    CLAUDE_CREDENTIAL_KEEPALIVE: '0',
    // 显式清空：防宿主/仓库 .env 泄漏鉴权与 TLS 配置（undefined = 不传入该变量）
    AUTH_TOKEN: undefined,
    LISTEN_ALL_INTERFACES: undefined,
    HTTPS: undefined,
    HTTPS_PORT: undefined,
    TLS_KEY_PATH: undefined,
    TLS_CERT_PATH: undefined,
  };
  if (opts.trace) serverEnv.TC_STUB_TRACE = path.join(sandboxRoot, 'stub-trace.ndjson');

  const server = spawn(tsxCmd, [...tsxPrefix, 'src/packages/server/index.ts'], {
    cwd: repoRoot,
    env: serverEnv,
    shell: process.platform === 'win32', // 与 scripts/dev-server.mjs:61 一致
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const outLog = fs.createWriteStream(outLogPath, { flags: 'a' });
  const errLog = fs.createWriteStream(errLogPath, { flags: 'a' });
  server.stdout?.on('data', (data: Buffer) => {
    outLog.write(data);
    if (opts.serverLogs) process.stdout.write(`[server] ${data.toString()}`);
  });
  server.stderr?.on('data', (data: Buffer) => {
    errLog.write(data);
    if (opts.serverLogs) process.stderr.write(`[server:err] ${data.toString()}`);
  });
  // spawn 本身失败（tsx 不可用等）会走 'error' 事件；不接会变成未捕获异常直接崩溃
  let spawnError: Error | undefined;
  server.on('error', (err) => {
    spawnError = err;
    console.error(`[l2-sandbox] 服务端 spawn 失败：${err.message}`);
  });

  let cleaningUp = false;
  const cleanupSandbox = (): void => {
    if (opts.keep) {
      console.log(`[l2-sandbox] 沙箱保留：${sandboxRoot}`);
      return;
    }
    try {
      fs.rmSync(sandboxRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      console.log('[l2-sandbox] 沙箱已清理');
    } catch (err) {
      console.warn(`[l2-sandbox] 沙箱清理失败（可手动删除）：${sandboxRoot}\n  ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Ctrl+C / SIGTERM：回收进程树 + 清理沙箱后再退出，避免留孤儿
  const onSignal = (sig: NodeJS.Signals): void => {
    if (cleaningUp) return;
    cleaningUp = true;
    console.error(`\n[l2-sandbox] 收到 ${sig}，回收沙箱…`);
    void killTree(server, verbose).then(() => {
      cleanupSandbox();
      process.exit(sig === 'SIGINT' ? 130 : 143);
    });
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  try {
    // ── 轮询就绪 ──
    verbose(`等待 http://127.0.0.1:${opts.port}/api/health 就绪（上限 ${opts.readyTimeoutMs}ms）…`);
    const deadline = Date.now() + opts.readyTimeoutMs;
    let lastProbe: { ok: boolean; status: number; error?: string } = { ok: false, status: 0, error: '未探测' };
    for (;;) {
      if (spawnError) {
        console.error(`[l2-sandbox] 服务端未能启动（spawn 失败）：${spawnError.message}（退出码 ${EXIT_SANDBOX}）`);
        return EXIT_SANDBOX;
      }
      if (isExited(server)) {
        console.error(`[l2-sandbox] 服务端进程提前退出（exitCode=${server.exitCode}）——沙箱启动失败（退出码 ${EXIT_SANDBOX}）`);
        console.error(`--- server stderr 尾部 ---\n${tailFile(errLogPath)}\n--- server stdout 尾部 ---\n${tailFile(outLogPath)}`);
        if (/EADDRINUSE|address already in use/i.test(tailFile(errLogPath) + tailFile(outLogPath))) {
          console.error(`[l2-sandbox] 端口 ${opts.port} 被占用：换 --port=<n> 或停掉占用进程。`);
        }
        return EXIT_SANDBOX;
      }
      lastProbe = await probeHealth(opts.port);
      if (lastProbe.ok) break;
      if (Date.now() >= deadline) {
        console.error(`[l2-sandbox] 等待就绪超时（${opts.readyTimeoutMs}ms）：${lastProbe.error ?? '?'}（退出码 ${EXIT_SANDBOX}）`);
        console.error(`--- server stderr 尾部 ---\n${tailFile(errLogPath)}\n--- server stdout 尾部 ---\n${tailFile(outLogPath)}`);
        return EXIT_SANDBOX;
      }
      await sleep(READY_POLL_MS);
    }
    console.log(`[l2-sandbox] 服务端就绪（/api/health ok，端口 ${opts.port}）`);

    // ── seed agent 团队（仅派活/回执链场景） ──
    const needSeed = scenarioNeedsAgentSeed(opts.scenario);
    if (needSeed) {
      let team: SeedTeam;
      try {
        team = await seedAgentTeam(opts.port, sandboxRoot, verbose);
      } catch (err) {
        console.error(`[l2-sandbox] seed agent 团队失败：${err instanceof Error ? err.message : String(err)}
  派活/回执链依赖沙箱内存在 Boss 与下属；seed 失败即无法判定（退出码 ${EXIT_FAIL}）。`);
        return EXIT_FAIL;
      }
      // 把真实 id/名填进规则副本（stub 每次被 spawn 时才读文件，此刻替换仍然生效）
      fs.writeFileSync(sandboxRulesPath, substituteSeedPlaceholders(baseRulesText, team));
      verbose(`stub 规则已注入 seed id：${path.basename(sandboxRulesPath)}`);
    }

    // ── 跑金丝雀场景 ──
    const runScript = path.join(here, 'run.ts');
    const dbPath = path.join(dataDir, 'events.db');
    const runArgs = buildRunArgs(opts, { runScript, port: opts.port, dbPath });
    console.log(`[l2-sandbox] 运行金丝雀: --level=${opts.level} --scenario=${opts.scenario}（stub LLM）\n`);
    const canaryStartedAt = Date.now() - 5_000; // 与金丝雀自己的 CLOCK_MARGIN_MS 同口径，覆盖日志写入延迟
    const canary = spawn(tsxCmd, [...tsxPrefix, ...runArgs], {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      windowsHide: true,
      env: { ...process.env, AUTH_TOKEN: undefined },
    });
    const canaryCode = await new Promise<number>((resolve) => {
      canary.on('error', (err) => {
        console.error(`[l2-sandbox] run.ts 启动失败：${err.message}`);
        resolve(EXIT_FAIL);
      });
      canary.on('close', (code) => resolve(code ?? EXIT_FAIL));
    });
    console.log(`\n[l2-sandbox] 金丝雀退出码: ${canaryCode}`);

    // ── 回执链判定（任务38②）：以任务08 回执埋点 delegation{phase:'receipt'} 为断言对象 ──
    // dry-run 不发消息 → 必然查不到回执埋点；此门控避免把 dry-run 误判成失败。
    const dryRun = opts.runArgs.includes('--dry-run');
    let receiptCheckFailed = false;
    if (scenarioNeedsReceiptCheck(opts.scenario)) {
      if (dryRun) {
        console.log('[l2-sandbox] --dry-run：不发消息，跳过回执链后验');
      } else {
        receiptCheckFailed = !verifyReceiptReceiptEvidence(dbPath, canaryStartedAt);
      }
    }
    return canaryCode !== EXIT_OK ? canaryCode : (receiptCheckFailed ? EXIT_FAIL : EXIT_OK);
  } finally {
    if (!cleaningUp) {
      cleaningUp = true;
      await killTree(server, verbose);
      outLog.end();
      errLog.end();
      cleanupSandbox();
    }
  }
}

// ─── 入口（tsx 直接执行时） ───

if (process.argv[1] && /l2-sandbox\.ts$/.test(process.argv[1].replace(/\\/g, '/'))) {
  runL2Sandbox(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error('[l2-sandbox] 未捕获异常:', err);
      process.exitCode = EXIT_FAIL;
    });
}
