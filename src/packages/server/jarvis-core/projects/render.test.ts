/**
 * jarvis-core/projects · 快照压缩渲染（任务 14·⑪ ⑤.1 / 验收 ⑥1）
 *
 * 钉死：每项目 1 行、当前项目 [当前] 标记、闲置 (闲置)、上限折叠为一行、
 * 在做摘要条数与长度截断、相对时间；cards 为空不注块（[] → 零变化）。
 */

import { describe, expect, it } from 'vitest';

import { formatSince, MAX_PROJECT_SNAPSHOT_CARDS, renderProjectSnapshotLines } from './render.js';
import type { ProjectCard } from './types.js';

const NOW = 1_800_000_000_000;

function card(partial: Partial<ProjectCard> & { id: string; name: string }): ProjectCard {
  return {
    aliases: [partial.name],
    areaIds: [],
    inProgress: [],
    keywords: [],
    lastActiveAt: NOW - 60_000,
    status: 'active',
    ...partial,
  };
}

describe('renderProjectSnapshotLines', () => {
  it('无项目卡 → []（不注快照块）', () => {
    expect(renderProjectSnapshotLines({ cards: [], activeWorkspaceId: 'wsB', now: NOW })).toEqual([]);
  });

  it('每项目 1 行：当前项目 [当前]、主管、在做、最近活跃、闲置标记', () => {
    const lines = renderProjectSnapshotLines({
      cards: [
        card({
          id: 'wsB', name: '项目B', bossId: 'bossB', bossName: '二当家B',
          inProgress: ['整理报价单', '开发登录页', '第三项'], lastActiveAt: NOW - 5 * 60_000,
        }),
        card({ id: 'wsC', name: '项目C', lastActiveAt: NOW - 40 * 60 * 60_000, status: 'idle' }),
      ],
      activeWorkspaceId: 'wsB',
      now: NOW,
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('[当前] 项目B');
    expect(lines[0]).toContain('id: wsB');
    expect(lines[0]).toContain('主管: 二当家B(bossB)');
    expect(lines[0]).toContain('在做: 整理报价单、开发登录页 等3项');
    expect(lines[0]).toContain('最近活跃: 5分钟前');
    expect(lines[0]).not.toContain('(闲置)');
    expect(lines[1]).toContain('项目C');
    expect(lines[1]).toContain('(闲置)');
    expect(lines[1]).toContain('1天前');
  });

  it('排序：当前项目最先 → active 按最近活跃 → idle 最后', () => {
    const lines = renderProjectSnapshotLines({
      cards: [
        card({ id: 'old', name: '旧活跃', lastActiveAt: NOW - 10 * 60_000 }),
        card({ id: 'idle', name: '闲置但刚动过', lastActiveAt: NOW - 1, status: 'idle' }),
        card({ id: 'new', name: '新活跃', lastActiveAt: NOW - 2 * 60_000 }),
        card({ id: 'cur', name: '当前项目', lastActiveAt: NOW - 30 * 24 * 60 * 60_000 }),
      ],
      activeWorkspaceId: 'cur',
      now: NOW,
    });
    expect(lines.map((l) => l.split(' | ')[0])).toEqual([
      '- [当前] 当前项目', '- 新活跃', '- 旧活跃', '- 闲置但刚动过',
    ]);
  });

  it('上限折叠：超出 MAX_PROJECT_SNAPSHOT_CARDS 只报剩余数', () => {
    const cards = Array.from({ length: MAX_PROJECT_SNAPSHOT_CARDS + 2 }, (_, i) =>
      card({ id: `ws${i}`, name: `项目${i}`, lastActiveAt: NOW - i * 1000 }));
    const lines = renderProjectSnapshotLines({ cards, now: NOW });
    expect(lines).toHaveLength(MAX_PROJECT_SNAPSHOT_CARDS + 1);
    expect(lines[lines.length - 1]).toBe('…另有 2 个项目(未展开)');
  });

  it('在做摘要：单条超长截 24 字符加省略号', () => {
    const long = '把登录页重构成 React 18 并发模式并补齐测试计划';
    const lines = renderProjectSnapshotLines({
      cards: [card({ id: 'wsA', name: '项目A', inProgress: [long] })],
      now: NOW,
    });
    expect(lines[0]).toContain(`在做: ${long.slice(0, 24)}…`);
  });
});

describe('formatSince', () => {
  it('分桶：无记录 / 刚刚 / 分钟 / 小时 / 天', () => {
    expect(formatSince(0, NOW)).toBe('无记录');
    expect(formatSince(NOW - 30_000, NOW)).toBe('刚刚');
    expect(formatSince(NOW - 5 * 60_000, NOW)).toBe('5分钟前');
    expect(formatSince(NOW - 3 * 60 * 60_000, NOW)).toBe('3小时前');
    expect(formatSince(NOW - 2 * 24 * 60 * 60_000, NOW)).toBe('2天前');
    expect(formatSince(NOW + 10_000, NOW)).toBe('刚刚'); // 时钟回拨钳 0
  });
});
