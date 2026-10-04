/**
 * 任务08② ⑥2 单测：待回执登记/匹配/过期（纯逻辑，不依赖服务与磁盘）。
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_TASK_SUMMARY_LENGTH,
  createPendingReceiptRegistry,
} from './pending-receipt-registry.js';

function makeReceipt(overrides: Partial<Parameters<ReturnType<typeof createPendingReceiptRegistry>['register']>[0]> = {}) {
  return {
    targetAgentId: 'agent-1',
    bossId: 'boss-1',
    taskId: 't-1',
    decisionId: 'd-1',
    taskSummary: '实现登录页',
    ...overrides,
  };
}

describe('createPendingReceiptRegistry', () => {
  it('登记后按 targetAgentId 匹配命中，并记录 matchedAt', () => {
    const registry = createPendingReceiptRegistry();
    registry.register(makeReceipt({ registeredAt: 1000 }));

    const match = registry.match('agent-1', 2000);
    expect(match?.duplicate).toBe(false);
    expect(match?.receipt.taskId).toBe('t-1');
    expect(match?.receipt.decisionId).toBe('d-1');
    expect(match?.receipt.taskSummary).toBe('实现登录页');
    expect(match?.receipt.matchedAt).toBe(2000);
    // 未登记的目标不命中
    expect(registry.match('agent-2', 2000)).toBeUndefined();
  });

  it('同一次完成第二入口匹配 → duplicate=true，复用同一条目（稳定去重键来源）', () => {
    const registry = createPendingReceiptRegistry();
    registry.register(makeReceipt({ registeredAt: 1000 }));

    const first = registry.match('agent-1', 2000);
    const second = registry.match('agent-1', 2500);
    expect(first?.duplicate).toBe(false);
    expect(second?.duplicate).toBe(true);
    expect(second?.receipt.taskId).toBe(first?.receipt.taskId);
    // 第二次不覆盖首次 matchedAt（幂等）
    expect(second?.receipt.matchedAt).toBe(2000);
  });

  it('过期条目：match 惰性清扫并返回 undefined（退化为未匹配完成，不静默）', () => {
    const registry = createPendingReceiptRegistry({ ttlMs: 1000 });
    registry.register(makeReceipt({ registeredAt: 1000 }));
    expect(registry.size()).toBe(1);

    expect(registry.match('agent-1', 2500)).toBeUndefined();
    expect(registry.size()).toBe(0);
  });

  it('过期条目：register 时同样惰性清扫（无定时器、内存有界）', () => {
    const registry = createPendingReceiptRegistry({ ttlMs: 1000 });
    registry.register(makeReceipt({ registeredAt: 1000 }));
    registry.register(makeReceipt({ targetAgentId: 'agent-2', registeredAt: 3000 }));
    expect(registry.size()).toBe(1); // agent-1 已过期被清
    expect(registry.match('agent-2', 3100)?.receipt.targetAgentId).toBe('agent-2');
  });

  it('同一 agent 新派活覆盖旧登记（语义同 activeDelegations：一次只挂一条）', () => {
    const registry = createPendingReceiptRegistry();
    registry.register(makeReceipt({ registeredAt: 1000 }));
    registry.match('agent-1', 2000); // 旧条目已消费
    registry.register(makeReceipt({ taskId: 't-2', taskSummary: '修复构建失败', registeredAt: 3000 }));

    const match = registry.match('agent-1', 3100);
    expect(match?.duplicate).toBe(false); // 新登记重新武装，不是第二入口
    expect(match?.receipt.taskId).toBe('t-2');
    expect(match?.receipt.taskSummary).toBe('修复构建失败');
  });

  it('条目上限驱逐最旧（内存有界）', () => {
    const registry = createPendingReceiptRegistry({ maxEntries: 2 });
    registry.register(makeReceipt({ targetAgentId: 'a', registeredAt: 1000 }));
    registry.register(makeReceipt({ targetAgentId: 'b', registeredAt: 2000 }));
    registry.register(makeReceipt({ targetAgentId: 'c', registeredAt: 3000 }));

    expect(registry.size()).toBe(2);
    expect(registry.match('a', 4000)).toBeUndefined(); // 最旧被驱逐
    expect(registry.match('b', 4000)?.receipt.targetAgentId).toBe('b');
    expect(registry.match('c', 4000)?.receipt.targetAgentId).toBe('c');
  });

  it('任务摘要登记时截断（内存 + 播报长度双约束）', () => {
    const registry = createPendingReceiptRegistry();
    registry.register(makeReceipt({ taskSummary: `长任务 ${'x'.repeat(200)}`, registeredAt: 1000 }));
    const summary = registry.match('agent-1', 2000)?.receipt.taskSummary ?? '';
    expect(summary.length).toBeLessThanOrEqual(MAX_TASK_SUMMARY_LENGTH + 1);
    expect(summary.endsWith('…')).toBe(true);
  });

  it('clear 清空全部（测试复位路径）', () => {
    const registry = createPendingReceiptRegistry();
    registry.register(makeReceipt({ registeredAt: 1000 }));
    registry.clear();
    expect(registry.size()).toBe(0);
    expect(registry.match('agent-1', 2000)).toBeUndefined();
  });
});
