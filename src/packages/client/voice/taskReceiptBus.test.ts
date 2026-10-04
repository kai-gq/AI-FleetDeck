/** 任务08② 回执总线单测:订阅/退订/多订阅者/异常隔离。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  emitTaskReceipt,
  resetTaskReceiptBusForTests,
  subscribeTaskReceipt,
  type TaskReceiptPayload,
} from './taskReceiptBus';

function payload(overrides: Partial<TaskReceiptPayload> = {}): TaskReceiptPayload {
  return {
    agentId: 'agent-1',
    agentName: 'Builder One',
    success: true,
    matched: true,
    taskId: 't-1',
    text: 'Builder One 完成任务:实现登录页',
    at: 1000,
    source: 'runtime',
    dedupeKey: 'agent-completed:agent-1:t-1',
    observed: { tier: 'PREPARE', reason: 'batched', score: 70 },
    ...overrides,
  };
}

describe('taskReceiptBus', () => {
  beforeEach(() => {
    resetTaskReceiptBusForTests();
  });

  it('订阅者收到广播载荷;退订后不再收到', () => {
    const fn = vi.fn();
    const unsubscribe = subscribeTaskReceipt(fn);

    emitTaskReceipt(payload());
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent-1', dedupeKey: 'agent-completed:agent-1:t-1' }));

    unsubscribe();
    emitTaskReceipt(payload());
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('多订阅者各自收到;单订阅者抛错不影响其它订阅者', () => {
    const first = vi.fn(() => {
      throw new Error('订阅者异常');
    });
    const second = vi.fn();
    subscribeTaskReceipt(first);
    subscribeTaskReceipt(second);

    expect(() => emitTaskReceipt(payload())).not.toThrow();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('订阅者在回调中退订自身也安全(快照迭代)', () => {
    const calls: string[] = [];
    const unsubscribeFirst = subscribeTaskReceipt(() => {
      calls.push('first');
      unsubscribeFirst();
    });
    const second = vi.fn(() => calls.push('second'));
    subscribeTaskReceipt(second);

    emitTaskReceipt(payload());
    emitTaskReceipt(payload());
    expect(calls).toEqual(['first', 'second', 'second']);
  });

  it('reset 清空全部订阅', () => {
    const fn = vi.fn();
    subscribeTaskReceipt(fn);
    resetTaskReceiptBusForTests();
    emitTaskReceipt(payload());
    expect(fn).not.toHaveBeenCalled();
  });
});
