import { describe, expect, it } from 'vitest';
import { computePeaks, formatTimecode, mixToMono } from './audioPeaks';

describe('computePeaks', () => {
  it('keeps the extremes of each bucket instead of averaging them away', () => {
    // A transient (+1) buried in silence must survive the reduction.
    const samples = new Float32Array(1000);
    samples[500] = 1;
    samples[501] = -1;
    const { min, max } = computePeaks(samples, 10);
    expect(max[5]).toBe(1);
    expect(min[5]).toBe(-1);
    expect(max[0]).toBe(0);
  });

  it('covers every sample when buckets do not divide evenly', () => {
    const samples = new Float32Array([0, 0, 0, 0, 0, 0, 0.5]);
    const { max } = computePeaks(samples, 3);
    expect(Math.max(...max)).toBe(0.5);
  });

  it('produces one value per bucket even for a single-sample clip', () => {
    const { min, max } = computePeaks(new Float32Array([0.25]), 4);
    expect(min).toHaveLength(4);
    expect(max[0]).toBe(0.25);
  });

  it('returns silent buckets for empty audio', () => {
    const { min, max } = computePeaks(new Float32Array(0), 3);
    expect([...min]).toEqual([0, 0, 0]);
    expect([...max]).toEqual([0, 0, 0]);
  });

  it('returns empty arrays for a zero bucket count', () => {
    const { min, max } = computePeaks(new Float32Array([0.5]), 0);
    expect(min).toHaveLength(0);
    expect(max).toHaveLength(0);
  });

  it('uses the default 1200 buckets and stretches short clips across the full width', () => {
    // 每个桶的起点恒小于样本数(短片段时多个桶共享同一样本),
    // 因此不是「超出部分为 0 的平尾」,而是整段拉伸铺满绘制宽度。
    const { min, max } = computePeaks(new Float32Array([0.25, -0.5]));
    expect(max).toHaveLength(1200);
    expect(max[0]).toBe(0.25);
    expect(max[1199]).toBe(-0.5);
    expect(min[1199]).toBe(-0.5);
  });
});

describe('mixToMono', () => {
  it('returns the single channel untouched', () => {
    const channel = new Float32Array([0.1, 0.2]);
    expect(mixToMono([channel])).toBe(channel);
  });

  it('averages channels so identical stereo stays at the same amplitude', () => {
    const left = new Float32Array([1, -1]);
    const right = new Float32Array([1, -1]);
    expect([...mixToMono([left, right])]).toEqual([1, -1]);
  });

  it('cancels opposite channels', () => {
    expect([...mixToMono([new Float32Array([1]), new Float32Array([-1])])]).toEqual([0]);
  });

  it('handles no channels', () => {
    expect(mixToMono([])).toHaveLength(0);
  });

  it('averages channels of unequal length by the usable overlap and keeps the longest length', () => {
    const mono = mixToMono([new Float32Array([1, 1, 1]), new Float32Array([1])]);
    expect([...mono]).toEqual([1, 0.5, 0.5]); // 短通道只参与重叠部分,除数仍是通道数
  });
});

describe('formatTimecode', () => {
  it('formats under an hour as m:ss', () => {
    expect(formatTimecode(0)).toBe('0:00');
    expect(formatTimecode(9.4)).toBe('0:09');
    expect(formatTimecode(75)).toBe('1:15');
  });

  it('formats an hour or more as h:mm:ss', () => {
    expect(formatTimecode(3725)).toBe('1:02:05');
  });

  it('guards against NaN/Infinity durations from a streaming element', () => {
    expect(formatTimecode(Number.NaN)).toBe('0:00');
    expect(formatTimecode(Number.POSITIVE_INFINITY)).toBe('0:00');
    expect(formatTimecode(-3)).toBe('0:00');
  });

  it('rolls over at minute/hour boundaries with floor semantics', () => {
    expect(formatTimecode(59.999)).toBe('0:59');
    expect(formatTimecode(60)).toBe('1:00');
    expect(formatTimecode(3599)).toBe('59:59');
    expect(formatTimecode(3600)).toBe('1:00:00');
  });
});
