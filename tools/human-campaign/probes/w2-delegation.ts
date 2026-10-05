/**
 * C2 · 单项目派活闭环（HC-15..24）——全部走真实链路（真 LLM / 真 Boss / 真下属）
 *
 * 无害任务模板（计划逐字；现存 agent cwd=仓库根，故模板必须零文件操作）：
 *   T1 零工具：只回复"收到"；
 *   T2 保活：只运行 sleep 120 后回"收到"（撤回/重派/孤儿探针用）；
 *   T3 项目标签（C3 用，见 w3）。
 * 完成一律优先半合成 report-task（acceptance+outputLocation 真形状，文本标注"半合成（工具验证用）"）。
 *
 * 证据面：
 *   dispatched=秘书→Boss 出站（channel=voice-companion）；
 *   delegated=Boss 拆解写入；reported/closed=真回执链；
 *   task-card-status=任务卡迁移行（19·B 研究）；receipt=回执播报行（task-receipt-notifier.ts:191）；
 *   病历=delegation/source=boss/phase ∈ completion-recorded|rating-recorded（boss-service.ts:717）。
 */

import type { CanaryEntry, ProbeContext, ProbeDef, ProbeOutcome } from '../types.js';
import {
  assertCancelEvidence, assertThat, bodyString, bossIdSet,
  dispatchedRows, entryEvidence, observedSummary, phaseOf, reportTask, sendTurn,
  SIMULATED_COMPLETION, sleep, truncate, waitDelegationPhase, waitDispatched,
  delegationRows, queryRows, type TurnResult,
} from '../runner.js';

// ─── 无害任务模板 ───

// 措辞与金丝雀 scenarios.ts:48/:63 对齐（已验证触发派活）：「让团队做一件…任务」前缀
// 是派活必要触发句式；缺前缀时模型会把"只回复收到"读成对自己的指令，4s 内裸 ack 零派发
// （2026-10-05 C2 首跑 HC-15/16 实况，样本作废）。
export function taskT1(tag: string): string {
  return `让团队做一件真人战役派活验证任务（${tag}）：只回复"收到"两个字，不要执行任何实际操作。`;
}
export function taskT2(tag: string): string {
  return `让团队做一件真人战役保活验证任务（${tag}）：执行下属运行命令「sleep 120」等待结束后回复"收到"，不要做其他任何操作。`;
}

const SETTLE_MS = 4000;

// ─── 降级感知回合（C1 移植，2026-10-05） ───
// 服务器 hop1 超时 → degraded=true 罐头回复 = LLM 从未处理该消息，该回合不构成有效评估。
// 重发最多 2 次（各等 20s）；仍全降级 → 如实 SKIP（非 optional SKIP 阻塞门禁，不充红/充绿）。

const TURN_OPTS = { retryOnDegrade: 2, degradeDelayMs: 20_000, outTimeoutMs: 120_000 };

async function turnOrSkip(ctx: ProbeContext, text: string): Promise<{ t: TurnResult } | { skip: ProbeOutcome }> {
  const t = await sendTurn(ctx, text, TURN_OPTS);
  if (t.out?.body?.degraded === true) {
    return {
      skip: {
        assertions: [],
        notes: [`LLM 降级窗口未恢复：共 ${1 + (t.degradeRetries ?? 0)} 次尝试均 degraded=true（服务器 hop 超时，消息未被处理）`],
        skipReason: 'LLM 降级窗口（环境阻塞）——目标链未获评估，待通道恢复后复跑',
      },
    };
  }
  return { t };
}

function findInFlightDelegation(ctx: ProbeContext): CanaryEntry | undefined {
  const rows = delegationRows(ctx, Date.now() - 30 * 60_000, 0);
  const finished = new Set(
    rows.filter((r) => ['reported', 'closed', 'cancelled'].includes(phaseOf(r) ?? '')).map((r) => r.taskId).filter(Boolean),
  );
  return [...rows].reverse().find((r) => phaseOf(r) === 'delegated' && r.taskId && !finished.has(r.taskId));
}

function phaseRows(ctx: ProbeContext, phases: string[], since: number, anchorId: number): CanaryEntry[] {
  return delegationRows(ctx, since, anchorId).filter((e) => phases.includes(phaseOf(e) ?? ''));
}

// ─── HC-15 派活只走 Boss ───

