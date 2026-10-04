/**
 * jarvis-core/projects · 项目记忆卡构建（任务 14·⑪ ⑤.1）
 *
 * 钉死：workspace(areaIds) → area(assignedAgentIds) → boss-like 主管链（含下属 bossId
 * 兜底）、委派史 → 在做/最近活跃、活跃度 30 天衰减 → idle、别名并入、关键词切词、
 * 最近委派窗口。全部纯函数（不读盘、不写盘）。
 */

import { describe, expect, it } from 'vitest';

import type { DelegationDecision, TaskCardStatus } from '../../../shared/agent-types.js';
import { buildProjectCards, collectRecentProjectIds, isProjectBossLike } from './cards.js';
import { PROJECT_CARD_DECAY_DAYS, RECENT_DELEGATION_WINDOW_MS } from './types.js';
import type { ProjectAliasEntry, ProjectAreaInput, ProjectAgentInput, ProjectWorkspaceInput } from './types.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function decision(partial: {
  timestamp: number;
  projectId?: string;
  sourceProject?: string;
  objective?: string;
  taskStatus?: TaskCardStatus;
  completed?: boolean;
}): DelegationDecision {
  return {
    id: `d-${partial.timestamp}-${partial.objective ?? ''}`,
    timestamp: partial.timestamp,
    bossId: 'bossA',
    userCommand: 'x',
    selectedAgentId: 'w1',
    selectedAgentName: '小工',
    reasoning: '',
    alternativeAgents: [],
    confidence: 'medium',
    status: 'sent',
    ...(partial.objective
      ? {
        taskCard: {
          objective: partial.objective,
          acceptanceCriteria: [],
          dependencies: [],
          status: partial.taskStatus ?? 'running',
          ...(partial.projectId ? { projectId: partial.projectId } : {}),
          ...(partial.sourceProject ? { sourceProject: partial.sourceProject } : {}),
        },
      }
      : {}),
    ...(partial.completed
      ? { completion: { completedAt: partial.timestamp, durationMs: 1000, result: 'completed' as const } }
      : {}),
  };
}

function world() {
  const workspaces: ProjectWorkspaceInput[] = [
    { id: 'wsA', name: '项目A', areaIds: ['arA'], createdAt: NOW - 2 * DAY },
    { id: 'wsB', name: '项目B', areaIds: ['arB'], createdAt: NOW - 2 * DAY },
  ];
  const areas: ProjectAreaInput[] = [
    { id: 'arA', name: 'A区', assignedAgentIds: ['bossA', 'w1'], directories: ['E:/projA'] },
    { id: 'arB', name: 'B区', assignedAgentIds: ['bossB'] },
  ];
  const agents: ProjectAgentInput[] = [
    { id: 'bossA', name: '大当家A', isBoss: true, class: 'boss', lastWorkedAt: NOW - 500 },
    { id: 'w1', name: '小工', class: 'builder', bossId: 'bossA' },
    { id: 'bossB', name: '二当家B', isBoss: true, class: 'boss', lastWorkedAt: NOW - 10 * DAY },
  ];
  return { workspaces, areas, agents };
}

describe('buildProjectCards — 主管链与卡字段', () => {
  it('workspace→area→boss-like：主管、目录提示、区域 id 全落卡', () => {
    const { workspaces, areas, agents } = world();
    const cards = buildProjectCards({ workspaces, areas, agents, now: NOW });
    expect(cards.map((c) => c.id)).toEqual(['wsA', 'wsB']);
    const a = cards[0];
    expect(a.name).toBe('项目A');
    expect(a.bossId).toBe('bossA');
    expect(a.bossName).toBe('大当家A');
    expect(a.areaIds).toEqual(['arA']);
    expect(a.rootDirHint).toBe('E:/projA');
    expect(a.aliases).toEqual(['项目A']);
    expect(a.status).toBe('active');
    expect(cards[1].rootDirHint).toBeUndefined();
  });

  it('区域里多个 boss-like：取最近活动；同刻按名字（确定序）', () => {
    const { workspaces, areas } = world();
    const agents: ProjectAgentInput[] = [
      { id: 'bossOld', name: '老主管', isBoss: true, lastWorkedAt: NOW - 100 },
      { id: 'bossNew', name: '新主管', isBoss: true, lastWorkedAt: NOW - 50 },
    ];
    const cards = buildProjectCards({
      workspaces: [workspaces[0]],
      areas: [{ id: 'arA', assignedAgentIds: ['bossOld', 'bossNew'] }],
      agents,
      now: NOW,
    });
    expect(cards[0].bossId).toBe('bossNew');
  });

  it('区域只挂了普通下属：用下属 bossId 反查兜底', () => {
    const { workspaces } = world();
    const agents: ProjectAgentInput[] = [
      { id: 'bossA', name: '大当家A', isBoss: true },
      { id: 'w1', name: '小工', class: 'builder', bossId: 'bossA' },
    ];
    const cards = buildProjectCards({
      workspaces: [workspaces[0]],
      areas: [{ id: 'arA', assignedAgentIds: ['w1'] }],
      agents,
      now: NOW,
    });
    expect(cards[0].bossId).toBe('bossA');
  });

  it('archived 区域整体跳过（不算成员、不选主管、不取目录）', () => {
    const { workspaces } = world();
    const cards = buildProjectCards({
      workspaces: [workspaces[1]],
      areas: [{ id: 'arB', assignedAgentIds: ['bossB'], directories: ['E:/dead'], archived: true }],
      agents: [{ id: 'bossB', name: '二当家B', isBoss: true }],
      now: NOW,
    });
    expect(cards[0].bossId).toBeUndefined();
    expect(cards[0].rootDirHint).toBeUndefined();
    expect(cards[0].areaIds).toEqual(['arB']); // areaIds 是 workspace 归属，不因归档消失
  });

  it('isProjectBossLike 与 vcs.isBossLikeAgent 同判定（isBoss 或 class==="boss"）', () => {
    expect(isProjectBossLike({ isBoss: true })).toBe(true);
    expect(isProjectBossLike({ class: 'boss' })).toBe(true);
    expect(isProjectBossLike({ class: 'builder', isBoss: false })).toBe(false);
  });
});

