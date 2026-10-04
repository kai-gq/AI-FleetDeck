/**
 * 任务16·⑬ 撤回 × 全局并发配额 —— gate 层 cancel API 单测。
 *
 * 覆盖「撤回配额占用」三态与边界：
 *   - queued：移除 FIFO 队列 + 删载荷（不派发；后续完成不再出队）；
 *   - running：释放槽位 + 复用完成语义自动出队队首（载荷返回调用方派发）；
 *   - 未知/重复/开关关闭 → not-found（幂等）；
 *   - 重建条目（taskId 不可达）按 decisionId 撤回；
 *   - 🟡⑫ 审计（quota-cancelled 含 cancelledFrom/initiator/reason）与「审计抛错不上抛」。
 *
 * 依赖 mock 与既有 delegation-quota-gate.test.ts 同款：data/system-log（logEvent 探针）、
 * data/index（loadDelegationHistory 注入）。15·A delegation-quota.ts 零改动（不 mock）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../data/system-log.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../data/system-log.js')>();
  return { ...actual, logEvent: vi.fn() };
});

vi.mock('../data/index.js', () => ({
  loadDelegationHistory: vi.fn(() => new Map()),
}));

import { logEvent } from '../data/system-log.js';
import { loadDelegationHistory } from '../data/index.js';
import type { DelegationDecision, TaskCard } from '../../shared/types.js';
import {
  DELEGATION_QUOTA_BUDGET_ENV,
  DELEGATION_QUOTA_ENABLED_ENV,
  DELEGATION_QUOTA_PHASE_CANCELLED,
  DELEGATION_QUOTA_PHASE_DEQUEUED,
  DELEGATION_QUOTA_PHASE_QUEUED,
  cancelDelegationQuotaSlot,
  getDelegationQuotaSnapshot,
  onDelegationComplete,
  rebuildDelegationQuotaQueueFromHistory,
  resetDelegationQuotaGateForTests,
  tryAdmitDelegation,
  type DelegationQuotaAdmitInput,
} from './delegation-quota-gate.js';

const logEventMock = vi.mocked(logEvent);
const loadHistoryMock = vi.mocked(loadDelegationHistory);

let seq = 0;

function card(over: Partial<TaskCard> = {}): TaskCard {
  return {
    objective: '目标',
    acceptanceCriteria: [],
    dependencies: [],
    status: 'pending',
    ...over,
  };
}

function admitInput(over: Partial<DelegationQuotaAdmitInput> = {}): DelegationQuotaAdmitInput {
  seq += 1;
  return {
    taskId: `task-${seq}`,
    bossId: 'boss-1',
    decisionId: `del-${seq}`,
    selectedAgentId: `agent-${seq}`,
    selectedAgentName: `Agent ${seq}`,
    taskCommand: `do task ${seq}`,
    taskCard: card({ objective: `task ${seq}`, projectId: 'proj-a' }),
    ...over,
  };
}

function decision(over: Partial<DelegationDecision> & { id: string }): DelegationDecision {
  return {
    timestamp: 1000,
    bossId: 'boss-1',
    userCommand: `cmd ${over.id}`,
    selectedAgentId: `agent-${over.id}`,
    selectedAgentName: `Agent ${over.id}`,
    reasoning: '',
    alternativeAgents: [],
    confidence: 'high',
    status: 'sent',
    ...over,
  };
}

/** 取「quota-*」审计行（body.cat==='delegation'）。 */
function quotaLogs(phase?: string): Record<string, unknown>[] {
  return logEventMock.mock.calls
    .map((call) => call[1] as { body?: Record<string, unknown> } | undefined)
    .map((fields) => fields?.body)
    .filter((body): body is Record<string, unknown> => !!body && body.cat === 'delegation' && (phase ? body.phase === phase : String(body.phase).startsWith('quota-')));
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv(DELEGATION_QUOTA_ENABLED_ENV, '1');
  resetDelegationQuotaGateForTests();
  logEventMock.mockReset();
  loadHistoryMock.mockReset();
  loadHistoryMock.mockReturnValue(new Map());
  seq = 0;
});