const hc15: ProbeDef = {
  id: 'HC-15', wave: 2, title: '派活只走 Boss（T1 零工具）', dim: '派活·不变式', effect: 'delegation',
  utterance: '（任务模板 T1，见 taskT1）',
  steps: ['发送 T1 任务', '等待 dispatched', '断言恰 1 条且只到 Boss'],
  assertionDocs: ['HTTP 200', 'dispatched 恰 1 条', '全窗口非 Boss dispatched=0', '无 blocked'],
  prereqIds: ['serverReachable', 'companionAvailable', 'bossExists', 'teamIdle'],
  run: async (ctx) => {
    const r = await turnOrSkip(ctx, taskT1('HC-15'));
    if ('skip' in r) return r.skip;
    const t = r.t;
    const rows = await waitDispatched(ctx, t.since, t.anchorId, ctx.options.bossWaitMs);
    const dispatched = rows ?? dispatchedRows(ctx, t.since, t.anchorId);
    const bosses = await bossIdSet(ctx);
    const bad = dispatched.filter((e) => { const to = e.agentId ?? bodyString(e, 'toAgentId'); return to === undefined || !bosses.has(to); });
    const blocked = phaseRows(ctx, ['blocked'], t.since, t.anchorId);
    if (dispatched[0]?.taskId) ctx.shared['w2.lastDispatchTaskId'] = dispatched[0].taskId;
    return {
      assertions: [
        assertThat('hc15-http', 'HTTP 200', t.res.ok, '200', `${t.res.status}`),
        assertThat('hc15-dispatch-1', 'dispatched 恰 1 条', dispatched.length === 1, '1', String(dispatched.length),
          dispatched.slice(0, 3).map((e) => entryEvidence(e, ['phase', 'toAgentId', 'toAgentName', 'channel', 'message'], 100))),
        assertThat('hc15-boss-only', '非 Boss dispatched=0', bad.length === 0, '0', String(bad.length),
          bad.slice(0, 3).map((e) => entryEvidence(e, ['phase', 'toAgentId', 'channel']))),
        assertThat('hc15-no-blocked', '无 blocked 告警', blocked.length === 0, '0', String(blocked.length)),
      ],
      notes: [...(t.anchorNote ? [t.anchorNote] : [])],
      observed: observedSummary(delegationRows(ctx, t.since, t.anchorId)),
    };
  },
};

// ─── HC-16 真回执链 ───

const hc16: ProbeDef = {
  id: 'HC-16', wave: 2, title: '真回执链（T1 真跑 → delegated/reported）', dim: '派活·回执链', effect: 'delegation',
  utterance: '（任务模板 T1，见 taskT1）',
  steps: ['发送 T1', '等待 delegated（Boss 拆解）', '等待 reported/closed；180s 未产出记时序观察项转半合成'],
  assertionDocs: ['HTTP 200', '链路推进（delegated/reported/closed 任一）', '真回执到 reported/closed（超时→转半合成观察项）'],
  prereqIds: ['serverReachable', 'companionAvailable', 'bossExists', 'teamIdle'],
  run: async (ctx) => {
    const r = await turnOrSkip(ctx, taskT1('HC-16'));
    if ('skip' in r) return r.skip;
    const t = r.t;
    await waitDispatched(ctx, t.since, t.anchorId, ctx.options.bossWaitMs);
    const progressed = await (async () => {
      const deadline = Date.now() + ctx.options.bossWaitMs;
      for (;;) {
        const rows = phaseRows(ctx, ['delegated', 'reported', 'closed'], t.since, t.anchorId);
        if (rows.length > 0) return rows;
        if (Date.now() >= deadline) return [];
        await sleep(ctx.options.pollMs);
      }
    })();
    const closed = await waitDelegationPhase(ctx, 'reported', t.since, t.anchorId, ctx.options.reportWaitMs)
      ?? await waitDelegationPhase(ctx, 'closed', t.since, t.anchorId, 10_000);
    const delegatedRow = progressed.find((e) => phaseOf(e) === 'delegated');
    if (delegatedRow?.taskId) ctx.shared['w2.lastDelegatedTaskId'] = delegatedRow.taskId;
    const subId = delegatedRow ? bodyString(delegatedRow, 'toAgentId') ?? delegatedRow.agentId : undefined;
    if (subId) ctx.shared['w2.lastSubAgentId'] = subId;
    const receiptOk = !!closed;
    const notes = [
      ...(t.anchorNote ? [t.anchorNote] : []),
      receiptOk ? `真回执链走通（${closed ? phaseOf(closed) : ''}）` : `${ctx.options.reportWaitMs}ms 内未见真回执 → 转为时序观察项，由 HC-19 半合成补链`,
    ];
    return {
      assertions: [
        assertThat('hc16-http', 'HTTP 200', t.res.ok, '200', `${t.res.status}`),
        assertThat('hc16-progress', '链路推进（delegated/reported/closed 任一）', progressed.length > 0,
          '≥1 行', `${progressed.length} 行`, progressed.slice(0, 3).map((e) => entryEvidence(e, ['phase', 'toAgentId', 'status'], 80))),
        assertThat('hc16-receipt', '真回执到 reported/closed（超时转半合成观察项）', true,
          'reported/closed 或（超时→半合成）', receiptOk ? '真回执' : '超时→半合成',
          closed ? [entryEvidence(closed, ['phase', 'status'], 80)] : []),
      ],
      notes,
      observed: observedSummary(delegationRows(ctx, t.since, t.anchorId)),
    };
  },
};

