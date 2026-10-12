import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LEASE_HOLD_MS,
  DEFAULT_MAX_CONCURRENT_STARTS,
  PROCESS_START_GATE_HOLD_MS_ENV,
  PROCESS_START_GATE_MAX_ENV,
  ProcessStartGate,
  isProcessStartGateEnabled,
  resolveProcessStartGateHoldMs,
  resolveProcessStartGateMax,
  type StartGateLease,
} from './start-gate.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** 队列放行是同步 resolve + then 微任务：等到 promise 结算后再断言。
 *  用微任务（而非 setImmediate）——fake timers 会连 setImmediate 一起接管。 */
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

function track(gate: ProcessStartGate, agentId: string): { settled: StartGateLease | null; promise: Promise<StartGateLease> } {
  const box: { settled: StartGateLease | null; promise: Promise<StartGateLease> } = { settled: null, promise: Promise.resolve() as unknown as Promise<StartGateLease> };
  box.promise = gate.acquire(agentId).then((lease) => {
    box.settled = lease;
    return lease;
  });
  return box;
}

describe('ProcessStartGate — 并发启动上限', () => {
  it('低于上限直通：不排队，active 计数正确', async () => {
    const gate = new ProcessStartGate({ maxConcurrent: 2, holdMs: 60_000 });

    await gate.acquire('a');
    await gate.acquire('b');

    expect(gate.getActiveCount()).toBe(2);
    expect(gate.getWaitingCount()).toBe(0);
  });

  it('到达上限后排队：FIFO，每次释放恰好放行一个', async () => {
    const gate = new ProcessStartGate({ maxConcurrent: 1, holdMs: 60_000 });

    const a = await gate.acquire('a');
    const b = track(gate, 'b');
    const c = track(gate, 'c');
    await flush();
    expect(b.settled).toBeNull();
    expect(c.settled).toBeNull();
    expect(gate.getWaitingCount()).toBe(2);

    a.release();
    await flush();
    expect(b.settled).not.toBeNull();
    expect(c.settled).toBeNull();
    expect(gate.getActiveCount()).toBe(1);

    b.settled!.release();
    await flush();
    expect(c.settled).not.toBeNull();
    expect(gate.getWaitingCount()).toBe(0);
  });

  it('release 幂等：释放过的槽位不会被二次归还', async () => {
    const gate = new ProcessStartGate({ maxConcurrent: 1, holdMs: 60_000 });

    const a = await gate.acquire('a');
    a.release();
    a.release();

    expect(gate.getActiveCount()).toBe(0);
    // 上一次双重释放若多还了槽位，这里第二个 acquire 会错误地直通。
    await gate.acquire('b');
    const c = track(gate, 'c');
    await flush();
    expect(c.settled).toBeNull();
    expect(gate.getActiveCount()).toBe(1);
  });

  it('持有超时兜底：既不产出也不退出时强制释放，队列继续走', async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const gate = new ProcessStartGate({ maxConcurrent: 1, holdMs: 1000, log: { log: () => {}, warn } });

    const a = await gate.acquire('a');
    const b = track(gate, 'b');
    await flush();
    expect(b.settled).toBeNull();

    await vi.advanceTimersByTimeAsync(1000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(b.settled).not.toBeNull();
    expect(gate.getActiveCount()).toBe(1);

    a.release();
  });

  it('提前 release 后超时不再二次释放', async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const gate = new ProcessStartGate({ maxConcurrent: 1, holdMs: 1000, log: { log: () => {}, warn } });

    const a = await gate.acquire('a');
    a.release();
    await vi.advanceTimersByTimeAsync(2000);

    expect(warn).not.toHaveBeenCalled();
    expect(gate.getActiveCount()).toBe(0);
  });

  it('开关关闭：直通、不计数、release 为空操作', async () => {
    const gate = new ProcessStartGate({ enabled: false, maxConcurrent: 1 });

    const a = await gate.acquire('a');
    const b = await gate.acquire('b');
    expect(gate.getActiveCount()).toBe(0);
    expect(gate.getWaitingCount()).toBe(0);
    a.release();
    b.release();
    expect(gate.getActiveCount()).toBe(0);
  });
});

describe('ProcessStartGate — 环境变量解析', () => {
  it('开关：未设/空串 → 开；只有显式关闭值才关', () => {
    expect(isProcessStartGateEnabled({})).toBe(true);
    expect(isProcessStartGateEnabled({ [PROCESS_START_GATE_MAX_ENV]: '' })).toBe(true);
    expect(isProcessStartGateEnabled({ TC_PROCESS_START_GATE: '0' })).toBe(false);
    expect(isProcessStartGateEnabled({ TC_PROCESS_START_GATE: 'OFF' })).toBe(false);
    expect(isProcessStartGateEnabled({ TC_PROCESS_START_GATE: 'false' })).toBe(false);
    expect(isProcessStartGateEnabled({ TC_PROCESS_START_GATE: '1' })).toBe(true);
  });

  it('并发上限：正整数生效；0/负数/小数/NaN 一律回退默认（0 会冻死队列）', () => {
    expect(resolveProcessStartGateMax({})).toBe(DEFAULT_MAX_CONCURRENT_STARTS);
    expect(resolveProcessStartGateMax({ [PROCESS_START_GATE_MAX_ENV]: '5' })).toBe(5);
    expect(resolveProcessStartGateMax({ [PROCESS_START_GATE_MAX_ENV]: '0' })).toBe(DEFAULT_MAX_CONCURRENT_STARTS);
    expect(resolveProcessStartGateMax({ [PROCESS_START_GATE_MAX_ENV]: '-3' })).toBe(DEFAULT_MAX_CONCURRENT_STARTS);
    expect(resolveProcessStartGateMax({ [PROCESS_START_GATE_MAX_ENV]: '2.5' })).toBe(DEFAULT_MAX_CONCURRENT_STARTS);
    expect(resolveProcessStartGateMax({ [PROCESS_START_GATE_MAX_ENV]: 'abc' })).toBe(DEFAULT_MAX_CONCURRENT_STARTS);
  });

  it('持有超时：正数生效；0/负数/NaN 回退默认', () => {
    expect(resolveProcessStartGateHoldMs({})).toBe(DEFAULT_LEASE_HOLD_MS);
    expect(resolveProcessStartGateHoldMs({ [PROCESS_START_GATE_HOLD_MS_ENV]: '1500' })).toBe(1500);
    expect(resolveProcessStartGateHoldMs({ [PROCESS_START_GATE_HOLD_MS_ENV]: '0' })).toBe(DEFAULT_LEASE_HOLD_MS);
    expect(resolveProcessStartGateHoldMs({ [PROCESS_START_GATE_HOLD_MS_ENV]: 'abc' })).toBe(DEFAULT_LEASE_HOLD_MS);
  });
});