describe('任务16·⑬ 撤回配额占用 · queued（移除队列，不派发）', () => {
  it('预算 1：排队项撤回 → 队列/载荷清空、审计 quota-cancelled、后续完成不再出队它', () => {
    vi.stubEnv(DELEGATION_QUOTA_BUDGET_ENV, '1');
    const a = admitInput();
    const b = admitInput();
    expect(tryAdmitDelegation(a).status).toBe('admitted');
    expect(tryAdmitDelegation(b).status).toBe('queued');
    logEventMock.mockClear();

    const result = cancelDelegationQuotaSlot({
      quotaId: b.taskId,
      taskId: b.taskId,
      decisionId: b.decisionId,
      bossId: b.bossId,
      selectedAgentId: b.selectedAgentId,
      initiator: 'user',
      reason: '不想做了',
      at: 12_345,
    });

    expect(result.status).toBe('queued-cancelled');
    expect(result.payload?.decisionId).toBe(b.decisionId);
    expect(result.payload?.taskCommand).toBe(b.taskCommand);
    expect(result.dequeued).toBeUndefined(); // 撤回 queued 不派发任何东西

    const snap = getDelegationQuotaSnapshot();
    expect(snap.activeIds).toEqual([a.taskId]);
    expect(snap.queuedIds).toEqual([]);
    expect(snap.queued).toEqual([]);

    // 🟡⑫ 审计：quota-cancelled（cancelledFrom=queued + 发起方/原因/账本快照）
    const rows = quotaLogs(DELEGATION_QUOTA_PHASE_CANCELLED);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      phase: DELEGATION_QUOTA_PHASE_CANCELLED,
      quotaId: b.taskId,
      taskId: b.taskId,
      decisionId: b.decisionId,
      bossId: 'boss-1',
      cancelledFrom: 'queued',
      initiator: 'user',
      reason: '不想做了',
      activeCount: 1,
      queuedCount: 0,
      at: 12_345,
    });
    expect(quotaLogs(DELEGATION_QUOTA_PHASE_DEQUEUED)).toHaveLength(0); // 未派发

    // 完成 a → 无出队（撤回项不得复活）；a 释放后槽位空
    expect(onDelegationComplete(a.taskId!)).toBeNull();
    expect(getDelegationQuotaSnapshot().activeIds).toEqual([]);
    expect(getDelegationQuotaSnapshot().queuedIds).toEqual([]);
  });

  it('重建条目（taskId 不可达）按 decisionId 撤回；未知 id → not-found（幂等）', () => {
    loadHistoryMock.mockReturnValue(
      new Map([
        ['boss-1', [decision({ id: 'del-rebuilt', taskCard: card({ status: 'queued', statusUpdatedAt: 5 }) })]],
      ])
    );
    expect(tryAdmitDelegation(admitInput()).status).toBe('admitted'); // 触发惰性重建
    expect(getDelegationQuotaSnapshot().queuedIds).toEqual(['del-rebuilt']);

    const hit = cancelDelegationQuotaSlot({ decisionId: 'del-rebuilt', initiator: 'user' });
    expect(hit.status).toBe('queued-cancelled');
    expect(hit.payload?.decisionId).toBe('del-rebuilt');
    expect(getDelegationQuotaSnapshot().queuedIds).toEqual([]);

    // 重复撤回同一条 → not-found（幂等，不抛不重复审计）
    logEventMock.mockClear();
    expect(cancelDelegationQuotaSlot({ decisionId: 'del-rebuilt' }).status).toBe('not-found');
    expect(cancelDelegationQuotaSlot({ quotaId: 'task-unknown' }).status).toBe('not-found');
    expect(quotaLogs(DELEGATION_QUOTA_PHASE_CANCELLED)).toHaveLength(0);
  });
});

