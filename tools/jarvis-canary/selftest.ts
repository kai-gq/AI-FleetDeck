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
import {
  ADVERSARIAL_ITEMS, CANCEL_TASK_TEXT, PROJECT_AMBIGUOUS_TEXT, QUOTA_DEFAULT_REQUESTS, SCENARIOS,
  assertCancelEvidence, assertCrossProjectHandoverEvidence, entryEvidence,
  projectRouteText, quotaTaskText, selectScenarios, truncate, waitFor,
} from './scenarios.js';
import type { AdversarialItem } from './scenarios.js';
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
  workspaces?: HttpResult;
  areas?: HttpResult;
  /** GET /api/workspaces/active 返回值（缺省 { workspaceId: null }）；httpPut 成功后同步覆盖 */
  activeWorkspace?: HttpResult;
  process?: HttpResult;
  report?: HttpResult;
  ws?: WsProbeResult;
  onPost?: (path: string, body: unknown) => void;
  onPut?: (path: string, body: unknown) => void;
}

export function ok(json: Record<string, unknown> = {}, status = 200): HttpResult {
  return { ok: true, status, json, elapsedMs: 1 };
}

export function fail(status: number, error?: string): HttpResult {
  return { ok: false, status, error, elapsedMs: 1 };
}

/** 镜像服务端 completed 回执校验（routes/agents.ts isAcceptanceItem + :1984-2013，task17·A3）：
 *  completed（含缺省）必须带非空 acceptance[{item,done}] 与非空白 outputLocation，缺任一 → 400。 */
export function isValidCompletedReport(b: { acceptance?: unknown; outputLocation?: unknown }): boolean {
  const acc = b.acceptance;
  const validAcc = Array.isArray(acc) && acc.length > 0 && acc.every((it) => {
    if (!it || typeof it !== 'object') return false;
    const v = it as { item?: unknown; done?: unknown };
    return typeof v.item === 'string' && v.item.trim().length > 0 && typeof v.done === 'boolean';
  });
  const outOk = typeof b.outputLocation === 'string' && b.outputLocation.trim().length > 0;
  return validAcc && outOk;
}

