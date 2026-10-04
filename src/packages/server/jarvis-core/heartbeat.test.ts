/**
 * jarvis-core · heartbeat 单测（任务 26 ⑥）
 *
 * 覆盖：周期触发 / 事件即时唤醒（绕过周期）/ 周期不重叠（触发器-执行分离 +
 * 事件合并轮）/ 阶段失败降级隔离（不吞循环）/ 周期区间归一化。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JarvisLogger } from './executors.js';
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  Heartbeat,
  MAX_HEARTBEAT_INTERVAL_MS,
  MIN_HEARTBEAT_INTERVAL_MS,
  normalizeHeartbeatIntervalMs,
  type HeartbeatCycleSummary,
  type HeartbeatPhaseError,
} from './heartbeat.js';

const silentLogger: JarvisLogger = {
  log: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
};

const MIN = MIN_HEARTBEAT_INTERVAL_MS;

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flushMicrotasks(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('周期配置归一化（初始值非实测，区间 5–15 分钟）', () => {
  it('默认 15 分钟', () => {
    expect(normalizeHeartbeatIntervalMs()).toBe(DEFAULT_HEARTBEAT_INTERVAL_MS);
    expect(DEFAULT_HEARTBEAT_INTERVAL_MS).toBe(15 * 60_000);
  });

  it('越界钳制到 [5,15] 分钟；非法值回落默认', () => {
    expect(normalizeHeartbeatIntervalMs(60_000)).toBe(MIN_HEARTBEAT_INTERVAL_MS);
    expect(normalizeHeartbeatIntervalMs(3 * 60 * 60_000)).toBe(MAX_HEARTBEAT_INTERVAL_MS);
    expect(normalizeHeartbeatIntervalMs(10 * 60_000)).toBe(10 * 60_000);
    expect(normalizeHeartbeatIntervalMs(Number.NaN)).toBe(DEFAULT_HEARTBEAT_INTERVAL_MS);
  });
});

describe('定时路径（wake 定时器）', () => {
  it('每个周期触发一轮；stop 后不再触发', async () => {
    vi.useFakeTimers();
    const runs: string[] = [];
    const heartbeat = new Heartbeat<readonly unknown[], string>({
      intervalMs: MIN,
      logger: silentLogger,
      phases: {
        observe: (ctx) => {
          runs.push(ctx.trigger);
          return [];
        },
        reason: () => 'ok',
        act: () => {},
      },
    });

    heartbeat.start();
    expect(heartbeat.started).toBe(true);
    await vi.advanceTimersByTimeAsync(MIN);
    await vi.advanceTimersByTimeAsync(MIN);
    expect(runs).toEqual(['timer', 'timer']);
    expect(heartbeat.stats.cycles).toBe(2);

    heartbeat.stop();
    expect(heartbeat.started).toBe(false);
    await vi.advanceTimersByTimeAsync(MIN * 3);
    expect(runs).toEqual(['timer', 'timer']);
  });

  it('周期不重叠（触发器/执行分离）：上一轮未结束时周期触发被跳过', async () => {
    vi.useFakeTimers();
    const gate = deferred();
    let runs = 0;
    let acts = 0;
    const heartbeat = new Heartbeat<readonly unknown[], string>({
      intervalMs: MIN,
      logger: silentLogger,
      phases: {
        observe: () => {
          runs++;
          return [];
        },
        reason: () => 'ok',
        act: () => {
          acts++;
          if (acts === 1) return gate.promise;
        },
      },
    });

    heartbeat.start();
    await vi.advanceTimersByTimeAsync(MIN); // 第 1 轮开跑，act 阻塞
    expect(runs).toBe(1);
    expect(heartbeat.busy).toBe(true);

    await vi.advanceTimersByTimeAsync(MIN * 3); // 第 2/3/4 个周期到点 → 全部跳过
    expect(runs).toBe(1);
    expect(heartbeat.stats.skippedTicks).toBe(3);

    gate.resolve();
    await heartbeat.whenIdle();
    expect(heartbeat.busy).toBe(false);

    await vi.advanceTimersByTimeAsync(MIN); // 第 5 个周期正常触发
    expect(runs).toBe(2);
    heartbeat.stop();
  });
});

describe('事件路径（wakeNow 即时唤醒）', () => {
  it('绕过周期立即跑一轮（无需 start）', async () => {
    const runs: string[] = [];
    const heartbeat = new Heartbeat<readonly unknown[], string>({
      logger: silentLogger,
      phases: {
        observe: (ctx) => {
          runs.push(ctx.trigger);
          return [];
        },
        reason: () => 'ok',
        act: () => {},
      },
    });

    expect(heartbeat.wakeNow()).toBe(true);
    await heartbeat.whenIdle();
    expect(runs).toEqual(['event']);
    expect(heartbeat.stats.cycles).toBe(1);
  });

  it('上一轮未结束时事件唤醒合并为紧随其后的一轮（不丢事件）', async () => {
    const gate = deferred();
    const triggers: string[] = [];
    let acts = 0;
    const heartbeat = new Heartbeat<readonly unknown[], string>({
      logger: silentLogger,
      phases: {
        observe: (ctx) => {
          triggers.push(ctx.trigger);
          return [];
        },
        reason: () => 'ok',
        act: () => {
          acts++;
          if (acts === 1) return gate.promise;
        },
      },
    });

    expect(heartbeat.wakeNow()).toBe(true);
    await flushMicrotasks(); // 让第 1 轮走到 act（阻塞）
    expect(heartbeat.busy).toBe(true);

    expect(heartbeat.wakeNow()).toBe(false);
    expect(heartbeat.wakeNow()).toBe(false);
    expect(heartbeat.stats.coalescedWakes).toBe(2);

    gate.resolve();
    await heartbeat.whenIdle();
    expect(triggers).toEqual(['event', 'event']); // 多次唤醒只补跑一轮（合并）
    expect(heartbeat.stats.cycles).toBe(2);
  });
});

describe('降级隔离（失败不吞循环）', () => {
  it('observe 抛错只降级本轮，下一周期照常执行', async () => {
    vi.useFakeTimers();
    const summaries: HeartbeatCycleSummary[] = [];
    const phaseErrors: HeartbeatPhaseError[] = [];
    let observeCalls = 0;
    let reasonCalls = 0;
    let actCalls = 0;
    const heartbeat = new Heartbeat<readonly unknown[], string>({
      intervalMs: MIN,
      logger: silentLogger,
      hooks: {
        onCycleEnd: (summary) => summaries.push(summary),
        onPhaseError: (info) => phaseErrors.push(info),
      },
      phases: {
        observe: () => {
          observeCalls++;
          if (observeCalls === 1) throw new Error('信号源炸了');
          return [];
        },
        reason: () => {
          reasonCalls++;
          return 'ok';
        },
        act: () => {
          actCalls++;
        },
      },
    });

    heartbeat.start();
    await vi.advanceTimersByTimeAsync(MIN);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.completed).toBe(false);
    expect(summaries[0]!.errors.map((e) => e.phase)).toEqual(['observe']);
    expect(reasonCalls).toBe(0);
    expect(actCalls).toBe(0);
    expect(phaseErrors).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(MIN); // 循环没被吞：下一轮全绿
    expect(summaries).toHaveLength(2);
    expect(summaries[1]!.completed).toBe(true);
    expect(actCalls).toBe(1);
    expect(heartbeat.stats.errors).toBe(1);
    heartbeat.stop();
  });

  it('wake 失败不阻断本轮（可选阶段：环境快照刷新失败仍继续读信号）', async () => {
    let observed = 0;
    const heartbeat = new Heartbeat<readonly unknown[], string>({
      logger: silentLogger,
      phases: {
        wake: () => {
          throw new Error('快照刷新失败');
        },
        observe: () => {
          observed++;
          return [];
        },
        reason: () => 'ok',
        act: () => {},
      },
    });

    heartbeat.wakeNow();
    await heartbeat.whenIdle();
    expect(observed).toBe(1);
    expect(heartbeat.stats.errors).toBe(1);
  });

  it('观测钩子抛错不影响循环', async () => {
    const summaries: HeartbeatCycleSummary[] = [];
    const heartbeat = new Heartbeat<readonly unknown[], string>({
      logger: silentLogger,
      hooks: {
        onCycleEnd: (summary) => {
          summaries.push(summary);
          throw new Error('观测出口炸了');
        },
      },
      phases: {
        observe: () => [],
        reason: () => 'ok',
        act: () => {},
      },
    });

    heartbeat.wakeNow();
    await heartbeat.whenIdle();
    expect(summaries).toHaveLength(1);
    expect(heartbeat.stats.errors).toBe(0);
  });
});
