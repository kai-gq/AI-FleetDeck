/**
 * View Mode Types
 *
 * Defines the available view modes for the main application viewport.
 */

export type ViewMode = '2d' | '3d' | 'dashboard' | 'flat';

export const VIEW_MODES: readonly ViewMode[] = ['3d', '2d', 'flat', 'dashboard'] as const;

export const VIEW_MODE_LABELS: Record<ViewMode, string> = {
  '2d': '2D',
  '3d': '3D',
  'dashboard': 'Dashboard',
  'flat': 'Flat',
};

export const VIEW_MODE_DESCRIPTIONS: Record<ViewMode, string> = {
  '2d': 'Lightweight top-down view',
  '3d': 'Full 3D isometric view',
  'dashboard': 'Metrics and status overview',
  'flat': 'Flat UI layout',
};

export const DEFAULT_VIEW_MODE: ViewMode = '3d';

/**
 * FleetDeck "home" (指挥台总览) view mode.
 *
 * Deliberately kept OUT of the `ViewMode` union: FloatingActionButtons /
 * MobileFabMenu hold exhaustive `Record<ViewMode, IconName>` literals, so
 * widening the legacy union would break them at build time. Legacy chrome
 * consumes the narrowed `useViewMode()` selector (home → '3d'), while the
 * app shell reads the raw value through `useAppViewMode()`.
 */
export const HOME_VIEW_MODE = 'home' as const;

/**
 * FleetDeck "commander" full view mode (B-30 · 指挥官).
 *
 * Same rationale as HOME_VIEW_MODE: deliberately kept OUT of the `ViewMode`
 * union so the frozen exhaustive-literal consumers stay untouched; legacy
 * chrome keeps seeing '3d' via the narrowed `useViewMode()` selector.
 */
export const COMMANDER_VIEW_MODE = 'commander' as const;
export type AppViewMode = ViewMode | typeof HOME_VIEW_MODE | typeof COMMANDER_VIEW_MODE;
export const APP_VIEW_MODES: readonly AppViewMode[] = ['home', 'commander', '3d', '2d', 'flat', 'dashboard'] as const;
