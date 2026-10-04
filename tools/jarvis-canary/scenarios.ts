/**
 * 金丝雀场景注册表
 *
 * 每个场景 = {name, 前置条件(prereqs), 执行步骤(steps), 断言(assertions), 证据(evidence)}。
 * 断言全部落在 system_log 的真实事件行上；失败时由调用方输出"缺失证据明细"。
 *
 * smoke（低侵入，阶段门必跑）：
 *   ① connectivity     —— 服务端 HTTP/WS + EventDB 连通性
 *   ② dialog-roundtrip —— 发一条查询类消息，断言 dialog in/out（不触发派活）
 * full（opt-in，真派活，会产生真实 LLM 消耗）：
 *   ③ delegation-chain —— '让团队做 X' → 断言 dispatched 目标只有 Boss（任务05 L3）
 *   ④ receipt-chain    —— 等待下属 report-task 回执 / closed（依赖③的 delegated 证据）
 *   ⑤ cancel-chain     —— '别做了' → cancelled（任务16 未交付，恒 SKIP，断言函数已备好）
 *
 * 事件/字段口径（来自任务01/02 交付 activity-log.ts + voice-companion-service 埋点）：
 *   dialog      {direction:'in'|'out', text, action, degraded, targetAgentId, isEvent}
 *   broadcast   {phase:'server-sent', text, action, degraded}
 *   delegation  {phase:'dispatched'|'delegated'|'reported'|'closed'|'failed'|'blocked',
 *                channel, routedBy, toAgentId, toAgentName, message, delivery, status, forwarded}
 */

import type {
  AssertionResult, CanaryEntry, Evidence, PrereqResult, ScenarioContext, ScenarioDef, ScenarioOutcome,
} from './types.js';
import {
  fetchAgents, findBoss, probeCompanionStatus, probeHealth, reportTask, sendCompanionMessage,
} from './client.js';

/** 服务端与客户端同机，但仍留 5s 余量抵消时钟漂移/写入延迟 */
export const CLOCK_MARGIN_MS = 5_000;

/** 秘书契约里"任务类"action（voice-companion-service.ts COMPANION_ACTIONS） */
export const TASK_ACTIONS = ['delegate_to_boss', 'send_to_agent'] as const;

/** ④ 单独运行时回溯 delegated 事件的默认窗口（30 分钟） */
export const RECENT_DELEGATED_LOOKBACK_MS = 30 * 60_000;

// ─── 通用工具 ───

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** 轮询直到 probe 返回非 undefined；超时返回 undefined */
export async function waitFor<T>(
  probe: () => T | undefined | Promise<T | undefined>,
  opts: { timeoutMs: number; pollMs: number },
): Promise<T | undefined> {
  const deadline = Date.now() + Math.max(0, opts.timeoutMs);
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) return undefined;
    await sleep(Math.min(Math.max(1, opts.pollMs), Math.max(1, deadline - Date.now())));
  }
}

