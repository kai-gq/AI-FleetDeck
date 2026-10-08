import { describe, expect, it } from 'vitest';
import { APP_VIEW_MODES } from '../../types/viewModes';
import { VIEW_MENU_OPTIONS, isDemoView, viewMenuOptionOf } from './viewMenu';

describe('viewMenu（顶栏视图菜单模型）', () => {
  it('覆盖全部 AppViewMode 且无重复', () => {
    const modes = VIEW_MENU_OPTIONS.map((option) => option.mode);
    expect([...modes].sort()).toEqual([...APP_VIEW_MODES].sort());
    expect(new Set(modes).size).toBe(modes.length);
  });

  it('home（指挥台）排在第一项', () => {
    expect(VIEW_MENU_OPTIONS[0].mode).toBe('home');
  });

  it('只有 3D 是演示模式', () => {
    expect(isDemoView('3d')).toBe(true);
    for (const option of VIEW_MENU_OPTIONS) {
      if (option.mode !== '3d') expect(option.demo).toBeUndefined();
    }
  });

  it('label/description key 指向 common:viewMode 命名空间', () => {
    for (const option of VIEW_MENU_OPTIONS) {
      expect(option.labelKey).toBe(`common:viewMode.labels.${option.mode}`);
      expect(option.descriptionKey).toBe(`common:viewMode.descriptions.${option.mode}`);
      expect(option.defaultLabel.length).toBeGreaterThan(0);
      expect(option.defaultDescription.length).toBeGreaterThan(0);
    }
  });

  it('viewMenuOptionOf 命中现有视图；未知值兜底 home', () => {
    expect(viewMenuOptionOf('home').icon).toBe('home');
    expect(viewMenuOptionOf('flat').icon).toBe('sparkle');
    expect(viewMenuOptionOf('nope' as never).mode).toBe('home');
  });
});
