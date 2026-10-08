/**
 * TopBar —— FleetDeck 顶栏（EPIC-4 · B4；换肤改版 B-23 全宽条重做）
 *
 * in-flow 全宽条（所有视图；容器样式见 styles/components/_layout.scss）：
 * 品牌 FleetDeck / 工作区（下拉） / 分段视图切换 / 搜索·设置·新建（ghost 图标钮） / 秘书状态位。
 * - 视图切换沿用 FAB / ViewModeToggle 的同一套编排（先广播 tide:viewmode-switch-pressed，
 *   3D 等下一帧再落值）；切回总览时顺带收起 Guake 终端覆盖层（台账 B-14）。
 * - 原 --flat 变体已删（B-23：in-flow 条天然全宽，无需视图级补丁）。
 * - 秘书 pill 是状态位（B-26 接真实语音状态），非入口。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { store, useAppViewMode } from '../../store';
import type { AppViewMode } from '../../types/viewModes';
import type { ThemeId } from '../../utils/themes';
import { getTheme } from '../../utils/themes';
import { getActiveThemeId, themeToneOf, toggleTheme } from '../../utils/fleetdeckTheme';
import { Icon } from '../Icon';
import { WorkspaceSwitcher } from '../WorkspaceSwitcher';
import { useVoiceCompanionPhase } from '../FleetDeckHome/useVoiceCompanionPhase';
import { VIEW_MENU_OPTIONS } from './viewMenu';
import './TopBar.scss';
// 亮色皮覆盖（B-24）静态引入：绝大多数 UI 走变量自动换皮，这里只带作者文件里的
// 硬编码覆盖（黑玻璃药丸/深阴影），详见文件头注释。
import './fleetdeck-light-overrides.scss';

export interface TopBarProps {
  onOpenSpotlight: () => void;
  onOpenToolbox: () => void;
  onSpawnAgent: () => void;
  onSpawnBoss: () => void;
}

type OpenMenu = 'new' | null;

export function TopBar({ onOpenSpotlight, onOpenToolbox, onSpawnAgent, onSpawnBoss }: TopBarProps) {
  const { t } = useTranslation(['terminal', 'common']);
  const viewMode = useAppViewMode();
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);

  // 主题钮状态（B-24）：applyTheme 每次换皮都会广播 tide-theme-changed，
  // 监听它即可让图标跟随任意来源的换皮（本钮 / 设置面板 / 终端头部下拉）。
  const [themeId, setThemeId] = useState<ThemeId>(() => getActiveThemeId());
  useEffect(() => {
    const onThemeChanged = (e: Event) => {
      const detail = (e as CustomEvent<{ themeId?: string }>).detail;
      setThemeId((detail?.themeId as ThemeId) ?? getActiveThemeId());
    };
    window.addEventListener('tide-theme-changed', onThemeChanged);
    return () => window.removeEventListener('tide-theme-changed', onThemeChanged);
  }, []);
  const isLightTheme = themeToneOf(getTheme(themeId)) === 'light';

  // 秘书 pill 状态（B-26）：镜像语音伙伴真实相位（DOM 读取，见 useVoiceCompanionPhase）；
  // title 直接用其本地化相位标签，无需新文案。非入口，仅状态位。
  const voice = useVoiceCompanionPhase();
  const voiceOn = voice.present === true && voice.phase !== 'off';

  // 窄屏时段位条横向滚动（overflow-x:auto）：把当前段位移进视野，
  // 否则手机上切到靠右的视图后，活动 chip 可能不在可见区。
  useEffect(() => {
    const active = navRef.current?.querySelector<HTMLElement>('.top-bar__segment.is-active');
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [viewMode]);

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

  return (
    <div className="app-top-bar" ref={rootRef}>
      {/* 品牌（原型：Fleet·Deck，Deck 走强调色；纯装饰，不进读屏） */}
      <div className="top-bar__brand" aria-hidden="true">
        <svg className="top-bar__brand-mark" viewBox="0 0 32 32">
          <path className="top-bar__brand-plate" d="M16 3 5 9v14l11 6 11-6V9L16 3z" />
          <path className="top-bar__brand-core" d="M16 8 9 12v8l7 4 7-4v-8l-7-4z" />
        </svg>
        <span className="top-bar__brand-text">
          Fleet<em>Deck</em>
        </span>
      </div>

      <WorkspaceSwitcher />

      {/* 分段视图切换（原型 .viewswitch；文案沿用现有视图名，只换样式） */}
      <nav
        className="top-bar__viewswitch"
        ref={navRef}
        aria-label={t('terminal:topBar.viewHint', { defaultValue: 'Switch view' })}
      >
        {VIEW_MENU_OPTIONS.map((option) => (
          <button
            key={option.mode}
            type="button"
            className={`top-bar__segment${option.mode === viewMode ? ' is-active' : ''}`}
            aria-pressed={option.mode === viewMode}
            title={t(option.descriptionKey, { defaultValue: option.defaultDescription })}
            onClick={() => handleSelectView(option.mode)}
          >
            {t(option.labelKey, { defaultValue: option.defaultLabel })}
            {option.demo && (
              <span className="top-bar__tag">{t('terminal:topBar.demoTag', { defaultValue: 'Demo' })}</span>
            )}
          </button>
        ))}
      </nav>

      <div className="top-bar__right">
        <button
          type="button"
          className="top-bar__btn"
          onClick={onOpenSpotlight}
          title={t('terminal:topBar.searchHint', { defaultValue: 'Search (Ctrl+K)' })}
          aria-label={t('terminal:topBar.search', { defaultValue: 'Search' })}
        >
          <Icon name="search" size={16} />
        </button>

        <button
          type="button"
          className="top-bar__btn"
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
            title={t('terminal:topBar.new', { defaultValue: 'New' })}
            aria-label={t('terminal:topBar.new', { defaultValue: 'New' })}
            aria-haspopup="menu"
            aria-expanded={openMenu === 'new'}
          >
            <Icon name="plus" size={16} />
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

        {/* 秘书状态位（B-26 起接真实语音状态）：呼吸点=语音开启中；非入口，仅状态位 */}
        <span
          className={`top-bar__secretary${voiceOn ? ' is-on' : ''}`}
          title={
            voice.present === true && voice.label
              ? voice.label
              : t('terminal:fleetHome.voice.disabled', { defaultValue: '未启用' })
          }
        >
          <span className="top-bar__secretary-dot" />
          {t('terminal:topBar.secretary', { defaultValue: 'Secretary' })}
        </span>

        {/* 主题切换（B-24）：深/亮一键对切；图标示当前语气（亮=太阳、暗=月亮） */}
        <button
          type="button"
          className="top-bar__btn top-bar__theme-btn"
          onClick={() => toggleTheme()}
          title={t('terminal:topBar.themeToggle', { defaultValue: 'Switch dark / light' })}
          aria-label={t('terminal:topBar.themeToggle', { defaultValue: 'Switch dark / light' })}
        >
          <Icon name={isLightTheme ? 'sun' : 'moon'} size={16} />
        </button>
      </div>
    </div>
  );
}

export default TopBar;
