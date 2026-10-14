/**
 * 音色配置读写纯函数测试(P6:语速/音量;2026-10-14 补:引擎切换/火山字段/「上次播报」状态)
 *
 * 只测不触网的 sanitize / sanitizeTuning / describeShimState:
 *   - 旧 voices.local.json 没有 rate/volume/engine/volcano 字段 → 走默认(向后兼容)
 *   - 非法/越界值 → 默认 / 钳制;volcano 空串是有效值(= 该语言回退 edge)
 *   - volcano 深拷贝防默认对象别名污染
 *   - describeShimState 五态映射
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_TTS_VOICES, VOLCANO_FALLBACK_VALUE, VOLCANO_VOICE_GROUPS, describeShimState, sanitize, sanitizeTuning } from './ttsVoice';

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
    expect(cfg.zh).toBe('zh-CN-YunxiNeural');
    expect(cfg.en).toBe('en-US-AriaNeural');
    expect(cfg.es).toBe('es-ES-ElviraNeural');
    expect(cfg.rate).toBe(20);
    expect(cfg.volume).toBe(-10);
  });

  it('defaults rate/volume to 0 for legacy files missing the fields', () => {
    const cfg = sanitize({ zh: 'zh-CN-XiaoyiNeural' }, DEFAULT_TTS_VOICES);
    expect(cfg.rate).toBe(0);
    expect(cfg.volume).toBe(0);
  });

  it('legacy file without engine/volcano → edge-tts equivalent(向后兼容)', () => {
    const cfg = sanitize({ zh: 'zh-CN-XiaoyiNeural', rate: 5 }, DEFAULT_TTS_VOICES);
    expect(cfg.engine).toBe('edge-tts');
    expect(cfg.volcano).toEqual(DEFAULT_TTS_VOICES.volcano);
    expect(cfg.volcanoApiKey).toBe('');
    expect(cfg.volcanoResourceId).toBe('');
  });

  it('accepts only known engines; anything else falls back to edge-tts', () => {
    expect(sanitize({ engine: 'volcano' }, DEFAULT_TTS_VOICES).engine).toBe('volcano');
    expect(sanitize({ engine: 'Edge-TTS' }, DEFAULT_TTS_VOICES).engine).toBe('edge-tts');
    expect(sanitize({ engine: 42 }, DEFAULT_TTS_VOICES).engine).toBe('edge-tts');
  });

  it('volcano: empty string is a valid value(= 该语言回退 edge-tts)', () => {
    const cfg = sanitize({ volcano: { zh: '', en: 'en_male_tim_uranus_bigtts' } }, DEFAULT_TTS_VOICES);
    expect(cfg.volcano.zh).toBe('');
    expect(cfg.volcano.en).toBe('en_male_tim_uranus_bigtts');
    expect(cfg.volcano.es).toBe(DEFAULT_TTS_VOICES.volcano.es); // 未提及的语言保持默认
  });

  it('volcano: non-object / non-string fields are ignored', () => {
    expect(sanitize({ volcano: 'nope' }, DEFAULT_TTS_VOICES).volcano).toEqual(DEFAULT_TTS_VOICES.volcano);
    expect(sanitize({ volcano: { zh: 7 } }, DEFAULT_TTS_VOICES).volcano.zh).toBe(DEFAULT_TTS_VOICES.volcano.zh);
  });

  it('does not alias the module-level defaults(volcano 深拷贝)', () => {
    const before = DEFAULT_TTS_VOICES.volcano.zh;
    const cfg = sanitize({}, DEFAULT_TTS_VOICES);
    cfg.volcano.zh = 'mutated';
    expect(DEFAULT_TTS_VOICES.volcano.zh).toBe(before);
    expect(sanitize({}, DEFAULT_TTS_VOICES).volcano.zh).toBe(before);
  });

  it('reads volcanoApiKey / volcanoResourceId(trimmed strings)', () => {
    const cfg = sanitize({ volcanoApiKey: ' abc ', volcanoResourceId: ' seed-tts-2.0 ' }, DEFAULT_TTS_VOICES);
    expect(cfg.volcanoApiKey).toBe('abc');
    expect(cfg.volcanoResourceId).toBe('seed-tts-2.0');
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

describe('VOLCANO_VOICE_GROUPS(音色表完整性)', () => {
  it('值唯一、非空、不占用回退空串;标签非空', () => {
    for (const lang of ['zh', 'en', 'es'] as const) {
      const values: string[] = [];
      for (const g of VOLCANO_VOICE_GROUPS[lang]) {
        for (const o of g.options) {
          expect(o.value).not.toBe(VOLCANO_FALLBACK_VALUE); // 空串 = 回退项,列表里不允许
          expect(o.value.trim()).not.toBe('');
          expect(o.label.trim()).not.toBe('');
          values.push(o.value);
        }
      }
      expect(new Set(values).size).toBe(values.length);
    }
  });

  it('DEFAULT_TTS_VOICES 的火山音色必须在表内(否则设置页下拉显示空白)', () => {
    for (const lang of ['zh', 'en'] as const) {
      const def = DEFAULT_TTS_VOICES.volcano[lang];
      const hit = VOLCANO_VOICE_GROUPS[lang].some((g) => g.options.some((o) => o.value === def));
      expect(hit, `${lang}: ${def} 不在候选表里`).toBe(true);
    }
  });
});

describe('describeShimState(「上次播报」五态)', () => {
  it('maps each used/fallback combination', () => {
    expect(describeShimState(null).key).toBe('lastNone');
    expect(describeShimState(undefined).key).toBe('lastNone');
    expect(describeShimState({}).key).toBe('lastNone');

    expect(describeShimState({ used: 'volcano', voice: 'zh_female_shuangkuaisisi_moon_bigtts', usage: '17字' }))
      .toEqual({
        level: 'ok',
        key: 'lastOkVolcano',
        params: { voice: 'zh_female_shuangkuaisisi_moon_bigtts', usage: '17字' },
      });

    const fb = describeShimState({ used: 'edge-tts', fallback: 'volcano->edge-tts', reason: 'HTTP 401' });
    expect(fb.level).toBe('warn');
    expect(fb.key).toBe('lastFallbackEdge');
    expect(fb.params.reason).toBe('HTTP 401');

    expect(describeShimState({ used: 'piper', reason: 'boom' }).key).toBe('lastFallbackPiper');
    expect(describeShimState({ used: 'piper', reason: 'boom' }).level).toBe('warn');
  });

  it('config-level fallback(volcano 该语言留空)不算失败:普通 edge 信息态', () => {
    const v = describeShimState({ used: 'edge-tts', fallback: null, reason: '该语言(es)未配置火山音色' });
    expect(v.key).toBe('lastOkEdge');
    expect(v.level).toBe('info');
  });

  it('tolerates missing optional params', () => {
    expect(describeShimState({ used: 'volcano' }).params).toEqual({ voice: '', usage: '' });
    expect(describeShimState({ used: 'edge-tts' }).params).toEqual({ voice: '' });
  });
});
