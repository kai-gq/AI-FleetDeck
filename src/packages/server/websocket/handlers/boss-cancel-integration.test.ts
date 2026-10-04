/**
 * 任务16·⑬ 撤回执行链 · handler 级整合测试（L2 口径：进程内真实函数链路，非真 LLM E2E）
 *
 * 场景：parseBossDelegation 真实派活（任务卡/回执/配额落账）→ cancelDelegation
 * 六态覆盖：running 撤回（通知投递 + 卡迁移 + 追踪/回执清理）、done 拒撤、
 * 重复撤回幂等、queued 撤回（不下发不派发）、running 释放带出队派发、
 * 通知失败 stopAgent 兜底、重启残留 tracking 模式。
 *
 * 真实参与：parseBossDelegation → 配额闸门（delegation-quota-gate 单例）→
 * bossService 落史/落卡（XDG 沙箱 delegation-history.json）→ completeDelegation
 * → cancelDelegation（本任务执行面）→ ⑬ logDelegation 审计 + 🟡⑫ quota-cancelled
 * （system_log 真盘可查）。
 * 仅 mock：agentService/runtimeService（桩 sendCommand/stopAgent）、command-handler、
 * vcs 的 logProactiveBroadcast。
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const h = vi.hoisted(() => ({
  agents: [] as Array<{ id: string; name: string; class?: string; isBoss?: boolean; status: string }>,
  sendCommand: vi.fn(async (..._args: unknown[]) => {}),
  stopAgent: vi.fn(async (_agentId: string) => {}),
}));

vi.mock('../../services/index.js', async () => {
  const realBoss = await vi.importActual<typeof import('../../services/boss-service.js')>('../../services/boss-service.js');
  return {
    agentService: {
      getAgent: (id: string) => h.agents.find((a) => a.id === id),
      getAllAgents: () => h.agents,
    },
    runtimeService: { sendCommand: h.sendCommand, stopAgent: h.stopAgent },
    bossService: realBoss,
    workPlanService: {},
    skillService: {},
  };
});

vi.mock('./command-handler.js', () => ({
  getLastBossCommand: vi.fn(() => ''),
  buildCustomAgentConfig: vi.fn((id: string, cls?: string) => ({ __custom: id, cls })),
}));

vi.mock('../../services/voice-companion-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/voice-companion-service.js')>();
  return { ...actual, logProactiveBroadcast: vi.fn() };
});

import {
  activeDelegations,
  cancelDelegation,
  clearDelegation,
  completeDelegation,
  getBossForSubordinate,
  parseBossDelegation,
  resetBossDelegationStateForTests,
} from './boss-response-handler.js';
import { listPendingReceipts } from './pending-receipt-registry.js';
import * as bossService from '../../services/boss-service.js';
import { closeEventDb, initEventDb } from '../../data/event-db.js';
import { querySystemLog } from '../../data/system-log.js';
import type { DelegationDecision } from '../../../shared/types.js';
import {
  DELEGATION_QUOTA_BUDGET_ENV,
  DELEGATION_QUOTA_ENABLED_ENV,
  getDelegationQuotaSnapshot,
} from '../../services/delegation-quota-gate.js';

const dataDir = path.join(process.env.XDG_DATA_HOME!, 'tide-commander');
const historyFile = path.join(dataDir, 'delegation-history.json');

const broadcastMock = vi.fn();

/** 读回沙箱委派史里指定 taskCommand 的记录（真实落盘）。 */
function readDecision(taskCommand: string): DelegationDecision {
  const raw = JSON.parse(fs.readFileSync(historyFile, 'utf8')) as { histories: Record<string, DelegationDecision[]> };
  const found = Object.values(raw.histories).flat().find((d) => d.userCommand === taskCommand);
  if (!found) throw new Error(`decision not found in delegation-history.json: ${taskCommand}`);
  return found;
}

function delegationRows(): Array<Record<string, unknown>> {
  return querySystemLog({ category: 'delegation', limit: 500, order: 'asc' })
    .map((row) => (row.body ? (JSON.parse(row.body) as Record<string, unknown>) : {}));
}

/** 🔴⑦ 任务卡迁移埋点行（delegation 通道 task-card-status）。 */
function taskCardStatusRows(decisionId: string): Array<Record<string, unknown>> {
  return delegationRows().filter((body) => body.phase === 'task-card-status' && body.decisionId === decisionId);
}

