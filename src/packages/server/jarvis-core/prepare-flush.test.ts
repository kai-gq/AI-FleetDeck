/**
 * prepare-flush 单测：注册表 + 开口点 flush（含真实 SignalQueue 的 PREPARE 攒批出队闭环）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignalQueue, type ConsumedSignal } from './index.js';
import {
  flushPreparedAtOpeningPoint,
  listPreparedQueues,
  registerPreparedQueue,
  resetPreparedFlushForTests,
  unregisterPreparedQueue,
} from './prepare-flush.js';
import type { RawSignal } from './signal-queue.js';

afterEach(() => {
  resetPreparedFlushForTests();
});

/** 周三正午（本地）：避开深夜/专注窗，保证判定只由评分驱动。 */
const NOON = new Date(2026, 9, 7, 12, 0, 0).getTime();

/** 60/70/95 → 70 分：默认配置下攒批档（对齐 09·B completed 评分口径）。 */
function prepareScoredSignal(kind = 'test_batch'): RawSignal {
  return { source: 'user', kind, ts: NOON, dedupeKey: `k-${kind}`, text: `攒批 ${kind}`, urgency: 60, relevance: 70, certainty: 95 };
}

function makeQueueWithPrepared(kinds: string[] = ['a']): SignalQueue {
  const queue = new SignalQueue({ now: NOON });
  for (const kind of kinds) queue.enqueue(prepareScoredSignal(kind));
  queue.consumeAll();
  return queue;
}

describe('prepare-flush 注册表', () => {
  it('空注册表 flush：无交付、无失败、不上抛', async () => {
    const report = await flushPreparedAtOpeningPoint('test_empty', { logger: silentLogger() });
    expect(report.delivered).toBe(0);
    expect(report.queues).toEqual([]);
    expect(report.failures).toEqual([]);
  });

  it('getQueue 返回 null：跳过不报错', async () => {
    registerPreparedQueue({ name: 'lazy', getQueue: () => null, speak: () => { throw new Error('不应被调用'); } });
    const report = await flushPreparedAtOpeningPoint('test_null', { logger: silentLogger() });
    expect(report.delivered).toBe(0);
    expect(report.failures).toEqual([]);
  });

  it('同名重复注册 = 覆盖（接线幂等 re-init）', () => {
    registerPreparedQueue({ name: 'dup', getQueue: () => null, speak: () => {} });
    registerPreparedQueue({ name: 'dup', getQueue: () => null, speak: () => {} });
    expect(listPreparedQueues()).toEqual(['dup']);
    unregisterPreparedQueue('dup');
    expect(listPreparedQueues()).toEqual([]);
  });

  it('getQueue 抛错：计入 failures，不阻塞其它注册项', async () => {
    registerPreparedQueue({ name: 'broken', getQueue: () => { throw new Error('boom'); }, speak: () => {} });
    const okQueue = makeQueueWithPrepared(['ok']);
    const spoken: ConsumedSignal[][] = [];
    registerPreparedQueue({ name: 'ok', getQueue: () => okQueue, speak: (entries) => { spoken.push([...entries]); } });

    const report = await flushPreparedAtOpeningPoint('test_broken', { logger: silentLogger() });
    expect(report.failures.map((f) => f.name)).toEqual(['broken']);
    expect(report.delivered).toBe(1);
    expect(spoken[0]).toHaveLength(1);
  });
});

describe('prepare-flush 与真实 SignalQueue 的闭环', () => {
  it('PREPARE 条目出队交付，且绝不重复交付（不判定/不复扣）', async () => {
    const queue = makeQueueWithPrepared(['a', 'b']);
    const stateBefore = queue.snapshotState();
    const spoken: ConsumedSignal[][] = [];
    registerPreparedQueue({ name: 'real', getQueue: () => queue, speak: (entries) => { spoken.push([...entries]); } });

    const first = await flushPreparedAtOpeningPoint('test_real', { logger: silentLogger(), now: () => NOON });
    expect(first.delivered).toBe(2);
    expect(first.queues).toEqual(['real']);
    expect(spoken[0].map((c) => c.signal.kind)).toEqual(['a', 'b']);
    expect(spoken[0].every((c) => c.decision.tier === 'PREPARE')).toBe(true);

    // 出队后缓冲已空；再 flush 不重复交付；队列状态（预算/幂等键）零变化。
    const second = await flushPreparedAtOpeningPoint('test_real_again', { logger: silentLogger() });
    expect(second.delivered).toBe(0);
    expect(spoken).toHaveLength(1);
    expect(queue.snapshotState()).toEqual(stateBefore);
  });

  it('非 PREPARE 档条目不进攒批缓冲（flush 不误取）', async () => {
    const queue = new SignalQueue({ now: NOON });
    // 90/80/90 ≈ 87 分：立即口播档，不进 prepared。
    queue.enqueue({ source: 'user', kind: 'urgent', ts: NOON, dedupeKey: 'k-urgent', text: '急', urgency: 90, relevance: 80, certainty: 90 });
    queue.consumeAll();

    const spoken: ConsumedSignal[][] = [];
    registerPreparedQueue({ name: 'mixed', getQueue: () => queue, speak: (entries) => { spoken.push([...entries]); } });
    const report = await flushPreparedAtOpeningPoint('test_mixed', { logger: silentLogger() });
    expect(report.delivered).toBe(0);
    expect(spoken).toHaveLength(0);
  });

  it('交付抛错：条目已出队＝丢弃，记 failures 不假装送达', async () => {
    const queue = makeQueueWithPrepared(['x']);
    registerPreparedQueue({ name: 'fails', getQueue: () => queue, speak: () => { throw new Error('speak down'); } });
    const report = await flushPreparedAtOpeningPoint('test_fail', { logger: silentLogger() });
    expect(report.delivered).toBe(0);
    expect(report.failures.map((f) => f.name)).toEqual(['fails']);
    expect(queue.flushPrepared()).toHaveLength(0); // 已出队，无回插
  });
});

/** 静默 logger：测试不污染控制台。 */
function silentLogger() {
  return {
    log: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}