// ─── HC-17 / HC-18 查询类 ───

const hc17: ProbeDef = {
  id: 'HC-17', wave: 2, title: '查进度「小陈手上那件事进行到哪一步了？」', dim: '派活·进度查询', effect: 'none',
  utterance: '小陈手上那件事进行到哪一步了？',
  steps: ['发送进度查询', '等回复', '确认无派活；回复留人工抽验'],
  assertionDocs: ['HTTP 200', '有 dialog out 回复', 'dispatched=0'],
  prereqIds: ['serverReachable', 'companionAvailable'],
  run: async (ctx) => {
    const r = await turnOrSkip(ctx, '小陈手上那件事进行到哪一步了？');
    if ('skip' in r) return r.skip;
    const t = r.t;
    await sleep(SETTLE_MS);
    const dispatched = dispatchedRows(ctx, t.since, t.anchorId);
    return {
      assertions: [
        assertThat('hc17-http', 'HTTP 200', t.res.ok, '200', `${t.res.status}`),
        assertThat('hc17-reply', '有 dialog out 回复', !!t.out, 'out 行存在', t.out ? `id=${t.out.id}` : '无'),
        assertThat('hc17-nodispatch', '查询不派活（dispatched=0）', dispatched.length === 0, '0', String(dispatched.length)),
      ],
      notes: [`回复样本：${truncate(bodyString(t.out, 'text'), 160) || '（无）'}`, ...(t.anchorNote ? [t.anchorNote] : [])],
      observed: [],
    };
  },
};

const hc18: ProbeDef = {
  id: 'HC-18', wave: 2, title: '委派史「刚才派出去的那个，是谁在办来着？」', dim: '派活·委派史', effect: 'none',
  utterance: '刚才派出去的那个，是谁在办来着？',
  steps: ['发送委派史追问', '等回复', '确认无派活；代理人名留人工抽验'],
  assertionDocs: ['HTTP 200', '有 dialog out 回复', 'dispatched=0'],
  prereqIds: ['serverReachable', 'companionAvailable'],
  run: async (ctx) => {
    const r = await turnOrSkip(ctx, '刚才派出去的那个，是谁在办来着？');
    if ('skip' in r) return r.skip;
    const t = r.t;
    await sleep(SETTLE_MS);
    const dispatched = dispatchedRows(ctx, t.since, t.anchorId);
    return {
      assertions: [
        assertThat('hc18-http', 'HTTP 200', t.res.ok, '200', `${t.res.status}`),
        assertThat('hc18-reply', '有 dialog out 回复', !!t.out, 'out 行存在', t.out ? `id=${t.out.id}` : '无'),
        assertThat('hc18-nodispatch', '追问不派活（dispatched=0）', dispatched.length === 0, '0', String(dispatched.length)),
      ],
      notes: [`回复样本（含代理人名与否人工抽验）：${truncate(bodyString(t.out, 'text'), 160) || '（无）'}`],
      observed: [],
    };
  },
};

// ─── HC-19 卡 + 病历（半合成完成） ───