export function makeFakeTransport(script: FakeTransportScript): CanaryTransport & { calls: string[] } {
  const calls: string[] = [];
  let active: HttpResult = script.activeWorkspace ?? ok({ workspaceId: null });
  return {
    baseUrl: 'http://fake:6200',
    calls,
    async httpGet(p: string): Promise<HttpResult> {
      calls.push(`GET ${p}`);
      if (p === '/api/health') return script.health ?? ok({ status: 'ok' });
      if (p === '/api/voice-companion/status') return script.status ?? ok({ available: true, turns: 1 });
      if (p === '/api/agents') return script.agents ?? ok({ value: [] });
      if (p === '/api/workspaces') return script.workspaces ?? ok({ value: [] });
      if (p === '/api/areas') return script.areas ?? ok({ value: [] });
      if (p === '/api/workspaces/active') return active;
      return fail(404, 'not found');
    },
    async httpPost(p: string, body: unknown): Promise<HttpResult> {
      calls.push(`POST ${p}`);
      if (p.includes('/report-task')) {
        // 镜像真实服务端顺序：校验先于一切副作用（onPost 的效果模拟不执行），invalid → 400。
        const b = (body ?? {}) as { status?: unknown; acceptance?: unknown; outputLocation?: unknown };
        const status = typeof b.status === 'string' && b.status ? b.status : 'completed';
        if (status === 'completed' && !isValidCompletedReport(b)) {
          return fail(400, 'Completed report rejected: missing or invalid acceptance, outputLocation');
        }
        script.onPost?.(p, body);
        return script.report ?? ok({ success: true, forwarded: true });
      }
      script.onPost?.(p, body);
      if (p === '/api/voice-companion/process') return script.process ?? ok({ success: true, action: 'list_agents', response: 'ok' });
      return fail(404, 'not found');
    },
    async httpPut(p: string, body: unknown): Promise<HttpResult> {
      calls.push(`PUT ${p}`);
      script.onPut?.(p, body);
      if (p === '/api/workspaces/active') {
        // 镜像服务端行为：setActiveWorkspace(workspaceId ?? null) → 回读并返回 { workspaceId }
        const raw = (body as { workspaceId?: unknown } | undefined)?.workspaceId;
        active = ok({ workspaceId: raw == null ? null : String(raw) });
        return active;
      }
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
    h.eq('full 级别含全部非 opt-in 场景（opt-in 默认不参赛）', full.selected.map((s) => s.name), ['connectivity', 'dialog-roundtrip', 'delegation-chain', 'receipt-chain']);
    for (const name of ['adversarial', 'cancel-chain', 'project-routing', 'cross-project-handover', 'quota-concurrency']) {
      h.check(`full 默认不含 opt-in ${name}`, !full.selected.some((s) => s.name === name));
    }
    const smokeAdv = selectScenarios('smoke', []);
    h.check('smoke 默认也不含对抗包', !smokeAdv.selected.some((s) => s.name === 'adversarial'));
    const advAlias = selectScenarios('smoke', ['adv']);
    h.eq('别名 adv 显式点名可参赛', advAlias.selected.map((s) => s.name), ['adversarial']);
    const advByName = selectScenarios('full', ['adversarial']);
    h.eq('--scenario=adversarial 显式点名可参赛', advByName.selected.map((s) => s.name), ['adversarial']);
    const cancelAlias = selectScenarios('smoke', ['cancel']);
    h.eq('别名 cancel → cancel-chain（opt-in 点名可参赛）', cancelAlias.selected.map((s) => s.name), ['cancel-chain']);
    const routingAlias = selectScenarios('smoke', ['routing']);
    h.eq('别名 routing → project-routing', routingAlias.selected.map((s) => s.name), ['project-routing']);
    const handoverAlias = selectScenarios('smoke', ['handover']);
    h.eq('别名 handover → cross-project-handover', handoverAlias.selected.map((s) => s.name), ['cross-project-handover']);
    const quotaAlias = selectScenarios('smoke', ['quota']);
    h.eq('别名 quota → quota-concurrency', quotaAlias.selected.map((s) => s.name), ['quota-concurrency']);
    const multi = selectScenarios('smoke', ['quota', 'routing', 'cancel']);
    // 注册表顺序（cancel-chain < project-routing < quota-concurrency）
    h.eq('多场景点名按注册表顺序排列', multi.selected.map((s) => s.name), ['cancel-chain', 'project-routing', 'quota-concurrency']);
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

    // 场景文本助手（selftest 与真跑共用同一常量，语料一致性）
    h.check('projectRouteText 含点名项目与任务措辞', projectRouteText('甲项目').includes('「甲项目」') && projectRouteText('甲项目').includes('让「') && projectRouteText('甲项目').includes('金丝雀路由验证任务'));
    h.check('PROJECT_AMBIGUOUS_TEXT 不含「让「」（无点名）', !PROJECT_AMBIGUOUS_TEXT.includes('让「'));
    h.check('quotaTaskText 条号唯一', quotaTaskText(1) !== quotaTaskText(2) && quotaTaskText(3).includes('第 3 条'));
    h.check('CANCEL_TASK_TEXT 为任务类措辞（让团队…）', CANCEL_TASK_TEXT.startsWith('让团队') && CANCEL_TASK_TEXT.includes('sleep'));

    // 撤回/跨项目断言助手形态
    const cancelHit = assertCancelEvidence([mkEntry({ category: 'delegation', body: { phase: 'cancelled', channel: 'boss', status: 'cancelled-running', notified: true } })]);
    h.check('assertCancelEvidence 命中 cancelled-running', cancelHit.ok && cancelHit.actual.includes('cancelled-running'));
    h.check('assertCancelEvidence 无行→不通过', !assertCancelEvidence([]).ok);
    const handoverHit = assertCrossProjectHandoverEvidence([mkEntry({ category: 'delegation', body: { phase: 'delegated', sourceProject: 'ws-b' } })]);
    h.check('assertCrossProjectHandoverEvidence 命中 sourceProject', handoverHit.ok && handoverHit.actual.includes('ws-b'));
    h.check('assertCrossProjectHandoverEvidence 无行→不通过', !assertCrossProjectHandoverEvidence([mkEntry({ category: 'delegation', body: { phase: 'delegated' } })]).ok);
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

    // simulate-receipt：走 report-task 接口（载荷须过 fake 镜像的 task17·A3 校验）
    let reportPosted = false;
    let reportBody: { acceptance?: unknown; outputLocation?: unknown } | undefined;
    const simT = makeFakeTransport({ onPost: (p, body) => { if (p.includes('/report-task')) { reportPosted = true; reportBody = body as typeof reportBody; } } });
    const sim = await runScenario(scenarioByName('receipt-chain'),
      mkCtx(simT, makeFakeQuery([delegatedRow, reportedRow]).query, { reportWaitMs: 60, simulateReceipt: true }));
    h.eq('④ simulate-receipt 通过', sim.status, 'pass');
    h.check('④ simulate-receipt 调用了 report-task', reportPosted);
    h.check('④ simulate-receipt 载荷含 acceptance+outputLocation（task17·A3）', !!reportBody && isValidCompletedReport(reportBody));
  }

  // 9. 场景⑤撤回链（任务16 已交付；opt-in 真撤回）
  {
    const mkCancelCase = (opts: {
      auditStatus?: string;
      notify?: boolean;
      clarifyAsk?: boolean;
      extraAudits?: number;
    } = {}) => {
      const rows: CanaryEntry[] = [];
      let ts = Date.now();
      const push = (partial: Partial<CanaryEntry> & { category: string }) => {
        ts += 1;
        rows.push(mkEntry({ ...partial, ts }));
      };
      const transport = makeFakeTransport({
        agents: ok({ value: AGENT_JSON }),
        onPost: (p, body) => {
          if (p !== '/api/voice-companion/process') return;
          const text = String((body as { text?: unknown } | undefined)?.text ?? '');
          if (text === CANCEL_TASK_TEXT) {
            push({ category: 'dialog', source: 'voice-companion', body: { direction: 'in', text } });
            push({ category: 'delegation', source: 'voice-companion', body: { phase: 'dispatched', channel: 'voice-companion', routedBy: 'delegate_to_boss', toAgentId: BOSS_ID, toAgentName: 'Boss' } });
            push({ category: 'delegation', source: 'boss', body: { phase: 'delegated', channel: 'boss', toAgentId: 'sub-1', toAgentName: '下属甲', taskId: 't-cancel' } });
            return;
          }
          if (text === defaultOptions().cancelText) {
            push({ category: 'dialog', source: 'voice-companion', body: { direction: 'in', text } });
            if (opts.clarifyAsk) {
              push({ category: 'delegation', source: 'voice-companion', body: { phase: 'cancelled', channel: 'voice-companion', status: 'clarify-ask', initiator: 'user' } });
              return;
            }
            push({ category: 'delegation', source: 'boss', body: { phase: 'cancelled', channel: 'boss', status: opts.auditStatus ?? 'cancelled-running', notified: opts.notify ?? true, initiator: 'user', toAgentId: 'sub-1', reason: '别做了' } });
            for (let i = 0; i < (opts.extraAudits ?? 0); i++) {
              push({ category: 'delegation', source: 'boss', body: { phase: 'cancelled', channel: 'boss', status: 'cancelled-running', toAgentId: `sub-extra-${i}` } });
            }
          }
        },
      });
      return { transport, query: makeFakeQuery(rows).query };
    };
    const cancelOpts = { bossWaitMs: 200, logWaitMs: 80 } as Partial<CanaryOptions>;

    const passCase = mkCancelCase();
    const pass = await runScenario(scenarioByName('cancel-chain'), mkCtx(passCase.transport, passCase.query, cancelOpts));
    h.eq('⑤ 撤回链全通', pass.status, 'pass');
    h.eq('⑤ 断言数=6', pass.assertions.length, 6);
    h.check('⑤ a1 dispatched→Boss', pass.assertions.find((a) => a.id === 'a1')?.ok === true);
    h.check('⑤ a3 审计行（channel=boss）', pass.assertions.find((a) => a.id === 'a3')?.ok === true);
    h.check('⑤ a4 status=cancelled-running', pass.assertions.find((a) => a.id === 'a4')?.ok === true);
    h.check('⑤ a5 notified=true', pass.assertions.find((a) => a.id === 'a5')?.ok === true);

    // not-found：撤回未命中在办任务（任务已完成/不存在）→ a4/a5 必须如实判红
    const nfCase = mkCancelCase({ auditStatus: 'not-found', notify: false });
    const nf = await runScenario(scenarioByName('cancel-chain'), mkCtx(nfCase.transport, nfCase.query, cancelOpts));
    h.eq('⑤ not-found（未命中在办）→ fail', nf.status, 'fail');
    h.check('⑤ a4 红（未撤销任何在办任务）', nf.assertions.find((a) => a.id === 'a4')?.ok === false);
    h.check('⑤ a5 红（未通知）', nf.assertions.find((a) => a.id === 'a5')?.ok === false);

    // clarify-ask：多候选反问形态 → 要求直接取消的 a3 判红 + notes 登记
    const caCase = mkCancelCase({ clarifyAsk: true });
    const ca = await runScenario(scenarioByName('cancel-chain'), mkCtx(caCase.transport, caCase.query, cancelOpts));
    h.eq('⑤ clarify-ask 反问 → fail（要求直接取消）', ca.status, 'fail');
    h.check('⑤ notes 登记 clarify-ask', ca.notes.some((n) => n.includes('clarify-ask')));
    h.check('⑤ a3 红（仅反问未取消）', ca.assertions.find((a) => a.id === 'a3')?.ok === false);

    // 反向守卫：两条审计行（撤回误伤第二个任务）→ 仅 a6 红
    const extraCase = mkCancelCase({ extraAudits: 1 });
    const extra = await runScenario(scenarioByName('cancel-chain'), mkCtx(extraCase.transport, extraCase.query, cancelOpts));
    h.eq('⑤ 两条审计行 → fail（不误伤判据）', extra.status, 'fail');
    h.check('⑤ a6 红（误伤）', extra.assertions.find((a) => a.id === 'a6')?.ok === false);
    h.check('⑤ a6 外其余通过', extra.assertions.filter((a) => a.id !== 'a6').every((a) => a.ok));
  }

  // 9b. 场景⑥对抗提示包（opt-in；onPost 按条动态落行，模拟真实运行时"下一条样本尚未发出"的窗口语义）
  {
    const mkAdvCase = (opts: {
      // 覆写某条的 out action（缺省：任务类 delegate_to_boss，其余 general_response）
      actionOf?: (item: AdversarialItem) => string | undefined;
      // 为某条追加额外 delegation 行（模拟派发泄漏/被拦截）
      extraDelegation?: (item: AdversarialItem) => CanaryEntry[];
    } = {}) => {
      const rows: CanaryEntry[] = [];
      let ts = Date.now();
      const transport = makeFakeTransport({
        agents: ok({ value: AGENT_JSON }),
        process: ok({ success: true, action: 'general_response', response: '好的' }),
        onPost: (p, body) => {
          if (p !== '/api/voice-companion/process') return;
          const text = String((body as { text?: unknown } | undefined)?.text ?? '');
          const item = ADVERSARIAL_ITEMS.find((it) => it.text === text);
          if (!item) return;
          const action = opts.actionOf?.(item) ?? (item.kind === 'task' ? 'delegate_to_boss' : 'general_response');
          ts += 1;
          rows.push(mkEntry({ category: 'dialog', source: 'voice-companion', ts, body: { direction: 'in', text: item.text } }));
          // 真实落盘顺序：dispatched 行先于 dialog out（voice-companion-service.ts logDelegation → finish）
          if (item.kind === 'task' && action === 'delegate_to_boss') {
            ts += 1;
            rows.push(mkEntry({ category: 'delegation', source: 'voice-companion', ts, body: { phase: 'dispatched', channel: 'voice-companion', routedBy: 'delegate_to_boss', toAgentId: BOSS_ID, toAgentName: 'Boss', message: 'task' } }));
          }
          for (const extra of opts.extraDelegation?.(item) ?? []) {
            ts += 1;
            rows.push({ ...extra, ts, category: 'delegation' });
          }
          ts += 1;
          rows.push(mkEntry({ category: 'dialog', source: 'voice-companion', ts, body: { direction: 'out', text: '回复', action } }));
        },
      });
      return { transport, query: makeFakeQuery(rows).query };
    };

    const passCase = mkAdvCase();
    const pass = await runScenario(scenarioByName('adversarial'), mkCtx(passCase.transport, passCase.query));
    h.eq('⑥ 对抗包全通（8 条样本）', pass.status, 'pass');
    h.eq('⑥ 断言数=17（8×p + 8×p-d + a-inv）', pass.assertions.length, 17);
    h.check('⑥ 任务类派发命中 Boss（p1-d）', pass.assertions.find((a) => a.id === 'p1-d')?.ok === true);
    h.check('⑥ 越权类无派发行（p6-d）', pass.assertions.find((a) => a.id === 'p6-d')?.ok === true);
    h.check('⑥ 全窗口无非 Boss dispatched（a-inv）', pass.assertions.find((a) => a.id === 'a-inv')?.ok === true);
    h.check('⑥ notes 汇总样本构成', pass.notes.some((n) => n.includes('task 4 / chat 1 / overreach 3')));

    // 反向守卫 A：任务类被话术带偏成闲聊（未派发）→ p1/p1-d 必须红
    const fallback = mkAdvCase({ actionOf: (item) => (item.id === 'ignore-prev-task' ? 'general_response' : undefined) });
    const fallbackRes = await runScenario(scenarioByName('adversarial'), mkCtx(fallback.transport, fallback.query));
    h.eq('⑥ 任务类回退闲聊 → fail', fallbackRes.status, 'fail');
    h.check('⑥ p1 与 p1-d 均失败', fallbackRes.assertions.find((a) => a.id === 'p1')?.ok === false && fallbackRes.assertions.find((a) => a.id === 'p1-d')?.ok === false);

    // 反向守卫 B：越权诱导真派发了普通 agent → p6-d 与 a-inv 必须红（p6 的 out action 仍是 general_response）
    const leak = mkAdvCase({
      extraDelegation: (item) => (item.id === 'secret-exfil'
        ? [mkEntry({ category: 'delegation', source: 'voice-companion', body: { phase: 'dispatched', channel: 'voice-companion', toAgentId: 'sub-1', toAgentName: '下属甲', message: '读密钥' } })]
        : []),
    });
    const leakRes = await runScenario(scenarioByName('adversarial'), mkCtx(leak.transport, leak.query));
    h.eq('⑥ 越权派发泄漏 → fail', leakRes.status, 'fail');
    h.check('⑥ p6-d 失败', leakRes.assertions.find((a) => a.id === 'p6-d')?.ok === false);
    h.check('⑥ a-inv 失败（非 Boss dispatched）', leakRes.assertions.find((a) => a.id === 'a-inv')?.ok === false);
  }

  // 9c. 场景⑦项目路由与并行隔离（opt-in；fake 预置 need-ask 分支与显式双腿）
  {
    const ROUTING_AGENTS = [
      { id: 'boss-a', name: '主管甲', isBoss: true, class: 'boss', status: 'idle' },
      { id: 'boss-b', name: '主管乙', isBoss: true, class: 'boss', status: 'idle' },
      { id: 'sub-a', name: '下属甲', bossId: 'boss-a', status: 'idle' },
    ] as AgentInfo[];
    const mkRoutingCase = (opts: { ask?: boolean; wrongRouteForA?: boolean } = {}) => {
      const rows: CanaryEntry[] = [];
      let ts = Date.now();
      const push = (partial: Partial<CanaryEntry> & { category: string }) => {
        ts += 1;
        rows.push(mkEntry({ ...partial, ts }));
      };
      const transport = makeFakeTransport({
        agents: ok({ value: ROUTING_AGENTS }),
        workspaces: ok({ value: [
          { id: 'ws-a', name: '项目甲', areaIds: ['area-a'] },
          { id: 'ws-b', name: '项目乙', areaIds: ['area-b'] },
        ] }),
        areas: ok({ value: [
          { id: 'area-a', assignedAgentIds: ['boss-a'] },
          { id: 'area-b', assignedAgentIds: ['boss-b'] },
        ] }),
        activeWorkspace: ok({ workspaceId: 'ws-a' }),
        onPost: (p, body) => {
          if (p !== '/api/voice-companion/process') return;
          const text = String((body as { text?: unknown } | undefined)?.text ?? '');
          if (text === PROJECT_AMBIGUOUS_TEXT) {
            push({ category: 'dialog', source: 'voice-companion', body: { direction: 'in', text } });
            if (opts.ask) {
              push({ category: 'system', source: 'project-routing', body: { cat: 'project-routing', kind: 'need-ask', question: '是哪个项目的任务？', askCount: 1 } });
            } else {
              // 非冷环境：②上下文层直路由（§9c 分支覆盖）
              push({ category: 'system', source: 'project-routing', body: { cat: 'project-routing', kind: 'route', layer: 'context', source: 'last-project', projectId: 'ws-b', finalBossId: 'boss-b' } });
              push({ category: 'delegation', source: 'voice-companion', body: { phase: 'dispatched', channel: 'voice-companion', toAgentId: 'boss-b', routedBy: 'project-routing' } });
            }
            return;
          }
          if (opts.ask && text === '项目乙') {
            // 腿1a：用项目 B 名回答反问
            push({ category: 'dialog', source: 'voice-companion', body: { direction: 'in', text } });
            push({ category: 'system', source: 'project-routing', body: { cat: 'project-routing', kind: 'clarify-resolved', finalBossId: 'boss-b', projectId: 'ws-b' } });
            push({ category: 'delegation', source: 'voice-companion', body: { phase: 'dispatched', channel: 'voice-companion', toAgentId: 'boss-b', routedBy: 'project-clarify', status: 'clarify-resolved' } });
            return;
          }
          for (const proj of [
            { name: '项目甲', id: 'ws-a', boss: 'boss-a' },
            { name: '项目乙', id: 'ws-b', boss: 'boss-b' },
          ]) {
            if (text !== projectRouteText(proj.name)) continue;
            const wrong = opts.wrongRouteForA === true && proj.id === 'ws-a';
            push({ category: 'dialog', source: 'voice-companion', body: { direction: 'in', text } });
            // 串台变体只坏 projectId 一处（finalBossId 保持正确）：单点判别——a3 必须只对 projectId 子句判红
            push({ category: 'system', source: 'project-routing', body: { cat: 'project-routing', kind: 'route', layer: 'explicit', source: `alias:${proj.name}`, projectId: wrong ? 'ws-b' : proj.id, finalBossId: proj.boss } });
            push({ category: 'delegation', source: 'voice-companion', body: { phase: 'dispatched', channel: 'voice-companion', toAgentId: proj.boss, routedBy: 'project-routing' } });
            return;
          }
        },
      });
      return { transport, query: makeFakeQuery(rows).query };
    };
    const routingOpts = { logWaitMs: 80 } as Partial<CanaryOptions>;

    const askCase = mkRoutingCase({ ask: true });
    const ask = await runScenario(scenarioByName('project-routing'), mkCtx(askCase.transport, askCase.query, routingOpts));
    h.eq('⑦ 项目路由（need-ask 分支）全通', ask.status, 'pass');
    h.eq('⑦ 断言数=7（含 a2 澄清分支）', ask.assertions.length, 7);
    h.check('⑦ a1 need-ask 命中', ask.assertions.find((a) => a.id === 'a1')?.ok === true);
    h.check('⑦ a2 澄清回答命中项目 B', ask.assertions.find((a) => a.id === 'a2')?.ok === true);
    h.check('⑦ a7 并行隔离', ask.assertions.find((a) => a.id === 'a7')?.ok === true);
    h.check('⑦ PUT active 两次（临时 All + 恢复）', askCase.transport.calls.filter((c) => c === 'PUT /api/workspaces/active').length === 2);
    h.check('⑦ notes 登记工作区恢复', ask.notes.some((n) => n.includes('恢复')));

    // 非冷环境：歧义腿走②上下文层直路由（无 a2，notes 登记）
    const routeCase = mkRoutingCase({ ask: false });
    const route = await runScenario(scenarioByName('project-routing'), mkCtx(routeCase.transport, routeCase.query, routingOpts));
    h.eq('⑦ 直路由分支 → pass（6 断言）', route.status, 'pass');
    h.eq('⑦ 直路由时无 a2', route.assertions.length, 6);
    h.check('⑦ notes 登记非冷环境', route.notes.some((n) => n.includes('非冷环境')));

    // 反向守卫：route 事件报错项目（A 的文本路由到 B）→ a3 红而 a4 绿（判别力单点）
    const wrongCase = mkRoutingCase({ ask: false, wrongRouteForA: true });
    const wrong = await runScenario(scenarioByName('project-routing'), mkCtx(wrongCase.transport, wrongCase.query, routingOpts));
    h.eq('⑦ route.projectId 串台 → fail', wrong.status, 'fail');
    h.check('⑦ a3 红（projectId 不符）', wrong.assertions.find((a) => a.id === 'a3')?.ok === false);
    h.check('⑦ a4 绿（派发仍正确、单点判别）', wrong.assertions.find((a) => a.id === 'a4')?.ok === true);
  }

  // 9d. 场景⑨并发配额（opt-in；fake 预置排队/出队行与播报/审计）
  {
    const QUEUE_N = QUOTA_DEFAULT_REQUESTS;
    const mkQuotaCase = (opts: { noQueue?: boolean; noDequeue?: boolean; wrongFifo?: boolean } = {}) => {
      const rows: CanaryEntry[] = [];
      let ts = Date.now();
      let lastReportBody: { acceptance?: unknown; outputLocation?: unknown } | undefined;
      const push = (partial: Partial<CanaryEntry> & { category: string }) => {
        ts += 1;
        rows.push(mkEntry({ ...partial, ts }));
      };
      const transport = makeFakeTransport({
        agents: ok({ value: AGENT_JSON }),
        onPost: (p, body) => {
          if (p === '/api/voice-companion/process') {
            const text = String((body as { text?: unknown } | undefined)?.text ?? '');
            let idx = 0;
            for (let i = 1; i <= QUEUE_N; i++) if (text === quotaTaskText(i)) { idx = i; break; }
            if (!idx) return;
            push({ category: 'dialog', source: 'voice-companion', body: { direction: 'in', text } });
            const queued = !opts.noQueue && idx > 3;   // 预算 3：第 4/5 条排队
            push({ category: 'delegation', source: 'boss', taskId: `task-${idx}`, body: { phase: 'delegated', channel: 'boss', delivery: 'queue', status: queued ? 'queued' : undefined, toAgentId: `sub-${idx}`, toAgentName: `下属${idx}`, taskId: `task-${idx}` } });
            if (queued) {
              push({ category: 'delegation', source: 'quota', taskId: `task-${idx}`, body: { cat: 'delegation', phase: 'quota-queued', taskId: `task-${idx}`, bossId: BOSS_ID, queuedCount: 1, activeCount: 3, reason: 'quota-exhausted' } });
              push({ category: 'broadcast', source: 'boss', body: { cat: 'broadcast', phase: 'server-sent', action: 'delegation_quota', text: `[并发配额] 任务已排队：等待在办任务结束（当前 ${idx - 3} 个排队）。` } });
            }
            return;
          }
          if (p.includes('/report-task')) {
            lastReportBody = body as typeof lastReportBody;
            if (opts.noDequeue) return;
            const head = opts.wrongFifo ? { taskId: 'task-5', toAgentId: 'sub-5' } : { taskId: 'task-4', toAgentId: 'sub-4' };
            push({ category: 'delegation', source: 'quota', taskId: head.taskId, body: { cat: 'delegation', phase: 'quota-dequeued', taskId: head.taskId, bossId: BOSS_ID, queueMs: 1000, queuedCount: 1, activeCount: 3, reason: 'completion' } });
            push({ category: 'delegation', source: 'boss', taskId: head.taskId, body: { phase: 'delegated', channel: 'boss', delivery: 'queue', status: 'dequeued', toAgentId: head.toAgentId, toAgentName: '下属', taskId: head.taskId } });
            push({ category: 'broadcast', source: 'boss', body: { cat: 'broadcast', phase: 'server-sent', action: 'delegation_quota', text: '[并发配额] 排队任务开始了：继续执行。' } });
          }
        },
      });
      return { transport, query: makeFakeQuery(rows).query, getLastReportBody: () => lastReportBody };
    };
    const quotaOpts = { bossWaitMs: 200, reportWaitMs: 80, logWaitMs: 80 } as Partial<CanaryOptions>;

    // fake 镜像自证：completed 缺 acceptance/outputLocation → 400（与真实服务端一致；
    // 同时保护下面的载荷断言不空转——镜像被删该检查先红）
    const badRes = await makeFakeTransport({}).httpPost('/api/agents/x/report-task', { summary: 'x', status: 'completed' });
    h.eq('fake 镜像：completed 缺 acceptance/outputLocation → 400', badRes.status, 400);

    const passCase = mkQuotaCase();
    const pass = await runScenario(scenarioByName('quota-concurrency'), mkCtx(passCase.transport, passCase.query, quotaOpts));
    h.eq('⑨ 并发配额全通', pass.status, 'pass');
    h.eq('⑨ 断言数=7', pass.assertions.length, 7);
    h.check('⑨ report-task 打到在办下属 sub-1', passCase.transport.calls.some((c) => c.includes('sub-1/report-task')));
    const quotaReportBody = passCase.getLastReportBody();
    h.check('⑨ report-task 载荷含 acceptance+outputLocation（task17·A3）', !!quotaReportBody && isValidCompletedReport(quotaReportBody));
    h.check('⑨ a2 排队出现', pass.assertions.find((a) => a.id === 'a2')?.ok === true);
    h.check('⑨ a6 FIFO 命中队首', pass.assertions.find((a) => a.id === 'a6')?.ok === true);
    h.check('⑨ a7 账目 N 条', pass.assertions.find((a) => a.id === 'a7')?.ok === true);

    const noQueueCase = mkQuotaCase({ noQueue: true });
    const noQueue = await runScenario(scenarioByName('quota-concurrency'), mkCtx(noQueueCase.transport, noQueueCase.query, quotaOpts));
    h.eq('⑨ 无排队（预算未占满）→ fail', noQueue.status, 'fail');
    h.check('⑨ a2 红', noQueue.assertions.find((a) => a.id === 'a2')?.ok === false);
    h.check('⑨ a6 红（无队首可比）', noQueue.assertions.find((a) => a.id === 'a6')?.ok === false);

    const noDequeueCase = mkQuotaCase({ noDequeue: true });
    const noDequeue = await runScenario(scenarioByName('quota-concurrency'), mkCtx(noDequeueCase.transport, noDequeueCase.query, quotaOpts));
    h.eq('⑨ 完成事件未触发出队 → fail', noDequeue.status, 'fail');
    h.check('⑨ a5/a6 红', noDequeue.assertions.find((a) => a.id === 'a5')?.ok === false && noDequeue.assertions.find((a) => a.id === 'a6')?.ok === false);

    // 反向守卫：出队跳队（非队首）→ a6 红而 a5 绿（FIFO 判据单点成立）
    const wrongFifoCase = mkQuotaCase({ wrongFifo: true });
    const wrongFifo = await runScenario(scenarioByName('quota-concurrency'), mkCtx(wrongFifoCase.transport, wrongFifoCase.query, quotaOpts));
    h.eq('⑨ 出队跳队 → fail', wrongFifo.status, 'fail');
    h.check('⑨ a6 红（FIFO 违规且 a5 绿）', wrongFifo.assertions.find((a) => a.id === 'a6')?.ok === false && wrongFifo.assertions.find((a) => a.id === 'a5')?.ok === true);
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

    const cancel = await runScenario(scenarioByName('cancel-chain'), ctx);
    h.eq('dry-run 撤回链 → planned', cancel.status, 'planned');
    const routing = await runScenario(scenarioByName('project-routing'), ctx);
    h.eq('dry-run 项目路由 → planned', routing.status, 'planned');
    h.check('dry-run multiProjectRouting 延后', routing.prereqs.some((p) => p.id === 'multiProjectRouting' && p.deferred === true));
    const quota = await runScenario(scenarioByName('quota-concurrency'), ctx);
    h.eq('dry-run 并发配额 → planned', quota.status, 'planned');

    const tDown = makeFakeTransport({ health: fail(0, 'ECONNREFUSED') });
    const connDown = await runScenario(scenarioByName('connectivity'), mkCtx(tDown, makeFakeQuery([]).query, { dryRun: true }));
    h.eq('dry-run 服务不可达 → fail', connDown.status, 'fail');
  }

  // 11. 报告与退出码
  {
    const pass = await runScenario(scenarioByName('connectivity'), mkCtx(makeFakeTransport({}), makeFakeQuery([]).query));
    // 能力类 skip 用恒 SKIP 场景（cross-project-handover unsupported）——与真实 skip 语义一致
    const skipRes = await runScenario(scenarioByName('cross-project-handover'), mkCtx(makeFakeTransport({}), makeFakeQuery([]).query));
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