/** 🟡⑫ 配额审计行（quota-queued / quota-dequeued / quota-cancelled，按 decisionId 过滤）。 */
function quotaRows(phase: string, decisionId: string): Array<Record<string, unknown>> {
  return delegationRows().filter((body) => body.phase === phase && body.decisionId === decisionId);
}

/** ⑬ 撤回审计行（phase='cancelled'；taskId 是 system_log 列，不在 body）。 */
function cancelAuditRows(taskId: string | undefined): Array<Record<string, unknown>> {
  if (!taskId) throw new Error('cancelAuditRows 需要 taskId（审计行按列过滤，undefined 会误配 null 行）');
  return querySystemLog({ category: 'delegation', limit: 500, order: 'asc' })
    .filter((row) => row.taskId === taskId)
    .map((row) => (row.body ? (JSON.parse(row.body) as Record<string, unknown>) : {}))
    .filter((body) => body.phase === 'cancelled');
}

/** 生成 N 条并发委派块（不同下属 + 不同命令，避免去重窗口）。 */
function delegationBlock(prefix: string, agentIds: string[]): string {
  const items = agentIds.map((id, i) => ({
    selectedAgentId: id,
    selectedAgentName: `下属${prefix}${i + 1}`,
    taskCommand: `${prefix}任务 ${i + 1}`,
    reasoning: '撤回整合测试',
    confidence: 'high',
    taskCard: { objective: `${prefix}任务 ${i + 1}`, acceptanceCriteria: [`验收 ${i + 1}`], projectId: 'proj-cancel' },
  }));
  return `拆解如下。\n\n\`\`\`delegation\n${JSON.stringify(items)}\n\`\`\``;
}