const hc19: ProbeDef = {
  id: 'HC-19', wave: 2, title: '任务卡迁移 + 病历行（半合成 report-task）', dim: '派活·卡与病历', effect: 'delegation',
  utterance: '（对在办下属发真形状 report-task，半合成；不经秘书）',
  steps: ['找在办 delegated（≤30min 未闭环）', 'POST report-task（acceptance+outputLocation 真形状）', '等待 reported + 病历行'],
  assertionDocs: ['report-task HTTP 200', 'reported 行出现', '病历行（completion-recorded）或 closed 出现'],
  prereqIds: ['serverReachable', 'bossExists'],
  optional: true,
  run: async (ctx) => {
    const inFlight = findInFlightDelegation(ctx);
    if (!inFlight) {
      return { assertions: [], notes: [], skipReason: '无在办 delegated（≤30min 未闭环）——HC-16/HC-21 未产出在办任务' };
    }
    const subId = bodyString(inFlight, 'toAgentId') ?? inFlight.agentId ?? String(ctx.shared['w2.lastSubAgentId'] ?? '');
    if (!subId) return { assertions: [], notes: [], skipReason: 'delegated 行缺 toAgentId（无法发 report-task）' };
    const taskId = inFlight.taskId;
    const since = Date.now() - 5000;
    const res = await reportTask(ctx.transport, subId, '真人战役半合成回执（工具验证用，非真实验收）', 'completed', SIMULATED_COMPLETION);
    const reported = await waitDelegationPhase(ctx, 'reported', since, 0, ctx.options.reportWaitMs);
    ctx.shared['w2.lastCompletionAt'] = Date.now();
    const records = queryRows(ctx, { category: 'delegation', source: 'boss', since }, 0)
      .filter((e) => (phaseOf(e) ?? '').startsWith('completion') || (phaseOf(e) ?? '') === 'rating-recorded');
    const closed = await waitDelegationPhase(ctx, 'closed', since, 0, 30_000);
    return {
      assertions: [
        assertThat('hc19-report-http', 'report-task HTTP 200', res.ok, '200', `${res.status} ${res.error ?? ''}`),
        assertThat('hc19-reported', 'reported 行出现（回执链闭合）', (reported?.length ?? 0) > 0,
          '≥1 reported', String(reported?.length ?? 0),
          (reported ?? []).slice(0, 2).map((e) => entryEvidence(e, ['phase', 'status', 'toAgentId'], 80))),
        assertThat('hc19-record', '病历行（completion-recorded）或 closed 出现', records.length > 0 || (closed?.length ?? 0) > 0,
          'completion-recorded 或 closed', `records=${records.length} closed=${closed?.length ?? 0}`,
          records.slice(0, 2).map((e) => entryEvidence(e, ['phase', 'decisionId', 'result'], 80))),
      ],
      notes: [`目标下属=${subId} taskId=${taskId ?? '（行无 taskId）'}`],
      observed: observedSummary(delegationRows(ctx, since, 0)),
    };
  },
};

// ─── HC-20 评价 ───

const hc20: ProbeDef = {
  id: 'HC-20', wave: 2, title: '评价「这单干得不错，给个好评」', dim: '派活·评价审计', effect: 'delegation',
  utterance: '这单干得不错，给个好评',
  steps: ['发送好评', '等回复', '确认无派活；扫描 rating-recorded 病历行'],
  assertionDocs: ['HTTP 200', '有 dialog out 回复', 'dispatched=0', '（观察）rating-recorded 行'],
  prereqIds: ['serverReachable', 'companionAvailable'],
  run: async (ctx) => {
    const r = await turnOrSkip(ctx, '这单干得不错，给个好评');
    if ('skip' in r) return r.skip;
    const t = r.t;
    await sleep(SETTLE_MS);
    const dispatched = dispatchedRows(ctx, t.since, t.anchorId);
    const ratings = queryRows(ctx, { category: 'delegation', source: 'boss', since: t.since }, t.anchorId)
      .filter((e) => phaseOf(e) === 'rating-recorded');
    return {
      assertions: [
        assertThat('hc20-http', 'HTTP 200', t.res.ok, '200', `${t.res.status}`),
        assertThat('hc20-reply', '有 dialog out 回复', !!t.out, 'out 行存在', t.out ? `id=${t.out.id}` : '无'),
        assertThat('hc20-nodispatch', '评价不派活（dispatched=0）', dispatched.length === 0, '0', String(dispatched.length)),
      ],
      notes: [
        ratings.length > 0
          ? `rating-recorded 病历行：${ratings.length} 条（${truncate(JSON.stringify(ratings[0].body ?? {}), 140)}）`
          : '未观测到 rating-recorded 行——评价是否落审计（含"给个好评"是否需要指认具体任务）为观察项，人工复核回复文本',
        `回复样本：${truncate(bodyString(t.out, 'text'), 160) || '（无）'}`,
      ],
      observed: observedSummary(ratings),
    };
  },
};

