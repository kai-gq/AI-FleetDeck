/**
 * jarvis-core · 项目感知与路由（任务 14·⑪）·快照压缩版渲染
 *
 * 每项目 1 行（上限 {@link MAX_PROJECT_SNAPSHOT_CARDS} 张；超出只报剩余数），
 * 当前项目标 [当前]；只读、无 IO（由接线层注入 cards/activeWorkspaceId）。
 */

import type { ProjectCard } from './types.js';

/** 快照最多展开几张项目卡（其余折叠为一行；按当前项目 → 活跃 → 闲置排序）。 */
export const MAX_PROJECT_SNAPSHOT_CARDS = 6;
/** 单卡「在做」摘要显示条数与截断长度。 */
export const PROJECT_SNAPSHOT_IN_PROGRESS_SHOWN = 2;
export const PROJECT_SNAPSHOT_OBJECTIVE_CHARS = 24;

/** 相对时间（无 IO、不依赖 services 的 formatTimeSince；快照只读展示用）。 */
export function formatSince(ts: number, now: number): string {
  if (!ts || ts <= 0) return '无记录';
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return '刚刚';
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)}分钟前`;
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))}小时前`;
  return `${Math.floor(diff / (24 * 60 * 60_000))}天前`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export interface RenderProjectSnapshotInput {
  cards: readonly ProjectCard[];
  /** 服务端激活工作区（null/缺省 = All）。 */
  activeWorkspaceId?: string | null;
  /** 当前时刻（相对时间展示；缺省 Date.now()）。 */
  now?: number;
  maxProjects?: number;
}

/**
 * 渲染项目快照行（每项目 1 行）；
 * - 当前项目 `- [当前] 名称 | id: … | 主管: 名(id) | 在做: … | 最近活跃: …`；
 * - 闲置项目行尾追加 `(闲置)`；
 * - cards 为空 → []（快照不注入项目块，开关关/无项目时零变化）。
 */
export function renderProjectSnapshotLines(input: RenderProjectSnapshotInput): string[] {
  const { cards, activeWorkspaceId } = input;
  if (cards.length === 0) return [];
  const now = input.now ?? Date.now();
  const maxProjects = input.maxProjects ?? MAX_PROJECT_SNAPSHOT_CARDS;

  const ordered = [...cards].sort((a, b) => {
    const ac = a.id === activeWorkspaceId ? 0 : 1;
    const bc = b.id === activeWorkspaceId ? 0 : 1;
    if (ac !== bc) return ac - bc;
    const as = a.status === 'active' ? 0 : 1;
    const bs = b.status === 'active' ? 0 : 1;
    if (as !== bs) return as - bs;
    if (b.lastActiveAt !== a.lastActiveAt) return b.lastActiveAt - a.lastActiveAt;
    return a.name.localeCompare(b.name);
  });

  const shown = ordered.slice(0, maxProjects);
  const lines = shown.map((card) => {
    const prefix = card.id === activeWorkspaceId ? '[当前] ' : '';
    const parts = [`${prefix}${card.name}`, `id: ${card.id}`];
    if (card.bossId) parts.push(`主管: ${card.bossName ?? card.bossId}(${card.bossId})`);
    if (card.inProgress.length > 0) {
      const items = card.inProgress.slice(0, PROJECT_SNAPSHOT_IN_PROGRESS_SHOWN)
        .map((item) => truncate(item, PROJECT_SNAPSHOT_OBJECTIVE_CHARS));
      const more = card.inProgress.length - items.length;
      parts.push(`在做: ${items.join('、')}${more > 0 ? ` 等${card.inProgress.length}项` : ''}`);
    }
    parts.push(`最近活跃: ${formatSince(card.lastActiveAt, now)}`);
    if (card.status === 'idle') parts.push('(闲置)');
    return `- ${parts.join(' | ')}`;
  });

  const rest = ordered.length - shown.length;
  if (rest > 0) lines.push(`…另有 ${rest} 个项目(未展开)`);
  return lines;
}