/** 派发是 sendCommand.then 异步落 running —— 多轮宏/微任务排干（同款既有整合测试用 tick）。 */
async function flush(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function seedAgents(ids: string[]): void {
  h.agents.length = 0;
  h.agents.push({ id: 'boss-1', name: '主管', class: 'boss', isBoss: true, status: 'idle' });
  ids.forEach((id, i) => h.agents.push({ id, name: `小${i + 1}`, class: 'builder', status: 'working' }));
}

describe('任务16·⑬ 撤回执行链 handler 级整合（L2）', () => {
  beforeAll(() => {
    initEventDb();
  });

  afterAll(() => {
    closeEventDb();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv(DELEGATION_QUOTA_ENABLED_ENV, '1');
    vi.stubEnv(DELEGATION_QUOTA_BUDGET_ENV, '3');
    h.sendCommand.mockReset();
    h.sendCommand.mockImplementation(async () => {});
    h.stopAgent.mockReset();
    h.stopAgent.mockImplementation(async () => {});
    // 沙箱委派史逐测清零：避免上一测试的 queued 卡被闸门启动重建吸回队列
    fs.rmSync(historyFile, { force: true });
    fs.rmSync(`${historyFile}.bak`, { force: true });
    bossService.init();
    resetBossDelegationStateForTests();
    seedAgents(['agent-c1', 'agent-c2']);
  });

  it('running 撤回：通知 forceInterrupt + 卡迁移 + 追踪/回执清理 + 双路审计；重复撤回幂等不重复通知', async () => {
    parseBossDelegation('boss-1', '主管', delegationBlock('撤回', ['agent-c1']), broadcastMock);
    await flush();
    const d = readDecision('撤回任务 1');
    expect(readDecision('撤回任务 1').taskCard?.status).toBe('running');
    expect(getBossForSubordinate('agent-c1')?.decisionId).toBe(d.id);
    expect(listPendingReceipts().some((r) => r.targetAgentId === 'agent-c1')).toBe(true);

    const outcome = await cancelDelegation({
      subordinateId: 'agent-c1',
      bossId: 'boss-1',
      decisionId: d.id,
      initiator: 'user',
      reason: '不想做了',
    });

    expect(outcome.status).toBe('cancelled');
    expect(outcome.cancelledFrom).toBe('running');
    expect(outcome.notified).toBe(true);
    expect(typeof outcome.notifyMs).toBe('number');
    expect(outcome.notifyMs as number).toBeGreaterThanOrEqual(0);
    expect(outcome.cardMigrated).toBe(true);
    expect(outcome.subordinateName).toBe('小1');
    expect(outcome.label).toBe('撤回任务 1');
    expect(outcome.dequeuedDecisionId).toBeUndefined();

    // 通知投递：第 2 次 sendCommand 指向同一下属，带停止文案 + forceInterrupt；派发那次不带强制打断
    expect(h.sendCommand).toHaveBeenCalledTimes(2);
    expect(h.sendCommand.mock.calls[0][0]).toBe('agent-c1');
    expect(h.sendCommand.mock.calls[0][5]).toBeUndefined();
    expect(h.sendCommand.mock.calls[1][0]).toBe('agent-c1');
    const notice = h.sendCommand.mock.calls[1][1] as string;
    expect(notice).toContain('[TASK CANCELLED by boss "主管"]');
    expect(notice).toContain('不想做了');
    expect(notice).toContain('撤回任务 1');
    expect(notice).toContain('"status":"failed"'); // A3 对齐：停止回执免验收/产出字段
    expect(h.sendCommand.mock.calls[1][5]).toEqual({ forceInterrupt: true });

    // 追踪清理 + 旧回执移除 + 卡迁移 cancelled
    expect(getBossForSubordinate('agent-c1')).toBeUndefined();
    expect(activeDelegations.has('agent-c1')).toBe(false);
    expect(listPendingReceipts().some((r) => r.targetAgentId === 'agent-c1')).toBe(false);
    expect(readDecision('撤回任务 1').taskCard?.status).toBe('cancelled');

    // 🔴⑦ 迁移流与原因；配额释放（running → 无排队则槽位清空）
    const cardRows = taskCardStatusRows(d.id);
    expect(cardRows.map((b) => `${b.from}->${b.to}`)).toEqual(['none->pending', 'pending->running', 'running->cancelled']);
    expect(cardRows[2].reason).toBe('不想做了');
    expect(getDelegationQuotaSnapshot().activeIds).toEqual([]);

    // ⑬ 审计：谁发/原因/目标/投递
    const audit = cancelAuditRows(outcome.taskId!);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      phase: 'cancelled',
      status: 'cancelled-running',
      initiator: 'user',
      reason: '不想做了',
      notified: true,
      fromAgentId: 'boss-1',
      toAgentId: 'agent-c1',
      toAgentName: '小1',
      message: '撤回任务 1',
    });
    expect(typeof audit[0].notifyMs).toBe('number');
    // 🟡⑫ 配额撤回审计（cancelledFrom=running）
    const quotaCancel = quotaRows('quota-cancelled', d.id);
    expect(quotaCancel).toHaveLength(1);
    expect(quotaCancel[0]).toMatchObject({ cancelledFrom: 'running', initiator: 'user', reason: '不想做了' });

    // 重复撤回：幂等（卡已 cancelled 守卫）→ 不重复通知、不重复迁移
    const again = await cancelDelegation({ subordinateId: 'agent-c1', bossId: 'boss-1', decisionId: d.id, taskId: outcome.taskId, initiator: 'user' });
    expect(again.status).toBe('already-cancelled');
    expect(again.notified).toBe(false);
    expect(again.cardMigrated).toBe(false);
    expect(h.sendCommand).toHaveBeenCalledTimes(2);
    expect(taskCardStatusRows(d.id).filter((b) => b.to === 'cancelled')).toHaveLength(1);
    expect(cancelAuditRows(outcome.taskId!)).toHaveLength(2); // 第二次为 already-cancelled 审计
    expect(cancelAuditRows(outcome.taskId!)[1].status).toBe('already-cancelled');
  });

  it('done 拒撤：guard 先行零副作用（卡保持 done、无通知、无二次迁移），审计记 rejected-done', async () => {
    parseBossDelegation('boss-1', '主管', delegationBlock('完工', ['agent-c1']), broadcastMock);
    await flush();
    const d = readDecision('完工任务 1');
    const taskId = getDelegationQuotaSnapshot().activeIds[0];
    completeDelegation('agent-c1', { success: true, reason: 'report-task' });
    expect(readDecision('完工任务 1').taskCard?.status).toBe('done');

    const outcome = await cancelDelegation({ subordinateId: 'agent-c1', bossId: 'boss-1', decisionId: d.id, taskId, initiator: 'user' });

    expect(outcome.status).toBe('rejected-done');
    expect(outcome.notified).toBe(false);
    expect(outcome.cardMigrated).toBe(false);
    expect(h.sendCommand).toHaveBeenCalledTimes(1); // 只有最初派发，无撤回通知
    expect(readDecision('完工任务 1').taskCard?.status).toBe('done');
    expect(taskCardStatusRows(d.id).map((b) => b.to)).toEqual(['pending', 'running', 'done']); // 无 cancelled 边
    const audit = cancelAuditRows(outcome.taskId!);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ status: 'rejected-done', notified: false, initiator: 'user' });
  });

  it('queued 撤回：移除队列不派发；随后完成在跑项不得把它复活（sendCommand 不再增加）', async () => {
    vi.stubEnv(DELEGATION_QUOTA_BUDGET_ENV, '1');
    parseBossDelegation('boss-1', '主管', delegationBlock('排队', ['agent-c1', 'agent-c2']), broadcastMock);
    await flush();
    const c1 = readDecision('排队任务 1');
    const c2 = readDecision('排队任务 2');
    expect(c1.taskCard?.status).toBe('running');
    expect(c2.taskCard?.status).toBe('queued');
    expect(getDelegationQuotaSnapshot().queuedIds).toHaveLength(1);

    const outcome = await cancelDelegation({ subordinateId: 'agent-c2', bossId: 'boss-1', decisionId: c2.id, initiator: 'user', reason: '不要了' });

    expect(outcome.status).toBe('cancelled');
    expect(outcome.cancelledFrom).toBe('queued');
    expect(outcome.notified).toBe(false); // 未派发 → 无需通知（也不硬造投递）
    expect(outcome.cardMigrated).toBe(true);
    expect(h.sendCommand).toHaveBeenCalledTimes(1); // 仅最初派发 c1；撤回 queued 不派发不通知
    expect(readDecision('排队任务 2').taskCard?.status).toBe('cancelled');
    expect(getDelegationQuotaSnapshot().queuedIds).toEqual([]);
    expect(taskCardStatusRows(c2.id).map((b) => `${b.from}->${b.to}`)).toEqual(['none->pending', 'pending->queued', 'queued->cancelled']);
    const audit = cancelAuditRows(outcome.taskId!);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ status: 'cancelled-queued', notified: false });
    expect(quotaRows('quota-cancelled', c2.id)).toHaveLength(1);

    // 完成 c1 → 队列无 c2，不得出队复活
    completeDelegation('agent-c1', { success: true, reason: 'report-task' });
    await flush();
    expect(h.sendCommand).toHaveBeenCalledTimes(1);
    expect(readDecision('排队任务 2').taskCard?.status).toBe('cancelled');
  });

  it('running 撤回带出队：通知先于派发（同一漏斗），队首补派发且回执重登记', async () => {
    vi.stubEnv(DELEGATION_QUOTA_BUDGET_ENV, '1');
    parseBossDelegation('boss-1', '主管', delegationBlock('接力', ['agent-c1', 'agent-c2']), broadcastMock);
    await flush();
    const c1 = readDecision('接力任务 1');
    const c2 = readDecision('接力任务 2');
    expect(c2.taskCard?.status).toBe('queued');

    const outcome = await cancelDelegation({ subordinateId: 'agent-c1', bossId: 'boss-1', decisionId: c1.id, initiator: 'user' });
    expect(outcome.status).toBe('cancelled');
    expect(outcome.cancelledFrom).toBe('running');
    expect(outcome.dequeuedDecisionId).toBe(c2.id);
    expect(h.sendCommand).toHaveBeenCalledTimes(3);
    expect(h.sendCommand.mock.calls[1][0]).toBe('agent-c1'); // 先通知被撤者停手
    expect(h.sendCommand.mock.calls[1][1] as string).toContain('[TASK CANCELLED');
    expect(h.sendCommand.mock.calls[2][0]).toBe('agent-c2'); // 再派发队首
    const dispatched = h.sendCommand.mock.calls[2][1] as string;
    expect(dispatched).toContain('[DELEGATED TASK');
    // A3 新契约：锚定内联 curl 示例的固定 JSON 片段（仅回退示例段也会变红；
    // 不接受 prose 里带引号的字段名顶替）
    expect(dispatched).toContain(
      `-d '{"summary":"Brief result summary","status":"completed","outputLocation":"path or link to the deliverable","acceptance":[{"item":"acceptance criterion from the task card","done":true}]}'`
    );
    expect(dispatched).toContain('otherwise it is rejected with HTTP 400');
    expect(h.sendCommand.mock.calls[2][5]).toBeUndefined(); // 派发不强制打断

    await flush();
    expect(readDecision('接力任务 2').taskCard?.status).toBe('running');
    expect(getBossForSubordinate('agent-c2')?.decisionId).toBe(c2.id);
    expect(listPendingReceipts().some((r) => r.targetAgentId === 'agent-c2')).toBe(true);
    expect(listPendingReceipts().some((r) => r.targetAgentId === 'agent-c1')).toBe(false);
    // 配额账本：c2 占位（dequeued → active），队列空
    const snap = getDelegationQuotaSnapshot();
    expect(snap.queuedIds).toEqual([]);
    expect(snap.activeIds).toHaveLength(1);
  });

  it('通知失败降级：stopAgent 兜底成功 + 审计如实登记（不上抛）', async () => {
    parseBossDelegation('boss-1', '主管', delegationBlock('失败', ['agent-c1']), broadcastMock);
    await flush();
    const d = readDecision('失败任务 1');
    h.sendCommand.mockRejectedValueOnce(new Error('spawn ENOENT'));

    const outcome = await cancelDelegation({ subordinateId: 'agent-c1', bossId: 'boss-1', decisionId: d.id, initiator: 'user' });

    expect(outcome.status).toBe('cancelled');
    expect(outcome.notified).toBe(false);
    expect(outcome.notifyError).toContain('ENOENT');
    expect(outcome.stopFallbackUsed).toBe(true);
    expect(typeof outcome.notifyMs).toBe('number');
    expect(h.stopAgent).toHaveBeenCalledTimes(1);
    expect(h.stopAgent.mock.calls[0][0]).toBe('agent-c1');
    // 撤回主链路照常完成（卡迁移/追踪清理不因投递失败回滚）
    expect(readDecision('失败任务 1').taskCard?.status).toBe('cancelled');
    expect(getBossForSubordinate('agent-c1')).toBeUndefined();
    const audit = cancelAuditRows(outcome.taskId!);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ status: 'cancelled-running', notified: false, error: expect.stringContaining('ENOENT') });
  });

  it('重启残留 tracking 模式：仅卡片在（追踪/配额已空）也能撤，走通知投递', async () => {
    parseBossDelegation('boss-1', '主管', delegationBlock('残留', ['agent-c1']), broadcastMock);
    await flush();
    const d = readDecision('残留任务 1');
    const quotaTaskId = getDelegationQuotaSnapshot().activeIds[0];
    clearDelegation('agent-c1'); // 模拟进程重启：追踪丢失、卡片仍在 running
    expect(getBossForSubordinate('agent-c1')).toBeUndefined();

    const outcome = await cancelDelegation({ subordinateId: 'agent-c1', bossId: 'boss-1', decisionId: d.id, taskId: quotaTaskId, initiator: 'user' });

    expect(outcome.status).toBe('cancelled');
    expect(outcome.cancelledFrom).toBe('tracking');
    expect(outcome.notified).toBe(true);
    expect(readDecision('残留任务 1').taskCard?.status).toBe('cancelled');
    expect(h.sendCommand).toHaveBeenCalledTimes(2); // 派发 + 撤回通知
    expect(h.sendCommand.mock.calls[1][1] as string).toContain('[TASK CANCELLED');
    const audit = cancelAuditRows(outcome.taskId!);
    expect(audit).toHaveLength(1);
    expect(audit[0].status).toBe('cancelled-tracking');
  });

  it('无目标：既无追踪/排队也无在办卡 → not-found（不猜不写，无通知）', async () => {
    seedAgents(['agent-c1']);
    const outcome = await cancelDelegation({ subordinateId: 'agent-c1', bossId: 'boss-1', decisionId: 'del-nope', initiator: 'user' });
    expect(outcome.status).toBe('not-found');
    expect(outcome.notified).toBe(false);
    expect(h.sendCommand).not.toHaveBeenCalled();
    expect(h.stopAgent).not.toHaveBeenCalled();
  });
});
