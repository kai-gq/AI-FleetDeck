/**
 * 任务15·B ⑥1 handler 级整合测试（L2 口径：进程内真实函数链路，非真 LLM E2E）
 *
 * 场景：5 个并发委派（预算 3）→ 3 准 2 排（任务卡 status=queued 真实落盘）
 * → 完成 1 个 → 自动出队 1 个（queued → running + sendCommand 被调）。
 * 另钉：同下属「删除先于派发」的时序边界、开关关闭时旧行为。
 *
 * 真实参与：parseBossDelegation → 配额闸门（delegation-quota-gate 单例，
 * 15·A 纯函数）→ bossService 落史/落卡（XDG 沙箱 delegation-history.json）
 * → completeDelegation（routes/agents.ts 与 runtime-listeners 共用的完成漏斗）
 * → 🟡⑫ logEvent 审计与 ⑩ logProactiveBroadcast 播报（system_log 真盘可查）。
 * 仅 mock：agentService/runtimeService（桩 sendCommand）、command-handler 取命令上下文。
 *
 * taskId 仅服务端进程内可达（任务 02 登记限制）；出队派发无 WS 广播上下文
 * （delegation_decision/agent_task_started 不发）——任务15·B 登记缺口。
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const h = vi.hoisted(() => {
  let resolveSend: (() => void) | null = null;
  return {
    sendCommand: vi.fn((_agentId: string, _message: string) => new Promise<void>((resolve) => { resolveSend = resolve; })),
    resolveSend: () => resolveSend?.(),
  };
});

vi.mock('../../services/index.js', async () => {
  const realBoss = await vi.importActual<typeof import('../../services/boss-service.js')>('../../services/boss-service.js');
  return {
    agentService: { getAgent: vi.fn(() => undefined) },
    runtimeService: { sendCommand: h.sendCommand },
    bossService: realBoss,
    workPlanService: {},
    skillService: {},
  };
});

vi.mock('./command-handler.js', () => ({
  getLastBossCommand: vi.fn(() => ''),
  buildCustomAgentConfig: vi.fn(() => undefined),
}));

vi.mock('../../services/voice-companion-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/voice-companion-service.js')>();
  return { ...actual, logProactiveBroadcast: vi.fn() };
});

import { completeDelegation, getBossForSubordinate, parseBossDelegation, resetBossDelegationStateForTests } from './boss-response-handler.js';
import { listPendingReceipts } from './pending-receipt-registry.js';
import * as bossService from '../../services/boss-service.js';
import { logProactiveBroadcast } from '../../services/voice-companion-service.js';
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
const broadcastMockRef = vi.mocked(logProactiveBroadcast);

/** 读回沙箱委派史里指定 taskCommand 的记录（真实落盘）。 */
function readDecision(taskCommand: string): DelegationDecision {
  const raw = JSON.parse(fs.readFileSync(historyFile, 'utf8')) as { histories: Record<string, DelegationDecision[]> };
  const found = Object.values(raw.histories).flat().find((d) => d.userCommand === taskCommand);
  if (!found) throw new Error(`decision not found in delegation-history.json: ${taskCommand}`);
  return found;
}

/** 🔴⑦ 任务卡迁移埋点行（delegation 通道 task-card-status）。 */
function taskCardStatusRows(decisionId: string): Array<Record<string, unknown>> {
  return querySystemLog({ category: 'delegation', limit: 500, order: 'asc' })
    .map((row) => (row.body ? (JSON.parse(row.body) as Record<string, unknown>) : {}))
    .filter((body) => body.phase === 'task-card-status' && body.decisionId === decisionId);
}

/** 🟡⑫ 配额审计行（delegation 通道 quota-queued / quota-dequeued）。 */
function quotaRows(phase: 'quota-queued' | 'quota-dequeued', decisionId: string): Array<Record<string, unknown>> {
  return querySystemLog({ category: 'delegation', limit: 500, order: 'asc' })
    .map((row) => (row.body ? (JSON.parse(row.body) as Record<string, unknown>) : {}))
    .filter((body) => body.phase === phase && body.decisionId === decisionId);
}