// ─── HC-21 撤回 ───

// 撤回话术：与金丝雀撤回链默认 --cancel-text 对齐（scenarios.ts:867「别做了，取消刚才的任务」）。
// 勿用 CANCEL_TASK_TEXT——那是金丝雀撤回链的被撤【任务派活文本】（scenarios.ts:833，sleep 240 任务），
// 不是撤回话术；C2 首跑误把它当撤回话术发送 → 撤回回合反而又派新任务（2026-10-05 修正，该样本作废）。
const CANCEL_UTTERANCE = '别做了，取消刚才的任务';

const hc21: ProbeDef = {
  id: 'HC-21', wave: 2, title: '撤回「别做了，取消刚才的任务」（T2 在办）', dim: '派活·撤回', effect: 'delegation',
  utterance: CANCEL_UTTERANCE,
  steps: ['T2 派发并在办', '发送撤回话术', '等待 phase=cancelled 并核验结论/通知'],
  assertionDocs: ['HTTP 200', 'cancelled 行出现', '结论 status=cancelled-*；notified=true（queued 除外）'],
  prereqIds: ['serverReachable', 'companionAvailable', 'bossExists', 'teamIdle'],
  run: async (ctx) => {
    const r1 = await turnOrSkip(ctx, taskT2('HC-21'));
    if ('skip' in r1) return r1.skip;
    const t1 = r1.t;
    await waitDispatched(ctx, t1.since, t1.anchorId, ctx.options.bossWaitMs);
    await sleep(3000); // 给 Boss 拆解留时间
    const r2 = await turnOrSkip(ctx, CANCEL_UTTERANCE);
    if ('skip' in r2) return r2.skip;
    const t2 = r2.t;
    const cancelled = await waitDelegationPhase(ctx, 'cancelled', t2.since, t2.anchorId, ctx.options.bossWaitMs);
    const rows = cancelled ?? phaseRows(ctx, ['cancelled'], t2.since, t2.anchorId);
    const verdict = assertCancelEvidence(rows);
    return {
      assertions: [
        assertThat('hc21-http', 'HTTP 200（撤回回合）', t2.res.ok, '200', `${t2.res.status}`),
        assertThat('hc21-cancelled', 'cancelled 行出现', rows.length > 0, '≥1', String(rows.length),
          rows.slice(0, 3).map((e) => entryEvidence(e, ['phase', 'status', 'message', 'notified'], 100))),
        assertThat('hc21-verdict', '撤回结论/通知核验（assertCancelEvidence）', verdict.ok, 'cancelled-* 且 notified=true（queued 除外）',
          verdict.actual, verdict.evidence),
      ],
      notes: [...(t2.anchorNote ? [t2.anchorNote] : [])],
      observed: observedSummary(delegationRows(ctx, t2.since, t2.anchorId)),
    };
  },
};

// ─── HC-22 红队③：撤回后立即重派同名任务 ───

const HC22_TEXT = '刚才那个不做了……不对，还是重来一版，活一样';