export function truncate(text: unknown, max = 120): string {
  const s = typeof text === 'string' ? text : String(text ?? '');
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function bodyString(e: CanaryEntry, key: string): string | undefined {
  const v = e.body?.[key];
  return typeof v === 'string' ? v : undefined;
}

/**
 * 定位"本次发送"的 dialog in 锚点：direction=in 且文本与所发消息精确匹配的行（同文本重复发送时取最新一条）。
 *
 * 为什么需要锚点：`since = now - 5s` 的时钟余量窗可能把**上一次运行**的残留行圈进来
 * （2026-10-04 L3 实测：smoke 刚结束 5.4s 后跑 full，smoke 的 `dialog out action=list_agents`
 * 行落进 full 的窗口，a2 取了窗口内第一条 out 行 → 误判失败，而本次真实行 `send_to_agent`
 * 就在窗口内）。因此凡"本次链路的回复/派生事件"的断言，一律只认 id > 锚点 id 的行。
 */
function findOwnDialogIn(entries: CanaryEntry[], text: string): CanaryEntry | undefined {
  const target = text.trim();
  return entries
    .filter((e) => bodyString(e, 'direction') === 'in' && bodyString(e, 'text')?.trim() === target)
    .at(-1);
}

/** 锚点缺失（理论上仅出现在日志写入异常时）时的退回说明，附进 notes 防静默降级。 */
const ANCHOR_FALLBACK_NOTE =
  '未找到本次消息的 dialog in 锚点（文本精确匹配失败）——断言退回窗口全域判定；' +
  '若与上一次运行间隔不足 5s，残留行可能被误判成本次结果，建议拉开间隔复跑。';

/** 抽取证据：命中行 id + 时间 + 关键字段（长文本截断；不回显全文/密钥） */
export function entryEvidence(e: CanaryEntry, bodyFields: string[] = [], maxText = 120): Evidence {
  const fields: Record<string, unknown> = {};
  if (e.sessionId) fields.sessionId = e.sessionId;
  if (e.taskId) fields.taskId = e.taskId;
  if (e.agentId) fields.agentId = e.agentId;
  for (const key of bodyFields) {
    const v = e.body?.[key];
    if (v === undefined) continue;
    fields[key] = typeof v === 'string' ? truncate(v, maxText) : v;
  }
  return {
    logId: e.id,
    tsIso: new Date(e.ts).toISOString(),
    category: e.category,
    source: e.source,
    level: e.level,
    fields,
  };
}

/** 失败诊断用的窗口内事件摘要（限 50 条，避免报告膨胀） */
export function observedSummary(entries: CanaryEntry[], limit = 50): Array<Record<string, unknown>> {
  return entries.slice(0, limit).map((e) => {
    const row: Record<string, unknown> = {
      id: e.id,
      ts: new Date(e.ts).toISOString(),
      category: e.category,
      source: e.source,
      level: e.level,
    };
    if (e.taskId) row.taskId = e.taskId;
    for (const key of ['phase', 'direction', 'action', 'status', 'toAgentId', 'fromAgentId', 'forwarded', 'routedBy', 'channel']) {
      const v = e.body?.[key];
      if (v !== undefined) row[key] = typeof v === 'string' ? truncate(v, 60) : v;
    }
    return row;
  });
}

function assertThat(
  id: string,
  desc: string,
  ok: boolean,
  expected: string,
  actual: string,
  evidence: Evidence[] = [],
): AssertionResult {
  return { id, desc, ok, expected, actual, evidence };
}

function isDelegation(e: CanaryEntry): boolean {
  return e.category === 'delegation';
}

function phaseOf(e: CanaryEntry): string | undefined {
  return bodyString(e, 'phase');
}

// ─── 前置条件（env = dry-run 也验证；runtime = dry-run 延后到真跑检查） ───

export interface PrereqDef {
  id: string;
  desc: string;
  kind: 'env' | 'runtime';
  check(ctx: ScenarioContext): Promise<PrereqResult>;
}

const PREREQ_DEFS: PrereqDef[] = [
  {
    id: 'serverReachable',
    desc: 'dev server HTTP 可达（GET /api/health）',
    kind: 'env',
    async check(ctx) {
      const res = await probeHealth(ctx.transport);
      const ok = res.ok && res.json?.status === 'ok';
      return {
        id: 'serverReachable', desc: this.desc, ok, kind: 'env',
        detail: ok ? `HTTP 200，${res.elapsedMs}ms` : `失败：${res.error ?? `HTTP ${res.status}`}（${ctx.transport.baseUrl}）`,
      };
    },
  },
  {
    id: 'companionAvailable',
    desc: '语音伙伴服务可用（GET /api/voice-companion/status.available）',
    kind: 'env',
    async check(ctx) {
      const res = await probeCompanionStatus(ctx.transport);
      const ok = res.ok && res.json?.available === true;
      return {
        id: 'companionAvailable', desc: this.desc, ok, kind: 'env',
        detail: ok ? `available=true（turns=${res.json?.turns ?? '?'}）` : `失败：${res.error ?? `HTTP ${res.status}`}`,
      };
    },
  },
  {
    id: 'dbReadable',
    desc: 'events.db 只读可查（system_log 表存在）',
    kind: 'env',
    async check(ctx) {
      try {
        ctx.query({ limit: 1 });
        return {
          id: 'dbReadable', desc: this.desc, ok: true, kind: 'env',
          detail: `${ctx.dbStats.dbPath}（共 ${ctx.dbStats.totalRows} 行，近24h ${ctx.dbStats.rows24h} 行）`,
        };
      } catch (err) {
        return {
          id: 'dbReadable', desc: this.desc, ok: false, kind: 'env',
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    },
  },
  {
    id: 'bossExists',
    desc: '团队存在主管（isBoss 或 class=boss）',
    kind: 'env',
    async check(ctx) {
      const { ok, agents, error } = await fetchAgents(ctx.transport);
      if (!ok) {
        return { id: 'bossExists', desc: this.desc, ok: false, kind: 'env', detail: `读取 /api/agents 失败：${error}` };
      }
      const boss = findBoss(agents);
      if (boss) ctx.shared.boss = boss;
      return {
        id: 'bossExists', desc: this.desc, ok: !!boss, kind: 'env',
        detail: boss ? `Boss = ${boss.name}（${boss.id}）` : `未找到主管（agents=${agents.length}）——③ 无法验证"目标只有 Boss"`,
      };
    },
  },
  {
    id: 'delegationChainEvidence',
    desc: '存在可关联的 delegated 事件（本次③真跑或最近 30 分钟）',
    kind: 'runtime',
    async check(ctx) {
      const chain = ctx.shared.delegationChain as { since: number } | undefined;
      const since = chain?.since ?? Date.now() - RECENT_DELEGATED_LOOKBACK_MS;
      const rows = ctx.query({ category: 'delegation', since, order: 'asc', limit: 200 });
      const delegated = rows.find((e) => phaseOf(e) === 'delegated');
      if (delegated) {
        ctx.shared.receiptChain = {
          since,
          delegated: {
            logId: delegated.id,
            toAgentId: bodyString(delegated, 'toAgentId'),
            toAgentName: bodyString(delegated, 'toAgentName'),
          },
        };
        return {
          id: 'delegationChainEvidence', desc: this.desc, ok: true, kind: 'runtime',
          detail: `delegated#${delegated.id} → ${bodyString(delegated, 'toAgentName') ?? bodyString(delegated, 'toAgentId')}`,
        };
      }
      return {
        id: 'delegationChainEvidence', desc: this.desc, ok: false, kind: 'runtime',
        detail: '未观测到 Boss 拆解派活（delegated）事件：④ 需要先完成 ③（Boss 在窗口内真实拆解派活），或最近 30 分钟内有过真实派活。',
      };
    },
  },
  {
    id: 'cancelChainSupported',
    desc: '撤回链能力已交付（任务16）',
    kind: 'env',
    async check() {
      return {
        id: 'cancelChainSupported', desc: this.desc, ok: false, kind: 'env',
        detail: '任务16（任务撤回/取消）尚未交付：当前服务端无撤回入口，system_log 也无 cancelled 事件源（可查 src/packages/server 无 cancelled 埋点）。',
      };
    },
  },
];

export const PREREQS: ReadonlyMap<string, PrereqDef> = new Map(PREREQ_DEFS.map((p) => [p.id, p]));

export async function runPrereqs(def: ScenarioDef, ctx: ScenarioContext): Promise<PrereqResult[]> {
  const results: PrereqResult[] = [];
  for (const id of def.prereqIds) {
    const prereq = PREREQS.get(id);
    if (!prereq) {
      results.push({ id, desc: id, ok: false, detail: `未注册的前置条件 ${id}`, kind: 'env' });
      continue;
    }
    if (ctx.options.dryRun && prereq.kind === 'runtime') {
      results.push({
        id, desc: prereq.desc, ok: true, kind: 'runtime', deferred: true,
        detail: '真跑时检查（dry-run 延后）',
      });
      continue;
    }
    try {
      results.push(await prereq.check(ctx));
    } catch (err) {
      results.push({
        id, desc: prereq.desc, ok: false, kind: prereq.kind,
        detail: `前置检查异常：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return results;
}

// ─── 场景 ① 连通性 ───

const connectivity: ScenarioDef = {
  name: 'connectivity',
  aliases: ['conn'],
  title: '连通性（HTTP / WS / EventDB）',
  level: 'smoke',
  consumesLlm: false,
  /** 只读：dry-run 下也真正执行，作为连通性预检 */
  safeInDryRun: true,
  description: '确认 dev server 的 HTTP、WebSocket 升级、events.db 只读查询三条通道都通。不发任何消息。',
  steps: [
    'GET /api/health 断言 status=ok',
    'GET /api/voice-companion/status 断言 available=true',
    'ws://…/ws 握手，等待服务端首帧（server_time 等）',
    '只读查询 system_log 并统计行数/最近写入时间',
  ],
  assertionDocs: [
    'a1 /api/health 返回 200 且 status=ok',
    'a2 /api/voice-companion/status 返回 200 且 available=true',
    'a3 WS 握手成功且收到服务端消息',
    'a4 system_log 只读可查（返回数组）',
  ],
  prereqIds: [],
  async run(ctx): Promise<ScenarioOutcome> {
    const assertions: AssertionResult[] = [];
    const notes: string[] = [];

    const health = await probeHealth(ctx.transport);
    assertions.push(assertThat(
      'a1', 'HTTP /api/health 连通',
      health.ok && health.json?.status === 'ok',
      "HTTP 200 且 body.status='ok'",
      health.ok ? `HTTP ${health.status} status=${String(health.json?.status)}` : `HTTP ${health.status} ${health.error ?? ''}`,
      [],
    ));

    const status = await probeCompanionStatus(ctx.transport);
    assertions.push(assertThat(
      'a2', '语音伙伴服务在线',
      status.ok && status.json?.available === true,
      'HTTP 200 且 available=true',
      status.ok ? `HTTP ${status.status} available=${String(status.json?.available)}` : `HTTP ${status.status} ${status.error ?? ''}`,
      [],
    ));

    const ws = await ctx.transport.wsHandshake();
    assertions.push(assertThat(
      'a3', 'WS /ws 握手 + 首帧',
      ws.ok,
      'WS 连接成功并在超时内收到服务端消息（server_time 等）',
      ws.ok ? `首帧 type=${ws.firstMessageType}（${ws.elapsedMs}ms）` : `${ws.error}`,
      ws.firstMessageType ? [{ fields: { firstMessageType: ws.firstMessageType } }] : [],
    ));

    let dbOk = false;
    let dbDetail = '';
    try {
      const rows = ctx.query({ limit: 1 });
      dbOk = Array.isArray(rows);
      dbDetail = `system_log 共 ${ctx.dbStats.totalRows} 行，近24h ${ctx.dbStats.rows24h} 行` +
        (ctx.dbStats.latestTs ? `，最近写入 ${new Date(ctx.dbStats.latestTs).toISOString()}` : '，暂无任何行');
    } catch (err) {
      dbDetail = err instanceof Error ? err.message : String(err);
    }
    assertions.push(assertThat(
      'a4', 'EventDB 只读查询可用',
      dbOk,
      'querySystemLog 语义的只读查询返回数组',
      dbDetail,
      [{ fields: { dbPath: ctx.dbStats.dbPath, totalRows: ctx.dbStats.totalRows, rows24h: ctx.dbStats.rows24h } }],
    ));

    if (ctx.dbStats.rows24h === 0) {
      notes.push('24h 内 system_log 无任何写入——若刚部署任务01/02 埋点，属正常；否则请确认 dev server 已重启加载新代码。');
    }
    return { assertions, notes, observed: [] };
  },
};

// ─── 场景 ② 对话往返（不派活） ───

const dialogRoundtrip: ScenarioDef = {
  name: 'dialog-roundtrip',
  aliases: ['dialog'],
  title: '对话往返（dialog in/out，不触发派活）',
  level: 'smoke',
  consumesLlm: false,
  description: '通过 POST /api/voice-companion/process 发一条查询类消息（默认"列出团队成员"），断言 system_log 出现 dialog in 与 out，且未产生任何 delegation 事件。',
  steps: [
    '记录窗口起点 t0（含 5s 时钟余量）',
    'POST /api/voice-companion/process {text: <--dialog-text>}',
    '轮询 system_log：dialog direction=in 且文本匹配',
    '轮询 system_log：dialog direction=out',
    '断言窗口内没有 delegation 事件（查询类消息不得派活）',
  ],
  assertionDocs: [
    'a1 HTTP 200（success!==false）',
    'a2 dialog in：body.direction=in 且 body.text 与发送文本一致',
    'a3 dialog out：body.direction=out 且文本非空',
    'a4 窗口内无任何 delegation 事件（低侵入保证）',
  ],
  prereqIds: ['serverReachable', 'companionAvailable', 'dbReadable'],
  async run(ctx): Promise<ScenarioOutcome> {
    const text = ctx.options.dialogText;
    const since = Date.now() - CLOCK_MARGIN_MS;
    const res = await sendCompanionMessage(ctx.transport, text);

    const assertions: AssertionResult[] = [];
    const notes: string[] = [];
    assertions.push(assertThat(
      'a1', '消息已受理',
      res.ok && res.status === 200 && res.json?.success !== false,
      'HTTP 200 且 success!==false',
      res.ok ? `HTTP ${res.status} action=${String(res.json?.action ?? '?')} elapsed=${res.elapsedMs}ms` : `HTTP ${res.status} ${res.error ?? JSON.stringify(res.json ?? {})}`,
      [],
    ));

    let inRow: CanaryEntry | undefined;
    let ownIn: CanaryEntry | undefined;
    let outRow: CanaryEntry | undefined;
    const waitMs = ctx.options.logWaitMs;
    const found = await waitFor(() => {
      const rows = ctx.query({ category: 'dialog', since, order: 'asc', limit: 200 });
      inRow = rows.find((e) => bodyString(e, 'direction') === 'in');
      // 锚点绑定：out 只认本次 in 锚点之后的行（详见 findOwnDialogIn 注释）
      ownIn = findOwnDialogIn(rows, text) ?? ownIn;
      outRow = rows.find((e) => bodyString(e, 'direction') === 'out' && e.id > (ownIn?.id ?? 0));
      return ownIn && outRow ? { ownIn, outRow } : undefined;
    }, { timeoutMs: waitMs, pollMs: ctx.options.pollMs });
    ownIn = found?.ownIn ?? ownIn;
    outRow = found?.outRow ?? outRow;

    const inEvidenceRow = ownIn ?? inRow;
    assertions.push(assertThat(
      'a2', 'dialog in 已落盘',
      !!ownIn,
      `system_log 中 category=dialog、body.direction='in'、body.text='${truncate(text)}'、ts>=${new Date(since).toISOString()}`,
      ownIn
        ? `命中 #${ownIn.id}`
        : inRow
          ? `窗口内有 dialog in（#${inRow.id}）但文本不一致：'${truncate(bodyString(inRow, 'text'))}'`
          : `未找到（轮询 ${waitMs}ms）`,
      inEvidenceRow ? [entryEvidence(inEvidenceRow, ['direction', 'text', 'isEvent'])] : [],
    ));
    assertions.push(assertThat(
      'a3', 'dialog out 已落盘',
      !!outRow && !!bodyString(outRow, 'text')?.trim(),
      `system_log 中 category=dialog、body.direction='out'、body.text 非空、ts>=${new Date(since).toISOString()}（id > 本次 in 锚点）`,
      outRow ? `命中 #${outRow.id} action=${String(outRow.body?.action ?? '?')}` : `未找到（轮询 ${waitMs}ms）`,
      outRow ? [entryEvidence(outRow, ['direction', 'text', 'action', 'degraded', 'targetAgentId'])] : [],
    ));
    if (!ownIn) notes.push(ANCHOR_FALLBACK_NOTE);

    const delegationRows = ctx
      .query({ category: 'delegation', since, order: 'asc', limit: 50 })
      .filter((e) => e.id > (ownIn?.id ?? 0));
    assertions.push(assertThat(
      'a4', '未触发派活',
      delegationRows.length === 0,
      '窗口内 delegation 事件数 = 0',
      delegationRows.length === 0 ? '0 条' : `${delegationRows.length} 条（${delegationRows.map((e) => `#${e.id}:${phaseOf(e)}`).join(', ')}）`,
      delegationRows.slice(0, 5).map((e) => entryEvidence(e, ['phase', 'channel', 'toAgentId', 'status'])),
    ));

    if (res.json?.degraded === true) {
      notes.push('注意：本次回合为降级兜底（degraded=true）——dialog out 是兜底话术，链路本身仍算走通，但模型输出未解析成功。');
    }
    notes.push(`返回 action=${String(res.json?.action ?? '?')}，response=${truncate(res.json?.response, 80)}`);

    const observed = observedSummary(ctx.query({ since, order: 'asc', limit: 200 }));
    return { assertions, notes, observed };
  },
};

// ─── 场景 ③ 派活链（full） ───

const delegationChain: ScenarioDef = {
  name: 'delegation-chain',
  aliases: ['delegation'],
  title: '派活链（"让团队做 X" → 目标只有 Boss）',
  level: 'full',
  consumesLlm: true,
  description: '真派活：向秘书发一条任务类消息，断言 delegation dispatched 的目标只有 Boss（任务05 的 L3 判据"全走 Boss"）。🔴 会产生真实 LLM 消耗（秘书 hop1 + Boss 拆解）。',
  steps: [
    '记录窗口起点 t0',
    'POST /api/voice-companion/process {text: <--task-text>}（默认金丝雀最小任务）',
    '断言 dialog out 的 action ∈ {delegate_to_boss, send_to_agent}',
    '断言 delegation dispatched 且 channel=voice-companion、toAgentId=Boss',
    '断言不存在 dispatched 到非 Boss agent 的行（全走 Boss 不变式）',
    '（--wait-boss-ms>0）等待 Boss 的 delegated 拆解事件作为二级证据（供④使用）',
  ],
  assertionDocs: [
    'a1 HTTP 200',
    'a2 dialog out 的 action 是任务类（delegate_to_boss/send_to_agent）',
    'a3 delegation dispatched → Boss（toAgentId=主管 id）',
    'a4 无 dispatched/非 Boss 目标（违规直派不会真正发出）',
    'warn 若出现 blocked（决策观测点①）只在 notes 提示，不判失败（系统已改道）',
  ],
  prereqIds: ['serverReachable', 'companionAvailable', 'dbReadable', 'bossExists'],
  async run(ctx): Promise<ScenarioOutcome> {
    const boss = ctx.shared.boss as { id: string; name: string } | undefined;
    const bossId = boss?.id ?? '';
    const text = ctx.options.taskText;
    const since = Date.now() - CLOCK_MARGIN_MS;

    const res = await sendCompanionMessage(ctx.transport, text);
    const assertions: AssertionResult[] = [];
    const notes: string[] = [];

    assertions.push(assertThat(
      'a1', '任务消息已受理',
      res.ok && res.status === 200,
      'HTTP 200',
      res.ok ? `HTTP ${res.status} action=${String(res.json?.action ?? '?')} elapsed=${res.elapsedMs}ms` : `HTTP ${res.status} ${res.error ?? JSON.stringify(res.json ?? {})}`,
      [],
    ));

    // 锚点绑定：本次链路的 out/dispatched 一律只认 id > 本次 dialog in 锚点的行
    // （2026-10-04 L3 实测缺陷：窗口余量圈进了上一次 smoke 的 dialog out，a2 误判）。
    const ownIn = findOwnDialogIn(ctx.query({ category: 'dialog', since, order: 'asc', limit: 200 }), text);
    const anchorId = ownIn?.id ?? 0;
    if (!ownIn) notes.push(ANCHOR_FALLBACK_NOTE);

    let outRow: CanaryEntry | undefined;
    let dispatched: CanaryEntry | undefined;
    const waitMs = ctx.options.logWaitMs;
    const found = await waitFor(() => {
      const dialogs = ctx.query({ category: 'dialog', since, order: 'asc', limit: 200 });
      outRow = dialogs.find((e) => bodyString(e, 'direction') === 'out' && e.id > anchorId);
      const dels = ctx.query({ category: 'delegation', since, order: 'asc', limit: 200 });
      dispatched = dels.find((e) => phaseOf(e) === 'dispatched' && bodyString(e, 'channel') === 'voice-companion' && e.id > anchorId);
      return outRow && dispatched ? { outRow, dispatched } : undefined;
    }, { timeoutMs: waitMs, pollMs: ctx.options.pollMs });
    outRow = found?.outRow ?? outRow;
    dispatched = found?.dispatched ?? dispatched;

    const action = outRow ? String(outRow.body?.action ?? '') : String(res.json?.action ?? '');
    assertions.push(assertThat(
      'a2', '秘书判定为任务类并派发',
      (TASK_ACTIONS as readonly string[]).includes(action),
      'dialog out 的 body.action ∈ {delegate_to_boss, send_to_agent}（锚点后的本次回复）',
      outRow ? `action='${action}'` : `未找到（锚点后）dialog out（轮询 ${waitMs}ms）`,
      outRow ? [entryEvidence(outRow, ['direction', 'action', 'targetAgentId', 'text'])] : [],
    ));

    assertions.push(assertThat(
      'a3', 'dispatched 目标为 Boss',
      !!dispatched && bodyString(dispatched, 'toAgentId') === bossId,
      `delegation phase='dispatched'、channel='voice-companion'、toAgentId='${bossId}'（${boss?.name ?? '?'}）`,
      dispatched
        ? `命中 #${dispatched.id} → ${bodyString(dispatched, 'toAgentName') ?? bodyString(dispatched, 'toAgentId')}（routedBy=${String(dispatched.body?.routedBy ?? '?')}）`
        : `未找到 dispatched（轮询 ${waitMs}ms）`,
      dispatched ? [entryEvidence(dispatched, ['phase', 'channel', 'routedBy', 'toAgentId', 'toAgentName', 'message', 'delivery', 'status'])] : [],
    ));

    const windowRows = ctx.query({ category: 'delegation', since, order: 'asc', limit: 200 });
    // 断言语义 = "本次消息触发的行"：残留行（锚点之前）不参与 全走 Boss 不变式 判定
    const scopedRows = windowRows.filter((e) => e.id > anchorId);
    const dispatchedToNonBoss = scopedRows.filter(
      (e) => phaseOf(e) === 'dispatched' && !!bodyString(e, 'toAgentId') && bodyString(e, 'toAgentId') !== bossId,
    );
    assertions.push(assertThat(
      'a4', '不存在非 Boss 的 dispatched 目标',
      dispatchedToNonBoss.length === 0,
      '本次消息（锚点后）dispatched 且 toAgentId ≠ Boss 的行数 = 0（全走 Boss 不变式）',
      dispatchedToNonBoss.length === 0
        ? '0 条'
        : `${dispatchedToNonBoss.length} 条：${dispatchedToNonBoss.map((e) => `#${e.id}→${bodyString(e, 'toAgentId')}`).join(', ')}`,
      dispatchedToNonBoss.slice(0, 5).map((e) => entryEvidence(e, ['phase', 'channel', 'toAgentId', 'toAgentName', 'status'])),
    ));

    const blockedRows = scopedRows.filter((e) => phaseOf(e) === 'blocked');
    if (blockedRows.length > 0) {
      notes.push(`决策观测点①：检测到 ${blockedRows.length} 条 blocked（违规直派被拦截并改道 Boss）：` +
        blockedRows.map((e) => `#${e.id}→${bodyString(e, 'toAgentId')}`).join(', ') +
        '——不变式未破，但模型话术/目标不符合约定，建议人工复核。');
    }

    // 二级证据：Boss 真正拆解派活（delegated）。不判失败，仅记录；④ 依赖它。
    let delegated: CanaryEntry | undefined;
    if (ctx.options.bossWaitMs > 0) {
      delegated = await waitFor(() => {
        const rows = ctx.query({ category: 'delegation', since, order: 'asc', limit: 200 });
        return rows.find((e) => phaseOf(e) === 'delegated' && e.id > anchorId);
      }, { timeoutMs: ctx.options.bossWaitMs, pollMs: Math.max(1000, ctx.options.pollMs) });
    }
    if (delegated) {
      notes.push(`Boss 拆解派活已观测到：delegated #${delegated.id} → ${bodyString(delegated, 'toAgentName') ?? bodyString(delegated, 'toAgentId')}。`);
    } else if (ctx.options.bossWaitMs > 0) {
      notes.push(`Boss 未在 ${ctx.options.bossWaitMs}ms 内产出 delegated 事件（Boss 可能仍在思考/排队）——③ 仍通过（秘书→Boss 已确认），④回执链将因缺前置跳过。`);
    }

    ctx.shared.delegationChain = {
      since,
      anchorLogId: ownIn?.id,
      dispatchedLogId: dispatched?.id,
      delegated: delegated
        ? {
            logId: delegated.id,
            toAgentId: bodyString(delegated, 'toAgentId'),
            toAgentName: bodyString(delegated, 'toAgentName'),
          }
        : undefined,
    };

    const observed = observedSummary(windowRows.slice(0, 50));
    return { assertions, notes, observed };
  },
};

// ─── 场景 ④ 回执链（full） ───

const receiptChain: ScenarioDef = {
  name: 'receipt-chain',
  aliases: ['receipt'],
  title: '回执链（下属 report-task → Boss 转发）',
  level: 'full',
  consumesLlm: true,
  description: '等待被派活的下属通过 POST /api/agents/:id/report-task 真回执，断言 delegation reported（forwarded=true 转发给 Boss）。默认等待真实下属完成；--simulate-receipt 可用接口模拟回执（半合成，不消耗下属 LLM）。',
  steps: [
    '取本次③（或最近30分钟）的 delegated 证据（subordinateId、窗口起点）',
    '（--simulate-receipt）以该下属身份 POST /api/agents/:id/report-task',
    '轮询 system_log：delegation phase=reported 且 ts>=窗口起点',
    '断言 forwarded=true（回执已转发 Boss）',
    '记录 phase=closed 是否出现（二级证据，不判失败）',
  ],
  assertionDocs: [
    'a1 reported 事件存在（channel=subordinate）',
    'a2 reported.forwarded=true（已转发给 Boss）',
    'note closed 事件（下属回合关闭）是否观测到',
  ],
  prereqIds: ['serverReachable', 'dbReadable', 'delegationChainEvidence'],
  async run(ctx): Promise<ScenarioOutcome> {
    const chain = ctx.shared.receiptChain as {
      since: number;
      delegated: { logId: number; toAgentId?: string; toAgentName?: string };
    };
    const since = chain.since;
    const subordinateId = chain.delegated.toAgentId ?? '';
    const assertions: AssertionResult[] = [];
    const notes: string[] = [];

    if (ctx.options.simulateReceipt) {
      const sim = await reportTask(
        ctx.transport,
        subordinateId,
        '[金丝雀] 回执链半合成验证：模拟下属完成回执（未执行实际任务）',
        'completed',
      );
      notes.push(sim.ok
        ? `已通过 report-task 模拟下属 ${subordinateId} 回执（半合成；HTTP ${sim.status}）`
        : `模拟回执请求失败：HTTP ${sim.status} ${sim.error ?? JSON.stringify(sim.json ?? {})}`);
    }

    const reported = await waitFor(() => {
      const rows = ctx.query({ category: 'delegation', since, order: 'asc', limit: 200 });
      return rows.find((e) => phaseOf(e) === 'reported');
    }, { timeoutMs: ctx.options.reportWaitMs, pollMs: Math.max(1000, ctx.options.pollMs) });

    assertions.push(assertThat(
      'a1', 'reported 回执事件已落盘',
      !!reported,
      `system_log 中 delegation phase='reported'（channel='subordinate'）、ts>=${new Date(since).toISOString()}`,
      reported
        ? `命中 #${reported.id} from=${bodyString(reported, 'fromName') ?? bodyString(reported, 'fromAgentId')} status=${String(reported.body?.status ?? '?')}`
        : `未找到（轮询 ${ctx.options.reportWaitMs}ms；真实下属可能尚未完成任务）`,
      reported ? [entryEvidence(reported, ['phase', 'channel', 'fromAgentId', 'fromName', 'toAgentId', 'toAgentName', 'message', 'status', 'forwarded'])] : [],
    ));

    assertions.push(assertThat(
      'a2', '回执已转发给 Boss',
      !!reported && reported.body?.forwarded === true,
      'reported.forwarded=true（report-task 转发进 Boss 会话）',
      reported ? `forwarded=${String(reported.body?.forwarded)}` : '无 reported 行',
      reported ? [entryEvidence(reported, ['phase', 'forwarded', 'toAgentId', 'toAgentName'])] : [],
    ));

    const closed = ctx.query({ category: 'delegation', since, order: 'asc', limit: 200 }).find((e) => phaseOf(e) === 'closed');
    if (closed) {
      notes.push(`下属回合关闭事件已观测到：closed #${closed.id} status=${String(closed.body?.status ?? '?')}。`);
    } else {
      notes.push('未观测到 closed 事件（下属回合可能未结束；不判失败）。');
    }

    const observed = observedSummary(ctx.query({ category: 'delegation', since, order: 'asc', limit: 50 }));
    return { assertions, notes, observed };
  },
};

// ─── 场景 ⑤ 撤回链（full，待任务16） ───

/**
 * 撤回链断言函数——任务16 交付后启用。
 * TODO（任务16 落地时）：把 cancelChainSupported 前置改为"探测撤回能力"（如 API 存在性），
 * 并确认 cancelled 的事件形态（phase='cancelled' 或 status='cancelled'）后收紧此处。
 */
export function assertCancelEvidence(rows: CanaryEntry[]): { ok: boolean; evidence: Evidence[]; actual: string } {
  const hit = rows.find((e) => {
    const phase = phaseOf(e) ?? '';
    const status = bodyString(e, 'status') ?? '';
    return phase === 'cancelled' || phase === 'cancel' || status === 'cancelled' || status === 'canceled';
  });
  if (!hit) return { ok: false, evidence: [], actual: '未找到 cancelled/cancel 形态的 delegation 事件' };
  return { ok: true, evidence: [entryEvidence(hit, ['phase', 'channel', 'status', 'toAgentId', 'message'])], actual: `命中 #${hit.id}` };
}

const cancelChain: ScenarioDef = {
  name: 'cancel-chain',
  aliases: ['cancel'],
  title: '撤回链（"别做了" → cancelled）',
  level: 'full',
  consumesLlm: true,
  description: '派错任务后撤回，断言任务 status=cancelled 且 Boss 通知下属停止。任务16（任务撤回/取消）尚未交付，当前恒 SKIP；断言函数与执行步骤已按预留形态实现。',
  unsupported: '任务16（任务撤回/取消）尚未交付：服务端无撤回入口、system_log 无 cancelled 事件源。断言函数 assertCancelEvidence 已按 phase/status=cancelled 形态实现，待任务16 落地后把 cancelChainSupported 前置改成能力探测即可启用。',
  steps: [
    '（待任务16）发送派活消息，等待 dispatched',
    '（待任务16）发送 --cancel-text（默认"别做了，取消刚才的任务"）',
    '（待任务16）断言 delegation 事件出现 status=cancelled（或 phase=cancelled）',
    '（待任务16）断言目标下属被通知停止（closed/status 证据）',
  ],
  assertionDocs: ['a1 cancelled 形态事件存在', 'a2 只取消目标任务，不误伤其他在途任务'],
  prereqIds: ['cancelChainSupported'],
  async run(): Promise<ScenarioOutcome> {
    return { assertions: [], notes: ['不该到达这里——cancelChainSupported 恒 false，场景应被跳过。'], observed: [] };
  },
};

// ─── 注册表 / 选择 ───

export const SCENARIOS: readonly ScenarioDef[] = [
  connectivity,
  dialogRoundtrip,
  delegationChain,
  receiptChain,
  cancelChain,
];

export function selectScenarios(level: 'smoke' | 'full', filter: string[]): { selected: ScenarioDef[]; unknown: string[] } {
  if (filter.length > 0) {
    const wanted = new Set(filter.map((f) => f.trim().toLowerCase()).filter(Boolean));
    const selected: ScenarioDef[] = [];
    const unknown: string[] = [];
    for (const name of wanted) {
      const def = SCENARIOS.find((s) => s.name.toLowerCase() === name || s.aliases?.some((a) => a.toLowerCase() === name));
      if (def) {
        if (!selected.includes(def)) selected.push(def);
      } else {
        unknown.push(name);
      }
    }
    // 注册表顺序
    selected.sort((a, b) => SCENARIOS.indexOf(a) - SCENARIOS.indexOf(b));
    return { selected, unknown };
  }
  const selected = SCENARIOS.filter((s) => (level === 'full' ? true : s.level === 'smoke'));
  return { selected: [...selected], unknown: [] };
}
