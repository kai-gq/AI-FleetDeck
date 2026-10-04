/**
 * jarvis-canary 离线自测（--self-test）
 *
 * 目标：不依赖 dev server 也能验证脚本核心逻辑——场景注册、断言函数、轮询、
 * 只读查询、报告与退出码。用假 HTTP/WS 传输 + 假日志查询 + 临时 SQLite 库
 * （仅 os.tmpdir()，用完即删；绝不触碰真实 events.db）。
 *
 * 运行：
 *   npx tsx tools/jarvis-canary/run.ts --self-test
 *   npx tsx tools/jarvis-canary/selftest.ts
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildFilter, openReadOnlyLogQuery, resolveDbPath } from './log-query.js';
import { buildReport, computeExitCode } from './report.js';
import { defaultOptions, parseArgs, runScenario } from './run.js';
import { SCENARIOS, entryEvidence, selectScenarios, truncate, waitFor } from './scenarios.js';
import type {
  AgentInfo, CanaryEntry, CanaryOptions, CanaryTransport, HttpResult, LogQueryFilter, LogQueryFn,
  ScenarioContext, WsProbeResult,
} from './types.js';

// ─── 迷你断言框架 ───

interface CheckResult { name: string; ok: boolean; detail?: string }

class Harness {
  results: CheckResult[] = [];
  check(name: string, ok: boolean, detail?: string): void {
    this.results.push({ name, ok, detail });
  }
  eq<T>(name: string, actual: T, expected: T): void {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    this.check(name, ok, ok ? undefined : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

// ─── 假传输 ───

interface FakeTransportScript {
  health?: HttpResult;
  status?: HttpResult;
  agents?: HttpResult;
  process?: HttpResult;
  report?: HttpResult;
  ws?: WsProbeResult;
  onPost?: (path: string, body: unknown) => void;
}

export function ok(json: Record<string, unknown> = {}, status = 200): HttpResult {
  return { ok: true, status, json, elapsedMs: 1 };
}

export function fail(status: number, error?: string): HttpResult {
  return { ok: false, status, error, elapsedMs: 1 };
}

export function makeFakeTransport(script: FakeTransportScript): CanaryTransport & { calls: string[] } {
  const calls: string[] = [];
  return {
    baseUrl: 'http://fake:6200',
    calls,
    async httpGet(p: string): Promise<HttpResult> {
      calls.push(`GET ${p}`);
      if (p === '/api/health') return script.health ?? ok({ status: 'ok' });
      if (p === '/api/voice-companion/status') return script.status ?? ok({ available: true, turns: 1 });
      if (p === '/api/agents') return script.agents ?? ok({ value: [] });
      return fail(404, 'not found');
    },
    async httpPost(p: string, body: unknown): Promise<HttpResult> {
      calls.push(`POST ${p}`);
      script.onPost?.(p, body);
      if (p === '/api/voice-companion/process') return script.process ?? ok({ success: true, action: 'list_agents', response: 'ok' });
      if (p.includes('/report-task')) return script.report ?? ok({ success: true, forwarded: true });
      return fail(404, 'not found');
    },
    async wsHandshake(): Promise<WsProbeResult> {
      calls.push('WS /ws');
      return script.ws ?? { ok: true, firstMessageType: 'server_time', elapsedMs: 1 };
    },
    close: () => {},
  };
}

// ─── 假日志查询（过滤语义与只读实现对齐的最小镜像） ───

export function makeFakeQuery(rows: CanaryEntry[]): { rows: CanaryEntry[]; query: LogQueryFn } {
  const query: LogQueryFn = (filter: LogQueryFilter = {}) => {
    let out = rows.filter((r) => {
      if (filter.category && r.category !== filter.category) return false;
      if (filter.source && r.source !== filter.source) return false;
      if (filter.agentId && r.agentId !== filter.agentId) return false;
      if (filter.sessionId && r.sessionId !== filter.sessionId) return false;
      if (filter.taskId && r.taskId !== filter.taskId) return false;
      if (filter.level && r.level !== filter.level) return false;
      if (filter.since !== undefined && r.ts < filter.since) return false;
      if (filter.until !== undefined && r.ts > filter.until) return false;
      return true;
    });
    out = [...out].sort((a, b) => (filter.order === 'asc' ? a.ts - b.ts || a.id - b.id : b.ts - a.ts || b.id - a.id));
    const offset = filter.offset ?? 0;
    return out.slice(offset, offset + (filter.limit ?? 200));
  };
  return { rows, query };
}

let idSeq = 1000;
export function mkEntry(partial: Partial<CanaryEntry> & { category: string }): CanaryEntry {
  idSeq += 1;
  return {
    id: partial.id ?? idSeq,
    ts: partial.ts ?? Date.now(),
    category: partial.category,
    source: partial.source ?? 'test',
    level: partial.level ?? 'info',
    body: partial.body,
    sessionId: partial.sessionId,
    taskId: partial.taskId,
    agentId: partial.agentId,
    projectId: partial.projectId,
    bodyRaw: partial.bodyRaw,
  };
}

export function mkCtx(transport: CanaryTransport, query: LogQueryFn, options?: Partial<CanaryOptions>): ScenarioContext {
  const opts = { ...defaultOptions(), logWaitMs: 80, pollMs: 10, bossWaitMs: 0, reportWaitMs: 80, scenarioTimeoutMs: 5000, ...options };
  return {
    transport, query, options: opts, shared: {},
    dbStats: { totalRows: 99, rows24h: 12, latestTs: Date.now(), dbPath: 'C:\\fake\\events.db' },
    log: () => {},
  };
}

function scenarioByName(name: string) {
  const def = SCENARIOS.find((s) => s.name === name);
  if (!def) throw new Error(`selftest 引用未知场景 ${name}`);
  return def;
}

const BOSS_ID = 'boss-1';
const AGENT_JSON = [
  { id: BOSS_ID, name: 'Boss', isBoss: true, class: 'boss', status: 'idle' },
  { id: 'sub-1', name: '下属甲', isBoss: false, class: 'builder', bossId: BOSS_ID, status: 'idle' },
] as AgentInfo[];

// ─── 自测主入口 ───

export async function runSelfTest(): Promise<number> {
  const h = new Harness();
  const started = Date.now();
  console.log('=== jarvis-canary 离线自测（不依赖 dev server）===\n');

  // 1. 参数解析
  {
    const d = parseArgs([]);
    h.eq('parseArgs 默认级别 smoke', d.options.level, 'smoke');
    h.eq('parseArgs 默认 dryRun false', d.options.dryRun, false);
    h.eq('parseArgs 默认场景过滤为空', d.options.scenarioFilter, []);
    h.eq('parseArgs 无错误', d.errors, []);

    const p = parseArgs(['--level=full', '--scenario=delegation,receipt', '--scenario=connectivity', '--dry-run', '--base-url=http://127.0.0.1:6200', '--timeout-ms=1234', '--wait-boss-ms=0', '--simulate-receipt', '--token=abc']);
    h.eq('parseArgs full', p.options.level, 'full');
    h.eq('parseArgs 场景合并去重前原样保留', p.options.scenarioFilter, ['delegation', 'receipt', 'connectivity']);
    h.eq('parseArgs dryRun', p.options.dryRun, true);
    h.eq('parseArgs 数字参数', p.options.httpTimeoutMs, 1234);
    h.eq('parseArgs wait-boss-ms=0', p.options.bossWaitMs, 0);
    h.eq('parseArgs token', p.options.token, 'abc');
    h.eq('parseArgs simulate-receipt', p.options.simulateReceipt, true);

    const bad = parseArgs(['--level=loud', '--unknown-thing=1', '--timeout-ms=abc']);
    h.check('parseArgs 非法级别/未知参数/非法数字报错', bad.errors.length === 3, JSON.stringify(bad.errors));

    const hs = parseArgs(['--self-test']);
    h.eq('parseArgs self-test', hs.selfTest, true);
  }

  // 2. 场景选择
  {
    const smoke = selectScenarios('smoke', []);
    h.eq('smoke 级别只选 smoke 场景', smoke.selected.map((s) => s.name), ['connectivity', 'dialog-roundtrip']);
    const full = selectScenarios('full', []);
    h.eq('full 级别含全部场景', full.selected.map((s) => s.name), ['connectivity', 'dialog-roundtrip', 'delegation-chain', 'receipt-chain', 'cancel-chain']);
    const filt = selectScenarios('smoke', ['delegation', 'conn']);
    h.eq('别名过滤 delegation→delegation-chain', filt.selected.map((s) => s.name), ['connectivity', 'delegation-chain']);
    h.eq('别名过滤 conn→connectivity', filt.selected[0].name, 'connectivity');
    const unknown = selectScenarios('smoke', ['nope']);
    h.eq('未知场景名进 unknown', unknown.unknown, ['nope']);
  }

  // 3. 工具函数
  {
    h.eq('truncate 短文本原样', truncate('abc', 10), 'abc');
    h.check('truncate 超长截断加省略号', truncate('x'.repeat(300), 120).length === 121);
    const ev = entryEvidence(mkEntry({ category: 'dialog', body: { direction: 'out', text: 'y'.repeat(300) }, taskId: 't1' }), ['direction', 'text']);
    h.eq('entryEvidence 字段截断', (ev.fields.text as string).length, 121);
    h.eq('entryEvidence 带 taskId', ev.fields.taskId, 't1');

    const immediate = await waitFor(() => 42, { timeoutMs: 50, pollMs: 5 });
    h.eq('waitFor 立即命中', immediate, 42);
    let n = 0;
    const delayed = await waitFor(() => (++n >= 3 ? 'done' : undefined), { timeoutMs: 500, pollMs: 5 });
    h.eq('waitFor 延迟命中', delayed, 'done');
    const timedOut = await waitFor(() => undefined, { timeoutMs: 30, pollMs: 5 });
    h.eq('waitFor 超时返回 undefined', timedOut, undefined);
  }

  // 4. 只读查询（临时 SQLite，不碰真实 events.db）
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-canary-selftest-'));
    const dbPath = path.join(dir, 'events.db');
    try {
      const db = new Database(dbPath);
      db.exec(`CREATE TABLE system_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, category TEXT NOT NULL,
        source TEXT, agent_id TEXT, project_id TEXT, session_id TEXT, task_id TEXT,
        level TEXT NOT NULL DEFAULT 'info', body TEXT)`);
      const ins = db.prepare('INSERT INTO system_log (ts, category, source, agent_id, session_id, task_id, level, body) VALUES (?,?,?,?,?,?,?,?)');
      ins.run(1000, 'dialog', 'voice-companion', null, 's1', 't1', 'info', JSON.stringify({ direction: 'in', text: '你好' }));
      ins.run(2000, 'delegation', 'voice-companion', null, 's1', 't1', 'info', JSON.stringify({ phase: 'dispatched', toAgentId: BOSS_ID }));
      ins.run(3000, 'dialog', 'voice-companion', null, 's1', 't1', 'warn', 'plain-text-body');
      db.close();

      const lq = openReadOnlyLogQuery(dbPath);
      h.eq('log-query countAll', lq.countAll(), 3);
      h.eq('log-query countSince', lq.countSince(2000), 2);
      h.eq('log-query latestTs', lq.latestTs(), 3000);
      h.eq('log-query category 过滤', lq.query({ category: 'dialog' }).length, 2);
      h.eq('log-query desc 默认排序', lq.query({}).map((e) => e.id), [3, 2, 1]);
      h.eq('log-query asc 排序', lq.query({ order: 'asc' }).map((e) => e.id), [1, 2, 3]);
      h.eq('log-query since 过滤', lq.query({ since: 2000, order: 'asc' }).map((e) => e.id), [2, 3]);
      h.eq('log-query limit/offset', lq.query({ order: 'asc', limit: 1, offset: 1 }).map((e) => e.id), [2]);
      const parsed = lq.query({ order: 'asc' })[0];
      h.eq('log-query body JSON 解析', parsed.body, { direction: 'in', text: '你好' });
      const raw = lq.query({ order: 'asc' })[2];
      h.eq('log-query 非 JSON body 原文保留', raw.bodyRaw, 'plain-text-body');
      lq.close();

      // 表缺失 → 明确报错
      const db2Path = path.join(dir, 'empty.db');
      new Database(db2Path).close();
      let threw = false;
      try { openReadOnlyLogQuery(db2Path); } catch { threw = true; }
      h.check('log-query 缺 system_log 表时抛错', threw);

      // 文件不存在 → 明确报错
      let threw2 = false;
      try { openReadOnlyLogQuery(path.join(dir, 'nope.db')); } catch { threw2 = true; }
      h.check('log-query 文件不存在时抛错', threw2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    const prevXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = 'D:\\xdg-test';
    h.check('resolveDbPath 遵循 XDG_DATA_HOME', resolveDbPath().replace(/\\/g, '/').endsWith('D:/xdg-test/tide-commander/events.db'));
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = prevXdg;
    h.check('resolveDbPath --db 覆盖', resolveDbPath('C:\\tmp\\x.db').replace(/\\/g, '/').endsWith('C:/tmp/x.db'));
  }

  // 5. 场景①连通性
  {
    const t = makeFakeTransport({});
    const q = makeFakeQuery([]);
    const pass = await runScenario(scenarioByName('connectivity'), mkCtx(t, q.query));
    h.eq('① 连通性 全通', pass.status, 'pass');
    h.eq('① 断言数=4', pass.assertions.length, 4);

    const down = await runScenario(scenarioByName('connectivity'), mkCtx(makeFakeTransport({ health: fail(0, 'ECONNREFUSED') }), q.query));
    h.eq('① health 失败 → fail', down.status, 'fail');
    h.check('① health 失败断言 a1 不通过', down.assertions.find((a) => a.id === 'a1')?.ok === false);

    const wsDown = await runScenario(scenarioByName('connectivity'), mkCtx(makeFakeTransport({ ws: { ok: false, error: '401', elapsedMs: 1 } }), q.query));
    h.eq('① WS 失败 → fail', wsDown.status, 'fail');
  }

  // 6. 场景②对话往返
  {
    const baseRows = () => [
      mkEntry({ category: 'dialog', source: 'voice-companion', ts: Date.now(), body: { direction: 'in', text: '列出团队成员', cat: 'dialog' } }),
      mkEntry({ category: 'dialog', source: 'voice-companion', ts: Date.now(), body: { direction: 'out', text: '团队里有 Boss、小刘、Nova', action: 'list_agents' } }),
    ];
    const t = makeFakeTransport({ process: ok({ success: true, action: 'list_agents', response: '团队里有…' }) });

    const pass = await runScenario(scenarioByName('dialog-roundtrip'), mkCtx(t, makeFakeQuery(baseRows()).query));
    h.eq('② 对话往返 全通', pass.status, 'pass');
    h.eq('② 断言数=4', pass.assertions.length, 4);

    const onlyIn = await runScenario(scenarioByName('dialog-roundtrip'), mkCtx(t, makeFakeQuery([baseRows()[0]]).query));
    h.eq('② 缺 dialog out → fail', onlyIn.status, 'fail');
    h.check('② a3 失败', onlyIn.assertions.find((a) => a.id === 'a3')?.ok === false);

    const withDelegation = await runScenario(scenarioByName('dialog-roundtrip'), mkCtx(t, makeFakeQuery([
      ...baseRows(),
      mkEntry({ category: 'delegation', source: 'voice-companion', ts: Date.now(), body: { phase: 'dispatched', toAgentId: BOSS_ID } }),
    ]).query));
    h.eq('② 意外派活 → fail', withDelegation.status, 'fail');
    h.check('② a4 失败', withDelegation.assertions.find((a) => a.id === 'a4')?.ok === false);

    // 回归（2026-10-04 L3 实测）：5s 余量窗混入上一次运行的残留行（in/out 文本不同 + delegation 行）——
    // 断言必须绑定"本次消息"（等文本 dialog in 为锚点），残留行不得污染 a2/a3/a4。
    const stalePrev = [
      mkEntry({ category: 'dialog', source: 'voice-companion', ts: Date.now(), body: { direction: 'in', text: '上一个问题（残留）', cat: 'dialog' } }),
      mkEntry({ category: 'dialog', source: 'voice-companion', ts: Date.now(), body: { direction: 'out', text: '上一个回答（残留）', action: 'list_agents', cat: 'dialog' } }),
      mkEntry({ category: 'delegation', source: 'voice-companion', ts: Date.now(), body: { phase: 'dispatched', channel: 'voice-companion', toAgentId: BOSS_ID, cat: 'delegation' } }),
    ];
    const staleMix = await runScenario(scenarioByName('dialog-roundtrip'), mkCtx(t, makeFakeQuery([...stalePrev, ...baseRows()]).query));
    h.eq('② 上次运行残留（含 delegation）不污染本次 → pass', staleMix.status, 'pass');
    h.check('② a2 锚定本次文本（非残留 in）', staleMix.assertions.find((a) => a.id === 'a2')?.ok === true);
    h.check('② a4 锚点前的残留 delegation 不计入', staleMix.assertions.find((a) => a.id === 'a4')?.ok === true);

    const httpDown = await runScenario(scenarioByName('dialog-roundtrip'), mkCtx(makeFakeTransport({ process: fail(500, 'boom') }), makeFakeQuery(baseRows()).query));
    h.eq('② HTTP 500 → fail', httpDown.status, 'fail');
  }

  // 7. 场景③派活链
  {
    const bossHttp = ok({ value: AGENT_JSON });
    const mkRows = (toAgentId: string, extra: CanaryEntry[] = []) => [
      mkEntry({ category: 'dialog', ts: Date.now(), body: { direction: 'out', text: '已交给主管', action: 'delegate_to_boss' } }),
      mkEntry({ category: 'delegation', source: 'voice-companion', ts: Date.now(), body: { phase: 'dispatched', channel: 'voice-companion', routedBy: 'delegate_to_boss', toAgentId, toAgentName: '目标', message: 'task' } }),
      ...extra,
    ];
    const mkOpts = { bossWaitMs: 0, logWaitMs: 60 } as Partial<CanaryOptions>;

    const pass = await runScenario(scenarioByName('delegation-chain'),
      mkCtx(makeFakeTransport({ agents: bossHttp }), makeFakeQuery(mkRows(BOSS_ID)).query, mkOpts));
    h.eq('③ 派活到 Boss 全通', pass.status, 'pass');
    h.eq('③ 断言数=4', pass.assertions.length, 4);

    const toSub = await runScenario(scenarioByName('delegation-chain'),
      mkCtx(makeFakeTransport({ agents: bossHttp }), makeFakeQuery(mkRows('sub-1')).query, mkOpts));
    h.eq('③ 直派下属 → fail', toSub.status, 'fail');
    h.check('③ a3/a4 均失败', toSub.assertions.find((a) => a.id === 'a3')?.ok === false && toSub.assertions.find((a) => a.id === 'a4')?.ok === false);

    const noDispatch = await runScenario(scenarioByName('delegation-chain'),
      mkCtx(makeFakeTransport({ agents: bossHttp, process: ok({ success: true, action: 'general_response', response: '好的' }) }),
        makeFakeQuery([mkEntry({ category: 'dialog', ts: Date.now(), body: { direction: 'out', text: '好的', action: 'general_response' } })]).query, mkOpts));
    h.eq('③ 秘书回退闲聊 → fail', noDispatch.status, 'fail');
    h.check('③ a2 失败（非任务类 action）', noDispatch.assertions.find((a) => a.id === 'a2')?.ok === false);

    const blockedRows = mkRows(BOSS_ID, [mkEntry({ category: 'delegation', source: 'voice-companion', ts: Date.now(), body: { phase: 'blocked', toAgentId: 'sub-1', status: 'direct-dispatch-blocked' } })]);
    const blockedCase = await runScenario(scenarioByName('delegation-chain'),
      mkCtx(makeFakeTransport({ agents: bossHttp }), makeFakeQuery(blockedRows).query, mkOpts));
    h.eq('③ blocked（已改道）仍通过', blockedCase.status, 'pass');
    h.check('③ blocked 写入 notes 告警', blockedCase.notes.some((n) => n.includes('观测点①')));

    // 回归（2026-10-04 L3 实测失败现场复现）：上一次 smoke 的 dialog out（action=list_agents）残留在
    // 窗口内、位于本次 dialog in 锚点之前——a2 必须取锚点后的本次 out（send_to_agent），不得取残留行。
    const mkChain = (staleBefore: CanaryEntry[], outAction = 'send_to_agent', toAgentId = BOSS_ID): CanaryEntry[] => [
      ...staleBefore,
      mkEntry({ category: 'dialog', source: 'voice-companion', ts: Date.now(), body: { direction: 'in', text: defaultOptions().taskText } }),
      mkEntry({ category: 'dialog', source: 'voice-companion', ts: Date.now(), body: { direction: 'out', action: outAction, text: '回复文本' } }),
      mkEntry({ category: 'delegation', source: 'voice-companion', ts: Date.now(), body: { phase: 'dispatched', channel: 'voice-companion', routedBy: 'send_to_agent', toAgentId, toAgentName: '目标', message: 'task' } }),
    ];

    const staleSmokeOut = [mkEntry({ category: 'dialog', source: 'voice-companion', ts: Date.now(), body: { direction: 'out', action: 'list_agents', text: '团队成员共 3 位：Boss、Nova、Reese，目前都空闲。' } })];
    const leakCase = await runScenario(scenarioByName('delegation-chain'),
      mkCtx(makeFakeTransport({ agents: bossHttp }), makeFakeQuery(mkChain(staleSmokeOut)).query, mkOpts));
    h.eq('③ 上次 smoke 残留 out 不污染本次 a2 → pass', leakCase.status, 'pass');
    h.eq('③ a2 取锚点后的 send_to_agent', leakCase.assertions.find((a) => a.id === 'a2')?.actual, "action='send_to_agent'");

    // 锚点前残留的非 Boss dispatched 行不得触发 a4 假红（断言语义 = 本次消息触发的行）
    const staleNonBoss = [mkEntry({ category: 'delegation', source: 'voice-companion', ts: Date.now(), body: { phase: 'dispatched', channel: 'voice-companion', toAgentId: 'sub-1', toAgentName: '下属甲' } })];
    const staleNonBossCase = await runScenario(scenarioByName('delegation-chain'),
      mkCtx(makeFakeTransport({ agents: bossHttp }), makeFakeQuery(mkChain(staleNonBoss)).query, mkOpts));
    h.eq('③ 锚点前残留非 Boss dispatched 不触发 a4 假红 → pass', staleNonBossCase.status, 'pass');
    h.check('③ a4 通过', staleNonBossCase.assertions.find((a) => a.id === 'a4')?.ok === true);

    // 反向守卫：锚定不得把断言放水——本次回复真不是任务类 action / 真直派了非 Boss，仍必须失败
    const wrongOutSelf = await runScenario(scenarioByName('delegation-chain'),
      mkCtx(makeFakeTransport({ agents: bossHttp, process: ok({ success: true, action: 'general_response', response: '好的' }) }),
        makeFakeQuery(mkChain([], 'general_response')).query, mkOpts));
    h.eq('③ 本次回复非任务类 action → 仍 fail', wrongOutSelf.status, 'fail');
    h.check('③ a2 失败', wrongOutSelf.assertions.find((a) => a.id === 'a2')?.ok === false);

    const ownToSub = await runScenario(scenarioByName('delegation-chain'),
      mkCtx(makeFakeTransport({ agents: bossHttp }), makeFakeQuery(mkChain([], 'send_to_agent', 'sub-1')).query, mkOpts));
    h.eq('③ 本次真直派非 Boss → 仍 fail', ownToSub.status, 'fail');
    h.check('③ a3/a4 均失败（锚点内违规不放行）', ownToSub.assertions.find((a) => a.id === 'a3')?.ok === false && ownToSub.assertions.find((a) => a.id === 'a4')?.ok === false);

    // bossWaitMs>0：捕获 delegated → shared 供④
    const delegatedRow = mkEntry({ category: 'delegation', source: 'boss', ts: Date.now() + 5, body: { phase: 'delegated', fromAgentId: BOSS_ID, toAgentId: 'sub-1', toAgentName: '下属甲' } });
    const ctx = mkCtx(makeFakeTransport({ agents: bossHttp }), makeFakeQuery(mkRows(BOSS_ID, [delegatedRow])).query, { bossWaitMs: 200, pollMs: 10 });
    const withBoss = await runScenario(scenarioByName('delegation-chain'), ctx);
    h.eq('③ wait boss → pass', withBoss.status, 'pass');
    h.check('③ delegated 证据写入 shared', (ctx.shared.delegationChain as { delegated?: unknown })?.delegated !== undefined);

    const noBoss = await runScenario(scenarioByName('delegation-chain'),
      mkCtx(makeFakeTransport({ agents: ok({ value: [AGENT_JSON[1]] }) }), makeFakeQuery(mkRows(BOSS_ID)).query, mkOpts));
    h.eq('③ 无 Boss 前置 → skip', noBoss.status, 'skip');
    h.check('③ skip 说明缺 Boss', noBoss.notes.some((n) => n.includes('bossExists')));
  }

  // 8. 场景④回执链
  {
    const delegatedRow = mkEntry({ category: 'delegation', source: 'boss', ts: Date.now() - 1000, body: { phase: 'delegated', toAgentId: 'sub-1', toAgentName: '下属甲' } });
    const reportedRow = mkEntry({ category: 'delegation', source: 'subordinate', ts: Date.now(), body: { phase: 'reported', channel: 'subordinate', fromAgentId: 'sub-1', toAgentId: BOSS_ID, status: 'completed', forwarded: true, message: '完成' } });
    const closedRow = mkEntry({ category: 'delegation', source: 'boss', ts: Date.now() + 10, body: { phase: 'closed', toAgentId: 'sub-1', status: 'completed' } });

    const pass = await runScenario(scenarioByName('receipt-chain'),
      mkCtx(makeFakeTransport({}), makeFakeQuery([delegatedRow, reportedRow, closedRow]).query, { reportWaitMs: 60 }));
    h.eq('④ 回执链 全通', pass.status, 'pass');
    h.eq('④ 断言数=2', pass.assertions.length, 2);
    h.check('④ closed 二级证据进 notes', pass.notes.some((n) => n.includes('closed')));

    const missingReport = await runScenario(scenarioByName('receipt-chain'),
      mkCtx(makeFakeTransport({}), makeFakeQuery([delegatedRow]).query, { reportWaitMs: 60 }));
    h.eq('④ 无 reported → fail', missingReport.status, 'fail');
    h.check('④ a1 失败', missingReport.assertions.find((a) => a.id === 'a1')?.ok === false);

    const noDelegated = await runScenario(scenarioByName('receipt-chain'),
      mkCtx(makeFakeTransport({}), makeFakeQuery([]).query, { reportWaitMs: 60 }));
    h.eq('④ 无 delegated 前置 → skip', noDelegated.status, 'skip');
    h.check('④ skip 说明缺前置', noDelegated.notes.some((n) => n.includes('delegationChainEvidence')));

    // simulate-receipt：走 report-task 接口
    let reportPosted = false;
    const simT = makeFakeTransport({ onPost: (p) => { if (p.includes('/report-task')) reportPosted = true; } });
    const sim = await runScenario(scenarioByName('receipt-chain'),
      mkCtx(simT, makeFakeQuery([delegatedRow, reportedRow]).query, { reportWaitMs: 60, simulateReceipt: true }));
    h.eq('④ simulate-receipt 通过', sim.status, 'pass');
    h.check('④ simulate-receipt 调用了 report-task', reportPosted);
  }

  // 9. 场景⑤撤回链（未交付 → skip）
  {
    const ctx = mkCtx(makeFakeTransport({}), makeFakeQuery([]).query);
    const res = await runScenario(scenarioByName('cancel-chain'), ctx);
    h.eq('⑤ 未交付能力 → skip', res.status, 'skip');
    h.check('⑤ skip 说明任务16', res.notes.some((n) => n.includes('任务16')));
  }

  // 10. dry-run 行为
  {
    const t = makeFakeTransport({ agents: ok({ value: AGENT_JSON }) });
    const ctx = mkCtx(t, makeFakeQuery([]).query, { dryRun: true });
    const conn = await runScenario(scenarioByName('connectivity'), ctx);
    h.eq('dry-run 只读连通性场景 → 真执行并 pass', conn.status, 'pass');
    h.eq('dry-run 连通性断言数=4', conn.assertions.length, 4);
    const dialog = await runScenario(scenarioByName('dialog-roundtrip'), ctx);
    h.eq('dry-run 对话 → planned', dialog.status, 'planned');
    h.check('dry-run 不发消息（无 POST /process）', !t.calls.some((c) => c.includes('/api/voice-companion/process')));

    const receipt = await runScenario(scenarioByName('receipt-chain'), ctx);
    h.eq('dry-run runtime 前置延后 → planned', receipt.status, 'planned');
    h.check('dry-run 前置 deferred 标记', receipt.prereqs.some((p) => p.id === 'delegationChainEvidence' && p.deferred === true));

    const tDown = makeFakeTransport({ health: fail(0, 'ECONNREFUSED') });
    const connDown = await runScenario(scenarioByName('connectivity'), mkCtx(tDown, makeFakeQuery([]).query, { dryRun: true }));
    h.eq('dry-run 服务不可达 → fail', connDown.status, 'fail');
  }

  // 11. 报告与退出码
  {
    const pass = await runScenario(scenarioByName('connectivity'), mkCtx(makeFakeTransport({}), makeFakeQuery([]).query));
    const skipRes = await runScenario(scenarioByName('cancel-chain'), mkCtx(makeFakeTransport({}), makeFakeQuery([]).query));
    const report = buildReport({
      level: 'smoke', dryRun: false, scenarioFilter: [], baseUrl: 'http://fake:6200',
      dbPath: 'x.db', globalErrors: [], results: [pass, skipRes], startedAt: Date.now(),
    });
    h.eq('report summary 统计', [report.summary.total, report.summary.pass, report.summary.skip], [2, 1, 1]);
    h.check('report JSON 可序列化', typeof JSON.stringify(report) === 'string' && JSON.parse(JSON.stringify(report)).tool === 'jarvis-canary');
    h.eq('退出码：有 skip 未 allowSkip → 1', computeExitCode(report, { allowSkip: false }), 1);
    h.eq('退出码：allowSkip → 0', computeExitCode(report, { allowSkip: true }), 0);
    h.eq('退出码：dry-run 下能力 skip 不阻断 → 0', computeExitCode(buildReport({
      level: 'full', dryRun: true, scenarioFilter: [], baseUrl: 'x', globalErrors: [], results: [skipRes], startedAt: Date.now(),
    }), { allowSkip: false }), 0);

    const failReport = buildReport({
      level: 'smoke', dryRun: false, scenarioFilter: [], baseUrl: 'x', globalErrors: [],
      results: [{ ...pass, status: 'fail' }], startedAt: Date.now(),
    });
    h.eq('退出码：失败 → 1', computeExitCode(failReport, { allowSkip: true }), 1);

    const errReport = buildReport({
      level: 'smoke', dryRun: true, scenarioFilter: [], baseUrl: 'x', globalErrors: ['DB 打不开'], results: [], startedAt: Date.now(),
    });
    h.eq('退出码：全局错误 → 1', computeExitCode(errReport, { allowSkip: true }), 1);
  }

  // 12. 只读查询过滤构造（与 system-log.ts buildFilter 对齐）
  {
    const built = buildFilter({ category: 'dialog', source: 'voice-companion', since: 1, until: 2, taskId: 't', sessionId: 's', agentId: 'a', projectId: 'p', level: 'warn' });
    h.eq('buildFilter 条件数', built.where.split(' AND ').length, 9);
    h.eq('buildFilter 参数数', built.params.length, 9);
    h.eq('buildFilter 空条件', buildFilter({}).where, '');
  }

  // 汇总
  const failed = h.results.filter((r) => !r.ok);
  for (const r of h.results) {
    if (!r.ok) console.log(`✗ ${r.name}${r.detail ? ` —— ${r.detail}` : ''}`);
  }
  const elapsed = Date.now() - started;
  console.log(`\n自测结果: ${h.results.length - failed.length}/${h.results.length} 通过（${elapsed}ms）`);
  if (failed.length > 0) console.log(`失败 ${failed.length} 项，见上方 ✗ 列表。`);
  return failed.length === 0 ? 0 : 1;
}

if (process.argv[1] && /selftest\.ts$/.test(process.argv[1])) {
  runSelfTest()
    .then((code) => { process.exitCode = code; })
    .catch((err) => { console.error('selftest 未捕获异常:', err); process.exitCode = 1; });
}
