import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSlowFiller } from './slow-filler.js';

/** 测试基准口径(取一个可辨识的组合;真实缺省见 voice-companion-service DEFAULT_SERVER_CONFIG):2.5s 预生成、5.5s 最早吐出。 */
function setup(overrides: Partial<Parameters<typeof createSlowFiller>[0]> = {}) {
  const emitted: string[] = [];
  const generate = vi.fn(async (): Promise<string | null> => '稍等,我看看。');
  const filler = createSlowFiller({
    enabled: true,
    armMs: 2_500,
    emitMs: 5_500,
    generate,
    emit: (s) => emitted.push(s),
    ...overrides,
  });
  return { filler, emitted, generate };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createSlowFiller(W5 慢档续垫)', () => {
  it('armMs 才发起预生成;未到 emitMs 一律不吐(即使已就绪)', async () => {
    vi.useFakeTimers();
    const { filler, emitted, generate } = setup();
    filler.arm();

    await vi.advanceTimersByTimeAsync(2_499);
    expect(generate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(generate).toHaveBeenCalledTimes(1); // 2.5s 预生成
    await vi.advanceTimersByTimeAsync(2_999);
    expect(emitted).toEqual([]); // 5.499s:已就绪但没到点

    await vi.advanceTimersByTimeAsync(1);
    expect(emitted).toEqual(['稍等,我看看。']); // 5.5s 到点即吐
    expect(filler.emitted).toBe(true);
  });

  it('armMs=0(W7 预生成档):立即取用,emitMs 到点即吐', async () => {
    vi.useFakeTimers();
    const { filler, emitted, generate } = setup({ armMs: 0, emitMs: 1_200 });
    filler.arm();

    await vi.advanceTimersByTimeAsync(0);
    expect(generate).toHaveBeenCalledTimes(1); // 立即取用预生成
    await vi.advanceTimersByTimeAsync(1_200);
    expect(emitted).toEqual(['稍等,我看看。']);
  });

  it('真实首句先到(cancel)→ 不再吐,且此后不会补吐', async () => {
    vi.useFakeTimers();
    const { filler, emitted } = setup();
    filler.arm();
    await vi.advanceTimersByTimeAsync(3_000); // 已生成就绪
    filler.cancel(); // 首句已出声

    await vi.advanceTimersByTimeAsync(10_000);
    expect(emitted).toEqual([]);
    expect(filler.emitted).toBe(false);
  });

  it('cancel 早于预生成 → 连生成都不会发起', async () => {
    vi.useFakeTimers();
    const { filler, generate } = setup();
    filler.arm();
    filler.cancel();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(generate).not.toHaveBeenCalled();
  });

  it('到点但生成未回来 → 生成一回来就补吐(不丢垫话)', async () => {
    vi.useFakeTimers();
    let resolveGen!: (s: string | null) => void;
    const generate = vi.fn(() => new Promise<string | null>((r) => { resolveGen = r; }));
    const { filler, emitted } = setup({ generate });
    filler.arm();

    await vi.advanceTimersByTimeAsync(5_500);
    expect(emitted).toEqual([]); // 到点但还没就绪
    resolveGen('这就来。');
    await vi.advanceTimersByTimeAsync(0); // 冲刷微任务
    expect(emitted).toEqual(['这就来。']);
  });

  it('生成失败/超时(自家兜底 null)→ 静默,绝不念半成品', async () => {
    vi.useFakeTimers();
    const generate = vi.fn(async (): Promise<string | null> => null);
    const { filler, emitted } = setup({ generate });
    filler.arm();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(emitted).toEqual([]);
    expect(filler.emitted).toBe(false);
  });

  it('generate 抛错也不炸(generate 契约允许 throw,实现兜底静默)', async () => {
    vi.useFakeTimers();
    const generate = vi.fn(async (): Promise<string | null> => { throw new Error('boom'); });
    const { filler, emitted } = setup({ generate });
    filler.arm();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(emitted).toEqual([]);
  });

  it('每回合最多一句:吐过之后 cancel/再等都不重复', async () => {
    vi.useFakeTimers();
    const { filler, emitted } = setup();
    filler.arm();
    await vi.advanceTimersByTimeAsync(5_500);
    filler.cancel(); // 真实首句随后到
    await vi.advanceTimersByTimeAsync(10_000);
    expect(emitted).toEqual(['稍等,我看看。']);
  });

  it('enabled=false 完全不武装(env TC_VOICE_SLOW_FILLER=0 / 配置关)', async () => {
    vi.useFakeTimers();
    const { filler, emitted, generate } = setup({ enabled: false });
    filler.arm();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(generate).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
  });

  it('重复 arm 幂等(不会装两套计时器吐两句)', async () => {
    vi.useFakeTimers();
    const { filler, emitted, generate } = setup();
    filler.arm();
    filler.arm();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(emitted).toEqual(['稍等,我看看。']);
  });
});
