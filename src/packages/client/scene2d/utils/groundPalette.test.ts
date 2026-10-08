import { describe, expect, it } from 'vitest';
import {
  DARK_GROUND_PALETTE,
  LIGHT_GROUND_PALETTE,
  groundPaletteFor,
  resolveSceneTone,
  sceneToneOfThemeId,
} from './groundPalette';

describe('2D 地面配色（主题语气感知，B-31）', () => {
  it('暗皮保持原作者字面色（回归安全）', () => {
    expect(DARK_GROUND_PALETTE.groundStops).toEqual(['#1a1f2e', '#141820', '#0a0c12']);
    expect(DARK_GROUND_PALETTE.gridRgb).toBe('100, 140, 180');
    expect(DARK_GROUND_PALETTE.gridAlphaGain).toBe(1);
    expect(DARK_GROUND_PALETTE.labelAlphaGain).toBe(1);
  });

  it('亮皮为浅色地板并抬高对比度补偿', () => {
    expect(LIGHT_GROUND_PALETTE.gridAlphaGain).toBeGreaterThan(1);
    expect(LIGHT_GROUND_PALETTE.labelAlphaGain).toBeGreaterThan(1);
    // 浅色地板：三档渐变每个通道都应落在亮部（> 0xc0）
    for (const stop of LIGHT_GROUND_PALETTE.groundStops) {
      const channels = [1, 3, 5].map((i) => parseInt(stop.slice(i, i + 2), 16));
      expect(Math.min(...channels)).toBeGreaterThan(0xc0);
    }
  });

  it('groundPaletteFor 按语气映射且对象稳定', () => {
    expect(groundPaletteFor('light')).toBe(LIGHT_GROUND_PALETTE);
    expect(groundPaletteFor('dark')).toBe(DARK_GROUND_PALETTE);
  });

  it('sceneToneOfThemeId：亮皮 id → light，其余/未知 → dark', () => {
    expect(sceneToneOfThemeId('fleetdeck-light')).toBe('light');
    expect(sceneToneOfThemeId('fleetdeck')).toBe('dark');
    expect(sceneToneOfThemeId('classic')).toBe('dark');
    // getTheme 对未知 id 回落 classicTheme（无 tone 标注 → 暗皮），不应抛
    expect(sceneToneOfThemeId('no-such-theme')).toBe('dark');
  });

  it('resolveSceneTone 在无 DOM 环境（node 测试）回落 dark', () => {
    expect(resolveSceneTone()).toBe('dark');
  });
});
