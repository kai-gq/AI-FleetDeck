/**
 * 总览右栏 · 语音会话流（EPIC-1 的只读 DOM 镜像）。
 *
 * 事实约束（源码亲验）：VoiceCompanion 没有统一根类，DOM 是
 * `.voice-companion-bubble`（条件渲染）+ `.voice-companion-btn` + `.voice-companion-pill`；
 * 条目 = `.vc-entry.vc-entry--{live|user|assistant|system}`（`__tag` + `__text`）。
 * 桌面实例挂在 .fab-rail 下，移动实例（MobileFabMenu）会给按钮加 .mobile-voice-companion——
 * 双实例并存时偏好 .fab-rail 里的气泡。
 *
 * 只读镜像：解析全容错（缺元素/未知角色 → 跳过或回退 system），不做任何写操作。
 * wave2 正解 = 语音事件总线（EPIC-2），届时本镜像退役。
 */

export const VOICE_STREAM_CLAMP = 50;

export type VoiceStreamRole = 'live' | 'user' | 'assistant' | 'system';

export interface VoiceStreamEntry {
  id: string;
  role: VoiceStreamRole;
  tag: string;
  text: string;
}

/** `.vc-entry` 行的最小读取面（真实 DOM 或测试桩都满足）。 */
export interface VoiceEntryRow {
  className?: string;
  querySelector(selector: string): { textContent: string | null } | null;
}

/** 真实 DOM 行 → 最小读取面。 */
export function toVoiceEntryRow(el: Element): VoiceEntryRow {
  return {
    className: el.className,
    querySelector: (selector: string) => el.querySelector(selector),
  };
}

const ROLES: ReadonlySet<string> = new Set(['live', 'user', 'assistant', 'system']);

/** 解析气泡内所有 `.vc-entry` 行；空文本行跳过，未知角色回退 system。 */
export function parseVoiceEntries(rows: readonly VoiceEntryRow[]): VoiceStreamEntry[] {
  const entries: VoiceStreamEntry[] = [];
  rows.forEach((row, index) => {
    const classes = row.className ?? '';
    const roleMatch = /(?:^|\s)vc-entry--(\S+)/.exec(classes);
    const rawRole = roleMatch?.[1] ?? '';
    const role: VoiceStreamRole = ROLES.has(rawRole) ? (rawRole as VoiceStreamRole) : 'system';
    const tag = row.querySelector('.vc-entry__tag')?.textContent?.trim() ?? '';
    const text = row.querySelector('.vc-entry__text')?.textContent?.trim() ?? '';
    if (!text) return;
    entries.push({ id: `${index}:${role}:${text.slice(0, 24)}`, role, tag, text });
  });
  return clampVoiceEntries(entries);
}

/** 只留最近 max 条（流式窗口）。非法 max → 空数组。 */
export function clampVoiceEntries(
  entries: readonly VoiceStreamEntry[],
  max: number = VOICE_STREAM_CLAMP
): VoiceStreamEntry[] {
  if (!Number.isFinite(max) || max <= 0) return [];
  return entries.length > max ? entries.slice(entries.length - max) : [...entries];
}

export interface VoiceBubbleCandidate<T> {
  /** 是否位于桌面 .fab-rail 挂载下。 */
  inFabRail: boolean;
  rows: readonly T[];
}

/** 双实例容错：优先 .fab-rail 实例；再优先行数最多的气泡；无候选 → null。 */
export function pickVoiceBubble<T>(candidates: readonly VoiceBubbleCandidate<T>[]): VoiceBubbleCandidate<T> | null {
  if (candidates.length === 0) return null;
  const inRail = candidates.filter((candidate) => candidate.inFabRail);
  const pool = inRail.length > 0 ? inRail : candidates;
  return pool.reduce((best, current) => (current.rows.length > best.rows.length ? current : best), pool[0]);
}
