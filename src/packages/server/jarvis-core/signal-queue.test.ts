/**
 * jarvis-core · signal-queue 单测（任务 26 ⑥ + 09·A 三项残余风险①–③）
 *
 * 覆盖：归一化入队（补 ts/dedupeKey、trim、非法抛 TypeError）/ 消费出队与幂等
 * 去重 / PREPARE 准入预扣 + 出队不复扣 / 预算硬顶 / seenKeys 裁剪（N + TTL）/
 * state.now 显式注入（深夜判定）/ 配置错误保守回退 / 快照恢复。
 */

import { describe, expect, it } from 'vitest';

import type { SignalSource } from '../../shared/broadcast-gates.js';
import type { JarvisLogger } from './executors.js';
import {
  SignalQueue,
  isSignalSource,
  normalizeSignal,
} from './signal-queue.js';

const silentLogger: JarvisLogger = {
  log: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
};

/** 本地 14:00（非深夜、非 focus time，闸门②③④均不拦截）。 */
const DAY = new Date(2026, 0, 15, 14, 0, 0).getTime();
/** 本地 23:30（深夜窗口 23:00–07:00）。 */
const DEEP_NIGHT = new Date(2026, 0, 15, 23, 30, 0).getTime();

describe('归一化', () => {
  it('补 ts/dedupeKey 并 trim 文本（ts 缺省 = 入队时刻）', () => {
    const signal = normalizeSignal({ source: 'agent', kind: ' agent_completed ', text: '  完成了  ' }, 1000);
    expect(signal.ts).toBe(1000);
    expect(signal.kind).toBe('agent_completed');
    expect(signal.dedupeKey).toBe('agent:agent_completed:1000');
    expect(signal.text).toBe('完成了');
  });

  it('显式 ts/dedupeKey 原样保留；六路 source 枚举校验', () => {
    const signal = normalizeSignal(
      { source: 'system', kind: 'disk_low', ts: 42, dedupeKey: ' custom-key ', text: '磁盘告警' },
      1000,
    );
    expect(signal.ts).toBe(42);
    expect(signal.dedupeKey).toBe('custom-key');
    expect(isSignalSource('memory')).toBe(true);
    expect(isSignalSource('nope')).toBe(false);
  });

  it('结构性非法抛 TypeError（编程错误尽早暴露，不静默丢信号）', () => {
    expect(() => normalizeSignal({ source: 'nope' as SignalSource, kind: 'x' }, 0)).toThrow(TypeError);
    expect(() => normalizeSignal({ source: 'agent', kind: '   ' }, 0)).toThrow(TypeError);
  });
});

describe('消费出队与幂等去重', () => {
  it('高分信号 → SPEAK 并预扣预算；同 dedupeKey 再入队只处理一次', () => {
    const queue = new SignalQueue({ now: DAY, logger: silentLogger });
    queue.enqueue({ source: 'agent', kind: 'agent_completed', dedupeKey: 'k-speak', score: 95, text: '任务完成' });

    const first = queue.consumeNext()!;
    expect(first.decision.tier).toBe('SPEAK');
    expect(first.decision.reason).toBe('urgent');
    expect(first.budgetCharged).toBe(true);
    expect(first.degraded).toBe(false);
    expect(queue.snapshotState().spokenToday).toBe(1);
    expect(queue.snapshotState().instantSpeakToday).toBe(1);

    queue.enqueue({ source: 'agent', kind: 'agent_completed', dedupeKey: 'k-speak', score: 95, text: '任务完成' });
    const second = queue.consumeNext()!;
    expect(second.decision.duplicate).toBe(true);
    expect(second.decision.tier).toBe('SILENT');
    expect(second.budgetCharged).toBe(false);
    // 幂等账本不重复计费、不重复记键
    expect(queue.snapshotState().spokenToday).toBe(1);
    expect(queue.snapshotState().seenKeys).toEqual(['k-speak']);
    expect(queue.consumeNext()).toBeNull();
  });

  it('低分信号 SILENT low_relevance，但仍记幂等键（不丢去重信息）', () => {
    const queue = new SignalQueue({ now: DAY, logger: silentLogger });
    queue.enqueue({ source: 'time', kind: 'tick', dedupeKey: 'k-low', score: 10 });
    const consumed = queue.consumeNext()!;
    expect(consumed.decision.tier).toBe('SILENT');
    expect(consumed.decision.reason).toBe('low_relevance');
    expect(consumed.budgetCharged).toBe(false);
    expect(queue.snapshotState().seenKeys).toEqual(['k-low']);
  });
});

