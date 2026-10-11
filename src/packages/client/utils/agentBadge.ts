/**
 * AgentBadge helpers — pure logic for the individual agent identity badge.
 *
 * Status is grouped into four tone levels (EPIC-8): active / success / danger /
 * muted. Ring colors are NOT hardcoded here as hex — they resolve to the same
 * CSS custom properties the cockpit fleet lamps use, via AGENT_BADGE_TONE_VARS,
 * so a badge ring and a lamp can never drift apart (SPEC EPIC-8 ②).
 */

import type { AgentStatus } from '../../shared/agent-types';

export type AgentBadgeTone = 'active' | 'success' | 'danger' | 'muted';

/** Status → lamp tone. Mirrors the cockpit fleet lamps (在办 / 待命 / 已办结). */
export const AGENT_BADGE_TONES: Record<AgentStatus, AgentBadgeTone> = {
  working: 'active',
  waiting: 'active',
  waiting_permission: 'active',
  idle: 'success',
  error: 'danger',
  offline: 'muted',
  orphaned: 'muted',
};

/** Unknown statuses fall back to muted instead of inventing a color. */
export function agentBadgeTone(status: string): AgentBadgeTone {
  return AGENT_BADGE_TONES[status as AgentStatus] ?? 'muted';
}

/**
 * Tone → CSS custom property. THE single source of truth for badge rings and
 * cockpit fleet lamps — both render `var(--accent-cyan)` etc. from this map.
 */
export const AGENT_BADGE_TONE_VARS: Record<AgentBadgeTone, string> = {
  active: 'var(--accent-cyan)',
  success: 'var(--accent-green)',
  danger: 'var(--accent-red)',
  muted: 'var(--text-muted)',
};

// CJK ideographs, kana and hangul — names in these scripts take the LAST
// glyph as the initial ("Builder 甲" → "甲", 小刘 → 刘), per SPEC EPIC-8.
const CJK_CHAR_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/;

/**
 * Single-character identity initial for an agent name.
 * CJK/kana/hangul → last such glyph; latin → first alphanumeric (uppercased);
 * empty or symbol-only → '?'.
 */
export function nameInitial(name: string | undefined | null): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return '?';
  const chars = [...trimmed];
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    if (CJK_CHAR_RE.test(chars[i])) return chars[i];
  }
  const alnum = trimmed.match(/[A-Za-z0-9]/);
  return alnum ? alnum[0].toUpperCase() : '?';
}