const hc22: ProbeDef = {
  id: 'HC-22', wave: 2, title: '红队③·撤回后立即重派「还是重来一版，活一样」', dim: '红队·撤回×重派', effect: 'delegation',
  utterance: HC22_TEXT,
  steps: ['T2 派发（旧任务）', '发送撤回+重派混合话术', '核验旧 taskId 已 cancelled、新 taskId 恰 1 派发且不重叠'],
  assertionDocs: ['HTTP 200', '旧任务 cancelled', '新 dispatched 恰 1 且 taskId≠旧', '新任务未被同回合撤回'],
  prereqIds: ['serverReachable', 'companionAvailable', 'bossExists', 'teamIdle'],
  run: async (ctx) => {
    const r1 = await turnOrSkip(ctx, taskT2('HC-22旧'));
    if ('skip' in r1) return r1.skip;
    const t1 = r1.t;
    const d1 = await waitDispatched(ctx, t1.since, t1.anchorId, ctx.options.bossWaitMs);
    const oldTaskId = d1?.find((e) => e.taskId)?.taskId;
    await sleep(3000);
    const r2 = await turnOrSkip(ctx, CANCEL_UTTERANCE);
    if ('skip' in r2) return r2.skip;
    const t2 = r2.t;
    const cancelRows = await waitDelegationPhase(ctx, 'cancelled', t2.since, t2.anchorId, ctx.options.bossWaitMs)
      ?? phaseRows(ctx, ['cancelled'], t2.since, t2.anchorId);
    const r3 = await turnOrSkip(ctx, HC22_TEXT);
    if ('skip' in r3) return r3.skip;
    const t3 = r3.t;
    const d3 = await waitDispatched(ctx, t3.since, t3.anchorId, ctx.options.bossWaitMs) ?? dispatchedRows(ctx, t3.since, t3.anchorId);
    await sleep(SETTLE_MS);
    const d3Final = dispatchedRows(ctx, t3.since, t3.anchorId);
    const c3 = phaseRows(ctx, ['cancelled'], t3.since, t3.anchorId);
    const newTaskIds = new Set(d3Final.map((e) => e.taskId).filter(Boolean));
    const selfCancel = c3.filter((e) => e.taskId && newTaskIds.has(e.taskId));
    const oldCancelled = cancelRows.length > 0
      && (oldTaskId === undefined || cancelRows.some((e) => !e.taskId || e.taskId === oldTaskId));
    return {
      assertions: [
        assertThat('hc22-http', 'HTTP 200（重派回合）', t3.res.ok, '200', `${t3.res.status}`),
        assertThat('hc22-old-cancelled', '旧任务已 cancelled（前置撤回成功）', oldCancelled,
          `cancelled 命中旧 taskId=${oldTaskId ?? '?'}`, `cancelled=${cancelRows.length} 行`, cancelRows.slice(0, 2).map((e) => entryEvidence(e, ['phase', 'status', 'message'], 80))),
        assertThat('hc22-new-dispatch-1', '新 dispatched 恰 1 条', d3Final.length === 1, '1', String(d3Final.length),
          d3Final.slice(0, 2).map((e) => entryEvidence(e, ['phase', 'toAgentId', 'message'], 100))),
        assertThat('hc22-distinct', '新 taskId ≠ 旧 taskId（无残留复用）',
          oldTaskId === undefined || !newTaskIds.has(oldTaskId), `≠${oldTaskId ?? '?'}`, [...newTaskIds].join(',') || '（无）'),
        assertThat('hc22-no-self-cancel', '新任务未被同回合撤回', selfCancel.length === 0, '0', String(selfCancel.length),
          selfCancel.map((e) => entryEvidence(e, ['phase', 'status'], 80))),
      ],
      notes: [
        `旧 taskId=${oldTaskId ?? '—'}；新 taskId=${[...newTaskIds].join(',') || '—'}`,
        `重派窗口 dispatched=${d3?.length ?? 0}（等待命中）/ ${d3Final.length}（静置后终值）`,
      ],
      observed: observedSummary(delegationRows(ctx, t3.since, t3.anchorId)),
    };
  },
};

// ─── HC-23 回执播报（WS 观测器 + DB receipt 行） ───

