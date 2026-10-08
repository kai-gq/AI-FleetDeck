/**
 * FleetDeck 双皮肤（B-24）接线与切换语义。
 * node 测试环境无浏览器全局——文件顶部为 localStorage / document / window 打桩，
 * 只覆盖 applyTheme 与 getActiveThemeId 用到的表面（style.setProperty / dataset / dispatchEvent）。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  fleetdeckDarkTheme,
  fleetdeckLightTheme,
  getActiveThemeId,
  migrateThemeOnce,
  themeToneOf,
  toggleTheme,
} from './fleetdeckTheme';
import { DEFAULT_THEME, getTheme, getXtermTheme, themes } from './themes';

// ── 浏览器全局桩 ──
const lsStore = new Map<string, string>();
const localStorageStub = {
  getItem: (k: string) => (lsStore.has(k) ? (lsStore.get(k) as string) : null),
  setItem: (k: string, v: string) => {
    lsStore.set(k, v);
  },
  removeItem: (k: string) => {
    lsStore.delete(k);
  },
};
const datasetStub: Record<string, string> = {};
const styleStub = {
  props: {} as Record<string, string>,
  setProperty(k: string, v: string) {
    this.props[k] = v;
  },
};

(globalThis as Record<string, unknown>).localStorage = localStorageStub;
(globalThis as Record<string, unknown>).document = {
  documentElement: { dataset: datasetStub, style: styleStub },
};
(globalThis as Record<string, unknown>).window = { dispatchEvent: () => true };
(globalThis as Record<string, unknown>).CustomEvent = class {
  constructor(_type: string, _init?: unknown) {}
};

beforeEach(() => {
  lsStore.clear();
  for (const key of Object.keys(datasetStub)) delete datasetStub[key];
});

describe('fleetdeck theme wiring', () => {
  it('registers both skins, sits first in the list, and becomes the default', () => {
    expect(themes).toHaveLength(25);
    expect(themes[0]?.id).toBe('fleetdeck');
    expect(themes[1]?.id).toBe('fleetdeck-light');
    expect(DEFAULT_THEME).toBe('fleetdeck');
    expect(themeToneOf(fleetdeckDarkTheme)).toBe('dark');
    expect(themeToneOf(fleetdeckLightTheme)).toBe('light');
    // 历史主题未标注 tone —— 一律视为暗色
    expect(themeToneOf(getTheme('abyss'))).toBe('dark');
  });
});

describe('migrateThemeOnce', () => {
  it('rewrites a classic save once and never again', () => {
    lsStore.set('tide-theme', 'classic');
    migrateThemeOnce();
    expect(lsStore.get('tide-theme')).toBe('fleetdeck');
    expect(lsStore.get('tide-theme-fleetdeck-migrated')).toBeTruthy();

    // 用户之后手选回 classic：标记在 → 不再迁走
    lsStore.set('tide-theme', 'classic');
    migrateThemeOnce();
    expect(lsStore.get('tide-theme')).toBe('classic');
  });

  it('leaves non-classic saves alone', () => {
    lsStore.set('tide-theme', 'abyss');
    migrateThemeOnce();
    expect(lsStore.get('tide-theme')).toBe('abyss');
  });
});

describe('toggleTheme', () => {
  it('switches between the fleetdeck pair by default', () => {
    lsStore.set('tide-theme', 'fleetdeck');
    expect(toggleTheme()).toBe('fleetdeck-light');
    expect(lsStore.get('tide-theme')).toBe('fleetdeck-light');
    // 回切命中 last-dark 记忆
    expect(toggleTheme()).toBe('fleetdeck');
    expect(lsStore.get('tide-theme')).toBe('fleetdeck');
  });

  it('remembers the last theme of the opposite tone', () => {
    lsStore.set('tide-theme', 'ember-noir');
    // 无 last-light 记忆 → 落默认亮皮
    expect(toggleTheme()).toBe('fleetdeck-light');
    // last-dark 记忆命中 → 回 ember-noir 而不是 fleetdeck
    expect(toggleTheme()).toBe('ember-noir');
  });

  it('uses the live dataset id as the current theme', () => {
    lsStore.set('tide-theme', 'fleetdeck');
    datasetStub.tideTheme = 'fleetdeck-light';
    expect(getActiveThemeId()).toBe('fleetdeck-light');
    // 从亮皮出发 → 切回暗皮
    expect(toggleTheme()).toBe('fleetdeck');
  });
});

describe('getXtermTheme 亮色分支（B-24）', () => {
  it('浅底上把 ANSI 黑白换成文本灰阶三档', () => {
    lsStore.set('tide-theme', 'fleetdeck-light');
    const x = getXtermTheme();
    const c = fleetdeckLightTheme.colors;
    expect(x.black).toBe(c.textSecondary);
    expect(x.brightBlack).toBe(c.textMuted);
    expect(x.white).toBe(c.textPrimary);
    expect(x.brightWhite).toBe(c.textPrimary);
    expect(x.background).toBe(c.bgPrimary);
  });

  it('深色皮维持原映射（black=bgTertiary / white=textPrimary）', () => {
    lsStore.set('tide-theme', 'fleetdeck');
    const x = getXtermTheme();
    const c = fleetdeckDarkTheme.colors;
    expect(x.black).toBe(c.bgTertiary);
    expect(x.white).toBe(c.textPrimary);
    expect(x.background).toBe(c.bgPrimary);
  });
});
