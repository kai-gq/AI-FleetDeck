/**
 * 语音伙伴客户端配置 sanitize 测试(P9:面板暴露 maxSegmentMs / startThreshold)
 *
 * 只测纯函数 sanitizeVoiceCompanionConfig,不触网:
 *   - startThreshold 是 0..1 的比值域,必须保留小数(旧实现 clampInt 会取整)
 *   - maxSegmentMs 走毫秒整数域,越界钳制
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_VOICE_COMPANION_CONFIG, sanitizeVoiceCompanionConfig } from './voiceCompanion';

function sanitizeListening(overrides: Record<string, unknown>) {
  return sanitizeVoiceCompanionConfig({ listening: overrides }).listening;
}

describe('sanitizeVoiceCompanionConfig · listening', () => {
  it('keeps fractional startThreshold(0..1 比值域,不取整)', () => {
    expect(sanitizeListening({ startThreshold: 0.15 }).startThreshold).toBe(0.15);
    expect(sanitizeListening({ startThreshold: 0.5 }).startThreshold).toBe(0.5);
  });

  it('clamps startThreshold to [0,1] and defaults on garbage', () => {
    expect(sanitizeListening({ startThreshold: 5 }).startThreshold).toBe(1);
    expect(sanitizeListening({ startThreshold: -1 }).startThreshold).toBe(0);
    expect(sanitizeListening({ startThreshold: 'abc' }).startThreshold).toBe(
      DEFAULT_VOICE_COMPANION_CONFIG.listening.startThreshold,
    );
    expect(sanitizeListening({}).startThreshold).toBe(0);
  });

  it('clamps maxSegmentMs to [3000, 120000] and keeps in-range ints', () => {
    expect(sanitizeListening({ maxSegmentMs: 10_000 }).maxSegmentMs).toBe(10_000);
    expect(sanitizeListening({ maxSegmentMs: 100 }).maxSegmentMs).toBe(3_000);
    expect(sanitizeListening({ maxSegmentMs: 999_999 }).maxSegmentMs).toBe(120_000);
    expect(sanitizeListening({}).maxSegmentMs).toBe(30_000);
  });

  it('leaves other listening fields on their shipped defaults for junk input', () => {
    const l = sanitizeListening({ silenceMs: 'x', confirmMs: 'x', wakeWord: 42 });
    expect(l.silenceMs).toBe(DEFAULT_VOICE_COMPANION_CONFIG.listening.silenceMs);
    expect(l.confirmMs).toBe(DEFAULT_VOICE_COMPANION_CONFIG.listening.confirmMs);
    expect(l.wakeWord).toBe('');
  });
});