const hc23: ProbeDef = {
  id: 'HC-23', wave: 2, title: '回执播报：receipt 行 + WS task_receipt 前缀', dim: '派活·回执播报', effect: 'none',
  utterance: '（消费 HC-19 的完成事件，无新回合）',
  steps: ['取 HC-19 完成时刻', '扫 DB receipt 行（matched/forwarded）', '扫 WS task_receipt（text 前缀【…】）'],
  assertionDocs: ['receipt 行 matched=true', 'WS task_receipt 广播（forwarded 时必须有）', '文本前缀【…】（14·B 唯一证据面）'],
  prereqIds: ['serverReachable'],
  optional: true,
  run: async (ctx) => {
    const since = (ctx.shared['w2.lastCompletionAt'] as number | undefined);
    if (!since) return { assertions: [], notes: [], skipReason: '本波无完成事件（HC-19 未跑/未闭环）' };
    const scanSince = since - 5000;
    const rows = queryRows(ctx, { category: 'delegation', since: scanSince }, 0).filter((e) => phaseOf(e) === 'receipt');
    const matched = rows.filter((e) => e.body?.matched === true);
    const forwardedRows = rows.filter((e) => e.body?.forwarded === true);
    const wsMsgs = ctx.ws.receivedSince(scanSince).filter((m) => m.type === 'task_receipt');
    const prefixed = wsMsgs.filter((m) => {
      const text = (m.payload as { text?: unknown } | undefined)?.text;
      return typeof text === 'string' && text.includes('【');
    });
    const anyForwarded = forwardedRows.length > 0;
    const assertions = [
      assertThat('hc23-receipt-row', 'receipt 行出现且 matched=true', matched.length > 0,
        '≥1 matched', `rows=${rows.length} matched=${matched.length}`,
        matched.slice(0, 3).map((e) => entryEvidence(e, ['phase', 'matched', 'forwarded', 'tier', 'reason'], 80))),
      assertThat('hc23-ws-broadcast', 'WS task_receipt 广播命中', wsMsgs.length > 0,
        anyForwarded ? '≥1（有 forwarded=true）' : '≥1 或全部 forwarded=false（SILENT 语义）',
        `ws=${wsMsgs.length}`),
      assertThat('hc23-prefix', '播报文本含【项目别名】前缀（14·B）', prefixed.length > 0,
        '≥1 含【', `prefixed=${prefixed.length}`,
        prefixed.slice(0, 2).map((m) => ({ fields: { text: truncate(String((m.payload as { text?: unknown }).text ?? ''), 80) } }))),
    ];
    if (!anyForwarded) {
      assertions[1] = assertThat('hc23-ws-broadcast', 'WS task_receipt 广播命中（本波全部 forwarded=false 时按闸门语义豁免）',
        true, 'forwarded=false → 不广播（闸门语义）', `forwardedRows=0 ws=${wsMsgs.length}`);
    }
    return { assertions, notes: [`观察面：DB receipt 行 ${rows.length} 条；WS task_receipt ${wsMsgs.length} 条（前缀命中 ${prefixed.length}）`], observed: observedSummary(rows) };
  },
};

// ─── HC-24 回执超时（机制级登记） ───

const hc24: ProbeDef = {
  id: 'HC-24', wave: 2, title: '回执超时监控（机制级登记 + 长驻腿可选）', dim: '派活·回执超时', effect: 'none',
  utterance: '（无新回合；观察 24h 窗口内的回执超时监控痕迹）',
  steps: ['扫描近 24h 是否有 receipt/超时监控行', '无 → 如实 SKIP（长驻腿未开启，登记欠账）'],
  assertionDocs: ['（观察）receipt_timeout 类行 或 如实 SKIP'],
  prereqIds: ['serverReachable'],
  optional: true,
  run: async (ctx) => {
    const since = Date.now() - 24 * 3600_000;
    const rows = queryRows(ctx, { category: 'delegation', since }, 0)
      .filter((e) => JSON.stringify(e.body ?? {}).includes('timeout') || JSON.stringify(e.body ?? {}).includes('超时'));
    const broadcasts = queryRows(ctx, { category: 'broadcast', since }, 0)
      .filter((e) => JSON.stringify(e.body ?? {}).includes('timeout') || JSON.stringify(e.body ?? {}).includes('超时'));
    if (rows.length === 0 && broadcasts.length === 0) {
      return {
        assertions: [],
        notes: ['欠账登记：回执超时监控的真链路（30min 长驻腿）未跑——计划口径：机制级登记，除非显式开启长驻观察。'],
        skipReason: '近 24h 无回执超时监控痕迹（长驻腿未开启）',
      };
    }
    return {
      assertions: [assertThat('hc24-timeout-evidence', '收到超时监控痕迹', true, '≥1', `rows=${rows.length} broadcasts=${broadcasts.length}`)],
      notes: [],
      observed: observedSummary([...rows, ...broadcasts]),
    };
  },
};

export const W2_PROBES: ProbeDef[] = [hc15, hc16, hc17, hc18, hc19, hc20, hc21, hc22, hc23, hc24];
