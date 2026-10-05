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

describe('sanitizeVoiceCompanionConfig · brain 直通键', () => {
  const sanitizeBrain = (overrides: Record<string, unknown>) =>
    sanitizeVoiceCompanionConfig({ brain: overrides }).brain;

  // W2 阶段2:不设面板,但面板保存一次必须不能把值改丢(sanitize 原样保留 + 钳制)。
  it('firstSentenceMaxChars 原样保留,钳 [0,60],垃圾输入回缺省 0(关)', () => {
    expect(sanitizeBrain({ firstSentenceMaxChars: 24 }).firstSentenceMaxChars).toBe(24);
    expect(sanitizeBrain({ firstSentenceMaxChars: 0 }).firstSentenceMaxChars).toBe(0);
    expect(sanitizeBrain({ firstSentenceMaxChars: 999 }).firstSentenceMaxChars).toBe(60);
    expect(sanitizeBrain({ firstSentenceMaxChars: -3 }).firstSentenceMaxChars).toBe(0);
    expect(sanitizeBrain({ firstSentenceMaxChars: 'abc' }).firstSentenceMaxChars).toBe(0);
    expect(sanitizeBrain({}).firstSentenceMaxChars).toBe(DEFAULT_VOICE_COMPANION_CONFIG.brain.firstSentenceMaxChars);
  });

  // W7 预生成命中档:同样不设面板、原样保留 + 钳制(否则面板保存一次就丢)。
  it('slowFiller.pregenEmitMs 原样保留,钳 [300,10000],垃圾输入回缺省 3000', () => {
    expect(sanitizeBrain({ slowFiller: { pregenEmitMs: 2_000 } }).slowFiller.pregenEmitMs).toBe(2_000);
    expect(sanitizeBrain({ slowFiller: { pregenEmitMs: 100 } }).slowFiller.pregenEmitMs).toBe(300);
    expect(sanitizeBrain({ slowFiller: { pregenEmitMs: 99_999 } }).slowFiller.pregenEmitMs).toBe(10_000);
    expect(sanitizeBrain({ slowFiller: { pregenEmitMs: 'abc' } }).slowFiller.pregenEmitMs).toBe(3_000);
    expect(sanitizeBrain({}).slowFiller.pregenEmitMs).toBe(DEFAULT_VOICE_COMPANION_CONFIG.brain.slowFiller.pregenEmitMs);
    // 与既有键互不干扰
    const sf = sanitizeBrain({ slowFiller: { enabled: false, armMs: 800, emitMs: 3_000, pregenEmitMs: 900 } }).slowFiller;
    expect(sf).toEqual({ enabled: false, armMs: 800, emitMs: 3_000, pregenEmitMs: 900 });
  });
});
