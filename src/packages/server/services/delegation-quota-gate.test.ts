/**
 * 任务15·B · delegation-quota-gate 单测
 *
 * 覆盖：配置解析（开关缺省开 / 关闭值 / 预算负与 NaN 兜底 + 警告）、准入与 N=3 边界、
 * FIFO 排队与出队（载荷完整、排队时长审计）、重复/未知确定性幂等、自留区免配、
 * 启动重建（只回填 queued、按 queuedAt 升序、读盘异常不上抛）、🟡⑫ 审计不上抛。
 *
 * 依赖 mock：data/system-log（logEvent 探针，可注入抛错）、data/index（loadDelegationHistory
 * 注入委派史，避免真盘）。15·A 纯函数模块与测试不改。
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
import { logger } from '../utils/index.js';
import type { DelegationDecision, TaskCard } from '../../shared/types.js';
import {
  DELEGATION_QUOTA_BUDGET_ENV,
  DELEGATION_QUOTA_ENABLED_ENV,
  DELEGATION_QUOTA_PHASE_DEQUEUED,
  DELEGATION_QUOTA_PHASE_QUEUED,
  getDelegationQuotaSnapshot,
  isDelegationQuotaEnabled,
  onDelegationComplete,
  rebuildDelegationQuotaQueueFromHistory,
  resetDelegationQuotaGateForTests,
  resolveDelegationQuotaBudget,
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

/** 取 🟡⑫ 审计行（quota-queued / quota-dequeued）。 */
function quotaLogs(phase?: string): Record<string, unknown>[] {
  return logEventMock.mock.calls
    .map((call) => call[1] as { body?: Record<string, unknown> } | undefined)
    .map((fields) => fields?.body)
    .filter((body): body is Record<string, unknown> => !!body && body.cat === 'delegation' && (phase ? body.phase === phase : String(body.phase).startsWith('quota-')));
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.stubEnv(DELEGATION_QUOTA_ENABLED_ENV, '1'); // 隔离本机环境变量：默认开
  resetDelegationQuotaGateForTests();
  logEventMock.mockReset();
  loadHistoryMock.mockReset();
  loadHistoryMock.mockReturnValue(new Map());
  seq = 0;
});

// ============================================================================
// 配置
// ============================================================================