describe('PREPARE 预扣与出队不复扣（残余风险①）', () => {
  it('PREPARE 准入即预扣；flushPrepared 只交付、不判定/不复扣', () => {
    const queue = new SignalQueue({ now: DAY, logger: silentLogger });
    queue.enqueue({ source: 'agent', kind: 'agent_completed', dedupeKey: 'k-prepare', score: 70 });

    const consumed = queue.consumeNext()!;
    expect(consumed.decision.tier).toBe('PREPARE');
    expect(consumed.decision.reason).toBe('batched');
    expect(consumed.budgetCharged).toBe(true);
    expect(queue.snapshotState().spokenToday).toBe(1);
    expect(queue.preparedCount).toBe(1);

    const flushed = queue.flushPrepared();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]!.signal.dedupeKey).toBe('k-prepare');
    // 出队不复扣：预算/口播配额/幂等账本一字不动
    expect(queue.snapshotState().spokenToday).toBe(1);
    expect(queue.snapshotState().instantSpeakToday).toBe(0);
    expect(queue.snapshotState().seenKeys).toEqual(['k-prepare']);
    expect(queue.flushPrepared()).toEqual([]);
    expect(queue.preparedCount).toBe(0);
  });

  it('预算硬顶：at-quota 一律 STORE/budget_exhausted，零增量、不预扣', () => {
    const queue = new SignalQueue({ now: DAY, logger: silentLogger, state: { config: { baseDailyBudget: 1 } } });
    queue.enqueue({ source: 'agent', kind: 'a', dedupeKey: 'k-a', score: 70 });
    const first = queue.consumeNext()!;
    expect(first.decision.tier).toBe('PREPARE');
    expect(queue.snapshotState().spokenToday).toBe(1);

    queue.enqueue({ source: 'agent', kind: 'b', dedupeKey: 'k-b', score: 70 });
    const second = queue.consumeNext()!;
    expect(second.decision.tier).toBe('STORE');
    expect(second.decision.reason).toBe('budget_exhausted');
    expect(second.budgetCharged).toBe(false);
    expect(queue.snapshotState().spokenToday).toBe(1);
    expect(queue.preparedCount).toBe(1); // 只有第一条攒批
  });
});

describe('seenKeys 裁剪（残余风险②）', () => {
  it('超过 maxSeenKeys 自动丢最旧（只保留最近 N）', () => {
    const queue = new SignalQueue({ now: DAY, logger: silentLogger, maxSeenKeys: 3 });
    for (let i = 1; i <= 5; i++) {
      queue.enqueue({ source: 'time', kind: 'tick', dedupeKey: `k${i}`, score: 10 });
      queue.consumeNext();
    }
    expect(queue.snapshotState().seenKeys).toEqual(['k3', 'k4', 'k5']);
  });

  it('超过 TTL 的键在下一次裁剪时丢弃；未过期保留', () => {
    const queue = new SignalQueue({ now: 0, logger: silentLogger, maxSeenKeys: 100, seenKeyTtlMs: 1000 });
    queue.enqueue({ source: 'time', kind: 'tick', dedupeKey: 'old', score: 10 });
    queue.consumeNext();

    queue.refreshNow(2000);
    queue.enqueue({ source: 'time', kind: 'tick', dedupeKey: 'new', score: 10 });
    queue.consumeNext();

    expect(queue.trimSeenKeys()).toBe(1);
    expect(queue.snapshotState().seenKeys).toEqual(['new']);
    expect(queue.trimSeenKeys()).toBe(0);
  });
});

describe('state.now 显式注入（残余风险③）', () => {
  it('深夜判定按注入时刻；refreshNow 更新后同一信号改判', () => {
    const queue = new SignalQueue({ now: DEEP_NIGHT, logger: silentLogger });
    queue.enqueue({ source: 'system', kind: 'disk_low', dedupeKey: 'k-night', score: 70 });
    const night = queue.consumeNext()!;
    expect(night.decision.tier).toBe('PREPARE');
    expect(night.decision.reason).toBe('deep_night');

    queue.refreshNow(DAY);
    expect(queue.now).toBe(DAY);
    queue.enqueue({ source: 'system', kind: 'disk_low', dedupeKey: 'k-day', score: 70 });
    const day = queue.consumeNext()!;
    expect(day.decision.reason).toBe('batched');
  });
});

describe('降级：配置错误回退保守默认（残余风险对应 §11.4 路径 3）', () => {
  it('配置非法 → 非紧急落 STORE、>85 仍可 SPEAK；重复键仍幂等', () => {
    const queue = new SignalQueue({
      now: DAY,
      logger: silentLogger,
      state: { config: { disruptionThreshold: Number.NaN } },
    });

    queue.enqueue({ source: 'agent', kind: 'normal', dedupeKey: 'k-norm', score: 70 });
    const normal = queue.consumeNext()!;
    expect(normal.degraded).toBe(true);
    expect(normal.decision.tier).toBe('STORE');
    expect(normal.decision.reason).toBe('budget_exhausted');
    expect(normal.budgetCharged).toBe(false);

    queue.enqueue({ source: 'agent', kind: 'urgent', dedupeKey: 'k-urgent', score: 96 });
    const urgent = queue.consumeNext()!;
    expect(urgent.degraded).toBe(true);
    expect(urgent.decision.tier).toBe('SPEAK');
    expect(urgent.decision.reason).toBe('urgent');
    expect(urgent.budgetCharged).toBe(true);

    queue.enqueue({ source: 'agent', kind: 'normal', dedupeKey: 'k-norm', score: 70 });
    const duplicate = queue.consumeNext()!;
    expect(duplicate.decision.duplicate).toBe(true);
    expect(duplicate.decision.tier).toBe('SILENT');
  });
});

describe('快照与恢复（GatesState 持有与持久化结构，落盘由接线层决定）', () => {
  it('恢复后幂等账本继续生效，重复键不重判', () => {
    const queue = new SignalQueue({ now: DAY, logger: silentLogger });
    queue.enqueue({ source: 'agent', kind: 'a', dedupeKey: 'k-keep', score: 96 });
    queue.consumeNext();
    const snapshot = queue.snapshotState();

    const restored = new SignalQueue({ now: DAY, logger: silentLogger });
    restored.restoreState(snapshot);
    restored.enqueue({ source: 'agent', kind: 'a', dedupeKey: 'k-keep', score: 96 });
    const again = restored.consumeNext()!;
    expect(again.decision.duplicate).toBe(true);
    expect(restored.snapshotState().spokenToday).toBe(snapshot.spokenToday);
    expect(restored.snapshotState().seenKeys).toEqual(['k-keep']);
  });
});
