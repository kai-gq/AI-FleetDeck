/**
 * TopBar —— FleetDeck 顶栏（EPIC-4 · B4）
 *
 * shell 常驻入口带（所有视图）：工作区切换 / 搜索 / 视图菜单 / 设置 / 新建 / 秘书状态位。
 * - 搜索、设置复用 App 现成的 spotlightModal / toolboxModal 回调（原功能零丢失）。
 * - 视图切换沿用 FAB / ViewModeToggle 的同一套编排（先广播 tide:viewmode-switch-pressed，
 *   3D 等下一帧再落值）；切回总览时顺带收起 Guake 终端覆盖层（台账 B-14）。
 * - 非 home 视图靠视图菜单里的「指挥台」返回；rail 原样保留各自的入口。
 * - flat 视图挂 `--flat` 变体（上游遗留样式：全宽条右对齐，避开 flat 侧栏）。
 * - 秘书 pill 是占位状态位（wave2 接真实状态），非入口。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { store, useAppViewMode } from '../../store';
import type { AppViewMode } from '../../types/viewModes';
import { Icon } from '../Icon';
import { WorkspaceSwitcher } from '../WorkspaceSwitcher';
import { VIEW_MENU_OPTIONS, viewMenuOptionOf } from './viewMenu';
import './TopBar.scss';

export interface TopBarProps {
  onOpenSpotlight: () => void;
  onOpenToolbox: () => void;
  onSpawnAgent: () => void;
  onSpawnBoss: () => void;
}

type OpenMenu = 'view' | 'new' | null;

export function TopBar({ onOpenSpotlight, onOpenToolbox, onSpawnAgent, onSpawnBoss }: TopBarProps) {
  const { t } = useTranslation(['terminal', 'common']);
  const viewMode = useAppViewMode();
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // 点击别处 / Escape 收起下拉
  useEffect(() => {
    if (!openMenu) return;
    const handlePointerDown = (e: PointerEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpenMenu(null);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenMenu(null);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKey);
    };
  }, [openMenu]);

  const handleSelectView = useCallback(
    (mode: AppViewMode) => {
      setOpenMenu(null);
      if (mode === viewMode) return;
      // 与 FAB / ViewModeToggle 同一套切场编排（3D 加载罩依赖这个广播）
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('tide:viewmode-switch-pressed', { detail: { mode } }));
      }
      // B-14：终端（Guake）是全局覆盖层，会盖住总览——切回总览时一并收起
      if (mode === 'home') store.setTerminalOpen(false);
      if (mode === '3d') {
        requestAnimationFrame(() => store.setViewMode(mode));
        return;
      }
      store.setViewMode(mode);
    },
    [viewMode]
  );

  const current = viewMenuOptionOf(viewMode);
  const currentLabel = t(current.labelKey, { defaultValue: current.defaultLabel });

  return (
    <div className={`app-top-bar${viewMode === 'flat' ? ' app-top-bar--flat' : ''}`} ref={rootRef}>
      <WorkspaceSwitcher />

      <button
        type="button"
        className="top-bar__btn top-bar__btn--icon"
        onClick={onOpenSpotlight}
        title={t('terminal:topBar.searchHint', { defaultValue: 'Search (Ctrl+K)' })}
        aria-label={t('terminal:topBar.search', { defaultValue: 'Search' })}
      >
        <Icon name="search" size={16} />
      </button>

      <div className="top-bar__menu-wrap">
        <button
          type="button"
          className="top-bar__btn"
          onClick={() => setOpenMenu((v) => (v === 'view' ? null : 'view'))}
          title={t('terminal:topBar.viewHint', { defaultValue: 'Switch view' })}
          aria-haspopup="menu"
          aria-expanded={openMenu === 'view'}
        >
          <Icon name={current.icon} size={16} />
          <span className="top-bar__label">{currentLabel}</span>
          <Icon name="caret-down" size={12} />
        </button>
        {openMenu === 'view' && (
          <div className="top-bar__menu" role="menu">
            {VIEW_MENU_OPTIONS.map((option) => (
              <button
                key={option.mode}
                type="button"
                role="menuitemradio"
                aria-checked={option.mode === viewMode}
                className={`top-bar__menu-item${option.mode === viewMode ? ' is-active' : ''}`}
                onClick={() => handleSelectView(option.mode)}
              >
                <span className="top-bar__menu-icon">
                  <Icon name={option.icon} size={16} />
                </span>
                <span className="top-bar__menu-text">
                  <span className="top-bar__menu-label">
                    {t(option.labelKey, { defaultValue: option.defaultLabel })}
                    {option.demo && (
                      <span className="top-bar__tag">
                        {t('terminal:topBar.demoTag', { defaultValue: 'Demo' })}
                      </span>
                    )}
                  </span>
                  <span className="top-bar__menu-desc">
                    {t(option.descriptionKey, { defaultValue: option.defaultDescription })}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <button
        type="button"
        className="top-bar__btn top-bar__btn--icon"
        onClick={onOpenToolbox}
        title={t('terminal:topBar.settingsHint', { defaultValue: 'Settings (Ctrl+,)' })}
        aria-label={t('terminal:topBar.settings', { defaultValue: 'Settings' })}
      >
        <Icon name="gear" size={16} />
      </button>

      <div className="top-bar__menu-wrap">
        <button
          type="button"
          className="top-bar__btn"
          onClick={() => setOpenMenu((v) => (v === 'new' ? null : 'new'))}
          aria-haspopup="menu"
          aria-expanded={openMenu === 'new'}
        >
          <Icon name="plus" size={14} />
          <span className="top-bar__label">{t('terminal:topBar.new', { defaultValue: 'New' })}</span>
          <Icon name="caret-down" size={12} />
        </button>
        {openMenu === 'new' && (
          <div className="top-bar__menu" role="menu">
            <button
              type="button"
              role="menuitem"
              className="top-bar__menu-item"
              onClick={() => {
                setOpenMenu(null);
                onSpawnAgent();
              }}
            >
              <span className="top-bar__menu-icon">
                <Icon name="plus" size={16} />
              </span>
              <span className="top-bar__menu-text">
                <span className="top-bar__menu-label">
                  {t('terminal:topBar.newAgent', { defaultValue: 'New agent' })}
                </span>
              </span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="top-bar__menu-item"
              onClick={() => {
                setOpenMenu(null);
                onSpawnBoss();
              }}
            >
              <span className="top-bar__menu-icon">
                <Icon name="crown" size={16} />
              </span>
              <span className="top-bar__menu-text">
                <span className="top-bar__menu-label">
                  {t('terminal:topBar.newBoss', { defaultValue: 'New boss' })}
                </span>
              </span>
            </button>
          </div>
        )}
      </div>

      {/* 秘书状态位：占位（wave2 接真实状态），非入口 */}
      <span
        className="top-bar__secretary"
        aria-disabled="true"
        title={t('terminal:topBar.secretarySoon', { defaultValue: 'Status coming soon' })}
      >
        <span className="top-bar__secretary-dot" />
        {t('terminal:topBar.secretary', { defaultValue: 'Secretary' })}
      </span>
    </div>
  );
}

export default TopBar;
