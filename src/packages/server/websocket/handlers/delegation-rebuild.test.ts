/**
 * HC-B7（W12.5 修复批）· 重启后从未完成委派史重建 activeDelegations 追踪（L2 口径：真实函数链路，注入历史）
 *
 * 背景：C4/HC-40 实测——tsx 重启清空内存 activeDelegations，recovery-store 只收养进程不重建
 * 委派追踪 → 在办任务重启后完成时完成漏斗失忆（卡不迁 done、病历永停 sent、closed 行缺失、配额槽不释放）。
 * 重建口径（19·B 记录 HC-B7）：status ∈ {pending,sent} 且无 completion、无终态/排队卡、24h 内、下属仍在册。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  agents: [] as Array<{ id: string; name: string; class?: string; isBoss?: boolean; status: string }>,
}));

vi.mock('../../services/index.js', () => ({
  agentService: {
    getAgent: (id: string) => h.agents.find((a) => a.id === id),
    getAllAgents: () => h.agents,
  },
  runtimeService: { sendCommand: vi.fn(async () => {}), stopAgent: vi.fn(async () => {}) },
  bossService: {},
  workPlanService: {},
  skillService: {},
}));

vi.mock('./command-handler.js', () => ({
  getLastBossCommand: vi.fn(() => ''),
  buildCustomAgentConfig: vi.fn((id: string, cls?: string) => ({ __custom: id, cls })),
}));

vi.mock('../../services/voice-companion-service.js', () => ({
  logProactiveBroadcast: vi.fn(),
}));

import {
  ACTIVE_DELEGATION_REBUILD_TTL_MS,
  activeDelegations,
  ensureActiveDelegationsRebuilt,
  resetBossDelegationStateForTests,
} from './boss-response-handler.js';
import type { DelegationDecision } from '../../../shared/types.js';

function mkDecision(over: Partial<DelegationDecision> & { id: string }): DelegationDecision {
  return {
    timestamp: Date.now(),
    bossId: 'boss-1',
    userCommand: `任务 ${over.id}`,
    selectedAgentId: 'a1',
    selectedAgentName: '小一',
    reasoning: '重建测试',
    alternativeAgents: [],
    confidence: 'high',
    status: 'sent',
    ...over,
  };
}

function historiesOf(...decisions: DelegationDecision[]): Map<string, DelegationDecision[]> {
  return new Map([['boss-1', decisions]]);
}

function seedAgents(ids: string[]): void {
  h.agents.length = 0;
  h.agents.push({ id: 'boss-1', name: '主管', class: 'boss', isBoss: true, status: 'idle' });
  ids.forEach((id, i) => h.agents.push({ id, name: `小${i + 1}`, class: 'builder', status: 'working' }));
}

describe('HC-B7 委派追踪重建（activeDelegations from history）', () => {
  beforeEach(() => {
    h.agents.length = 0;
    resetBossDelegationStateForTests();
    seedAgents(['a1', 'a2', 'a3', 'a4']);
  });

  it('sent/pending 未完成决策重建为追踪（含 taskId/decisionId/卡快照）；completed 与有 completion 的跳过', () => {
    const added = ensureActiveDelegationsRebuilt(
      historiesOf(
        mkDecision({
          id: 'del-1',
          selectedAgentId: 'a1',
          taskId: 'task-abc',
          taskCard: { objective: '完成 X', acceptanceCriteria: ['标准'], status: 'running' } as never,
        }),
        mkDecision({ id: 'del-2', selectedAgentId: 'a2', status: 'pending' }),
        mkDecision({ id: 'del-3', selectedAgentId: 'a3', status: 'completed' }),
        mkDecision({
          id: 'del-4',
          selectedAgentId: 'a4',
          completion: { completedAt: Date.now(), durationMs: 1000, result: 'completed' },
        }),
      ),
    );

    expect(added).toBe(2);
    const e1 = activeDelegations.get('a1');
    expect(e1).toMatchObject({ bossId: 'boss-1', taskId: 'task-abc', decisionId: 'del-1', taskDescription: '任务 del-1' });
    expect(e1?.taskCard?.objective).toBe('完成 X');
    expect(activeDelegations.get('a2')?.decisionId).toBe('del-2');
    expect(activeDelegations.has('a3')).toBe(false);
    expect(activeDelegations.has('a4')).toBe(false);
    // 无 taskId 的旧决策仍重建（taskId 缺省，仅靠 decisionId 关联）
    expect(activeDelegations.get('a2')?.taskId).toBeUndefined();
  });

  it('过滤矩阵：终态/排队卡、超 24h、下属不在册 → 跳过；live 条目不被覆盖', () => {
    activeDelegations.set('a1', { bossId: 'boss-1', taskDescription: 'live 任务', decisionId: 'del-live' });

    const added = ensureActiveDelegationsRebuilt(
      historiesOf(
        mkDecision({ id: 'del-live', selectedAgentId: 'a1' }), // live 已存在 → 保留 live
        mkDecision({ id: 'del-done', selectedAgentId: 'a2', taskCard: { objective: 'x', status: 'done' } as never }),
        mkDecision({ id: 'del-cancel', selectedAgentId: 'a2', taskCard: { objective: 'x', status: 'cancelled' } as never }),
        mkDecision({ id: 'del-queued', selectedAgentId: 'a2', taskCard: { objective: 'x', status: 'queued' } as never }),
        mkDecision({ id: 'del-old', selectedAgentId: 'a2', timestamp: Date.now() - ACTIVE_DELEGATION_REBUILD_TTL_MS - 60_000 }),
        mkDecision({ id: 'del-gone', selectedAgentId: 'deleted-agent' }),
      ),
    );

    expect(added).toBe(0);
    expect(activeDelegations.get('a1')?.decisionId).toBe('del-live');
    expect(activeDelegations.get('a1')?.taskDescription).toBe('live 任务');
    expect(activeDelegations.size).toBe(1);
  });

  it('一次性语义：首读重建后不再重复；force 与状态复位可重放', () => {
    const histories = historiesOf(mkDecision({ id: 'del-1', selectedAgentId: 'a1' }));
    expect(ensureActiveDelegationsRebuilt(histories)).toBe(1);

    activeDelegations.clear(); // 模拟再次“重启”清空
    expect(ensureActiveDelegationsRebuilt(histories)).toBe(0); // 标志已置 → 不重复
    expect(activeDelegations.size).toBe(0);

    expect(ensureActiveDelegationsRebuilt(histories, true)).toBe(1); // force 重放
    resetBossDelegationStateForTests(); // 复位后恢复 lazy 语义
    seedAgents(['a1']);
    expect(ensureActiveDelegationsRebuilt(histories)).toBe(1);
  });

  it('同一下属多条未完成决策：后到的（较新）覆盖较旧，语义与 live 单槽一致', () => {
    ensureActiveDelegationsRebuilt(
      historiesOf(
        mkDecision({ id: 'del-old', selectedAgentId: 'a1', taskId: 'task-old' }),
        mkDecision({ id: 'del-new', selectedAgentId: 'a1', taskId: 'task-new' }),
      ),
    );
    expect(activeDelegations.get('a1')?.decisionId).toBe('del-new');
    expect(activeDelegations.get('a1')?.taskId).toBe('task-new');
  });
});