/** 生成 N 条并发委派块（不同下属 + 不同命令，避免去重窗口）。 */
function delegationBlock(prefix: string, agentIds: string[], projectId = 'proj-quota'): string {
  const items = agentIds.map((id, i) => ({
    selectedAgentId: id,
    selectedAgentName: `Builder ${prefix}${i + 1}`,
    taskCommand: `${prefix}任务 ${i + 1}`,
    reasoning: '并发配额集成测试',
    confidence: 'high',
    taskCard: { objective: `${prefix}任务 ${i + 1}`, acceptanceCriteria: [`验收 ${i + 1}`], projectId },
  }));
  return `拆解如下。\n\n\`\`\`delegation\n${JSON.stringify(items)}\n\`\`\``;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('任务15·B ⑥1：全局并发配额 handler 级整合（L2）', () => {
  beforeAll(() => {
    initEventDb();
  });

  afterAll(() => {
    closeEventDb();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv(DELEGATION_QUOTA_ENABLED_ENV, '1'); // 隔离本机环境变量：默认开
    vi.stubEnv(DELEGATION_QUOTA_BUDGET_ENV, '3');
    // 沙箱委派史逐测清零：避免上一测试的 queued 卡被闸门启动重建吸回队列
    fs.rmSync(historyFile, { force: true });
    fs.rmSync(`${historyFile}.bak`, { force: true });
    bossService.init();
    resetBossDelegationStateForTests();
  });

  it('5 并发 → 3 准 2 排（status=queued）→ 完成 1 个自动出队 1 个（running + sendCommand）', async () => {
    const agents = ['agent-q1', 'agent-q2', 'agent-q3', 'agent-q4', 'agent-q5'];
    parseBossDelegation('boss-1', 'Boss', delegationBlock('并发', agents), broadcastMock);

    // ── 准入侧：恰 3 个 sendCommand（前 3），2 个排队不派发 ──
    expect(h.sendCommand).toHaveBeenCalledTimes(3);
    expect(h.sendCommand.mock.calls.map((c) => c[0])).toEqual(['agent-q1', 'agent-q2', 'agent-q3']);

    // 任务卡落盘：前 3 pending（sendCommand 未 resolve），后 2 queued
    for (let i = 1; i <= 3; i += 1) {
      expect(readDecision(`并发任务 ${i}`).taskCard?.status).toBe('pending');
    }
    const queued4 = readDecision('并发任务 4');
    const queued5 = readDecision('并发任务 5');
    expect(queued4.taskCard?.status).toBe('queued');
    expect(queued5.taskCard?.status).toBe('queued');
    expect(typeof queued4.taskCard?.statusUpdatedAt).toBe('number');

    // 闸门账本：3 活跃 2 排队（载荷带 decisionId/taskCard）
    let snap = getDelegationQuotaSnapshot();
    expect(snap.activeIds).toHaveLength(3);
    expect(snap.queuedIds).toHaveLength(2);
    expect(snap.queued.map((q) => q.decisionId)).toEqual([queued4.id, queued5.id]);
    expect(snap.queued[0].taskCard?.projectId).toBe('proj-quota');

    // 排队不假装开工：无 agent_task_started 广播；给排队说明 output
    const outputTexts = broadcastMock.mock.calls
      .map((c) => c[0] as { type: string; payload?: { text?: string } })
      .filter((m) => m.type === 'output')
      .map((m) => m.payload?.text ?? '');
    expect(broadcastMock.mock.calls.filter((c) => (c[0] as { type: string }).type === 'agent_task_started')).toHaveLength(3);
    expect(outputTexts.filter((t) => t.includes('queued (concurrency quota)'))).toHaveLength(2);
    expect(outputTexts.some((t) => t.includes('并发任务 4'))).toBe(true);

    // 🔴⑦ 排队卡迁移流：none→pending→queued（走既有状态日志）
    expect(taskCardStatusRows(queued4.id).map((b) => `${b.from}->${b.to}`)).toEqual(['none->pending', 'pending->queued']);
    expect(taskCardStatusRows(queued4.id)[1].reason).toBe('quota-exhausted');
    expect(queued4.taskCard?.statusUpdatedAt).toBe(taskCardStatusRows(queued4.id)[1].at);

    // ⑩ 播报：有 N 个排队（1 → 2）
    const queueBroadcasts = broadcastMockRef.mock.calls.filter((c) => c[0].action === 'delegation_quota');
    expect(queueBroadcasts).toHaveLength(2);
    expect(queueBroadcasts[0][0].text).toContain('任务已排队');
    expect(queueBroadcasts[0][0].text).toContain('（项目 proj-quota）');
    expect(queueBroadcasts[0][0].text).toContain('当前 1 个排队');
    expect(queueBroadcasts[1][0].text).toContain('当前 2 个排队');

    // 🟡⑫ 审计：入队行（taskId/bossId/queueMs/phase 齐）
    const queuedAudit = quotaRows('quota-queued', queued4.id);
    expect(queuedAudit).toHaveLength(1);
    expect(queuedAudit[0]).toMatchObject({
      phase: 'quota-queued', taskId: expect.any(String), bossId: 'boss-1', queueMs: 0, queuedCount: 1, activeCount: 3,
    });
    expect(quotaRows('quota-queued', queued5.id)).toHaveLength(1);

    // 排队未登记回执（延到出队）：无追踪
    expect(getBossForSubordinate('agent-q4')).toBeUndefined();
    expect(getBossForSubordinate('agent-q5')).toBeUndefined();

    // ── 完成 1 个（report-task 入口）→ 自动出队队首（agent-q4）──
    completeDelegation('agent-q1', { success: true, reason: 'report-task' });
    expect(h.sendCommand).toHaveBeenCalledTimes(4);
    expect(h.sendCommand.mock.calls[3][0]).toBe('agent-q4');
    expect(getBossForSubordinate('agent-q4')?.decisionId).toBe(queued4.id); // 出队补登记
    expect(getBossForSubordinate('agent-q5')).toBeUndefined(); // 仍排队
    // 任务14·B：出队登记同样带 projectId（回执【项目别名】前缀的第二登记路径）
    expect(listPendingReceipts().find((r) => r.targetAgentId === 'agent-q4')?.projectId).toBe('proj-quota');

    // 出队完成卡迁移：queued → running（sendCommand resolve 后）
    h.resolveSend();
    await tick();
    expect(readDecision('并发任务 4').taskCard?.status).toBe('running');
    expect(readDecision('并发任务 5').taskCard?.status).toBe('queued');
    expect(readDecision('并发任务 1').taskCard?.status).toBe('done'); // 完成漏斗照常
    expect(getBossForSubordinate('agent-q1')).toBeUndefined();

    // ⑩ 播报：排队任务开始了（projectId 原值——任务14·B 别名替换只落回执前缀，未动配额播报）
    const startedBroadcast = broadcastMockRef.mock.calls.filter((c) => c[0].action === 'delegation_quota')[2];
    expect(startedBroadcast[0].text).toContain('排队任务开始了');
    expect(startedBroadcast[0].text).toContain('（项目 proj-quota）');

    // 🟡⑫ 审计：出队行（排队时长/账本快照）
    const dequeuedAudit = quotaRows('quota-dequeued', queued4.id);
    expect(dequeuedAudit).toHaveLength(1);
    expect(dequeuedAudit[0]).toMatchObject({ phase: 'quota-dequeued', bossId: 'boss-1', activeCount: 3, queuedCount: 1 });
    expect(dequeuedAudit[0].queueMs as number).toBeGreaterThanOrEqual(0);

    // 闸门账本推进：q4 占 slot，q5 仍排队（live 条目按 taskId 记账，
    // 出队/释放与完成漏斗同一把钥匙；断言经载荷 decisionId 映射）
    snap = getDelegationQuotaSnapshot();
    expect(snap.queued.map((q) => q.decisionId)).toEqual([queued5.id]);
    expect(snap.queuedIds).toHaveLength(1);

    // 🔴⑦ 出队派发迁移流：none→pending→queued→running
    expect(taskCardStatusRows(queued4.id).map((b) => `${b.from}->${b.to}`)).toEqual([
      'none->pending', 'pending->queued', 'queued->running',
    ]);
    expect(taskCardStatusRows(queued4.id)[2].reason).toBe('dispatched');
  });

  it('同下属时序边界：完成即出队派回同一 subordinate，追踪不被 delete 清掉（先删后派）', async () => {
    vi.stubEnv(DELEGATION_QUOTA_BUDGET_ENV, '1');
    parseBossDelegation('boss-1', 'Boss', delegationBlock('串行', ['agent-same', 'agent-same']), broadcastMock);

    // 预算 1：A 派发、B 排队同一下属
    expect(h.sendCommand).toHaveBeenCalledTimes(1);
    const a = readDecision('串行任务 1');
    const b = readDecision('串行任务 2');
    expect(getBossForSubordinate('agent-same')?.decisionId).toBe(a.id);
    expect(b.taskCard?.status).toBe('queued');

    // A 完成 → B 出队派回 agent-same；若先派后删，B 追踪会被清掉
    completeDelegation('agent-same', { success: true, reason: 'report-task' });
    expect(h.sendCommand).toHaveBeenCalledTimes(2);
    expect(h.sendCommand.mock.calls[1][0]).toBe('agent-same');
    expect(getBossForSubordinate('agent-same')?.decisionId).toBe(b.id);

    h.resolveSend();
    await tick();
    expect(readDecision('串行任务 2').taskCard?.status).toBe('running');
  });

  it('开关关闭（TC_JARVIS_DELEGATION_QUOTA=0）：旧直派行为，无排队无审计', () => {
    vi.stubEnv(DELEGATION_QUOTA_ENABLED_ENV, '0');
    const agents = ['agent-off1', 'agent-off2', 'agent-off3', 'agent-off4', 'agent-off5'];
    parseBossDelegation('boss-1', 'Boss', delegationBlock('关闭', agents), broadcastMock);

    expect(getDelegationQuotaSnapshot().enabled).toBe(false);
    expect(h.sendCommand).toHaveBeenCalledTimes(5);
    expect(getDelegationQuotaSnapshot().activeIds).toEqual([]);
    expect(getDelegationQuotaSnapshot().queuedIds).toEqual([]);
    for (let i = 1; i <= 5; i += 1) {
      expect(readDecision(`关闭任务 ${i}`).taskCard?.status).toBe('pending');
    }
    expect(broadcastMockRef.mock.calls.filter((c) => c[0].action === 'delegation_quota')).toHaveLength(0);
    expect(quotaRows('quota-queued', readDecision('关闭任务 5').id)).toHaveLength(0);
  });
});
