/**
 * 音色配置读写纯函数测试(P6:语速/音量)
 *
 * 只测不触网的 sanitize / sanitizeTuning:
 *   - 旧 voices.local.json 没有 rate/volume 字段 → 走默认 0(向后兼容)
 *   - 非法/越界值 → 默认 / 钳制
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_TTS_VOICES, sanitize, sanitizeTuning } from './ttsVoice';

describe('sanitizeTuning', () => {
  it('falls back for missing / empty / non-finite values', () => {
    expect(sanitizeTuning(undefined, 0)).toBe(0);
    expect(sanitizeTuning(null, 7)).toBe(7);
    expect(sanitizeTuning('', 0)).toBe(0);
    expect(sanitizeTuning('abc', 0)).toBe(0);
    expect(sanitizeTuning(NaN, 3)).toBe(3);
    expect(sanitizeTuning(Infinity, 3)).toBe(3);
  });

  it('accepts numbers and numeric strings with optional sign / percent', () => {
    expect(sanitizeTuning(10, 0)).toBe(10);
    expect(sanitizeTuning(-5, 0)).toBe(-5);
    expect(sanitizeTuning('+10', 0)).toBe(10);
    expect(sanitizeTuning('10%', 0)).toBe(10);
    expect(sanitizeTuning('-5%', 0)).toBe(-5);
    expect(sanitizeTuning(0, 9)).toBe(0); // 显式 0 是合法值,不走 fallback
  });

  it('clamps to [-100, 100]', () => {
    expect(sanitizeTuning(150, 0)).toBe(100);
    expect(sanitizeTuning(-150, 0)).toBe(-100);
  });
});

describe('sanitize', () => {
  it('keeps zh/en/es strings and reads rate/volume from the file', () => {
    const cfg = sanitize(
      { zh: 'zh-CN-YunxiNeural', en: ' en-US-AriaNeural ', es: 'es-ES-ElviraNeural', rate: 20, volume: '-10%' },
      DEFAULT_TTS_VOICES,
    );
    expect(cfg).toEqual({
      zh: 'zh-CN-YunxiNeural',
      en: 'en-US-AriaNeural',
      es: 'es-ES-ElviraNeural',
      rate: 20,
      volume: -10,
    });
  });

  it('defaults rate/volume to 0 for legacy files missing the fields', () => {
    const cfg = sanitize({ zh: 'zh-CN-XiaoyiNeural' }, DEFAULT_TTS_VOICES);
    expect(cfg.rate).toBe(0);
    expect(cfg.volume).toBe(0);
  });

  it('falls back entirely for non-object / empty input', () => {
    expect(sanitize(null, DEFAULT_TTS_VOICES)).toEqual(DEFAULT_TTS_VOICES);
    expect(sanitize('nope', DEFAULT_TTS_VOICES)).toEqual(DEFAULT_TTS_VOICES);
    expect(sanitize({ rate: 'junk' }, DEFAULT_TTS_VOICES)).toEqual(DEFAULT_TTS_VOICES);
  });

  it('ignores blank language strings and out-of-range tuning', () => {
    const cfg = sanitize({ zh: '   ', rate: 999, volume: -999 }, DEFAULT_TTS_VOICES);
    expect(cfg.zh).toBe(DEFAULT_TTS_VOICES.zh);
    expect(cfg.rate).toBe(100);
    expect(cfg.volume).toBe(-100);
  });
});