describe('delegation-quota-gate · 配置（开关 + 预算）', () => {
  it('缺省开、预算缺省 3（15·A 起步值）', () => {
    expect(isDelegationQuotaEnabled({})).toBe(true);
    expect(resolveDelegationQuotaBudget({})).toBe(3);
  });

  it("开关关闭值：'0' / 'off' / 'false'（忽略大小写空白）关；其余开", () => {
    expect(isDelegationQuotaEnabled({ [DELEGATION_QUOTA_ENABLED_ENV]: '0' })).toBe(false);
    expect(isDelegationQuotaEnabled({ [DELEGATION_QUOTA_ENABLED_ENV]: ' off ' })).toBe(false);
    expect(isDelegationQuotaEnabled({ [DELEGATION_QUOTA_ENABLED_ENV]: 'FALSE' })).toBe(false);
    expect(isDelegationQuotaEnabled({ [DELEGATION_QUOTA_ENABLED_ENV]: '' })).toBe(true);
    expect(isDelegationQuotaEnabled({ [DELEGATION_QUOTA_ENABLED_ENV]: '1' })).toBe(true);
  });

  it('预算合法值原样；负/NaN/Infinity/非数字兜底 3 且警告一次；0 保留（全部排队语义）', () => {
    const warnSpy = vi.spyOn(logger.boss, 'warn').mockImplementation(() => {});
    try {
      expect(resolveDelegationQuotaBudget({ [DELEGATION_QUOTA_BUDGET_ENV]: '7' })).toBe(7);
      expect(resolveDelegationQuotaBudget({ [DELEGATION_QUOTA_BUDGET_ENV]: '0' })).toBe(0);
      expect(resolveDelegationQuotaBudget({ [DELEGATION_QUOTA_BUDGET_ENV]: '-1' })).toBe(3);
      expect(resolveDelegationQuotaBudget({ [DELEGATION_QUOTA_BUDGET_ENV]: 'abc' })).toBe(3);
      expect(resolveDelegationQuotaBudget({ [DELEGATION_QUOTA_BUDGET_ENV]: 'NaN' })).toBe(3);
      expect(resolveDelegationQuotaBudget({ [DELEGATION_QUOTA_BUDGET_ENV]: 'Infinity' })).toBe(3);
      expect(warnSpy).toHaveBeenCalledTimes(4);
      // 同一非法值重复解析不重复告警
      resolveDelegationQuotaBudget({ [DELEGATION_QUOTA_BUDGET_ENV]: '-1' });
      expect(warnSpy).toHaveBeenCalledTimes(4);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ============================================================================
// 准入 / 排队 / 出队
// ============================================================================

describe('delegation-quota-gate · 准入与 FIFO 排队（N=3）', () => {
  it('5 个并发请求 → 3 准 2 排；排队载荷完整保留（不丢任务）', () => {
    vi.stubEnv(DELEGATION_QUOTA_BUDGET_ENV, '3');
    const inputs = Array.from({ length: 5 }, () => admitInput());
    const results = inputs.map((i) => tryAdmitDelegation(i));

    expect(results.map((r) => r.status)).toEqual(['admitted', 'admitted', 'admitted', 'queued', 'queued']);
    const snap = getDelegationQuotaSnapshot();
    expect(snap.activeIds).toEqual([inputs[0].taskId, inputs[1].taskId, inputs[2].taskId]);
    expect(snap.queuedIds).toEqual([inputs[3].taskId, inputs[4].taskId]);
    expect(snap.queued).toHaveLength(2);
    expect(snap.queued[0]).toMatchObject({
      taskId: inputs[3].taskId,
      bossId: 'boss-1',
      decisionId: inputs[3].decisionId,
      selectedAgentId: inputs[3].selectedAgentId,
      selectedAgentName: inputs[3].selectedAgentName,
      taskCommand: inputs[3].taskCommand,
      taskCard: inputs[3].taskCard,
    });
    expect(typeof snap.queued[0].queuedAt).toBe('number');

    // 🟡⑫ 审计：两条排队行（taskId/bossId/queueMs/phase 齐）
    const queuedRows = quotaLogs(DELEGATION_QUOTA_PHASE_QUEUED);
    expect(queuedRows).toHaveLength(2);
    expect(queuedRows[0]).toMatchObject({
      phase: 'quota-queued',
      taskId: inputs[3].taskId,
      bossId: 'boss-1',
      queueMs: 0,
      queuedCount: 1,
    });
    expect(queuedRows[1]).toMatchObject({ taskId: inputs[4].taskId, queuedCount: 2 });
    expect(quotaLogs(DELEGATION_QUOTA_PHASE_DEQUEUED)).toHaveLength(0);
  });

  it('完成 1 个 → 自动出队队首 1 个（返回载荷，FIFO 连续出队）', () => {
    vi.stubEnv(DELEGATION_QUOTA_BUDGET_ENV, '3');
    const inputs = Array.from({ length: 5 }, () => admitInput());
    inputs.forEach((i) => tryAdmitDelegation(i));

    const first = onDelegationComplete(inputs[0].taskId!);
    expect(first?.taskId).toBe(inputs[3].taskId);
    expect(first?.taskCommand).toBe(inputs[3].taskCommand);
    let snap = getDelegationQuotaSnapshot();
    expect(snap.activeIds).toEqual([inputs[1].taskId, inputs[2].taskId, inputs[3].taskId]);
    expect(snap.queuedIds).toEqual([inputs[4].taskId]);

    const dequeuedRows = quotaLogs(DELEGATION_QUOTA_PHASE_DEQUEUED);
    expect(dequeuedRows).toHaveLength(1);
    expect(dequeuedRows[0]).toMatchObject({
      phase: 'quota-dequeued',
      taskId: inputs[3].taskId,
      bossId: 'boss-1',
      activeCount: 3,
      queuedCount: 1, // 出队后仍余 inputs[4]
    });
    expect(typeof dequeuedRows[0].queueMs).toBe('number');
    expect(dequeuedRows[0].queueMs as number).toBeGreaterThanOrEqual(0);

    // 继续释放：出队第 2 个，然后队列空 → null
    expect(onDelegationComplete(inputs[1].taskId!)?.taskId).toBe(inputs[4].taskId);
    expect(onDelegationComplete(inputs[2].taskId!)).toBeNull();
    expect(getDelegationQuotaSnapshot().activeIds).toEqual([inputs[3].taskId, inputs[4].taskId]);
  });

  it('重复请求不双计；未知/重复完成确定性幂等（不出队不抛）', () => {
    vi.stubEnv(DELEGATION_QUOTA_BUDGET_ENV, '1');
    const a = admitInput();
    const b = admitInput();
    expect(tryAdmitDelegation(a).status).toBe('admitted');
    expect(tryAdmitDelegation(a).status).toBe('admitted'); // 15·A duplicate → 直派放行
    expect(getDelegationQuotaSnapshot().activeIds).toEqual([a.taskId]);

    expect(tryAdmitDelegation(b).status).toBe('queued');
    // 误报完成一个仍在排队的 id → null 且不触发任何出队
    expect(onDelegationComplete(b.taskId!)).toBeNull();
    expect(getDelegationQuotaSnapshot().queuedIds).toEqual([b.taskId]);

    expect(onDelegationComplete('task-unknown')).toBeNull();
    expect(onDelegationComplete(a.taskId!)?.taskId).toBe(b.taskId);
    expect(onDelegationComplete(a.taskId!)).toBeNull(); // 重复释放
  });

  it('秘书自留区（scope=secretary）免配：预算 0 也直接放行且不进状态', () => {
    vi.stubEnv(DELEGATION_QUOTA_BUDGET_ENV, '0');
    const r = tryAdmitDelegation(admitInput({ scope: 'secretary' }));
    expect(r.status).toBe('admitted');
    const snap = getDelegationQuotaSnapshot();
    expect(snap.activeIds).toEqual([]);
    expect(snap.queuedIds).toEqual([]);
  });

  it('开关关闭：全部直派、不进状态、完成事件为 noop', () => {
    vi.stubEnv(DELEGATION_QUOTA_ENABLED_ENV, '0');
    const inputs = Array.from({ length: 5 }, () => admitInput());
    expect(inputs.map((i) => tryAdmitDelegation(i).status)).toEqual(Array(5).fill('admitted'));
    const snap = getDelegationQuotaSnapshot();
    expect(snap.activeIds).toEqual([]);
    expect(snap.queuedIds).toEqual([]);
    expect(onDelegationComplete(inputs[0].taskId!)).toBeNull();
  });
});

// ============================================================================
// 🟡⑫ 审计不上抛
// ============================================================================

describe('delegation-quota-gate · 审计是旁路（永不上抛）', () => {
  it('logEvent 抛错时准入/出队照常推进', () => {
    vi.stubEnv(DELEGATION_QUOTA_BUDGET_ENV, '1');
    logEventMock.mockImplementation(() => {
      throw new Error('audit exploded');
    });
    const a = admitInput();
    const b = admitInput();
    expect(() => tryAdmitDelegation(a)).not.toThrow();
    expect(() => tryAdmitDelegation(b)).not.toThrow();
    expect(getDelegationQuotaSnapshot().queuedIds).toEqual([b.taskId]);
    expect(() => onDelegationComplete(a.taskId!)).not.toThrow();
    expect(onDelegationComplete('task-none')).toBeNull();
    // 出队已发生（b 进入活跃），审计失败不影响账本
    expect(getDelegationQuotaSnapshot().activeIds).toEqual([b.taskId]);
  });
});

// ============================================================================
// 启动重建
// ============================================================================

describe('delegation-quota-gate · 启动重建（best-effort）', () => {
  it('只回填 queued 卡，按 queuedAt（statusUpdatedAt ?? timestamp）升序；done/running/pending 忽略', () => {
    vi.stubEnv(DELEGATION_QUOTA_BUDGET_ENV, '3');
    const histories = new Map<string, DelegationDecision[]>([
      [
        'boss-1',
        [
          decision({ id: 'del-done', taskCard: card({ status: 'done', statusUpdatedAt: 10 }) }),
          decision({ id: 'del-run', taskCard: card({ status: 'running', statusUpdatedAt: 20 }) }),
          decision({ id: 'del-q-late', taskCard: card({ status: 'queued', statusUpdatedAt: 300 }) }),
          decision({ id: 'del-q-early', taskCard: card({ status: 'queued', statusUpdatedAt: 100 }) }),
          decision({ id: 'del-q-ts', timestamp: 200, taskCard: card({ status: 'queued' }) }),
          decision({ id: 'del-nocard' }),
        ],
      ],
    ]);
    loadHistoryMock.mockReturnValue(histories);

    expect(rebuildDelegationQuotaQueueFromHistory(histories)).toBe(3);
    const snap = getDelegationQuotaSnapshot();
    expect(snap.activeIds).toEqual([]);
    expect(snap.queuedIds).toEqual(['del-q-early', 'del-q-ts', 'del-q-late']);
    expect(snap.queued[0]).toMatchObject({
      decisionId: 'del-q-early',
      bossId: 'boss-1',
      taskCommand: 'cmd del-q-early',
      queuedAt: 100,
    });
    expect(snap.queued[0].taskId).toBeUndefined(); // 旧 taskId 进程内不可达
    // 幂等：重复回填不重复入队
    expect(rebuildDelegationQuotaQueueFromHistory(histories)).toBe(0);
  });

  it('惰性重建：首个准入前回填；新任务完成 → 出队重建条目（载荷可直接派发）', () => {
    vi.stubEnv(DELEGATION_QUOTA_BUDGET_ENV, '1');
    loadHistoryMock.mockReturnValue(
      new Map([
        ['boss-1', [decision({ id: 'del-queued', taskCard: card({ status: 'queued', statusUpdatedAt: 5 }) })]],
      ])
    );

    const fresh = admitInput(); // 活跃为空 → 准入
    expect(tryAdmitDelegation(fresh).status).toBe('admitted');
    expect(getDelegationQuotaSnapshot().queuedIds).toEqual(['del-queued']);

    const payload = onDelegationComplete(fresh.taskId!);
    expect(payload?.decisionId).toBe('del-queued');
    expect(payload?.selectedAgentId).toBe('agent-del-queued');
  });

  it('读盘异常：重建跳过并告警，准入照常（不拦断派活）', () => {
    const warnSpy = vi.spyOn(logger.boss, 'warn').mockImplementation(() => {});
    try {
      vi.stubEnv(DELEGATION_QUOTA_BUDGET_ENV, '3');
      loadHistoryMock.mockImplementation(() => {
        throw new Error('history unreadable');
      });
      expect(() => tryAdmitDelegation(admitInput())).not.toThrow();
      expect(getDelegationQuotaSnapshot().activeIds).toHaveLength(1);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
