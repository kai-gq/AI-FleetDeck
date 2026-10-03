import { describe, it, expect } from 'vitest';
import {
  SILERO_CONTEXT,
  SILERO_INPUT_SIZE,
  SILERO_STATE_SIZE,
  SILERO_WINDOW,
  createSileroVadCore,
  createWindowAssembler,
  type SileroInfer,
  type SileroInferResult,
} from './sileroVadCore.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

/** 手动放闸的假推理:记录每次调用,由测试显式 resolve/reject。 */
function gatedInfer() {
  const calls: Array<{
    input: Float32Array;
    state: Float32Array;
    resolve: (r: SileroInferResult) => void;
    reject: (e: unknown) => void;
  }> = [];
  const infer: SileroInfer = (input, state) =>
    new Promise<SileroInferResult>((resolve, reject) => {
      calls.push({ input, state, resolve, reject });
    });
  return { infer, calls };
}

const newState = (fill = 1) => new Float32Array(SILERO_STATE_SIZE).fill(fill);

/** 512 样本、全为 marker 的音频(正好凑一个窗口)。 */
const markerWindow = (marker: number) => new Float32Array(SILERO_WINDOW).fill(marker);

describe('createWindowAssembler', () => {
  const frame = (start: number) => Float32Array.from({ length: 480 }, (_, i) => start + i);

  it('assembles a 576-sample window from 480-sample frames with 64-sample context', () => {
    const a = createWindowAssembler();
    expect(a.push(frame(0))).toHaveLength(0); // 480 < 512,还凑不齐
    const w = a.push(frame(480)); // 累计 960 → 窗口 1
    expect(w).toHaveLength(1);
    expect(w[0].length).toBe(SILERO_INPUT_SIZE);
    // 首窗上下文为零,随后是样本 0..511
    expect(w[0][0]).toBe(0);
    expect(w[0][SILERO_CONTEXT - 1]).toBe(0);
    expect(w[0][SILERO_CONTEXT]).toBe(0);
    expect(w[0][SILERO_INPUT_SIZE - 1]).toBe(511);
  });

  it('carries the previous window tail as the next window context', () => {
    const a = createWindowAssembler();
    a.push(frame(0));
    a.push(frame(480));
    const w2 = a.push(frame(960));
    expect(w2).toHaveLength(1);
    // 窗口 2 覆盖样本 512..1023,上下文 = 样本 448..511
    expect(w2[0][0]).toBe(448);
    expect(w2[0][SILERO_CONTEXT - 1]).toBe(511);
    expect(w2[0][SILERO_CONTEXT]).toBe(512);
    expect(w2[0][SILERO_INPUT_SIZE - 1]).toBe(1023);
  });

  it('emits floor(total/512) windows and keeps the remainder pending', () => {
    const a = createWindowAssembler();
    let windows = 0;
    for (let i = 0; i < 20; i++) windows += a.push(frame(i * 480)).length;
    expect(windows).toBe(18); // 9600 / 512
  });

  it('reset clears pending samples and context', () => {
    const a = createWindowAssembler();
    a.push(frame(0));
    a.reset();
    expect(a.push(frame(1000))).toHaveLength(0); // 上一帧已清掉
    const w = a.push(frame(1480)); // 1000..1959 → 窗口 1(零上下文 + 1000..1511)
    expect(w).toHaveLength(1);
    expect(w[0][0]).toBe(0);
    expect(w[0][SILERO_CONTEXT]).toBe(1000);
  });
});

