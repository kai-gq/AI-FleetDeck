/**
 * FlatView 的布局常量与终端视图模式表。
 *
 * 自 index.tsx 按主题拆出(2026-10-11 W2);块级逐行原样搬移。
 */

import { ViewMode as TerminalViewMode } from '../../ClaudeOutputPanel/types';

// ============================================================================
// Layout constants (desktop/tablet resizable splitters: one between
// .flat-middle and .flat-right, one between .flat-right and .flat-inspector
// when it's open). Mirror the CSS fallback values so the drag clamp logic
// agrees with what the responsive stylesheet enforces.
// ============================================================================
export const FLAT_SPLITTER_WIDTH = 3;

export const FLAT_AGENTS_MIN_WIDTH = 280;

export const FLAT_RIGHT_MIN_WIDTH = 320;

export const FLAT_INSPECTOR_MIN_WIDTH = 240;

export const FLAT_LEFT_GUTTER = 64; // matches .flat-view `padding-left` in FlatView.scss

// ============================================================================
// Types
// ============================================================================

export const TERMINAL_VIEW_MODES: TerminalViewMode[] = ['simple', 'chat', 'advanced'];

export const TERMINAL_VIEW_MODE_LABELS: Record<TerminalViewMode, string> = {
  simple: 'Simple',
  chat: 'Chat',
  advanced: 'Advanced',
};

export const TERMINAL_VIEW_MODE_ICONS: Record<TerminalViewMode, string> = {
  simple: '○',
  chat: '◐',
  advanced: '◉',
};

export const TERMINAL_VIEW_MODE_DESCRIPTIONS: Record<TerminalViewMode, string> = {
  simple: 'Simple view — clean messages only',
  chat: 'Chat view — assistant replies (no tool calls)',
  advanced: 'Advanced view — everything including tools',
};

export const CLEAR_CONFIRM_ID = 'flat-clear-context';

// Per-area persistence of the flat embedded bottom panel — mirrors the guake's
// tide:bottom-panels-v2 map so switching to an agent of another area and back
// restores the panel exactly as it was left.
export const FLAT_EMBED_LS_KEY = 'tide:flat-embedded-panels';
