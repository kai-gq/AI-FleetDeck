/**
 * 顶栏视图菜单 · 纯模型（EPIC-4 · B4）
 *
 * 指挥台总览（home）是第一公民，其余视图排在后面；3D 场景打「演示模式」标
 * （它是演示性视图，指挥台才是主视图）。图标沿用 FloatingActionButtons 的
 * 既有词汇（cube/grid/sparkle/dashboard），home 用新增的 house。
 *
 * 无 React / store 依赖，便于单测；中文文案走 i18n key（common:viewMode.*），
 * 代码侧 defaultValue 为英文兜底。
 */

import type { AppViewMode } from '../../types/viewModes';
import type { IconName } from '../Icon';

export interface ViewMenuOption {
  mode: AppViewMode;
  icon: IconName;
  /** i18n key —— common:viewMode.labels.* */
  labelKey: string;
  /** i18n key —— common:viewMode.descriptions.* */
  descriptionKey: string;
  defaultLabel: string;
  defaultDescription: string;
  /** 演示性视图（3D 场景）在菜单里带一枚「演示模式」小标 */
  demo?: boolean;
}

export const VIEW_MENU_OPTIONS: readonly ViewMenuOption[] = [
  {
    mode: 'home',
    icon: 'home',
    labelKey: 'common:viewMode.labels.home',
    descriptionKey: 'common:viewMode.descriptions.home',
    defaultLabel: 'FleetDeck',
    defaultDescription: 'Team & delegation overview',
  },
  {
    mode: '2d',
    icon: 'grid',
    labelKey: 'common:viewMode.labels.2d',
    descriptionKey: 'common:viewMode.descriptions.2d',
    defaultLabel: '2D',
    defaultDescription: 'Lightweight top-down view',
  },
  {
    mode: '3d',
    icon: 'cube',
    labelKey: 'common:viewMode.labels.3d',
    descriptionKey: 'common:viewMode.descriptions.3d',
    defaultLabel: '3D',
    defaultDescription: 'Full 3D isometric view',
    demo: true,
  },
  {
    mode: 'flat',
    icon: 'sparkle',
    labelKey: 'common:viewMode.labels.flat',
    descriptionKey: 'common:viewMode.descriptions.flat',
    defaultLabel: 'Flat',
    defaultDescription: 'Flat UI layout',
  },
  {
    mode: 'dashboard',
    icon: 'dashboard',
    labelKey: 'common:viewMode.labels.dashboard',
    descriptionKey: 'common:viewMode.descriptions.dashboard',
    defaultLabel: 'Dashboard',
    defaultDescription: 'Metrics and status overview',
  },
];

/** 当前视图对应的菜单项；未知值兜底为第一项（home）。 */
export function viewMenuOptionOf(mode: AppViewMode): ViewMenuOption {
  return VIEW_MENU_OPTIONS.find((option) => option.mode === mode) ?? VIEW_MENU_OPTIONS[0];
}

/** 「演示模式」标：只有 3D 场景属于演示性视图。 */
export function isDemoView(mode: AppViewMode): boolean {
  return viewMenuOptionOf(mode).demo === true;
}
