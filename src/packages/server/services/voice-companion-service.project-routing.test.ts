/**
 * voice-companion-service · 任务14·⑪ 项目路由接线胶水（纯函数面）
 *
 * 与 projects/** 模块单测互补：这里只钉 vcs 侧的三处薄胶水 ——
 *   1) resolveDispatchRoute 第 4 参「解析命中注入路由决策」（缺省 = 旧行为逐字不变）；
 *   2) buildAgentSnapshotLines 第 4 参「项目快照块注入」（缺省 = 旧输出逐字不变）；
 *   3) buildProjectRoutingWorld / resolveProjectRoutingForTurn 的接线（依赖全注入，零真实 IO）。
 * 真实 processVoiceInput 编排的 ⑥ 验收在 integration 文件（任务14·⑪ describe）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  buildAgentSnapshotLines,
  buildProjectRoutingWorld,
  buildProjectRoutingSnapshotLines,
  resolveDispatchRoute,
  resolveProjectRoutingForTurn,
  type DispatchTargetAgent,
} from './voice-companion-service.js';
import type {
  ProjectAliasEntry,
  ProjectResolveResult,
} from '../jarvis-core/projects/types.js';

const AGENTS: DispatchTargetAgent[] = [
  { id: 'a1', name: '小美', class: 'builder' },
  { id: 'bA', name: '大当家A', class: 'boss', isBoss: true },
  { id: 'bB', name: '二当家B', class: 'boss', isBoss: true },
];

function decision(partial: Partial<ProjectResolveResult> = {}): ProjectResolveResult {
  return { candidates: [], needAsk: false, ...partial };
}

describe('resolveDispatchRoute 第 4 参 — 解析命中注入路由决策', () => {
  it('缺省第 4 参 = 旧行为逐字不变（无 projectRouting 键）', () => {
    const route = resolveDispatchRoute('delegate_to_boss', null, AGENTS);
    expect(route).toStrictEqual({ route: 'boss', agent: AGENTS[1] });
    expect('projectRouting' in route).toBe(false);
  });

  it('命中 bossId → 该项目主管（优先于首位 Boss），并带回解析结果供 ⑪ 观测', () => {
    const pr = decision({ projectId: 'wsB', projectName: '项目B', bossId: 'bB', layer: 'explicit', source: 'alias:项目b' });
    const route = resolveDispatchRoute('delegate_to_boss', null, AGENTS, pr);
    expect(route).toStrictEqual({ route: 'boss', agent: AGENTS[2], projectRouting: pr });
  });

  it('模型显式点名主管 → 尊重点名（不被项目解析覆盖），解析结果仍回带', () => {
    const pr = decision({ projectId: 'wsB', bossId: 'bB', layer: 'explicit', source: 'boss-id' });
    const route = resolveDispatchRoute('delegate_to_boss', 'bB', AGENTS, pr);
    expect(route).toStrictEqual({ route: 'boss', agent: AGENTS[2], projectRouting: pr });
  });

  it('needAsk → need_ask（不派发）；带违规请求时 violation 仍如实保留', () => {
    const pr = decision({ needAsk: true, askQuestion: '交给哪个项目？' });
    expect(resolveDispatchRoute('delegate_to_boss', null, AGENTS, pr)).toStrictEqual({ route: 'need_ask', decision: pr });
    expect(resolveDispatchRoute('delegate_to_boss', 'a1', AGENTS, pr)).toStrictEqual({
      route: 'need_ask',
      decision: pr,
      violation: { requestedAgentId: 'a1', requestedAgentName: '小美' },
    });
  });

  it('解析无命中（bossId 缺省）→ 回落现状首位 Boss，解析结果带回登记 fallback', () => {
    const pr = decision({ candidates: [{ projectId: 'wsA', name: '项目A', layer: 'keyword', source: 'keyword:x', hit: false }] });
    const route = resolveDispatchRoute('delegate_to_boss', null, AGENTS, pr);
    expect(route).toStrictEqual({ route: 'boss', agent: AGENTS[1], projectRouting: pr });
  });

  it('bossId 指向已不存在的主管（陈旧解析）→ 回落首位 Boss', () => {
    const pr = decision({ bossId: 'bGone', projectId: 'wsC' });
    const route = resolveDispatchRoute('delegate_to_boss', null, AGENTS, pr);
    expect(route).toStrictEqual({ route: 'boss', agent: AGENTS[1], projectRouting: pr });
  });

  it('send_to_agent 是「直接对主管说话」：不参与项目路由（第 4 参忽略）', () => {
    const pr = decision({ bossId: 'bB', needAsk: true });
    expect(resolveDispatchRoute('send_to_agent', 'bA', AGENTS, pr)).toStrictEqual({ route: 'boss', agent: AGENTS[1] });
    expect(resolveDispatchRoute('send_to_agent', 'nope', AGENTS, pr)).toStrictEqual({ route: 'missing' });
  });

  it('团队没有主管 → no_boss（正常流程下解析也不会给 needAsk：bosses 为空时不反问）', () => {
    const noBoss = [{ id: 'a1', name: '小美', class: 'builder' }];
    expect(resolveDispatchRoute('delegate_to_boss', null, noBoss, decision()))
      .toStrictEqual({ route: 'no_boss' });
    // 防御序：即便外部塞了不一致的 needAsk 决策，也绝不派给普通 agent（need_ask 优先于兜底）。
    expect(resolveDispatchRoute('delegate_to_boss', null, noBoss, decision({ needAsk: true })).route).toBe('need_ask');
  });
});

describe('buildAgentSnapshotLines 第 4 参 — 项目快照块注入', () => {
  const agents = [
    { id: 'a1', name: '小美', class: 'builder', status: 'working', lastWorkedAt: 100 },
  ];

  it('不传 projectLines → 输出逐字不变', () => {
    const without = buildAgentSnapshotLines(agents, []);
    expect(without.lines).toHaveLength(1);
    expect(without.lines[0]).toContain('小美');
    expect(without.lines.join('\n')).not.toContain('项目感知');
  });

  it('传 projectLines → 头部注入【项目感知】块，agent 行原样跟在后面，总数/截断不受影响', () => {
    const result = buildAgentSnapshotLines(agents, [], [], ['- [当前] 项目B | id: wsB', '- 项目A']);
    expect(result.total).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.lines[0]).toBe('【项目感知】(当前/各项目在做与最近活跃;派活归属先看这里)');
    expect(result.lines[1]).toBe('- [当前] 项目B | id: wsB');
    expect(result.lines[2]).toBe('- 项目A');
    expect(result.lines[3]).toBe('');
    expect(result.lines[4]).toContain('小美');
  });

  it('空数组传入 = 不注块（与缺省一致）', () => {
    expect(buildAgentSnapshotLines(agents, [], [], []).lines)
      .toEqual(buildAgentSnapshotLines(agents, []).lines);
  });
});

describe('buildProjectRoutingWorld / resolveProjectRoutingForTurn（依赖注入，零真实 IO）', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcs-project-routing-'));
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const NOW = 1_800_000_000_000;

  function buildWorld() {
    return buildProjectRoutingWorld({
      getWorkspaces: () => [
        { id: 'wsA', name: '项目A', areaIds: ['arA'], createdAt: NOW - 1000 },
        { id: 'wsB', name: '项目B', areaIds: ['arB'], createdAt: NOW - 1000 },
      ],
      getActiveWorkspace: () => null,
      loadAreasFn: () => [
        { id: 'arA', assignedAgentIds: ['bA'] },
        { id: 'arB', assignedAgentIds: ['bB'] },
      ],
      getAllAgents: () => [
        { id: 'bA', name: '大当家A', isBoss: true, lastWorkedAt: NOW - 100 },
        { id: 'bB', name: '二当家B', isBoss: true, lastWorkedAt: NOW - 200 },
      ],
      delegationHistory: [],
      aliasesFilePath: path.join(dir, 'aliases.json'),
      now: () => NOW,
    });
  }

  it('世界构建：卡/主管/种子别名/激活工作区/bosses 齐全，种子落盘可复用', () => {
    const world = buildWorld();
    expect(world.cards.map((c) => [c.id, c.bossId])).toEqual([['wsA', 'bA'], ['wsB', 'bB']]);
    expect(world.bosses).toEqual([{ id: 'bA', name: '大当家A' }, { id: 'bB', name: '二当家B' }]);
    expect(world.activeWorkspaceId).toBeNull();
    expect(world.aliasEntries.map((e) => [e.alias, e.projectId]).sort()).toEqual([['项目a', 'wsA'], ['项目b', 'wsB']]);
    expect(fs.existsSync(path.join(dir, 'aliases.json'))).toBe(true); // 种子有新增 → 落盘
    expect(buildWorld().aliasEntries).toHaveLength(2); // 再读不重复种
  });

  it('resolveProjectRoutingForTurn：口称别名 → 命中该项目主管（decision 即接线传入 route 的输入）', () => {
    const world = buildWorld();
    const r = resolveProjectRoutingForTurn({
      text: '让项目B的团队做登录页',
      targetAgentId: null,
      agents: AGENTS,
      world,
      lastProjectId: null,
    });
    expect(r).toEqual(expect.objectContaining({ projectId: 'wsB', bossId: 'bB', layer: 'explicit', needAsk: false }));
  });

  it('resolveProjectRoutingForTurn：模型显式主管 id 是显式信号（不反问）；普通 agent id 不作为信号', () => {
    const world = buildWorld();
    const bossy = resolveProjectRoutingForTurn({
      text: '让团队做登录页', targetAgentId: 'bB', agents: AGENTS, world, lastProjectId: null,
    });
    expect(bossy).toEqual(expect.objectContaining({ bossId: 'bB', layer: 'explicit', source: 'boss-id', needAsk: false }));
    const plain = resolveProjectRoutingForTurn({
      text: '让团队做登录页', targetAgentId: 'a1', agents: AGENTS, world, lastProjectId: null,
    });
    expect(plain.needAsk).toBe(true); // 多主管 + All + 无信号 → 反问
  });

  it('resolveProjectRoutingForTurn：最近提及（会话态）走上下文层', () => {
    const world = buildWorld();
    const r = resolveProjectRoutingForTurn({
      text: '接着弄', targetAgentId: null, agents: AGENTS, world, lastProjectId: 'wsA',
    });
    expect(r).toEqual(expect.objectContaining({ projectId: 'wsA', layer: 'context', source: 'last-project' }));
  });

  it('快照行：当前工作区 + 每项目 1 行；空世界不注块', () => {
    const world = buildWorld();
    const lines = buildProjectRoutingSnapshotLines(world);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('项目A');
    const withActive = buildProjectRoutingSnapshotLines({ ...world, activeWorkspaceId: 'wsB' });
    expect(withActive[0]).toContain('[当前] 项目B');
    expect(buildProjectRoutingSnapshotLines({ ...world, cards: [] })).toEqual([]);
  });
});

describe('别名条目的消歧输入形态（接线与模块契约对钉）', () => {
  it('aliasEntries 直接喂 resolveProjectRoutingForTurn 时可命中', () => {
    const aliases: ProjectAliasEntry[] = [{ alias: '报价组', projectId: 'wsA', createdAt: 0, source: 'file' }];
    const world = buildProjectRoutingWorld({
      getWorkspaces: () => [{ id: 'wsA', name: '项目A', areaIds: [] }],
      getActiveWorkspace: () => null,
      loadAreasFn: () => [],
      getAllAgents: () => [
        { id: 'bA', name: '大当家A', isBoss: true },
        { id: 'bB', name: '二当家B', isBoss: true },
      ],
      delegationHistory: [],
      now: () => 1,
    });
    const cards = world.cards.map((c) => (c.id === 'wsA' ? { ...c, bossId: 'bA', aliases: ['项目A', '报价组'] } : c));
    const r = resolveProjectRoutingForTurn({
      text: '报价组那件事办一下',
      targetAgentId: null,
      agents: AGENTS,
      world: { ...world, cards, aliasEntries: aliases },
      lastProjectId: null,
    });
    expect(r).toEqual(expect.objectContaining({ projectId: 'wsA', bossId: 'bA' }));
  });
});