describe('buildProjectCards — 活跃度衰减（30 天 → idle）', () => {
  it('超过 30 天无活跃 → idle；边界（恰好 30 天）仍 active', () => {
    const cards = buildProjectCards({
      workspaces: [
        { id: 'wsIdle', name: '闲置项目', areaIds: [], createdAt: NOW - (PROJECT_CARD_DECAY_DAYS * DAY + 1) },
        { id: 'wsEdge', name: '边界项目', areaIds: [], createdAt: NOW - PROJECT_CARD_DECAY_DAYS * DAY },
      ],
      areas: [],
      agents: [],
      now: NOW,
    });
    expect(cards.find((c) => c.id === 'wsIdle')?.status).toBe('idle');
    expect(cards.find((c) => c.id === 'wsEdge')?.status).toBe('active');
  });

  it('最近委派/成员活动能把旧项目拉回 active（取最大）', () => {
    const { workspaces, areas, agents } = world();
    const cards = buildProjectCards({
      workspaces: [{ ...workspaces[1], createdAt: NOW - 60 * DAY }],
      areas: [areas[1]],
      agents: [agents[2]], // bossB lastWorkedAt = NOW - 10d
      delegationHistory: [decision({ timestamp: NOW - 3 * DAY, projectId: 'wsB', objective: '跟进' })],
      now: NOW,
    });
    expect(cards[0].lastActiveAt).toBe(NOW - 3 * DAY);
    expect(cards[0].status).toBe('active');
  });
});

describe('buildProjectCards — 在做（委派史派生）与关键词', () => {
  it('taskCard.projectId/sourceProject 命中且未完成 → 在做；完成/病历/done 不算；去重、上限 3', () => {
    const { workspaces, areas, agents } = world();
    const history = [
      decision({ timestamp: NOW - 1, projectId: 'wsA', objective: '整理报价单' }),
      decision({ timestamp: NOW - 2, projectId: 'wsA', objective: '整理报价单' }), // 去重
      decision({ timestamp: NOW - 3, projectId: 'wsA', objective: '开发登录页' }),
      decision({ timestamp: NOW - 4, sourceProject: 'wsA', objective: '写周报' }),
      decision({ timestamp: NOW - 5, projectId: 'wsA', objective: '不该出现-1', completed: true }),
      decision({ timestamp: NOW - 6, projectId: 'wsA', objective: '不该出现-2', taskStatus: 'done' }),
      decision({ timestamp: NOW - 7, projectId: 'wsA', objective: '被上限挤出' }),
      decision({ timestamp: NOW - 8, projectId: 'wsB', objective: 'B 的活' }),
    ];
    const cards = buildProjectCards({ workspaces, areas, agents, delegationHistory: history, now: NOW });
    const a = cards.find((c) => c.id === 'wsA')!;
    expect(a.inProgress).toEqual(['整理报价单', '开发登录页', '写周报']); // 新→旧、去重、上限 3
    const b = cards.find((c) => c.id === 'wsB')!;
    expect(b.inProgress).toEqual(['B 的活']);
    // 关键词来自 名字/别名/在做：报价 2-gram 可被消歧③ 吃到
    expect(a.keywords).toContain('整理报价单');
  });

  it('别名并入卡的 aliases 与 keywords', () => {
    const { workspaces, areas, agents } = world();
    const aliases: ProjectAliasEntry[] = [
      { alias: '报价组', projectId: 'wsA', createdAt: NOW, source: 'file' },
      { alias: '项目a', projectId: 'wsA', createdAt: NOW, source: 'seed' }, // 与名字重复 → 去重
    ];
    const cards = buildProjectCards({ workspaces, areas, agents, aliases, now: NOW });
    const a = cards.find((c) => c.id === 'wsA')!;
    expect(a.aliases).toEqual(['项目A', '报价组']);
    expect(a.keywords).toContain('报价组');
  });
});

describe('collectRecentProjectIds — 消歧② 的最近委派窗口', () => {
  it('只认窗口内、新→旧去重；projectId 优先、sourceProject 兜底', () => {
    const history = [
      decision({ timestamp: NOW - 1000, projectId: 'wsA', objective: 'a' }),
      decision({ timestamp: NOW - 2000, projectId: 'wsA', objective: 'b' }), // 去重
      decision({ timestamp: NOW - 3000, sourceProject: 'wsB', objective: 'c' }), // 兜底字段
      decision({ timestamp: NOW - (RECENT_DELEGATION_WINDOW_MS + 1), projectId: 'wsOld', objective: 'd' }), // 窗口外
    ];
    expect(collectRecentProjectIds(history, NOW)).toEqual(['wsA', 'wsB']);
  });

  it('无 projectId 的旧记录（无卡）跳过，不产生 undefined', () => {
    expect(collectRecentProjectIds([decision({ timestamp: NOW - 1000, objective: 'no-card-project' })], NOW)).toEqual([]);
  });
});
