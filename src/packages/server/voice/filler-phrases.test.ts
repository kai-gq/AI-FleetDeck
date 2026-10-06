/**
 * 静态垫话池专测:池不变量(长度/去重/上限/护栏全过)+ 选取语义(去重窗、兜底、随机注入)。
 * 护栏遍历是承重断言——池句要「场景无关且不食言」,任何新增句必须一并过 filler-guard。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkFillerSafety } from './filler-guard.js';
import {
  STATIC_FILLER_MAX_CHARS,
  STATIC_FILLER_PHRASES,
  isStaticFillerMode,
  pickStaticFiller,
} from './filler-phrases.js';

describe('静态垫话池 · 不变量', () => {
  it('池非空、无重复、句句 ≤ 上限', () => {
    expect(STATIC_FILLER_PHRASES.length).toBeGreaterThanOrEqual(10);
    expect(new Set(STATIC_FILLER_PHRASES).size).toBe(STATIC_FILLER_PHRASES.length);
    for (const phrase of STATIC_FILLER_PHRASES) {
      expect(Array.from(phrase).length, `超长:${phrase}`).toBeLessThanOrEqual(STATIC_FILLER_MAX_CHARS);
    }
  });

  it('池句全部通过 filler-guard(承诺类硬闸)', () => {
    for (const phrase of STATIC_FILLER_PHRASES) {
      expect(checkFillerSafety(phrase), `被护栏拦下:${phrase}`).toBeNull();
    }
  });
});

describe('静态垫话池 · 选取', () => {
  it('rng 注入:0 → 首句;接近 1 → 末句;越界值钳在界内', () => {
    expect(pickStaticFiller({ rng: () => 0 })).toBe(STATIC_FILLER_PHRASES[0]);
    expect(pickStaticFiller({ rng: () => 0.999999 })).toBe(STATIC_FILLER_PHRASES[STATIC_FILLER_PHRASES.length - 1]);
    expect(pickStaticFiller({ rng: () => 1 })).toBe(STATIC_FILLER_PHRASES[STATIC_FILLER_PHRASES.length - 1]);
    expect(pickStaticFiller({ rng: () => -1 })).toBe(STATIC_FILLER_PHRASES[0]);
  });

  it('exclude 命中者被剔除(「别连续同款」)', () => {
    // 排除前两句后,rng=0 应落在第三句。
    const picked = pickStaticFiller({
      exclude: [STATIC_FILLER_PHRASES[0]!, STATIC_FILLER_PHRASES[1]!],
      rng: () => 0,
    });
    expect(picked).toBe(STATIC_FILLER_PHRASES[2]);
  });

  it('全部被 exclude → 退化全池随机(不返回空)', () => {
    const all = [...STATIC_FILLER_PHRASES];
    const picked = pickStaticFiller({ exclude: all, rng: () => 0.5 });
    expect(STATIC_FILLER_PHRASES).toContain(picked);
  });

  it('默认随机:多次选取全部落在池内且能覆盖多句', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const picked = pickStaticFiller();
      expect(STATIC_FILLER_PHRASES).toContain(picked);
      seen.add(picked);
    }
    expect(seen.size).toBeGreaterThan(5);
  });
});

describe('静态垫话模式开关', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('缺省/未知值 = 静态;=llm 切回动态档(精确匹配,与其它 TC_VOICE_* 开关同规)', () => {
    vi.stubEnv('TC_VOICE_FILLER_MODE', '');
    expect(isStaticFillerMode()).toBe(true); // 未设
    vi.stubEnv('TC_VOICE_FILLER_MODE', 'static');
    expect(isStaticFillerMode()).toBe(true);
    vi.stubEnv('TC_VOICE_FILLER_MODE', 'garbage');
    expect(isStaticFillerMode()).toBe(true); // 未知值一律落安全侧
    vi.stubEnv('TC_VOICE_FILLER_MODE', 'llm');
    expect(isStaticFillerMode()).toBe(false);
  });
});