describe('createSileroVadCore', () => {
  it('returns null until the first inference resolves, then the latest prob', async () => {
    const { infer, calls } = gatedInfer();
    const core = createSileroVadCore(infer);
    expect(core.push(markerWindow(1))).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toHaveLength(SILERO_INPUT_SIZE);
    calls[0].resolve({ prob: 0.72, state: newState(2) });
    await flush();
    expect(core.prob()).toBe(0.72);
    expect(core.push(markerWindow(2))).toBe(0.72); // 新窗在途,返回的仍是最近完成值
  });

  it('feeds the previous result state back into the next inference', async () => {
    const { infer, calls } = gatedInfer();
    const core = createSileroVadCore(infer);
    core.push(markerWindow(1));
    calls[0].resolve({ prob: 0.5, state: newState(7) });
    await flush();
    core.push(markerWindow(2));
    expect(calls).toHaveLength(2);
    expect(calls[1].state[0]).toBe(7); // 回灌上一次的 state
  });

  it('drops the oldest queued windows while an inference is in flight', async () => {
    const { infer, calls } = gatedInfer();
    const core = createSileroVadCore(infer, { maxQueue: 2 });
    core.push(markerWindow(1)); // 在途,queue []
    core.push(markerWindow(2)); // queue [2]
    core.push(markerWindow(3)); // queue [2,3]
    core.push(markerWindow(4)); // queue [2,3,4] → 丢 2
    core.push(markerWindow(5)); // queue [3,4,5] → 丢 3
    expect(calls).toHaveLength(1);
    expect(core.pendingCount()).toBe(3); // 1 在途 + 2 排队

    calls[0].resolve({ prob: 0.9, state: newState(1) });
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1].input[SILERO_CONTEXT]).toBe(4); // 下一个吃到的是 4(最旧的被丢)

    calls[1].resolve({ prob: 0.8, state: newState(1) });
    await flush();
    expect(calls).toHaveLength(3);
    expect(calls[2].input[SILERO_CONTEXT]).toBe(5);

    calls[2].resolve({ prob: 0.1, state: newState(1) });
    await flush();
    expect(core.prob()).toBe(0.1);
    expect(core.pendingCount()).toBe(0);
  });

  it('reset discards in-flight results and restarts from zero state', async () => {
    const { infer, calls } = gatedInfer();
    const core = createSileroVadCore(infer);
    core.push(markerWindow(1));
    expect(calls).toHaveLength(1);
    core.reset();
    calls[0].resolve({ prob: 0.9, state: newState(7) }); // 迟到的旧结果
    await flush();
    expect(core.prob()).toBeNull();
    expect(core.pendingCount()).toBe(0);

    core.push(markerWindow(2));
    expect(calls).toHaveLength(2);
    expect(calls[1].state.every((v) => v === 0)).toBe(true); // 状态已清零
  });

  it('survives a failed inference and keeps consuming later windows', async () => {
    const { infer, calls } = gatedInfer();
    const core = createSileroVadCore(infer);
    core.push(markerWindow(1));
    calls[0].resolve({ prob: 0.7, state: newState(1) });
    await flush();
    expect(core.prob()).toBe(0.7);

    core.push(markerWindow(2));
    calls[1].reject(new Error('boom'));
    await flush();
    expect(core.prob()).toBe(0.7); // 概率保持

    core.push(markerWindow(3));
    expect(calls).toHaveLength(3); // 链路继续
    calls[2].resolve({ prob: 0.2, state: newState(1) });
    await flush();
    expect(core.prob()).toBe(0.2);
  });

  // ---- 阶段一补测:队列边界/代数守卫/记录项 ----

  it('maxQueue 0 drops every window instead of inferring', async () => {
    const { infer, calls } = gatedInfer();
    const core = createSileroVadCore(infer, { maxQueue: 0 });
    core.push(markerWindow(1));
    core.push(markerWindow(2));
    expect(calls).toHaveLength(0); // 积压上限为 0:窗口进了就丢,从不推理
    expect(core.pendingCount()).toBe(0);
    expect(core.prob()).toBeNull();
  });

  it('a single oversized frame keeps only the newest windows up to maxQueue', async () => {
    const { infer, calls } = gatedInfer();
    const core = createSileroVadCore(infer, { maxQueue: 2 });
    // 一帧 1536 样本 → 一次产出 3 个窗口(样本 0..511 / 512..1023 / 1024..1535)
    const frame = Float32Array.from({ length: 3 * SILERO_WINDOW }, (_, i) => i);
    core.push(frame);
    expect(calls).toHaveLength(1);
    expect(calls[0].input[SILERO_CONTEXT]).toBe(SILERO_WINDOW); // 最旧(0..511)已丢,在途的是第 2 窗

    calls[0].resolve({ prob: 0.5, state: newState(1) });
    await flush();
    expect(calls[1].input[SILERO_CONTEXT]).toBe(2 * SILERO_WINDOW); // 接着是最新的第 3 窗
  });

  it('emits a window exactly at 512 samples and waits one sample short of it', async () => {
    const { infer, calls } = gatedInfer();
    const core = createSileroVadCore(infer);
    const samples = Float32Array.from({ length: SILERO_WINDOW }, (_, i) => i);

    core.push(samples.subarray(0, SILERO_WINDOW - 1)); // 511:还差 1 个
    expect(calls).toHaveLength(0);
    core.push(samples.subarray(SILERO_WINDOW - 1)); // 补上第 512 个 → 成窗
    expect(calls).toHaveLength(1);
    expect(calls[0].input[SILERO_CONTEXT]).toBe(0); // 首窗零上下文
    expect(calls[0].input[SILERO_INPUT_SIZE - 1]).toBe(SILERO_WINDOW - 1);
  });

  it('passes a NaN probability through without sanitising (upper layer filters)', async () => {
    const { infer, calls } = gatedInfer();
    const core = createSileroVadCore(infer);
    core.push(markerWindow(1));
    calls[0].resolve({ prob: Number.NaN, state: newState(1) });
    await flush();
    expect(Number.isNaN(core.prob())).toBe(true);
  });

  it('reset clears queued (not just in-flight) windows and invalidates their generation', async () => {
    const { infer, calls } = gatedInfer();
    const core = createSileroVadCore(infer);
    core.push(markerWindow(1)); // 在途
    core.push(markerWindow(2)); // 排队
    core.push(markerWindow(3));
    expect(core.pendingCount()).toBe(3);

    core.reset();
    expect(core.pendingCount()).toBe(0); // 排队的 2、3 一并清掉

    calls[0].resolve({ prob: 0.9, state: newState(7) }); // 在途旧结果
    await flush();
    expect(core.prob()).toBeNull();

    core.push(markerWindow(4));
    expect(calls).toHaveLength(2); // 旧队列没有偷偷补跑:这是 reset 后的第一次推理
    expect(calls[1].state.every((v) => v === 0)).toBe(true);
  });

  it.fails('survives a synchronously-throwing infer (known gap, tracked for 阶段二)', async () => {
    let calls = 0;
    const infer: SileroInfer = () => {
      calls++;
      throw new Error('sync boom'); // 同步抛出而非 Promise reject
    };
    const core = createSileroVadCore(infer);
    expect(() => core.push(markerWindow(1))).toThrow(); // 当前实现把异常抛给调用方

    core.push(markerWindow(2));
    await flush();
    expect(calls).toBe(2); // 期望链路继续;实际 inflight 永久卡住,calls 停在 1
  });
});
