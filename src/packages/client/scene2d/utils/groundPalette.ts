/**
 * 2D 画布地面/网格配色（主题语气感知，B-31）
 *
 * 原作者在 GridRenderer 里把地面径向渐变、网格线与坐标标签写死为暗色 —— 亮色皮
 * （fleetdeck-light）下整块 2D 画布呈近黑，与浅色界面强烈割裂。本模块按当前主题的
 * tone 给两套取色：暗皮保持原作者字面色不变；亮皮取亮色 token 的冷灰地板 + 深一档的
 * 网格/坐标色，并抬高不透明度补偿浅底上更弱的对比感知。
 *
 * 只测「语气」不测具体主题 id：其余历史主题全部是 dark 语气，与暗皮共用一套配色。
 * 供 GridRenderer（地面/网格）+ Scene2D 动画循环（语气切换探测）使用。
 */

import type { ThemeId } from '../../utils/themes';
import { getTheme } from '../../utils/themes';
import { getActiveThemeId, themeToneOf } from '../../utils/fleetdeckTheme';

export type SceneTone = 'dark' | 'light';

export interface GroundPalette {
  /** 地面径向渐变：中心 → 中点 → 边缘 */
  groundStops: [string, string, string];
  /** 网格线基色 "r, g, b"（渐隐透明度由 GridRenderer 曲线另行计算） */
  gridRgb: string;
  /** 网格线透明度增益（浅底需更高对比） */
  gridAlphaGain: number;
  /** 坐标标签基色 "r, g, b" */
  labelRgb: string;
  /** 坐标标签透明度增益 */
  labelAlphaGain: number;
}

/** 暗皮：原作者字面色（fleetdeck 及全部历史主题） */
export const DARK_GROUND_PALETTE: GroundPalette = {
  groundStops: ['#1a1f2e', '#141820', '#0a0c12'],
  gridRgb: '100, 140, 180',
  gridAlphaGain: 1,
  labelRgb: '100, 140, 180',
  labelAlphaGain: 1,
};

/** 亮皮：冷灰地板（= 亮皮 panel2/line 色系）+ 石板蓝网格 */
export const LIGHT_GROUND_PALETTE: GroundPalette = {
  groundStops: ['#f6f9fd', '#eef2f8', '#e3e9f2'],
  gridRgb: '96, 118, 152',
  gridAlphaGain: 1.6,
  labelRgb: '82, 104, 138',
  labelAlphaGain: 1.5,
};

export function groundPaletteFor(tone: SceneTone): GroundPalette {
  return tone === 'light' ? LIGHT_GROUND_PALETTE : DARK_GROUND_PALETTE;
}

/** 主题 id → 语气；未知 id 由 getTheme 回落 classicTheme（暗皮），不会抛 */
export function sceneToneOfThemeId(id: string): SceneTone {
  return themeToneOf(getTheme(id as ThemeId));
}

/** 当前生效主题的语气；非浏览器环境或异常一律按暗皮（可读性最稳） */
export function resolveSceneTone(): SceneTone {
  try {
    return sceneToneOfThemeId(getActiveThemeId());
  } catch {
    return 'dark';
  }
}