describe('任务16·⑬ 撤回配额占用 · running（释放槽位 + 出队队首）', () => {
  it('预算 1：撤回在跑项 → 队首被出队并返回载荷（quota-cancelled + quota-dequeued 双审计）', () => {
    vi.stubEnv(DELEGATION_QUOTA_BUDGET_ENV, '1');
    const a = admitInput();
    const b = admitInput();
    tryAdmitDelegation(a);
    tryAdmitDelegation(b);
    logEventMock.mockClear();

    const at = Date.now(); // queueMs = at − queuedAt 用真实时刻，保证非负（同生产语义）
    const result = cancelDelegationQuotaSlot({
      quotaId: a.taskId,
      taskId: a.taskId,
      decisionId: a.decisionId,
      bossId: a.bossId,
      selectedAgentId: a.selectedAgentId,
      initiator: 'user',
      reason: '停掉',
      at,
    });

    expect(result.status).toBe('running-released');
    expect(result.dequeued?.decisionId).toBe(b.decisionId);
    expect(result.dequeued?.taskCommand).toBe(b.taskCommand);
    // 账本：a 释放、b 占位（出队即入活跃，与完成语义一致）
    const snap = getDelegationQuotaSnapshot();
    expect(snap.activeIds).toEqual([b.taskId]);
    expect(snap.queuedIds).toEqual([]);

    const cancelledRows = quotaLogs(DELEGATION_QUOTA_PHASE_CANCELLED);
    expect(cancelledRows).toHaveLength(1);
    expect(cancelledRows[0]).toMatchObject({
      cancelledFrom: 'running',
      quotaId: a.taskId,
      taskId: a.taskId,
      initiator: 'user',
      reason: '停掉',
      activeCount: 1,
      queuedCount: 0,
      at,
    });
    const dequeuedRows = quotaLogs(DELEGATION_QUOTA_PHASE_DEQUEUED);
    expect(dequeuedRows).toHaveLength(1);
    expect(dequeuedRows[0]).toMatchObject({ phase: DELEGATION_QUOTA_PHASE_DEQUEUED, taskId: b.taskId, bossId: 'boss-1' });
    expect(dequeuedRows[0].queueMs as number).toBeGreaterThanOrEqual(0);

    // b 后续完成照常释放（出队后的账与正常流程同构；队列已空 → 不再出队）
    expect(onDelegationComplete(b.taskId!)).toBeNull();
    expect(getDelegationQuotaSnapshot().activeIds).toEqual([]);
  });

  it('预算 2：撤回在跑项但队列为空 → running-released + dequeued null（不硬造载荷）', () => {
    vi.stubEnv(DELEGATION_QUOTA_BUDGET_ENV, '2');
    const a = admitInput();
    tryAdmitDelegation(a);
    logEventMock.mockClear();

    const result = cancelDelegationQuotaSlot({ taskId: a.taskId });
    expect(result.status).toBe('running-released');
    expect(result.dequeued).toBeNull();
    expect(getDelegationQuotaSnapshot().activeIds).toEqual([]);
    expect(quotaLogs(DELEGATION_QUOTA_PHASE_DEQUEUED)).toHaveLength(0);
    expect(quotaLogs(DELEGATION_QUOTA_PHASE_CANCELLED)).toHaveLength(1);
    // 重复撤回 → not-found
    expect(cancelDelegationQuotaSlot({ taskId: a.taskId }).status).toBe('not-found');
  });

  it('入参缺 id（无 quotaId/taskId/decisionId）→ not-found（不猜）', () => {
    const a = admitInput();
    tryAdmitDelegation(a);
    expect(cancelDelegationQuotaSlot({}).status).toBe('not-found');
    expect(getDelegationQuotaSnapshot().activeIds).toEqual([a.taskId]);
  });
});

describe('任务16·⑬ 撤回配额占用 · 开关与审计旁路', () => {
  it('开关关闭 → not-found 且账本不动（即使存在排队条目）', () => {
    vi.stubEnv(DELEGATION_QUOTA_BUDGET_ENV, '1');
    const a = admitInput();
    const b = admitInput();
    tryAdmitDelegation(a);
    tryAdmitDelegation(b);
    vi.stubEnv(DELEGATION_QUOTA_ENABLED_ENV, '0');
    expect(cancelDelegationQuotaSlot({ taskId: b.taskId }).status).toBe('not-found');
    expect(cancelDelegationQuotaSlot({ taskId: a.taskId }).status).toBe('not-found');
    expect(getDelegationQuotaSnapshot().queuedIds).toEqual([b.taskId]); // 关开关不吞队列
    expect(getDelegationQuotaSnapshot().activeIds).toEqual([a.taskId]);
  });

  it('logEvent 抛错：queued/running 撤回照常推进（审计是旁路，绝不上抛）', () => {
    vi.stubEnv(DELEGATION_QUOTA_BUDGET_ENV, '1');
    const a = admitInput();
    const b = admitInput();
    tryAdmitDelegation(a);
    tryAdmitDelegation(b);
    logEventMock.mockImplementation(() => {
      throw new Error('audit exploded');
    });

    expect(() => cancelDelegationQuotaSlot({ taskId: b.taskId })).not.toThrow();
    expect(getDelegationQuotaSnapshot().queuedIds).toEqual([]); // queued 撤回已生效

    const c = admitInput();
    tryAdmitDelegation(c); // 队列空 → c 直进活跃
    expect(() => cancelDelegationQuotaSlot({ taskId: a.taskId })).not.toThrow();
    expect(getDelegationQuotaSnapshot().activeIds).toEqual([c.taskId]); // a 已释放、c 出队
  });
});
